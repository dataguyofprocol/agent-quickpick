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

export type LifecycleStatus = "running" | "finished" | "waiting" | "failed";

/**
 * Human labels for each lifecycle status, using Herdr's vocabulary. Shared by
 * the status-bar tooltip and the session quickpick so the two never drift.
 */
export const STATUS_LABEL: Record<LifecycleStatus, string> = {
  running: "working",
  finished: "done",
  waiting: "blocked",
  failed: "failed",
};

/** Compact glyph per status, matching {@link statusBarText}. */
export const STATUS_GLYPH: Record<LifecycleStatus, string> = {
  running: "●",
  finished: "✓",
  waiting: "⏸",
  failed: "✗",
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
  mergeHooks(parsedConfig: unknown, hookUrl: string, session: string): unknown;

  /**
   * Strip *only* our hooks (by {@link BaseAdapter.marker}) from a parsed config
   * object. Idempotent. Must leave user hooks byte-for-byte intact. Prunes an
   * empty `hooks` object if removing ours empties it.
   */
  stripHooks(parsedConfig: unknown): unknown;

  /** True iff our hooks are present in a parsed config. */
  hasOurHooks(parsedConfig: unknown): boolean;
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
  /** Generate the plugin file's source (embeds the hook URL as a fallback). */
  buildSource(hookUrl: string, session: string): string;
}

export type LifecycleAdapter = CommandHookAdapter | PluginFileAdapter;

// ---------------------------------------------------------------------------
// Command-hook helpers (shared by Claude & Droid, which use the same schema)
// ---------------------------------------------------------------------------

/**
 * Generate a self-contained `node -e` command that reads stdin JSON, reads the
 * lifecycle server URL + session name from env, and POSTs a hook payload to the
 * server. Embeds the marker as a comment + payload field so the hook is
 * unambiguously ours.
 *
 * Path-free → survives extension version updates regardless of install path.
 * Uses only Node built-ins (`http`), so it works on any machine with Node.
 */
export function buildNodeHookCommand(
  hookUrl: string,
  session: string,
  marker: string,
  status: LifecycleStatus
): string {
  // Read stdin (the agent pipes JSON event data), then POST to our server.
  // The command is a single line so it embeds cleanly in a JSON string value.
  const body = JSON.stringify({ marker, session, status });
  // Inline-escape for a double-quoted JSON string value.
  const escapedUrl = hookUrl.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const escapedBody = body.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  // Guard first: this hook is installed globally, so it runs on *every* Stop/
  // Notification for this agent — even sessions we didn't launch. When
  // AQP_SESSION is absent (not one of ours), exit immediately: a no-op, no
  // socket, no dead-port noise.
  return `node -e "if(!process.env.AQP_SESSION){process.exit(0)}const h=require('http'),u=process.env.AQP_HOOK_URL||'${escapedUrl}';let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d||'{}');const b=JSON.stringify({marker:'${marker}',session:process.env.AQP_SESSION||'${session}',status:'${status}',agentName:'${marker.split(':')[1]||''}'});const r=h.request(u,{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(b)}});r.setTimeout(2000,()=>r.destroy());r.on('error',()=>{});r.end(b)}catch{}})"`;
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
 * Merge our command hooks into a Claude/Droid-style config for a given event.
 * Schema: `{ hooks: { <Event>: [ { matcher?, hooks: [ { type, command } ] } ] } }`.
 *
 * This is used by both the Claude and Droid adapters (identical schema). We keep
 * it here so the merge/strip logic is tested once and shared.
 */
export function mergeCommandHooks(
  parsedConfig: unknown,
  events: readonly string[],
  hookUrl: string,
  session: string,
  marker: string
): unknown {
  const config = cloneObject(parsedConfig);
  const hooksSection = cloneObject(config.hooks);

  for (const event of events) {
    const arr = Array.isArray(hooksSection[event])
      ? [...(hooksSection[event] as unknown[])]
      : [];

    // Avoid duplicates: skip if one of our hooks for this event+marker exists.
    const already = arr.some(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        JSON.stringify(entry).includes(marker)
    );
    if (!already) {
      // One entry per lifecycle status we care about for this event.
      const statuses = statusesForEvent(event);
      for (const status of statuses) {
        const command = buildNodeHookCommand(hookUrl, session, marker, status);
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
 * Strip our command hooks (by marker) from a Claude/Droid-style config.
 * Idempotent. Prunes an empty `hooks` section.
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

    const filtered = arr.filter(
      (entry) =>
        !(entry && typeof entry === "object" && JSON.stringify(entry).includes(marker))
    );
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
 * Check whether our command hooks (by marker) exist in a config.
 */
export function hasCommandHooks(parsedConfig: unknown, marker: string): boolean {
  if (!parsedConfig || typeof parsedConfig !== "object") return false;
  return JSON.stringify(parsedConfig).includes(marker);
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
  };
  for (const s of states) {
    counts[s.status]++;
  }
  return counts;
}

/**
 * Render the status-bar item text. All-zero → the static default (preserves
 * pre-lifecycle behavior). Otherwise a compact live count:
 * `$(agent-quickpick) 2● 1✓ 1⏸ 1✗` (only non-zero groups shown).
 */
export function statusBarText(counts: Record<LifecycleStatus, number>): string {
  const glyph = "$(agent-quickpick)";
  const parts: string[] = [];
  if (counts.running > 0) parts.push(`${counts.running}●`);
  if (counts.finished > 0) parts.push(`${counts.finished}✓`);
  if (counts.waiting > 0) parts.push(`${counts.waiting}⏸`);
  if (counts.failed > 0) parts.push(`${counts.failed}✗`);

  if (parts.length === 0) {
    return `${glyph} Agent`;
  }
  return `${glyph} ${parts.join(" ")}`;
}

/**
 * Render the status-bar tooltip: a per-session list, most-recently-changed
 * first. Empty → a generic description.
 */
export function statusBarTooltip(states: SessionState[]): string {
  if (states.length === 0) {
    return "Agent Quickpick — running agents";
  }
  const sorted = [...states].sort((a, b) => b.changedAt - a.changedAt);
  return sorted.map((s) => `${s.name} — ${STATUS_LABEL[s.status]}`).join("\n");
}

/**
 * Whether a notification toast should fire for this status. Suppressed when the
 * terminal is already focused (the user is looking at it) or the setting is off.
 * Fires on `finished`, `waiting`, and `failed` — not on `running` (too noisy).
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
  return status === "finished" || status === "waiting" || status === "failed";
}

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
    if (prev && prev.status !== "running") continue; // already tracked
    result.set(t.name, {
      status: exit.code === 0 ? "finished" : "failed",
      exitCode: exit.code,
    });
  }
  return result;
}
