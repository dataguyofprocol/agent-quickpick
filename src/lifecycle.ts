/**
 * Agent lifecycle awareness — shared core.
 *
 * Lets Agent Quickpick track per-session status (running / finished / waiting /
 * failed) for lifecycle-aware agents (Claude Code, OpenCode, Droid) and surface
 * it via notifications + a live status-bar count. Each agent's hook mechanism is
 * abstracted behind a {@link LifecycleAdapter}; the shared core is agnostic to
 * whether an agent uses command hooks (Claude/Droid) or a file-based plugin
 * (OpenCode).
 *
 * Pure functions are exported for unit testing; the HTTP server + polling are
 * VS Code-coupled and live at the bottom.
 */

import * as http from "http";
import * as vscode from "vscode";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LifecycleStatus =
  | "running"
  | "finished"
  | "waiting"
  | "failed"
  | "unknown";

/**
 * Human labels for each lifecycle status, using Herdr's vocabulary. Shared by
 * the status-bar tooltip and the session quickpick so the two never drift.
 * `unknown` is the honest label for a re-adopted terminal after a host reload:
 * we know an agent tab exists, but until a hook or exit-status poll confirms
 * its state, we don't claim it's working.
 */
export const STATUS_LABEL: Record<LifecycleStatus, string> = {
  running: "working",
  finished: "done",
  waiting: "blocked",
  failed: "failed",
  unknown: "reconnecting",
};

/** Compact glyph per status, matching {@link statusBarText}. */
export const STATUS_GLYPH: Record<LifecycleStatus, string> = {
  running: "●",
  finished: "✓",
  waiting: "⏸",
  failed: "✗",
  unknown: "○",
};

export interface SessionState {
  /** Terminal tab name, e.g. "Claude" or "Codex (2)". */
  name: string;
  /** Base agent name, e.g. "Claude". */
  agentName: string;
  status: LifecycleStatus;
  /** Epoch ms of last status change. */
  changedAt: number;
  /**
   * Process exit code captured by the exit-status poller, when the status
   * transition was caused by the agent's process exiting. Absent for
   * hook-driven transitions (Stop/Notification/etc). Surfaced in the
   * status-bar tooltip and the failure toast.
   */
  exitCode?: number;
  /**
   * The workspace folder this session was launched from (fsPath), captured at
   * `trackSession` time. Immutable per session — used as the fallback for
   * repo-scoping when no `cwd` has arrived from a hook yet (e.g. immediately
   * after launch, or after a host reload re-adopted the terminal).
   */
  launchedInFolder?: string;
  /**
   * The agent's actual current working directory (fsPath), as reported by the
   * most recent hook payload that carried `cwd`. Source of truth for
   * repo-scoping when set (it accounts for `cd` inside the agent); falls back
   * to {@link launchedInFolder} when absent.
   */
  cwd?: string;
}

/**
 * The raw payload POSTed by an agent hook to the lifecycle HTTP server.
 * Agents that lack a field send it unset; we read defensively.
 */
export interface HookPayload {
  /** Marker identifying which adapter produced this hook. */
  marker?: string;
  /** The session/tab name to update (injected into the terminal's env). */
  session?: string;
  status?: LifecycleStatus;
  agentName?: string;
  /**
   * The agent's current working directory, when the agent's hook payload
   * includes it (Claude Code does via stdin `cwd`; OpenCode via `process.cwd()`).
   * Used to associate the session with a workspace folder for repo-scoped
   * status-bar filtering. Absent for adapters/sources that don't supply it.
   */
  cwd?: string;
}

// ---------------------------------------------------------------------------
// JSON config helpers (shared by all adapters that write JSON config files)
// ---------------------------------------------------------------------------

/**
 * Safely parse a JSON config file's text into an object. Missing, empty, or
 * malformed input → `{}` (so we never crash on a bad edit). Non-object top
 * levels (arrays, primitives) also → `{}`.
 */
export function readConfigJson(text: string): unknown {
  if (typeof text !== "string" || text.trim() === "") {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

/**
 * Pretty-print a config object as 2-space-indented JSON with a trailing
 * newline. Stable so install → remove round-trips are deterministic.
 */
export function writeConfigJson(parsed: unknown): string {
  return JSON.stringify(parsed, null, 2) + "\n";
}

/**
 * Shallow-clone an object-typed config value. Non-objects → `{}`.
 */
function cloneObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  return {};
}

// ---------------------------------------------------------------------------
// Lifecycle adapter interface
// ---------------------------------------------------------------------------

/**
 * Lifecycle hooks are installed **globally** (once per agent, into the agent's
 * user-level config), not per-workspace. Because the hook payload is driven by
 * the `AQP_HOOK_URL` / `AQP_SESSION` env we inject into each terminal we launch
 * (see {@link HOOK_ENV}), a single global hook routes correctly to whichever
 * VS Code window launched the terminal, in any repo — and no-ops for agent
 * sessions we didn't launch (the guard in {@link buildNodeHookCommand}).
 *
 * Two install mechanisms, discriminated by {@link BaseAdapter.kind}:
 *  - "command-hooks" (Claude, Droid): edit a JSON config file, merging our
 *    `node -e` command hooks. Install/remove are idempotent mirror images
 *    identified by {@link BaseAdapter.marker}, so a user editing the file in
 *    between never confuses removal.
 *  - "plugin-file" (OpenCode): drop a self-contained plugin file into the
 *    agent's auto-loaded plugin dir. Install = write file; remove = delete it.
 */
export type AdapterKind = "command-hooks" | "plugin-file";

interface BaseAdapter {
  /** Human name matching BUILTIN_AGENTS, e.g. "Claude". */
  readonly agentName: string;
  /**
   * A unique marker string embedded in the generated hook/plugin so it is
   * unambiguously ours. Never reused across adapters.
   */
  readonly marker: string;
  readonly kind: AdapterKind;
}

/**
 * An agent whose hooks live in a JSON config file as `node -e` command hooks
 * (Claude & Droid share this schema).
 */
export interface CommandHookAdapter extends BaseAdapter {
  readonly kind: "command-hooks";
  /**
   * Path (relative to the user's home dir) of the global config file to edit,
   * e.g. ".claude/settings.json".
   */
  readonly configPath: string;

  /**
   * Merge our hooks into an already-parsed config object. Idempotent: merging
   * twice produces the same result as merging once. Must not clobber keys the
   * user added themselves.
   */
  mergeHooks(
    parsedConfig: unknown,
    hookUrl: string,
    session: string,
    portFilePath: string
  ): unknown;

  /**
   * Strip *only* our hooks (by {@link BaseAdapter.marker}) from a parsed config
   * object. Idempotent. Must leave user hooks byte-for-byte intact. Prunes an
   * empty `hooks` object if removing ours empties it.
   */
  stripHooks(parsedConfig: unknown): unknown;

  /** True iff our hooks (any schema version) are present in a parsed config. */
  hasOurHooks(parsedConfig: unknown): boolean;

  /**
   * True iff a hook of ours written by the current {@link HOOK_SCHEMA_VERSION}
   * is present for **every** event this adapter wires. False (not just "absent")
   * signals `installHook` should rewrite — see
   * `LifecycleContext.autoUpgradeHooks`. Per-event, so a config missing one
   * event's hook self-heals instead of passing as current.
   */
  hasCurrentHooks(parsedConfig: unknown): boolean;
}

/**
 * An agent whose hook is a self-contained plugin file the agent auto-loads from
 * a well-known dir (OpenCode). Install writes the file; remove deletes it;
 * detection is file existence.
 */
export interface PluginFileAdapter extends BaseAdapter {
  readonly kind: "plugin-file";
  /**
   * Path (relative to the user's home dir) of the plugin file we write into the
   * agent's auto-loaded plugin dir, e.g.
   * ".config/opencode/plugin/agent-quickpick-lifecycle.js".
   */
  readonly pluginPath: string;
  /**
   * Generate the plugin file's source (embeds the hook URL as a fallback, and
   * `portFilePath` so a stale-env session can still find the current server —
   * see {@link buildNodeHookCommand}'s doc for the same resolution order).
   */
  buildSource(hookUrl: string, session: string, portFilePath: string): string;
}

export type LifecycleAdapter = CommandHookAdapter | PluginFileAdapter;

// ---------------------------------------------------------------------------
// Command-hook helpers (shared by Claude & Droid, which use the same schema)
// ---------------------------------------------------------------------------

/**
 * Bumped whenever the generated hook command/plugin source changes shape
 * (new events wired, new payload fields, new URL-resolution strategy). Embedded
 * as a `<marker>:v<N>` token alongside the marker so an already-installed hook
 * can be told apart from a stale one written by an older extension version —
 * see {@link hasCurrentCommandHooks} and `LifecycleContext.autoUpgradeHooks`
 * (extension.ts), which silently rewrites stale installs on activation so
 * existing users get new hook behavior without reinstalling anything.
 */
export const HOOK_SCHEMA_VERSION = 2;

/** The version tag embedded alongside a marker; shared by embed + detect sites. */
function versionTag(marker: string): string {
  return `${marker}:v${HOOK_SCHEMA_VERSION}`;
}

/**
 * Generate a self-contained `node -e` command that reads stdin JSON, reads the
 * lifecycle server URL + session name from env, and POSTs a hook payload to the
 * server. Embeds the marker (+ schema version tag) as a comment + payload field
 * so the hook is unambiguously ours and its generation is detectable.
 *
 * URL resolution order: the port file at `portFilePath` (rewritten with the
 * current port on every extension activation — see `startLifecycleServer`'s
 * caller in extension.ts) → `AQP_HOOK_URL` env (frozen at terminal-launch time,
 * so stale after any restart) → the URL baked in at install time. Checking the
 * port file first means a terminal opened *before* an extension restart still
 * reaches the new server on its very next hook event, with no relaunch needed
 * — the on-disk hook command itself is re-read fresh by the agent CLI every
 * time, unlike the terminal's env.
 *
 * Path-free → survives extension version updates regardless of install path.
 * Uses only Node built-ins (`http`, `fs`), so it works on any machine with Node.
 */
export function buildNodeHookCommand(
  hookUrl: string,
  session: string,
  marker: string,
  status: LifecycleStatus,
  portFilePath: string
): string {
  // Inline-escape for a double-quoted JSON string value.
  const escapedUrl = hookUrl.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const escapedPortFilePath = portFilePath
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  // Guard first: this hook is installed globally, so it runs on *every* Stop/
  // Notification for this agent — even sessions we didn't launch. When
  // AQP_SESSION is absent (not one of ours), exit immediately: a no-op, no
  // socket, no dead-port noise.
  return `node -e "/*${versionTag(marker)}*/if(!process.env.AQP_SESSION){process.exit(0)}const h=require('http'),fs=require('fs');let fileUrl;try{fileUrl=JSON.parse(fs.readFileSync('${escapedPortFilePath}','utf8')).url}catch(e){}const u=fileUrl||process.env.AQP_HOOK_URL||'${escapedUrl}';let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d||'{}');const b=JSON.stringify({marker:'${marker}',session:process.env.AQP_SESSION||'${session}',status:'${status}',agentName:'${marker.split(':')[1]||''}',cwd:j?.cwd||''});const r=h.request(u,{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(b)}});r.setTimeout(2000,()=>r.destroy());r.on('error',()=>{});r.end(b)}catch(e){}})"`;
}

/**
 * The env vars injected into each lifecycle-aware agent's terminal so its hooks
 * can reach back to our server. `strictEnv: false` (the default) means these
 * are *added* to the inherited environment, not replacing it.
 */
export const HOOK_ENV = (hookUrl: string, session: string) => ({
  AQP_HOOK_URL: hookUrl,
  AQP_SESSION: session,
});

/**
 * A single hook object inside an entry's `hooks` array:
 * `{ type: "command", command: "..." }`. Returns the command string when the
 * value has that shape, else undefined.
 */
function hookCommand(hook: unknown): string | undefined {
  if (!hook || typeof hook !== "object") return undefined;
  const command = (hook as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
}

/** True if this hook object is one of ours (any schema version). */
function isOurHook(hook: unknown, marker: string): boolean {
  return hookCommand(hook)?.includes(marker) ?? false;
}

/** True if this hook object is ours *and* written by the current version. */
function isCurrentHook(hook: unknown, marker: string): boolean {
  return hookCommand(hook)?.includes(versionTag(marker)) ?? false;
}

/**
 * Filter an event's entry array, rewriting each entry's inner `hooks` array with
 * `keepHook` and dropping only entries our filtering left empty. Entries that
 * never contained a hook of ours (and any other keys they carry, e.g. `matcher`)
 * come through untouched, so a user hook sharing an entry with ours survives —
 * this is why filtering happens per *hook*, not per entry.
 */
function filterEventEntries(
  entries: readonly unknown[],
  marker: string,
  keepHook: (hook: unknown) => boolean
): unknown[] {
  const result: unknown[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      result.push(entry);
      continue;
    }
    const record = entry as Record<string, unknown>;
    const hooks = record.hooks;
    if (!Array.isArray(hooks) || !hooks.some((h) => isOurHook(h, marker))) {
      result.push(entry); // none of ours here — leave it exactly as-is
      continue;
    }
    const keptHooks = hooks.filter((h) => !isOurHook(h, marker) || keepHook(h));
    // Only ours were in this entry and all got dropped → drop the entry too, so
    // we don't leave `{ hooks: [] }` litter behind.
    if (keptHooks.length === 0) continue;
    result.push({ ...record, hooks: keptHooks });
  }
  return result;
}

/**
 * Merge our command hooks into a Claude/Droid-style config for the given events.
 * Schema: `{ hooks: { <Event>: [ { matcher?, hooks: [ { type, command } ] } ] } }`.
 *
 * Replaces rather than accumulates: any hook of ours written by an *older*
 * {@link HOOK_SCHEMA_VERSION} is dropped from the event before the current form
 * is appended, so upgrading never leaves two generations of our hook firing side
 * by side. An event that already has the current hook is left untouched, which
 * makes this idempotent; an event missing it gets it, even when *other* events
 * are already current (a partial install self-heals).
 *
 * User hooks — including one that shares an entry with ours — are preserved.
 *
 * This is used by both the Claude and Droid adapters (identical schema). We keep
 * it here so the merge/strip logic is tested once and shared.
 */
export function mergeCommandHooks(
  parsedConfig: unknown,
  events: readonly string[],
  hookUrl: string,
  session: string,
  marker: string,
  portFilePath: string
): unknown {
  const config = cloneObject(parsedConfig);
  const hooksSection = cloneObject(config.hooks);

  for (const event of events) {
    const existing = Array.isArray(hooksSection[event])
      ? (hooksSection[event] as unknown[])
      : [];

    // Drop stale generations of ours; keep current ones (and everything else).
    const arr = filterEventEntries(existing, marker, (h) =>
      isCurrentHook(h, marker)
    );

    const already = arr.some(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        Array.isArray((entry as Record<string, unknown>).hooks) &&
        ((entry as Record<string, unknown>).hooks as unknown[]).some((h) =>
          isCurrentHook(h, marker)
        )
    );
    if (!already) {
      // One entry per lifecycle status we care about for this event.
      const statuses = statusesForEvent(event);
      for (const status of statuses) {
        const command = buildNodeHookCommand(
          hookUrl,
          session,
          marker,
          status,
          portFilePath
        );
        arr.push({
          hooks: [{ type: "command", command }],
        });
      }
    }
    hooksSection[event] = arr;
  }

  config.hooks = hooksSection;
  return config;
}

/**
 * Strip our command hooks (by marker, any schema version) from a Claude/Droid-
 * style config. Idempotent. Prunes an event left with no entries and an empty
 * `hooks` section. Leaves user hooks intact even when one shares an entry with
 * ours — see {@link filterEventEntries}.
 */
export function stripCommandHooks(
  parsedConfig: unknown,
  marker: string
): unknown {
  const config = cloneObject(parsedConfig);
  const hooksSection = cloneObject(config.hooks);

  for (const event of Object.keys(hooksSection)) {
    const arr = hooksSection[event];
    if (!Array.isArray(arr)) continue;

    const filtered = filterEventEntries(arr, marker, () => false);
    if (filtered.length === 0) {
      delete hooksSection[event];
    } else {
      hooksSection[event] = filtered;
    }
  }

  if (Object.keys(hooksSection).length === 0) {
    delete config.hooks;
  } else {
    config.hooks = hooksSection;
  }
  return config;
}

/**
 * Check whether our command hooks (by marker) exist in a config, regardless of
 * which schema version wrote them. Used for dedup/removal, where any version of
 * our hook must be recognized as "ours."
 */
export function hasCommandHooks(parsedConfig: unknown, marker: string): boolean {
  if (!parsedConfig || typeof parsedConfig !== "object") return false;
  return JSON.stringify(parsedConfig).includes(marker);
}

/**
 * Check whether our command hooks in a config were written by the *current*
 * {@link HOOK_SCHEMA_VERSION}. False for a config with no hooks of ours at all,
 * and false for one written by an older version — both cases mean
 * `installHook` should (re)write the current form. Used by
 * `LifecycleContext.autoUpgradeHooks` (extension.ts) to silently upgrade
 * existing users' installed hooks with no prompt.
 */
export function hasCurrentCommandHooks(
  parsedConfig: unknown,
  marker: string,
  events: readonly string[]
): boolean {
  if (!parsedConfig || typeof parsedConfig !== "object") return false;
  const hooksSection = (parsedConfig as Record<string, unknown>).hooks;
  if (!hooksSection || typeof hooksSection !== "object") return false;
  const section = hooksSection as Record<string, unknown>;

  // Every wired event must carry a current hook of ours. Checking per-event
  // (rather than "the version tag appears somewhere in the file") means a
  // half-installed config — one event hand-deleted, or a write interrupted
  // mid-merge — is reported stale and re-merged, instead of looking current
  // forever because one sibling event still has its tag.
  return events.every((event) => {
    const arr = section[event];
    if (!Array.isArray(arr)) return false;
    return arr.some(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        Array.isArray((entry as Record<string, unknown>).hooks) &&
        ((entry as Record<string, unknown>).hooks as unknown[]).some((h) =>
          isCurrentHook(h, marker)
        )
    );
  });
}

/**
 * Map a Claude/Droid event name to the lifecycle statuses we want to report.
 * `Stop` → the agent finished a turn. `Notification` → the agent needs input.
 * `UserPromptSubmit` → the user sent a new message, so the agent is working
 * again (without this, status wrongly stays "done" for the entire next turn
 * until the next Stop fires — the bar would lie while the agent is mid-work).
 */
function statusesForEvent(event: string): LifecycleStatus[] {
  switch (event) {
    case "Stop":
      return ["finished"];
    case "Notification":
      return ["waiting"];
    case "SessionStart":
      return ["running"];
    case "UserPromptSubmit":
      return ["running"];
    default:
      return ["running"];
  }
}

// ---------------------------------------------------------------------------
// Status-bar + notification rendering (pure, tested)
// ---------------------------------------------------------------------------

/** Tally an array of session states into a count-per-status map. */
export function countByStatus(states: SessionState[]): Record<LifecycleStatus, number> {
  const counts: Record<LifecycleStatus, number> = {
    running: 0,
    finished: 0,
    waiting: 0,
    failed: 0,
    unknown: 0,
  };
  for (const s of states) {
    counts[s.status]++;
  }
  return counts;
}

/**
 * Render the status-bar item text. All-zero → the static default (preserves
 * pre-lifecycle behavior). Otherwise a compact live count:
 * `$(agent-quickpick) 2● 1✓ 1⏸ 1✗` (only non-zero groups shown). `unknown`
 * sessions render as `○` (hollow) so re-adopted terminals after a host reload
 * are visually distinct from confirmed-working ones.
 */
export function statusBarText(counts: Record<LifecycleStatus, number>): string {
  const glyph = "$(agent-quickpick)";
  const parts: string[] = [];
  if (counts.running > 0) parts.push(`${counts.running}●`);
  if (counts.finished > 0) parts.push(`${counts.finished}✓`);
  if (counts.waiting > 0) parts.push(`${counts.waiting}⏸`);
  if (counts.failed > 0) parts.push(`${counts.failed}✗`);
  if (counts.unknown > 0) parts.push(`${counts.unknown}○`);

  if (parts.length === 0) {
    return `${glyph} Agent`;
  }
  return `${glyph} ${parts.join(" ")}`;
}

/**
 * Render the status-bar tooltip: a per-session list, most-recently-changed
 * first. Empty → a generic description. When a session's `workspaceFolder` is
 * known (either via a hook-reported `cwd` or its launch folder), the folder's
 * basename is appended so the same agent across multiple repos is
 * disambiguated in the tooltip.
 */
export function statusBarTooltip(states: SessionState[]): string {
  if (states.length === 0) {
    return "Agent Quickpick — running agents";
  }
  const sorted = [...states].sort((a, b) => b.changedAt - a.changedAt);
  return sorted
    .map((s) => {
      const folder = folderOf(s);
      const suffix = folder ? ` · ${folderBasename(folder)}` : "";
      return `${s.name} — ${STATUS_LABEL[s.status]}${suffix}`;
    })
    .join("\n");
}

/**
 * The workspace folder to attribute a session to. Prefers the hook-reported
 * `cwd` (source of truth, accounts for `cd` inside the agent) and falls back
 * to the launch folder. Returns undefined for re-adopted terminals that have
 * neither (after a host reload, before any hook has arrived).
 */
export function folderOf(state: SessionState): string | undefined {
  return state.cwd ?? state.launchedInFolder;
}

/** Return the basename of a folder path, tolerating trailing slashes. */
export function folderBasename(folder: string): string {
  const trimmed = folder.replace(/[\\/]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/**
 * Filter a list of session states to those that belong to the active workspace
 * folder. Pure + host-free so it's unit-testable. A session belongs iff its
 * {@link folderOf} matches `activeFolder`. When `activeFolder` is undefined
 * (no workspace open), all sessions are returned (preserves the pre-filter
 * aggregate-everything behavior).
 *
 * Re-adopted sessions with neither `cwd` nor `launchedInFolder` are excluded
 * when an `activeFolder` is set — we can't honestly claim them for any repo.
 */
export function filterSessionsByFolder(
  states: SessionState[],
  activeFolder: string | undefined
): SessionState[] {
  if (activeFolder === undefined) {
    return states;
  }
  return states.filter((s) => folderOf(s) === activeFolder);
}

/**
 * The statuses worth announcing to the user. `running` is too noisy and
 * `unknown` isn't a state we can honestly announce. Shared by the toast, the
 * OS notification, and the sound so the three never drift apart.
 */
const ANNOUNCED_STATUSES: readonly LifecycleStatus[] = [
  "finished",
  "waiting",
  "failed",
];

/** True if this status is one we announce (toast / OS notification / sound). */
export function isAnnouncedStatus(status: LifecycleStatus): boolean {
  return ANNOUNCED_STATUSES.includes(status);
}

/**
 * Whether a notification toast should fire for this status. Suppressed when the
 * terminal is already focused (the user is looking at it) or the setting is off.
 * Fires on `finished`, `waiting`, and `failed` — not on `running` (too noisy)
 * and never on `unknown` (we don't have a confident state to announce).
 * `failed` is rendered as an error-severity toast by the caller (see
 * {@link LifecycleContext.maybeNotify}), so it is included here; a crashed agent
 * must not be silent.
 */
export function shouldNotify(
  status: LifecycleStatus,
  isActiveTerminal: boolean,
  settingOn: boolean
): boolean {
  if (!settingOn) return false;
  if (isActiveTerminal) return false;
  return isAnnouncedStatus(status);
}

// ---------------------------------------------------------------------------
// OS notifications + notification sound
// ---------------------------------------------------------------------------

/**
 * When to raise a *native* OS notification (Notification Center / toast /
 * libnotify) in addition to the in-editor toast.
 *
 * `always` is the default: the OS notification is the only channel that reaches
 * you outside the editor *and* the only one that persists in Notification
 * Center, so it fires on every announced status. A VS Code toast is invisible
 * when the window is behind another app, minimized, or on another Space — which
 * is exactly when "the agent needs you" matters. `whenUnfocused` is available
 * for people who find the doubled alert while looking at VS Code redundant.
 */
export type SystemNotifyMode = "off" | "whenUnfocused" | "always";

/**
 * A process to spawn, described as file + argv so the caller can use `spawn`
 * without a shell. Never build these strings by interpolating agent names, repo
 * paths, or session names into a shell/AppleScript/PowerShell command — those
 * are attacker-adjacent free text (a session name can contain quotes, `$(...)`,
 * backticks). Everything user-derived travels as argv or via `env`.
 */
export interface SpawnSpec {
  file: string;
  args: string[];
  /** Extra env vars for the child (merged over `process.env` by the caller). */
  env?: Record<string, string>;
  /** Tried once if `file` fails to spawn (e.g. ENOENT on Linux audio tools). */
  fallback?: SpawnSpec;
}

/**
 * Whether to raise an OS notification for this status change.
 *
 * Deliberately does NOT consider `isActiveTerminal` the way {@link shouldNotify}
 * does. That suppression assumes "terminal focused ⇒ user is watching", which is
 * false when the VS Code window itself isn't focused: the agent's terminal can
 * be the active terminal while the user is in a browser. Window focus is the
 * only signal that matters here.
 *
 * `settingOn` is the master `lifecycleNotifications` switch — off means silent
 * operation across every channel.
 */
export function shouldSystemNotify(
  mode: SystemNotifyMode,
  status: LifecycleStatus,
  windowFocused: boolean,
  settingOn: boolean
): boolean {
  if (!settingOn) return false;
  if (mode === "off") return false;
  if (!isAnnouncedStatus(status)) return false;
  return mode === "always" ? true : !windowFocused;
}

/**
 * Whether to play the notification sound. Independent of *where* the
 * notification is rendered: Agent Quickpick's sound is its signature, so it
 * fires for an in-editor toast and an OS notification alike (one sound per
 * event — the caller announces a status change once).
 */
export function shouldPlaySound(
  soundOn: boolean,
  status: LifecycleStatus,
  settingOn: boolean
): boolean {
  if (!settingOn) return false;
  if (!soundOn) return false;
  return isAnnouncedStatus(status);
}

/**
 * A macOS bundle identifier is safe to splice into AppleScript source only if it
 * looks like one. Bundle ids are reverse-DNS: letters, digits, dots, hyphens.
 * Anything else (a quote, `"` + arbitrary AppleScript) is rejected so the caller
 * falls back to the unattributed form rather than building an injectable script.
 */
export function isSafeBundleId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/.test(id);
}

/**
 * Everything platform-specific the caller knows about the host editor. All
 * optional: with none of it we still raise a banner, just an unattributed one.
 */
export interface NotifyTarget {
  /** macOS bundle id of the host editor — sets the banner's icon and owner. */
  bundleId?: string;
  /**
   * Absolute path to `terminal-notifier`. A GUI-launched editor inherits
   * launchd's minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so Homebrew's
   * `terminal-notifier` is invisible to a bare-name spawn — the caller resolves
   * it on disk instead.
   */
  notifierPath?: string;
  /** URI opened when the banner is clicked (our `…://…/focus?session=` link). */
  openUrl?: string;
}

/**
 * Build the OS-notification command for a platform, or `null` where we have no
 * native channel (then the toast + sound still fire).
 *
 * - **macOS**: `terminal-notifier` when the caller found it, falling back to
 *   `osascript`. A bare `display notification` is attributed to whatever app
 *   *ran* the script — Script Editor, whose grey icon lands on the banner and
 *   whose folder opens in Finder when you click it. `terminal-notifier` fixes
 *   both: `-sender` puts the editor's icon on the banner, and `-open <uri>`
 *   hands the click to our URI handler, which focuses the agent's terminal
 *   (`-activate` is the fallback when there's no URI — it merely raises the
 *   editor). Re-attributing via AppleScript instead (`tell application id ...
 *   to display notification`) is *not* an option: it sends an Apple event, which
 *   triggers a TCC automation-consent prompt and blocks `osascript`
 *   indefinitely until it's answered. The fallback passes title/body through an
 *   `on run argv` wrapper so they are arguments, never spliced into the
 *   AppleScript source.
 * - **Linux**: `notify-send` (argv, nothing to escape).
 * - **Windows**: PowerShell raising a real WinRT toast, reading title/body from
 *   env vars. The AUMID is PowerShell's own registered id — an unregistered
 *   AppId makes `Show()` a silent no-op.
 */
export function systemNotifyCommand(
  platform: NodeJS.Platform,
  title: string,
  body: string,
  target: NotifyTarget = {}
): SpawnSpec | null {
  switch (platform) {
    case "darwin": {
      const osa: SpawnSpec = {
        file: "osascript",
        args: [
          "-e",
          "on run argv",
          "-e",
          "display notification (item 1 of argv) with title (item 2 of argv)",
          "-e",
          "end run",
          body,
          title,
        ],
      };
      const { bundleId, notifierPath, openUrl } = target;
      if (!bundleId || !isSafeBundleId(bundleId)) {
        return osa;
      }
      // A click follows -open when we have a URI (focuses the exact terminal),
      // otherwise -activate (raises the editor). Both beat Script Editor.
      const click = openUrl ? ["-open", openUrl] : ["-activate", bundleId];
      return {
        file: notifierPath ?? "terminal-notifier",
        args: ["-title", title, "-message", body, "-sender", bundleId, ...click],
        // ENOENT (not installed) → the unattributed AppleScript banner.
        fallback: osa,
      };
    }
    case "linux":
      return { file: "notify-send", args: [title, body] };
    case "win32": {
      const aumid =
        "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";
      const script = [
        "$null=[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]",
        "$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
        "$n=$t.GetElementsByTagName('text')",
        "$null=$n.Item(0).AppendChild($t.CreateTextNode($env:AQP_NOTIFY_TITLE))",
        "$null=$n.Item(1).AppendChild($t.CreateTextNode($env:AQP_NOTIFY_BODY))",
        `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${aumid}').Show([Windows.UI.Notifications.ToastNotification]::new($t))`,
      ].join(";");
      return {
        file: "powershell",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-Command",
          script,
        ],
        env: { AQP_NOTIFY_TITLE: title, AQP_NOTIFY_BODY: body },
      };
    }
    default:
      return null;
  }
}

/**
 * Build the sound-playback command for a platform, or `null` where we have no
 * player. The bundled asset is 16-bit PCM WAV because that's the lowest common
 * denominator: `Media.SoundPlayer` (Windows) plays *only* WAV, and `paplay`
 * won't take MP3.
 *
 * Linux has no single guaranteed player, so `paplay` (PulseAudio/PipeWire)
 * falls back to `aplay` (ALSA).
 */
export function soundPlayCommand(
  platform: NodeJS.Platform,
  soundPath: string
): SpawnSpec | null {
  switch (platform) {
    case "darwin":
      return { file: "afplay", args: [soundPath] };
    case "linux":
      return {
        file: "paplay",
        args: [soundPath],
        fallback: { file: "aplay", args: ["-q", soundPath] },
      };
    case "win32":
      return {
        file: "powershell",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-Command",
          "(New-Object Media.SoundPlayer $env:AQP_SOUND_PATH).PlaySync()",
        ],
        env: { AQP_SOUND_PATH: soundPath },
      };
    default:
      return null;
  }
}

/**
 * The single bundled cue, relative to the extension root. One sound for every
 * announced status: the sound's only job is "look at me", and per-status
 * variants asked the user to learn a vocabulary for information the toast
 * already spells out.
 */
export const SOUND_FILE_DEFAULT = "media/sounds/notif.wav";

/**
 * The notification message + button label for a status change. Returns `null`
 * only for `running` (no toast). `finished` and `waiting` render as info
 * toasts; `failed` renders as an error toast (the caller switches severity).
 *
 * Copy: `<glyph> <agent> <verb> · <repo>` — e.g. "✓ Claude finished · my-app".
 * The status glyph leads (VS Code toasts can't carry a per-agent icon; only the
 * fixed severity icon), and the repo name disambiguates the same agent running
 * across several repos now that hooks are global. `repo` is omitted when empty.
 * For `failed`, the exit code (when known from the exit-status poller) is
 * appended: "✗ Claude crashed · my-app · exit 130".
 */
export function notificationMessage(
  agentName: string,
  status: LifecycleStatus,
  repo?: string,
  exitCode?: number
): { text: string; action: string } | null {
  const suffix = repo && repo.trim() !== "" ? ` · ${repo.trim()}` : "";
  switch (status) {
    case "finished":
      return { text: `${STATUS_GLYPH.finished} ${agentName} finished${suffix}`, action: "Show" };
    case "waiting":
      return { text: `${STATUS_GLYPH.waiting} ${agentName} needs your input${suffix}`, action: "Show" };
    case "failed": {
      const codeSuffix =
        typeof exitCode === "number" ? `${suffix} · exit ${exitCode}` : suffix;
      return { text: `${STATUS_GLYPH.failed} ${agentName} crashed${codeSuffix}`, action: "Show" };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP lifecycle server (VS Code-coupled)
// ---------------------------------------------------------------------------

/**
 * Start a localhost HTTP server that receives hook payloads from agent hooks.
 * Each window's extension host gets its own server on a random port; agent
 * terminals are injected with the URL via `createTerminal({ env })`.
 *
 * The returned `url` resolves only once the socket is actually listening —
 * `server.address()` is `null` synchronously after `listen()`, so reading it
 * inline yields port 0 and a broken `http://127.0.0.1:0` that no hook can
 * reach. Callers must `await` `url` before injecting it into terminals.
 *
 * @param onEvent called for each valid payload received
 * @returns a `dispose()` (synchronous) and a `url` promise that resolves with
 *          the bound `http://127.0.0.1:<port>` once listening.
 */
export function startLifecycleServer(
  onEvent: (payload: HookPayload) => void
): { url: Promise<string>; dispose: () => void } {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      // Guard against unbounded payloads (hooks are tiny).
      if (body.length > 65536) {
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body) as HookPayload;
        if (payload && typeof payload === "object") {
          onEvent(payload);
        }
      } catch {
        // Malformed payload — ignore.
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    req.on("error", () => {
      // Connection errors are non-fatal.
    });
  });

  // Listen on a random port on localhost. The port isn't known until the
  // 'listening' event fires (listen() returns before the socket is bound), so
  // resolve the URL from inside the callback rather than reading
  // server.address() synchronously — that would yield port 0.
  const url = new Promise<string>((resolve, reject) => {
    server.once("listening", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
    server.once("error", reject);
  });
  server.listen(0, "127.0.0.1");

  return {
    url,
    dispose: () => {
      try {
        server.closeAllConnections?.();
      } catch {
        // closeAllConnections may not exist on older Node; fall through.
      }
      server.close();
    },
  };
}

/** A terminal whose process has exited, reported by {@link pollExitStatuses}. */
export interface PolledExit {
  status: "finished" | "failed";
  /** The raw exit code from `vscode.Terminal.exitStatus`, when available. */
  exitCode?: number;
}

/**
 * Universal fallback: poll terminal exit statuses for agents that may not have
 * hooks wired (or whose hooks haven't fired yet). Detects process exit only —
 * not "needs input". Called on a ~3s interval from activate().
 *
 * @returns a map of terminal name → {status, exitCode} for terminals whose
 *          process has exited (exitStatus defined) but aren't already marked.
 */
export function pollExitStatuses(
  terminals: readonly vscode.Terminal[],
  sessions: Map<string, SessionState>,
  agentNames: Set<string>
): Map<string, PolledExit> {
  const result = new Map<string, PolledExit>();
  for (const t of terminals) {
    const base = t.name.replace(/ \(\d+\)$/, "");
    if (!agentNames.has(base.toLowerCase())) continue;
    const exit = t.exitStatus;
    if (!exit || exit.code === undefined) continue; // still running
    const prev = sessions.get(t.name);
    // Skip sessions already in a final state (finished/failed). Everything
    // else — including `unknown` (re-adopted after a host reload) — is polled
    // so its real status is discovered once the process has exited.
    if (prev && (prev.status === "finished" || prev.status === "failed")) continue;
    result.set(t.name, {
      status: exit.code === 0 ? "finished" : "failed",
      exitCode: exit.code,
    });
  }
  return result;
}
