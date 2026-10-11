/**
 * Per-terminal status state machine.
 *
 * This is the whole status brain, deliberately free of runtime `vscode` usage so
 * the unit tier can drive it with synthetic output and clocks. `extension.ts`
 * only wires terminal events in and renders transitions out.
 *
 * ## Where status comes from, in priority order
 *
 * 1. **`OSC 7501`** — the Program Status Protocol. Authoritative: when a report
 *    is present nothing else may override it.
 * 2. **Heuristics** (`./detect`) — window title, `OSC 9` progress, and a text
 *    tail, for agents that don't speak the protocol yet.
 * 3. **The process exit code** — always available, and the only source that may
 *    claim `done`/`error` when the protocol is silent.
 *
 * A heuristic may never claim `done` or `error`: only a program (via the
 * protocol) or the OS (via an exit code) can know a task finished.
 *
 * ## Record lifetime (spec §States)
 *
 * `working` and `blocked` are transient: a new foreground command drops them.
 * `done` and `error` survive process exit and the next shell prompt, because the
 * user has not seen the result yet — which is why a session stays `done` after
 * its agent exits. Once a session reaches `done`/`error` from the protocol or an
 * exit code it is *latched*, so stale text in the tail cannot drag it back to
 * `working`.
 */

import type { LifecycleStatus, WaitingReason } from "./program-status";
import { TerminalSignals } from "./terminal-signals";
import { detect, manifestFor, type DetectManifest, type DetectResult } from "./detect";
import { DETECT_MANIFESTS } from "./detect-manifests";

/** Where a session's current status came from. */
export type SessionSource = "osc" | "heuristic" | "exit" | "none";

export interface SessionState {
  /** Terminal tab name (the display name, which a user can rename). */
  name: string;
  /** The agent this tab runs, e.g. "Claude". */
  agentName: string;
  status: LifecycleStatus;
  /** When `status` last changed — drives tooltip ordering. */
  changedAt: number;
  /** Absolute path the agent reported (shell integration `cwd`). */
  cwd?: string;
  /** Workspace folder the tab was launched from; immutable fallback. */
  launchedInFolder?: string;
  /** Why the agent is blocked, when known (protocol `kind` or rule). */
  blockedKind?: WaitingReason;
  /** One human-readable line from the protocol's `msg`. */
  message?: string;
  /** Short record label from the protocol's `title`. */
  title?: string;
  /** Stable program id from the protocol's `app`. */
  app?: string;
  /** Protocol progress percentage, 0-100. */
  progress?: number;
  /** Raw exit code when the process exited. */
  exitCode?: number;
  source: SessionSource;
}

/** A status change worth acting on. */
export interface SessionTransition {
  /** Stable session key (not the display name). */
  session: string;
  previous: LifecycleStatus;
  status: LifecycleStatus;
  source: SessionSource;
  /** True when this transition should reach the user as an alert. */
  notify: boolean;
  reason?: WaitingReason;
  detail?: string;
  exitCode?: number;
}

/** Recording grace after a launch: nothing is claimed until evidence arrives. */
export const STARTUP_GRACE_MS = 3_000;
/** Output within this window means the program is up to something. */
export const ACTIVITY_MS = 700;
/**
 * A `blocked` claim from *text* has to survive a short quiet period — a live
 * prompt is drawn and then waits, whereas a line passing through on its way out
 * does not.
 */
export const BLOCKED_QUIET_MS = 300;
/** Don't re-run the rule table on every repaint of a TUI spinner. */
export const CLASSIFY_THROTTLE_MS = 100;
/** The protocol asks consumers to rate-limit anything a record triggers. */
export const NOTIFY_MIN_INTERVAL_MS = 2_000;

/** The fields a commit may replace on a session. */
interface StatusFields {
  blockedKind?: WaitingReason;
  message?: string;
  title?: string;
  app?: string;
  progress?: number;
  exitCode?: number;
}

interface Tracked {
  /** Stable session key (the creation-time terminal name). */
  key: string;
  state: SessionState;
  signals: TerminalSignals;
  /** When the current foreground command started. */
  startedAt: number;
  /** When output last arrived (0 = never). */
  lastChunkAt: number;
  lastClassifyAt: number;
  lastNotifyAt: number;
  /** Observed `OSC 7501` report count, to act on protocol traffic at once. */
  seenReports: number;
  /** Final for this command: only a fresh protocol report may change it. */
  latched: boolean;
}

export class SessionTracker {
  private readonly sessions = new Map<string, Tracked>();
  private readonly aliases = new Map<string, string>();

  /** Heuristic detection on/off (the `fallbackDetection` setting). */
  private fallback = true;

  constructor(private readonly manifests: readonly DetectManifest[] = DETECT_MANIFESTS) {}

  /**
   * Turn heuristic detection off for users who only trust the protocol. With it
   * off, status changes come solely from `OSC 7501` reports and process exit
   * codes — an agent that never reports stays `unknown`.
   */
  setFallbackEnabled(enabled: boolean): void {
    this.fallback = enabled;
  }

  /** Register a terminal we launched. */
  track(
    tabName: string,
    agentName: string,
    launchedInFolder?: string,
    now = Date.now()
  ): void {
    this.sessions.set(tabName, this.blank(tabName, tabName, agentName, launchedInFolder, now));
  }

  /**
   * Re-adopt terminals that outlived a window reload. `key` is the
   * creation-time name, which is what an alias maps a renamed tab back to.
   */
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

  /** Resolve a display name to the stable session key. */
  resolve(name: string): string {
    return this.aliases.get(name) ?? name;
  }

  get(name: string): SessionState | undefined {
    return this.sessions.get(this.resolve(name))?.state;
  }

  all(): SessionState[] {
    return [...this.sessions.values()].map((entry) => entry.state);
  }

  /** Stable keys of every tracked session. */
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

  /** The agent's reported working directory, from shell integration. */
  setCwd(displayOrKey: string, cwd: string | undefined): boolean {
    if (!cwd) return false;
    const entry = this.sessions.get(this.resolve(displayOrKey));
    if (!entry || entry.state.cwd === cwd) return false;
    entry.state = { ...entry.state, cwd };
    return true;
  }

  /** Feed raw agent output. */
  output(displayOrKey: string, chunk: string, now = Date.now()): SessionTransition[] {
    const entry = this.sessions.get(this.resolve(displayOrKey));
    if (!entry) return [];
    entry.signals.push(chunk, now);
    entry.lastChunkAt = now;

    const reports = entry.signals.reportVersion();
    const protocolArrived = reports !== entry.seenReports;
    // Protocol reports are rare and authoritative: act on them at once. Text-only
    // changes are throttled so a 60 Hz spinner redraw doesn't run the table 60
    // times a second.
    if (!protocolArrived && now - entry.lastClassifyAt < CLASSIFY_THROTTLE_MS) return [];
    entry.seenReports = reports;
    entry.lastClassifyAt = now;
    return this.reclassify(entry, now);
  }

  /**
   * A new foreground command started in this terminal. The previous program is
   * gone, so transient state goes with it; a `done`/`error` record stands.
   */
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

  /**
   * The foreground command ended with `exitCode` (`undefined` when the shell
   * could not report one). A protocol `done`/`error` record wins over it.
   */
  execEnd(
    displayOrKey: string,
    exitCode: number | undefined,
    now = Date.now()
  ): SessionTransition[] {
    const entry = this.sessions.get(this.resolve(displayOrKey));
    if (!entry) return [];

    // A shell's own startup command (a virtualenv/conda activation script, say)
    // finishes inside the recording grace, long before the agent has said
    // anything. Its exit is not the agent's, and reporting it would fire a
    // spurious "done" on every launch.
    if (entry.state.status === "unknown" && now - entry.startedAt < STARTUP_GRACE_MS) {
      return [];
    }

    entry.latched = true;
    if (entry.state.status === "done" || entry.state.status === "error") {
      // The protocol already reported the outcome — keep its message, but a
      // crash after a `done` report is still worth recording.
      if (exitCode !== undefined && exitCode !== 0) {
        return this.commit(entry, { status: "error", source: "osc" }, now, { exitCode });
      }
      if (exitCode !== undefined && entry.state.exitCode !== exitCode) {
        entry.state = { ...entry.state, exitCode };
      }
      return [];
    }
    // A clean exit is only news when the agent was mid-task (a one-shot run
    // finishing on its own). From rest it is the user quitting — `/q`, `/exit`,
    // Ctrl-D — and they are looking right at it. "Mid-task" needs evidence: a
    // protocol report, or a visible approval prompt. Activity-derived `working`
    // doesn't count, since typing the quit command and the redraw are output too.
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

  /**
   * Periodic re-evaluation. Text-derived `working` decays to `idle` once the
   * terminal goes quiet — the only way to leave a busy state when the agent
   * prints nothing to say it stopped.
   */
  tick(now = Date.now()): SessionTransition[] {
    const transitions: SessionTransition[] = [];
    for (const entry of this.sessions.values()) {
      if (entry.latched) continue;
      if (entry.lastClassifyAt === 0) continue; // never saw output
      if (now - entry.lastClassifyAt < CLASSIFY_THROTTLE_MS) continue;
      entry.lastClassifyAt = now;
      transitions.push(...this.reclassify(entry, now));
    }
    return transitions;
  }

  private reclassify(entry: Tracked, now: number): SessionTransition[] {
    const snapshot = entry.signals.snapshot();

    // 1. The protocol — authoritative whenever it has a live record.
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

    // A latched `done`/`error` outlives its process; only a new report (handled
    // above) or a new command may move it.
    if (entry.latched) return [];

    // 2. Recording grace after launch.
    if (now - entry.startedAt < STARTUP_GRACE_MS) return [];

    // 3. Heuristics.
    if (!this.fallback) return [];
    // A prompt can disappear briefly between the erase and repaint chunks.
    // Output alone doesn't resolve an existing blocker; wait for the redraw
    // to settle before deciding whether the prompt is still there.
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

    // 4. No rule matched: infer from activity, then settle to rest.
    if (entry.lastChunkAt === 0) return [];
    if (now - entry.lastChunkAt <= ACTIVITY_MS) {
      return this.commit(entry, { status: "working", source: "heuristic" }, now);
    }
    return this.commit(entry, { status: "idle", source: "heuristic" }, now);
  }

  /**
   * Decide whether a rule's verdict may be published.
   *
   * A `blocked` verdict sourced from text must survive `BLOCKED_QUIET_MS` of
   * silence: a live prompt waits, a line scrolling past does not. This is the
   * guard that keeps a stream's *history* from impersonating the screen's
   * *state*.
   */
  private accept(entry: Tracked, result: DetectResult, now: number): DetectResult | undefined {
    if (result.state === "unknown") return undefined;
    if (result.state === "blocked" && now - entry.lastChunkAt < BLOCKED_QUIET_MS) return undefined;
    return result;
  }

  /** Apply a status/field update, emitting a transition only on a real change. */
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

    // Each report replaces its record completely (spec §Records and ids): a
    // field the update does not carry is absent afterwards.
    const replacement: SessionState = {
      name: previous.name,
      agentName: previous.agentName,
      status: next.status,
      // Ordering follows status changes, not metadata churn — a protocol `msg`
      // that updates every second must not reshuffle the picker.
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

    // Alerts are for outcomes the user must act on, and only from a source that
    // can be trusted to know: the protocol, a real exit code, or a text rule
    // explicitly marked as a blocker.
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
