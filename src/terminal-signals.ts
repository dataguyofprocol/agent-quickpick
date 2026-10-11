/**
 * Raw terminal output → the signals a status classifier can use.
 *
 * VS Code gives us the agent's raw output stream (via shell integration's
 * `execution.read()`) and nothing else — there is no screen buffer, so there is
 * no rendered grid to read. That rules out the screen-region matching tools like
 * Herdr use, and leaves three usable signals:
 *
 * 1. **OSC 7501** — the Program Status Protocol. Authoritative; see
 *    `./program-status`.
 * 2. **OSC 0 / OSC 2 (window title)** and **OSC 9 (progress)**. These are what
 *    an agent's own TUI publishes continuously, and they survive the missing
 *    grid intact. Herdr's most reliable rules are built on this pair.
 * 3. **A text tail** — recent output with escape sequences interpreted well
 *    enough to stay line-oriented: `\r` rewrites the current line, `ESC[K`
 *    erases it, `\n` starts a new one. This approximates a screen for line-mode
 *    agents, but it is *history*, not state: text that was dismissed is never
 *    erased from a stream the way it is from a screen. Rules built on it must be
 *    conservative — see `./detect-manifests`.
 *
 * Free of runtime `vscode` usage so the unit tier can drive it directly.
 */

import { ProgramStatusParser, type ProgramStatusSnapshot } from "./program-status";

/** Lines retained for text-based matching. */
export const TEXT_TAIL_LINES = 24;
/** Cap on an unterminated OSC we will buffer across chunks. */
const OSC_PENDING_MAX = 4096;
/** `title` is a label, so it is capped the way the protocol caps payloads. */
export const OSC_TITLE_MAX = 256;
/**
 * A progress payload has no expiry in the protocol, so an agent that reports
 * "indeterminate" and never clears it would look busy forever. Derived state
 * expires on its own instead.
 */
export const OSC_PROGRESS_TTL_MS = 10_000;

/** A parsed `OSC 9;4` progress report. */
export interface OscProgress {
  /** 0 = clear, 1 = normal, 2 = error, 3 = indeterminate, 4 = paused. */
  state: number;
  percent?: number;
  /** Raw payload after `9;`, e.g. `4;3;` — what the rule table matches on. */
  raw: string;
  at: number;
}

/** Strip control characters from a title/progress payload, then cap it. */
function sanitize(payload: string): string {
  return payload.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, OSC_TITLE_MAX);
}

/**
 * A rolling, line-oriented view of recent output.
 *
 * Not a terminal emulator: it tracks neither the cursor between rows nor a
 * column width, because both need the rendered grid we do not have. It does
 * handle the rewrite idioms TUIs actually use — carriage return, erase-line,
 * newline, backspace — which is enough for spinner and prompt-line patterns.
 */
class TextTail {
  private lines: string[] = [""];
  /** An escape sequence split across two chunks. */
  private carry = "";

  constructor(private readonly maxLines: number) {}

  reset(): void {
    this.lines = [""];
    this.carry = "";
  }

  /** Feed output; returns the current tail as `\n`-joined lines. */
  push(chunk: string): string {
    if (this.carry) {
      chunk = this.carry + chunk;
      this.carry = "";
    }

    for (let i = 0; i < chunk.length; i++) {
      const code = chunk.charCodeAt(i);

      if (code === 0x1b) {
        const consumed = this.consumeEscape(chunk, i);
        if (consumed < 0) {
          // Incomplete escape: hold it for the next chunk so we never mistake
          // the tail of a sequence for text.
          this.carry = chunk.slice(i);
          break;
        }
        i = consumed;
        continue;
      }

      if (code === 0x0a) {
        this.lines.push("");
        if (this.lines.length > this.maxLines) this.lines.shift();
        continue;
      }
      if (code === 0x0d) {
        this.lines[this.lines.length - 1] = "";
        continue;
      }
      if (code === 0x08) {
        const last = this.lines.length - 1;
        this.lines[last] = this.lines[last].slice(0, -1);
        continue;
      }
      if (code === 0x09) {
        this.lines[this.lines.length - 1] += " ";
        continue;
      }
      if (code < 0x20 || code === 0x7f) continue; // other C0 / DEL

      this.lines[this.lines.length - 1] += chunk[i];
    }

    return this.text();
  }

  /**
   * Interpret the escape sequence starting at `at`.
   *
   * @returns the index of its last consumed character, or `-1` when the
   *          sequence is incomplete and must be carried to the next chunk.
   */
  private consumeEscape(chunk: string, at: number): number {
    const next = chunk[at + 1];
    if (next === undefined) return -1;

    // OSC: ESC ] ... BEL | ESC \
    if (next === "]") {
      for (let i = at + 2; i < chunk.length; i++) {
        const c = chunk.charCodeAt(i);
        if (c === 0x07) return i;
        if (c === 0x1b) {
          if (i + 1 >= chunk.length) return -1;
          if (chunk.charCodeAt(i + 1) === 0x5c) return i + 1;
        }
      }
      return -1;
    }

    // CSI: ESC [ params intermediates final
    if (next === "[") {
      let i = at + 2;
      while (i < chunk.length && chunk.charCodeAt(i) >= 0x30 && chunk.charCodeAt(i) <= 0x3f) i++;
      while (i < chunk.length && chunk.charCodeAt(i) >= 0x20 && chunk.charCodeAt(i) <= 0x2f) i++;
      if (i >= chunk.length) return -1;
      const final = chunk[i];
      const params = chunk.slice(at + 2, i);
      if (final === "K") {
        // Erase in line — every variant means "clear this line".
        this.lines[this.lines.length - 1] = "";
      } else if (final === "J" && params.includes("2")) {
        // Erase in display — mirror a real screen clear.
        this.lines = [""];
      }
      return i;
    }

    // Three-character escapes: ESC ( ) * + - . / # % and space designators.
    if ("(#%)*+-./ ".includes(next)) {
      if (at + 2 >= chunk.length) return -1;
      return at + 2;
    }

    // Any other two-character escape (ESC 7, ESC =, ESC M, ...).
    return at + 1;
  }

  text(): string {
    return this.lines.join("\n");
  }

  /** The last `count` lines, for rules that should only trust the bottom. */
  bottom(count: number): string {
    return this.lines.slice(-count).join("\n");
  }
}

/**
 * Accumulates one agent terminal's OSC traffic and text tail.
 *
 * Clearing is lifecycle-driven: {@link startExecution} drops title/progress
 * because a new command means a new foreground program (Herdr clears both when
 * the agent changes), while the 7501 record set is kept because the protocol
 * says `done` and `error` records survive a new shell prompt.
 */
export class TerminalSignals {
  private readonly status = new ProgramStatusParser();
  private readonly tail = new TextTail(TEXT_TAIL_LINES);
  private titleValue: string | undefined;
  private progressValue: OscProgress | undefined;
  private latest: ProgramStatusSnapshot | undefined;
  /** An OSC sequence split across two reads (the text tail carries its own). */
  private pendingOsc = "";
  private oscReportCount = 0;

  /**
   * Monotonic count of accepted `OSC 7501` reports. A caller can classify
   * immediately (protocol traffic is authoritative and rare) when this advances,
   * and throttle text-driven reclassification otherwise.
   */
  reportVersion(): number {
    return this.oscReportCount;
  }

  push(chunk: string, now = Date.now()): void {
    // Reassemble an OSC that was split across reads. The text tail keeps its
    // own carry, so both scanners see the sequence exactly once.
    const data = this.pendingOsc === "" ? chunk : this.pendingOsc + chunk;
    this.pendingOsc = "";

    let i = 0;
    while (i < data.length) {
      if (data.charCodeAt(i) !== 0x1b) {
        i++;
        continue;
      }
      if (i + 1 >= data.length) {
        this.pendingOsc = data.slice(i); // a lone ESC at a chunk boundary
        break;
      }
      if (data[i + 1] !== "]") {
        i++;
        continue;
      }
      const terminator = this.findOscEnd(data, i + 2);
      if (terminator === null) {
        const pending = data.slice(i);
        this.pendingOsc = pending.length <= OSC_PENDING_MAX ? pending : "";
        break;
      }
      this.handleOsc(data.slice(i + 2, terminator.bodyEnd), now);
      i = terminator.next;
    }

    this.tail.push(chunk);
  }

  /**
   * Locate an OSC terminator at or after `from`.
   *
   * @returns the body end and the index just past the terminator, or `-1` when
   *          the sequence is incomplete.
   */
  private findOscEnd(chunk: string, from: number): { bodyEnd: number; next: number } | null {
    for (let i = from; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i);
      if (c === 0x07) return { bodyEnd: i, next: i + 1 };
      if (c === 0x1b) {
        if (i + 1 >= chunk.length) return null;
        if (chunk.charCodeAt(i + 1) === 0x5c) return { bodyEnd: i, next: i + 2 };
      }
    }
    return null;
  }

  private handleOsc(body: string, now: number): void {
    // OSC 7501 — the Program Status Protocol. Re-presented to the protocol
    // parser as a well-formed sequence so record semantics live in one place.
    if (body.startsWith("7501;")) {
      const snapshot = this.status.push(`\u001b]7501;${body.slice(5)}\u001b\\`);
      if (snapshot) {
        this.latest = snapshot;
        this.oscReportCount++;
      }
      return;
    }

    // OSC 0 and OSC 2 both set the window title; the last one wins, and an
    // empty payload clears it.
    if (body.startsWith("0;") || body.startsWith("2;")) {
      const value = sanitize(body.slice(2));
      this.titleValue = value === "" ? undefined : value;
      return;
    }

    // OSC 9 — iTerm2-style progress: `9;4;<state>;<percent>`. An empty payload
    // does not clear it, matching Herdr's capture.
    if (body.startsWith("9;")) {
      const raw = sanitize(body.slice(2));
      if (raw !== "") this.progressValue = this.parseProgress(raw, now);
    }
  }

  private parseProgress(raw: string, now: number): OscProgress {
    const parts = raw.split(";");
    const progress: OscProgress = {
      state: Number(parts[1] ?? parts[0]) || 0,
      raw,
      at: now,
    };
    const percent = Number(parts[2]);
    if (Number.isFinite(percent) && percent >= 0) progress.percent = percent;
    return progress;
  }

  /**
   * A new foreground command started: title and progress describe the previous
   * program, and its transient protocol records are no longer true.
   */
  startExecution(): void {
    this.titleValue = undefined;
    this.progressValue = undefined;
    this.pendingOsc = "";
    this.tail.reset();
    this.status.dropTransient();
    if (this.latest?.reported) this.latest = this.status.snapshot();
  }

  /** Full reset, e.g. when the terminal is re-adopted after a reload. */
  reset(): void {
    this.startExecution();
    this.latest = undefined;
    this.pendingOsc = "";
  }

  /** The latest `OSC 7501` snapshot, or `undefined` if none ever arrived. */
  snapshot(): ProgramStatusSnapshot | undefined {
    return this.latest;
  }

  title(): string | undefined {
    return this.titleValue;
  }

  /** Progress, or `undefined` once it has gone stale. */
  progress(now = Date.now()): OscProgress | undefined {
    if (!this.progressValue) return undefined;
    if (now - this.progressValue.at > OSC_PROGRESS_TTL_MS) return undefined;
    return this.progressValue;
  }

  /** The whole text tail. */
  text(): string {
    return this.tail.text();
  }

  /** The last `count` lines of the text tail. */
  bottom(count: number): string {
    return this.tail.bottom(count);
  }
}
