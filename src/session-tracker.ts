import type { LifecycleStatus, WaitingReason } from "./program-status";
import { TerminalSignals } from "./terminal-signals";
import { detect, manifestFor, type DetectManifest, type DetectResult } from "./detect";
import { DETECT_MANIFESTS } from "./detect-manifests";

export type SessionSource = "osc" | "heuristic" | "exit" | "none";

export interface SessionState {
  name: string;
  agentName: string;
  status: LifecycleStatus;
  changedAt: number;
  cwd?: string;
  launchedInFolder?: string;
  blockedKind?: WaitingReason;
  message?: string;
  title?: string;
  app?: string;
  progress?: number;
  exitCode?: number;
  source: SessionSource;
}

export interface SessionTransition {
  session: string;
  previous: LifecycleStatus;
  status: LifecycleStatus;
  source: SessionSource;
  notify: boolean;
  reason?: WaitingReason;
  detail?: string;
  exitCode?: number;
}

export const STARTUP_GRACE_MS = 3_000;
export const ACTIVITY_MS = 700;
export const BLOCKED_QUIET_MS = 300;
export const CLASSIFY_THROTTLE_MS = 100;
export const NOTIFY_MIN_INTERVAL_MS = 2_000;

interface StatusFields {
  blockedKind?: WaitingReason;
  message?: string;
  title?: string;
  app?: string;
  progress?: number;
  exitCode?: number;
}

interface Tracked {
  key: string;
  state: SessionState;
  signals: TerminalSignals;
  startedAt: number;
  lastChunkAt: number;
  lastClassifyAt: number;
  lastNotifyAt: number;
  seenReports: number;
  latched: boolean;
}

export class SessionTracker {
  private readonly sessions = new Map<string, Tracked>();
  private readonly aliases = new Map<string, string>();

  private fallback = true;

  constructor(private readonly manifests: readonly DetectManifest[] = DETECT_MANIFESTS) {}

  setFallbackEnabled(enabled: boolean): void {
    this.fallback = enabled;
  }

  track(
    tabName: string,
    agentName: string,
    launchedInFolder?: string,
    now = Date.now()
  ): void {
    this.sessions.set(tabName, this.blank(tabName, tabName, agentName, launchedInFolder, now));
  }

  seed(
    candidates: { key: string; name: string; agentName: string }[],
    now = Date.now()
  ): boolean {
    let changed = false;
    for (const candidate of candidates) {
      const existing = this.sessions.get(candidate.key);
      if (!existing) {
        this.sessions.set(
          candidate.key,
          this.blank(candidate.key, candidate.name, candidate.agentName, undefined, now)
        );
        changed = true;
      } else if (existing.state.name !== candidate.name) {
        existing.state = { ...existing.state, name: candidate.name };
        changed = true;
      }
      if (candidate.name === candidate.key) {
        this.aliases.delete(candidate.name);
      } else if (this.aliases.get(candidate.name) !== candidate.key) {
        this.aliases.set(candidate.name, candidate.key);
      }
    }
    return changed;
  }

  private blank(
    key: string,
    name: string,
    agentName: string,
    launchedInFolder?: string,
    now = Date.now()
  ): Tracked {
    return {
      key,
      state: {
        name,
        agentName,
        status: "unknown",
        changedAt: now,
        source: "none",
        ...(launchedInFolder ? { launchedInFolder } : {}),
      },
      signals: new TerminalSignals(),
      startedAt: now,
      lastChunkAt: 0,
      lastClassifyAt: 0,
      lastNotifyAt: 0,
      seenReports: 0,
      latched: false,
    };
  }

  resolve(name: string): string {
    return this.aliases.get(name) ?? name;
  }

  get(name: string): SessionState | undefined {
    return this.sessions.get(this.resolve(name))?.state;
  }

  all(): SessionState[] {
    return [...this.sessions.values()].map((entry) => entry.state);
  }

  keys(): string[] {
    return [...this.sessions.keys()];
  }

  rename(oldDisplayName: string, newDisplayName: string, stableSessionName: string): boolean {
    this.aliases.delete(oldDisplayName);
    if (stableSessionName === newDisplayName) this.aliases.delete(newDisplayName);
    else this.aliases.set(newDisplayName, stableSessionName);

    const entry = this.sessions.get(stableSessionName);
    if (!entry || entry.state.name === newDisplayName) return false;
    entry.state = { ...entry.state, name: newDisplayName };
    return true;
  }

  forget(displayOrKey: string): boolean {
    const key = this.resolve(displayOrKey);
    const deleted = this.sessions.delete(key);
    this.aliases.delete(displayOrKey);
    for (const [display, target] of [...this.aliases]) {
      if (target === key) this.aliases.delete(display);
    }
    return deleted;
  }

  setCwd(displayOrKey: string, cwd: string | undefined): boolean {
    if (!cwd) return false;
    const entry = this.sessions.get(this.resolve(displayOrKey));
    if (!entry || entry.state.cwd === cwd) return false;
    entry.state = { ...entry.state, cwd };
    return true;
  }

  output(displayOrKey: string, chunk: string, now = Date.now()): SessionTransition[] {
    const entry = this.sessions.get(this.resolve(displayOrKey));
    if (!entry) return [];
    entry.signals.push(chunk, now);
    entry.lastChunkAt = now;

    const reports = entry.signals.reportVersion();
    const protocolArrived = reports !== entry.seenReports;
    if (!protocolArrived && now - entry.lastClassifyAt < CLASSIFY_THROTTLE_MS) return [];
    entry.seenReports = reports;
    entry.lastClassifyAt = now;
    return this.reclassify(entry, now);
  }

  execStart(displayOrKey: string, now = Date.now()): SessionTransition[] {
    const entry = this.sessions.get(this.resolve(displayOrKey));
    if (!entry) return [];
    entry.signals.startExecution();
    entry.startedAt = now;
    entry.lastChunkAt = now;
    entry.lastClassifyAt = now;
    entry.latched = false;

    const transient = entry.state.status === "working" || entry.state.status === "blocked";
    if (transient || entry.state.source === "heuristic") {
      return this.commit(entry, { status: "unknown", source: "none" }, now);
    }
    return [];
  }

  execEnd(
    displayOrKey: string,
    exitCode: number | undefined,
    now = Date.now()
  ): SessionTransition[] {
    const entry = this.sessions.get(this.resolve(displayOrKey));
    if (!entry) return [];

    if (entry.state.status === "unknown" && now - entry.startedAt < STARTUP_GRACE_MS) {
      return [];
    }

    entry.latched = true;
    if (entry.state.status === "done" || entry.state.status === "error") {
      if (exitCode !== undefined && exitCode !== 0) {
        return this.commit(entry, { status: "error", source: "osc" }, now, { exitCode });
      }
      if (exitCode !== undefined && entry.state.exitCode !== exitCode) {
        entry.state = { ...entry.state, exitCode };
      }
      return [];
    }
    const midTask =
      (entry.state.source === "osc" &&
        (entry.state.status === "working" || entry.state.status === "blocked")) ||
      (entry.state.source === "heuristic" && entry.state.status === "blocked");
    return this.commit(
      entry,
      { status: exitCode === 0 ? "done" : "error", source: "exit" },
      now,
      {
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(exitCode === 0 && !midTask ? { silent: true } : {}),
      }
    );
  }

  tick(now = Date.now()): SessionTransition[] {
    const transitions: SessionTransition[] = [];
    for (const entry of this.sessions.values()) {
      if (entry.latched) continue;
      if (entry.lastClassifyAt === 0) continue;
      if (now - entry.lastClassifyAt < CLASSIFY_THROTTLE_MS) continue;
      entry.lastClassifyAt = now;
      transitions.push(...this.reclassify(entry, now));
    }
    return transitions;
  }

  private reclassify(entry: Tracked, now: number): SessionTransition[] {
    const snapshot = entry.signals.snapshot();

    if (snapshot?.reported && snapshot.status !== "unknown") {
      entry.latched = snapshot.status === "done" || snapshot.status === "error";
      entry.seenReports = entry.signals.reportVersion();
      return this.commit(
        entry,
        { status: snapshot.status, source: "osc" },
        now,
        {
          ...(snapshot.kind ? { blockedKind: snapshot.kind } : {}),
          ...(snapshot.msg ? { message: snapshot.msg } : {}),
          ...(snapshot.title ? { title: snapshot.title } : {}),
          ...(snapshot.app ? { app: snapshot.app } : {}),
          ...(snapshot.progress !== undefined ? { progress: snapshot.progress } : {}),
        }
      );
    }

    if (entry.latched) return [];

    if (now - entry.startedAt < STARTUP_GRACE_MS) return [];

    if (!this.fallback) return [];
    if (entry.state.status === "blocked" && now - entry.lastChunkAt < BLOCKED_QUIET_MS) return [];
    const manifest = manifestFor(entry.state.agentName, this.manifests);
    const title = entry.signals.title();
    const progress = entry.signals.progress(now);
    if (manifest) {
      const result = detect(manifest, {
        ...(title !== undefined ? { title } : {}),
        ...(progress !== undefined ? { progress } : {}),
        text: entry.signals.text(),
        bottom: (n: number) => entry.signals.bottom(n),
      });
      const verdict = result ? this.accept(entry, result, now) : undefined;
      if (verdict) {
        return this.commit(
          entry,
          { status: verdict.state, source: "heuristic" },
          now,
          {
            ...(verdict.kind ? { blockedKind: verdict.kind } : {}),
            ...(verdict.rule.visibleBlocker ? { visibleBlocker: true } : {}),
          }
        );
      }
    }

    if (entry.lastChunkAt === 0) return [];
    if (now - entry.lastChunkAt <= ACTIVITY_MS) {
      return this.commit(entry, { status: "working", source: "heuristic" }, now);
    }
    return this.commit(entry, { status: "idle", source: "heuristic" }, now);
  }

  private accept(entry: Tracked, result: DetectResult, now: number): DetectResult | undefined {
    if (result.state === "unknown") return undefined;
    if (result.state === "blocked" && now - entry.lastChunkAt < BLOCKED_QUIET_MS) return undefined;
    return result;
  }

  private commit(
    entry: Tracked,
    next: { status: LifecycleStatus; source: SessionSource },
    now: number,
    fields: StatusFields & { visibleBlocker?: boolean; silent?: boolean } = {}
  ): SessionTransition[] {
    const previous = entry.state;
    const blockedKind = next.status === "blocked" ? fields.blockedKind : undefined;
    const statusChanged = previous.status !== next.status;
    const unchanged =
      !statusChanged &&
      previous.blockedKind === blockedKind &&
      previous.message === fields.message &&
      previous.title === fields.title &&
      previous.app === fields.app &&
      previous.progress === fields.progress;

    if (unchanged) {
      if (next.source !== previous.source) entry.state = { ...previous, source: next.source };
      return [];
    }

    const replacement: SessionState = {
      name: previous.name,
      agentName: previous.agentName,
      status: next.status,
      changedAt: statusChanged ? now : previous.changedAt,
      source: next.source,
      ...(previous.cwd ? { cwd: previous.cwd } : {}),
      ...(previous.launchedInFolder ? { launchedInFolder: previous.launchedInFolder } : {}),
      ...(blockedKind ? { blockedKind } : {}),
      ...(fields.message !== undefined ? { message: fields.message } : {}),
      ...(fields.title !== undefined ? { title: fields.title } : {}),
      ...(fields.app !== undefined ? { app: fields.app } : {}),
      ...(fields.progress !== undefined ? { progress: fields.progress } : {}),
      ...(fields.exitCode !== undefined ? { exitCode: fields.exitCode } : {}),
    };
    entry.state = replacement;

    const transition: SessionTransition = {
      session: entry.key,
      previous: previous.status,
      status: next.status,
      source: next.source,
      notify: false,
      ...(blockedKind ? { reason: blockedKind } : {}),
      ...(fields.message ?? fields.title
        ? { detail: fields.message ?? fields.title }
        : {}),
      ...(fields.exitCode !== undefined ? { exitCode: fields.exitCode } : {}),
    };

    if (statusChanged && (next.status === "blocked" || next.status === "done" || next.status === "error")) {
      const trusted =
        next.source === "osc" ||
        next.source === "exit" ||
        (next.source === "heuristic" && fields.visibleBlocker === true);
      if (trusted && !fields.silent && now - entry.lastNotifyAt >= NOTIFY_MIN_INTERVAL_MS) {
        transition.notify = true;
        entry.lastNotifyAt = now;
      }
    }

    return [transition];
  }
}
