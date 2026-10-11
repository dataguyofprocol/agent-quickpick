/**
 * OSC 7501 — the Program Status Protocol.
 *
 * A program tells the terminal what it is doing with a single escape sequence:
 *
 *   ESC ] 7501 ; key=value:key=value ST
 *
 * `state` is required and is one of idle / working / done / blocked / error,
 * plus `clear` which removes records instead of creating one. Optional keys are
 * `id` (hierarchical record path), `kind` (why a blocked program is blocked),
 * `progress` (0-100), `app`, `title` and `msg`.
 *
 * Spec: https://www.superlogical.com/rex/docs/build/program-status
 *
 * This module is deliberately free of *runtime* `vscode` usage so the unit tier
 * can exercise it in plain Node. The parser follows the spec's error handling:
 * a malformed *optional* key is treated as absent rather than discarding the
 * whole report (`kind=auth` on a `working` state is still a valid `working`
 * report), while a malformed `state`/`id` or an undecodable or
 * control-character-bearing `msg`/`title` does discard it.
 */

export type LifecycleStatus = "idle" | "working" | "done" | "blocked" | "error" | "unknown";

/** Why a program is blocked, per the protocol's `kind` key. */
export type WaitingReason = "permission" | "question" | "auth";

/** A `state` value a report can carry; `clear` deletes records instead. */
export type ProgramState = Exclude<LifecycleStatus, "unknown"> | "clear";

export interface ProgramStatusRecord {
  /** Hierarchical record path (`build/test`); absent means the root record. */
  id?: string;
  state: ProgramState;
  kind?: WaitingReason;
  progress?: number;
  app?: string;
  title?: string;
  msg?: string;
}

export interface ProgramStatusSnapshot {
  /** Every live record, keyed by id (`""` is the root record). */
  records: ReadonlyMap<string, ProgramStatusRecord>;
  /** The record the UI should show, after attention/root selection. */
  status: LifecycleStatus;
  kind?: WaitingReason;
  progress?: number;
  msg?: string;
  title?: string;
  app?: string;
  /** True once any valid report has been seen (the protocol is in use). */
  reported: boolean;
}

/** Whole-sequence cap, `OSC` through `ST` (the largest legal report is <3300). */
export const OSC7501_MAX_SEQUENCE = 4096;
/** Records per terminal; the least-recently-updated is evicted past this. */
export const OSC7501_MAX_RECORDS = 256;

/** Bound on an unterminated sequence we are willing to buffer across chunks. */
const MAX_PENDING = OSC7501_MAX_SEQUENCE * 2;
const PREFIX = "\u001b]7501;";
const STATES: readonly ProgramState[] = ["idle", "working", "done", "blocked", "error", "clear"];
const KINDS: readonly WaitingReason[] = ["permission", "question", "auth"];

/**
 * Decode a base64 free-text value (`msg`, `title`), enforcing the spec's three
 * conditions: the encoded size, the decoded size, and the ban on control
 * characters — which is also what stops a program smuggling a newline or an
 * escape sequence into a notification.
 */
function decodeText(value: string, encodedLimit: number, decodedLimit: number): string | undefined {
  if (value.length > encodedLimit || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return undefined;
  try {
    const bytes = Buffer.from(value, "base64");
    if (bytes.length > decodedLimit) return undefined;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return /[\u0000-\u001f\u007f-\u009f]/.test(text) ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * Parse the body of one `OSC 7501` report.
 *
 * Returns `"query"` for the feature-detection request (`OSC 7501 ; ? ST`), the
 * record for a valid report, and `undefined` for anything malformed.
 */
export function parseProgramStatusBody(body: string): ProgramStatusRecord | "query" | undefined {
  if (body === "?") return "query";
  if (!body || body.startsWith("?")) return undefined;
  if (Buffer.byteLength(body, "utf8") + 8 > OSC7501_MAX_SEQUENCE) return undefined;

  // Pairs are `key=value` separated by `:`. A malformed pair is skipped and the
  // rest of the report is still processed; a repeated key keeps the last value.
  const fields: Record<string, string> = {};
  for (const item of body.split(":")) {
    const at = item.indexOf("=");
    if (at < 1) continue;
    const key = item.slice(0, at).trim();
    const value = item.slice(at + 1).trim();
    if (/^[a-z]{1,16}$/.test(key) && /^[A-Za-z0-9_.,+/=-]*$/.test(value)) {
      fields[key] = value;
    }
  }

  // An unknown or absent state discards the report whole, so a state added in a
  // later revision can never be misread as one we know.
  const state = fields.state as ProgramState | undefined;
  if (!state || !STATES.includes(state)) return undefined;

  const record: ProgramStatusRecord = { state };

  // A malformed id may not fall back to the root record — that would let it
  // overwrite a well-formed one.
  if (fields.id !== undefined) {
    const parts = fields.id.split("/");
    if (
      fields.id.length > 128 ||
      parts.length > 8 ||
      !parts.every((part) => /^[A-Za-z0-9_.+-]{1,32}$/.test(part))
    ) {
      return undefined;
    }
    record.id = fields.id;
  }

  // From here on an invalid optional value is treated as absent (spec compliance
  // matters here: a later revision may add a kind we don't know).
  if (fields.app !== undefined && /^[A-Za-z0-9_.+-]{1,32}$/.test(fields.app)) {
    record.app = fields.app;
  }
  if (state === "blocked" && fields.kind !== undefined) {
    if ((KINDS as readonly string[]).includes(fields.kind)) {
      record.kind = fields.kind as WaitingReason;
    }
  }
  if ((state === "working" || state === "blocked") && fields.progress !== undefined) {
    if (/^(?:100|[1-9]?\d)$/.test(fields.progress)) record.progress = Number(fields.progress);
  }
  if (fields.msg !== undefined) {
    const msg = decodeText(fields.msg, 2732, 2048);
    if (msg === undefined) return undefined; // undecodable/control chars: discard
    record.msg = msg;
  }
  if (fields.title !== undefined) {
    const title = decodeText(fields.title, 256, 192);
    if (title === undefined) return undefined;
    record.title = title;
  }

  return record;
}

/** Child-record preference when no attention state is present. */
const CHILD_RANK: Record<ProgramState, number> = {
  blocked: 0,
  error: 1,
  working: 2,
  done: 3,
  idle: 4,
  clear: 5,
};

/**
 * Pick the record to show.
 *
 * The protocol lets one program report many records at once — a deploy tool can
 * be `working` at the root while a region is `blocked` — and leaves the choice
 * to the consumer. Our rule, in order:
 *
 * 1. Attention wins: a `blocked` record, else an `error` record, preferring the
 *    root record among equals. A sub-task waiting on the user is the most
 *    useful thing to surface.
 * 2. Otherwise the root record defines the program's own state — which is what
 *    keeps a `done` root from being masked by a stale `working` child.
 * 3. Otherwise the most informative child.
 */
function selectRecord(
  records: ReadonlyMap<string, ProgramStatusRecord>
): [string, ProgramStatusRecord] | undefined {
  const live = [...records.entries()].filter(([, record]) => record.state !== "clear");
  if (live.length === 0) return undefined;

  const rootFirst = (a: [string, ProgramStatusRecord], b: [string, ProgramStatusRecord]) =>
    (a[0] === "" ? 0 : 1) - (b[0] === "" ? 0 : 1);

  const attention = live
    .filter(([, record]) => record.state === "blocked" || record.state === "error")
    .sort((a, b) => CHILD_RANK[a[1].state] - CHILD_RANK[b[1].state] || rootFirst(a, b));
  if (attention.length > 0) return attention[0];

  const root = live.find(([id]) => id === "");
  if (root) return root;

  return live.sort((a, b) => CHILD_RANK[a[1].state] - CHILD_RANK[b[1].state])[0];
}

/**
 * Streaming parser for `OSC 7501` output, tolerating sequences split across
 * reads. Holds the bounded record set the protocol describes.
 */
export class ProgramStatusParser {
  private pending = "";
  private readonly records = new Map<string, { value: ProgramStatusRecord; used: number }>();
  private clock = 0;
  private hasReported = false;

  /**
   * Feed a chunk of raw terminal output.
   *
   * @returns the new snapshot when a record changed, else `undefined` — so a
   *          caller can skip work on the (overwhelmingly common) chunk that
   *          carries no protocol traffic.
   */
  push(chunk: string): ProgramStatusSnapshot | undefined {
    this.pending = (this.pending + chunk).slice(-MAX_PENDING);
    let changed = false;

    for (;;) {
      const start = this.pending.indexOf(PREFIX);
      if (start < 0) {
        // Keep a short tail so a prefix split across chunks still matches.
        this.pending = this.pending.slice(-(PREFIX.length - 1));
        break;
      }
      const bodyStart = start + PREFIX.length;

      // Find the terminator (BEL or ESC \) before the next OSC 7501.
      let end = -1;
      let term = 0;
      let nested = -1;
      for (let i = bodyStart; i < this.pending.length; i++) {
        if (this.pending.startsWith(PREFIX, i)) {
          nested = i;
          break;
        }
        const code = this.pending.charCodeAt(i);
        if (code === 7) {
          end = i;
          term = 1;
          break;
        }
        if (code === 27) {
          if (i + 1 === this.pending.length) break; // might be a split ST
          if (this.pending.charCodeAt(i + 1) === 92) {
            end = i;
            term = 2;
            break;
          }
        }
      }

      if (nested >= 0) {
        // An unterminated sequence immediately followed by a new report: drop
        // the broken one and parse the new one.
        this.pending = this.pending.slice(nested);
        continue;
      }
      if (end < 0) {
        this.pending = this.pending.slice(start);
        if (this.pending.length > OSC7501_MAX_SEQUENCE) {
          // An unterminated sequence can never be legal past the cap; forget it
          // rather than buffering output without bound.
          const next = this.pending.indexOf(PREFIX, 1);
          this.pending = next >= 0 ? this.pending.slice(next) : "";
          continue;
        }
        break;
      }

      const full = this.pending.slice(start, end + term);
      const body = this.pending.slice(bodyStart, end);
      this.pending = this.pending.slice(end + term);

      const report =
        Buffer.byteLength(full, "utf8") <= OSC7501_MAX_SEQUENCE
          ? parseProgramStatusBody(body)
          : undefined;
      if (!report || report === "query") continue;

      this.hasReported = true;
      const id = report.id ?? "";
      if (report.state === "clear") {
        // `clear` removes the addressed record and everything beneath it; with
        // no id it removes every record on the terminal.
        for (const key of [...this.records.keys()]) {
          if (!id || key === id || key.startsWith(`${id}/`)) this.records.delete(key);
        }
      } else {
        // Each report replaces its record completely.
        this.records.set(id, { value: report, used: ++this.clock });
        if (this.records.size > OSC7501_MAX_RECORDS) {
          let oldestKey: string | undefined;
          let oldestUsed = Infinity;
          for (const [key, entry] of this.records) {
            if (entry.used < oldestUsed) {
              oldestUsed = entry.used;
              oldestKey = key;
            }
          }
          if (oldestKey !== undefined) this.records.delete(oldestKey);
        }
      }
      changed = true;
    }

    return changed ? this.snapshot() : undefined;
  }

  /**
   * Drop the records that cannot outlive their process.
   *
   * Spec §States: when the process exits or a new shell prompt begins, a
   * terminal MUST drop `working` and `blocked` records and MAY drop `idle` ones.
   * `done` and `error` survive, because the user has not seen the result yet.
   * Without this, an agent that reported `working` and then exited would have
   * that stale record re-published by the next parse.
   */
  dropTransient(dropIdle = false): void {
    for (const [id, entry] of [...this.records]) {
      const state = entry.value.state;
      if (state === "working" || state === "blocked" || (dropIdle && state === "idle")) {
        this.records.delete(id);
      }
    }
  }

  /** Current records + the record the UI should show. */
  snapshot(): ProgramStatusSnapshot {
    const records = new Map<string, ProgramStatusRecord>();
    for (const [id, entry] of this.records) records.set(id, { ...entry.value });

    const selected = selectRecord(records);
    if (!selected) {
      return { records, status: "unknown", reported: this.hasReported };
    }

    const [id, record] = selected;
    // `app` is inherited from the nearest ancestor that has one.
    let app = record.app;
    const segments = id.split("/");
    while (!app && segments.length > 0) {
      segments.pop();
      app = records.get(segments.join("/"))?.app;
    }

    return {
      records,
      status: record.state === "clear" ? "unknown" : record.state,
      reported: this.hasReported,
      ...(record.kind ? { kind: record.kind } : {}),
      ...(record.progress !== undefined ? { progress: record.progress } : {}),
      ...(record.msg ? { msg: record.msg } : {}),
      ...(record.title ? { title: record.title } : {}),
      ...(app ? { app } : {}),
    };
  }
}
