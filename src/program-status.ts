export type LifecycleStatus = "idle" | "working" | "done" | "blocked" | "error" | "unknown";

export type WaitingReason = "permission" | "question" | "auth";

export type ProgramState = Exclude<LifecycleStatus, "unknown"> | "clear";

export interface ProgramStatusRecord {
  id?: string;
  state: ProgramState;
  kind?: WaitingReason;
  progress?: number;
  app?: string;
  title?: string;
  msg?: string;
}

export interface ProgramStatusSnapshot {
  records: ReadonlyMap<string, ProgramStatusRecord>;
  status: LifecycleStatus;
  kind?: WaitingReason;
  progress?: number;
  msg?: string;
  title?: string;
  app?: string;
  reported: boolean;
}

export const OSC7501_MAX_SEQUENCE = 4096;
export const OSC7501_MAX_RECORDS = 256;

const MAX_PENDING = OSC7501_MAX_SEQUENCE * 2;
const PREFIX = "\u001b]7501;";
const STATES: readonly ProgramState[] = ["idle", "working", "done", "blocked", "error", "clear"];
const KINDS: readonly WaitingReason[] = ["permission", "question", "auth"];

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

export function parseProgramStatusBody(body: string): ProgramStatusRecord | "query" | undefined {
  if (body === "?") return "query";
  if (!body || body.startsWith("?")) return undefined;
  if (Buffer.byteLength(body, "utf8") + 8 > OSC7501_MAX_SEQUENCE) return undefined;

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

  const state = fields.state as ProgramState | undefined;
  if (!state || !STATES.includes(state)) return undefined;

  const record: ProgramStatusRecord = { state };

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
    if (msg === undefined) return undefined;
    record.msg = msg;
  }
  if (fields.title !== undefined) {
    const title = decodeText(fields.title, 256, 192);
    if (title === undefined) return undefined;
    record.title = title;
  }

  return record;
}

const CHILD_RANK: Record<ProgramState, number> = {
  blocked: 0,
  error: 1,
  working: 2,
  done: 3,
  idle: 4,
  clear: 5,
};

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

export class ProgramStatusParser {
  private pending = "";
  private readonly records = new Map<string, { value: ProgramStatusRecord; used: number }>();
  private clock = 0;
  private hasReported = false;

  push(chunk: string): ProgramStatusSnapshot | undefined {
    this.pending = (this.pending + chunk).slice(-MAX_PENDING);
    let changed = false;

    for (;;) {
      const start = this.pending.indexOf(PREFIX);
      if (start < 0) {
        this.pending = this.pending.slice(-(PREFIX.length - 1));
        break;
      }
      const bodyStart = start + PREFIX.length;

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
          if (i + 1 === this.pending.length) break;
          if (this.pending.charCodeAt(i + 1) === 92) {
            end = i;
            term = 2;
            break;
          }
        }
      }

      if (nested >= 0) {
        this.pending = this.pending.slice(nested);
        continue;
      }
      if (end < 0) {
        this.pending = this.pending.slice(start);
        if (this.pending.length > OSC7501_MAX_SEQUENCE) {
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
        for (const key of [...this.records.keys()]) {
          if (!id || key === id || key.startsWith(`${id}/`)) this.records.delete(key);
        }
      } else {
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

  dropTransient(dropIdle = false): void {
    for (const [id, entry] of [...this.records]) {
      const state = entry.value.state;
      if (state === "working" || state === "blocked" || (dropIdle && state === "idle")) {
        this.records.delete(id);
      }
    }
  }

  snapshot(): ProgramStatusSnapshot {
    const records = new Map<string, ProgramStatusRecord>();
    for (const [id, entry] of this.records) records.set(id, { ...entry.value });

    const selected = selectRecord(records);
    if (!selected) {
      return { records, status: "unknown", reported: this.hasReported };
    }

    const [id, record] = selected;
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
