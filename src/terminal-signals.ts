import { ProgramStatusParser, type ProgramStatusSnapshot } from "./program-status";

export const TEXT_TAIL_LINES = 24;
const OSC_PENDING_MAX = 4096;
export const OSC_TITLE_MAX = 256;
export const OSC_PROGRESS_TTL_MS = 10_000;

export interface OscProgress {
  state: number;
  percent?: number;
  raw: string;
  at: number;
}

function sanitize(payload: string): string {
  return payload.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, OSC_TITLE_MAX);
}

class TextTail {
  private lines: string[] = [""];
  private carry = "";

  constructor(private readonly maxLines: number) {}

  reset(): void {
    this.lines = [""];
    this.carry = "";
  }

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
      if (code < 0x20 || code === 0x7f) continue;

      this.lines[this.lines.length - 1] += chunk[i];
    }

    return this.text();
  }

  private consumeEscape(chunk: string, at: number): number {
    const next = chunk[at + 1];
    if (next === undefined) return -1;

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

    if (next === "[") {
      let i = at + 2;
      while (i < chunk.length && chunk.charCodeAt(i) >= 0x30 && chunk.charCodeAt(i) <= 0x3f) i++;
      while (i < chunk.length && chunk.charCodeAt(i) >= 0x20 && chunk.charCodeAt(i) <= 0x2f) i++;
      if (i >= chunk.length) return -1;
      const final = chunk[i];
      const params = chunk.slice(at + 2, i);
      if (final === "K") {
        this.lines[this.lines.length - 1] = "";
      } else if (final === "J" && params.includes("2")) {
        this.lines = [""];
      }
      return i;
    }

    if ("(#%)*+-./ ".includes(next)) {
      if (at + 2 >= chunk.length) return -1;
      return at + 2;
    }

    return at + 1;
  }

  text(): string {
    return this.lines.join("\n");
  }

  bottom(count: number): string {
    return this.lines.slice(-count).join("\n");
  }
}

export class TerminalSignals {
  private readonly status = new ProgramStatusParser();
  private readonly tail = new TextTail(TEXT_TAIL_LINES);
  private titleValue: string | undefined;
  private progressValue: OscProgress | undefined;
  private latest: ProgramStatusSnapshot | undefined;
  private pendingOsc = "";
  private oscReportCount = 0;

  reportVersion(): number {
    return this.oscReportCount;
  }

  push(chunk: string, now = Date.now()): void {
    const data = this.pendingOsc === "" ? chunk : this.pendingOsc + chunk;
    this.pendingOsc = "";

    let i = 0;
    while (i < data.length) {
      if (data.charCodeAt(i) !== 0x1b) {
        i++;
        continue;
      }
      if (i + 1 >= data.length) {
        this.pendingOsc = data.slice(i);
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
    if (body.startsWith("7501;")) {
      const snapshot = this.status.push(`\u001b]7501;${body.slice(5)}\u001b\\`);
      if (snapshot) {
        this.latest = snapshot;
        this.oscReportCount++;
      }
      return;
    }

    if (body.startsWith("0;") || body.startsWith("2;")) {
      const value = sanitize(body.slice(2));
      this.titleValue = value === "" ? undefined : value;
      return;
    }

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

  startExecution(): void {
    this.titleValue = undefined;
    this.progressValue = undefined;
    this.pendingOsc = "";
    this.tail.reset();
    this.status.dropTransient();
    if (this.latest?.reported) this.latest = this.status.snapshot();
  }

  reset(): void {
    this.startExecution();
    this.latest = undefined;
    this.pendingOsc = "";
  }

  snapshot(): ProgramStatusSnapshot | undefined {
    return this.latest;
  }

  title(): string | undefined {
    return this.titleValue;
  }

  progress(now = Date.now()): OscProgress | undefined {
    if (!this.progressValue) return undefined;
    if (now - this.progressValue.at > OSC_PROGRESS_TTL_MS) return undefined;
    return this.progressValue;
  }

  text(): string {
    return this.tail.text();
  }

  bottom(count: number): string {
    return this.tail.bottom(count);
  }
}
