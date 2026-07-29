/**
 * Lifecycle adapters for each supported agent.
 *
 * Hooks are installed **globally** (once per agent, into the agent's user-level
 * config), never per-workspace — see the LifecycleAdapter docs in lifecycle.ts.
 *
 * Two mechanisms:
 *  - Claude Code and Droid ("command-hooks"): identical JSON schema
 *      { hooks: { <Event>: [ { hooks: [ { type:"command", command } ] } ] } }
 *    installed into `~/.claude/settings.json` and `~/.factory/settings.json`.
 *    Adapter paths are home-relative; the extension joins them with
 *    `os.homedir()`.
 *  - OpenCode ("plugin-file"): a self-contained ESM plugin dropped into
 *    OpenCode's config dir under `plugin/`, which OpenCode auto-loads (glob
 *    `{plugin,plugins}/*.{ts,js}`). No JSON config edit needed. The config dir
 *    is resolved per-platform by {@link resolveOpenCodeConfigDir} (NOT a
 *    hardcoded `~/.config/opencode`, which is wrong on Windows and ignores
 *    `OPENCODE_CONFIG_DIR`); the extension joins the resolved dir with
 *    {@link OPENCODE_ADAPTER.pluginPath}.
 */

import * as path from "path";
import {
  type LifecycleAdapter,
  type CommandHookAdapter,
  type PluginFileAdapter,
  type LifecycleStatus,
  mergeCommandHooks,
  stripCommandHooks,
  hasCommandHooks,
  hasCurrentCommandHooks,
} from "./lifecycle";

// ---------------------------------------------------------------------------
// Shared command-hook adapter factory (Claude & Droid)
// ---------------------------------------------------------------------------

/**
 * Create a command-hook adapter for an agent that uses the Claude/Droid hook
 * schema. The only per-agent differences are the name, config path, marker,
 * and which events to wire.
 */
function commandHookAdapter(
  agentName: string,
  configPath: string,
  marker: string,
  events: readonly string[]
): CommandHookAdapter {
  return {
    kind: "command-hooks",
    agentName,
    configPath,
    marker,

    mergeHooks(
      parsedConfig: unknown,
      hookUrl: string,
      session: string,
      portFilePath: string
    ): unknown {
      return mergeCommandHooks(
        parsedConfig,
        events,
        hookUrl,
        session,
        marker,
        portFilePath
      );
    },

    stripHooks(parsedConfig: unknown): unknown {
      return stripCommandHooks(parsedConfig, marker);
    },

    hasOurHooks(parsedConfig: unknown): boolean {
      return hasCommandHooks(parsedConfig, marker);
    },

    hasCurrentHooks(parsedConfig: unknown): boolean {
      return hasCurrentCommandHooks(parsedConfig, marker, events);
    },
  };
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

/**
 * Claude Code. Hooks live in the global `~/.claude/settings.json`.
 *
 * Events: `Stop` (turn finished), `Notification` (needs input/permission),
 * `UserPromptSubmit` (user sent a new message → agent is working again, so the
 * status bar reflects reality mid-turn instead of staying on "done").
 * stdin payload: `{ session_id, hook_event_name, message?, cwd }`.
 */
export const CLAUDE_ADAPTER: CommandHookAdapter = commandHookAdapter(
  "Claude",
  ".claude/settings.json",
  "agentQuickpick:claude",
  ["Stop", "Notification", "UserPromptSubmit"]
);

// ---------------------------------------------------------------------------
// Droid (Factory)
// ---------------------------------------------------------------------------

/**
 * Droid. Hooks live in the global `~/.factory/settings.json`. Uses the **same
 * schema as Claude**.
 *
 * Events: `Stop` (turn finished), `Notification` (needs input),
 * `UserPromptSubmit` (user sent a new message → agent is working again).
 * stdin payload: `{ session_id, hook_event_name }`.
 */
export const DROID_ADAPTER: CommandHookAdapter = commandHookAdapter(
  "Droid",
  ".factory/settings.json",
  "agentQuickpick:droid",
  ["Stop", "Notification", "UserPromptSubmit"]
);

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

const OPENCODE_PLUGIN_MARKER = "agentQuickpick:opencode";

/**
 * The plugin file's path, relative to OpenCode's **config dir** (NOT home).
 * OpenCode auto-loads any `{plugin,plugins}/*.{ts,js}` under its config dir, so
 * dropping this file there wires OpenCode globally with no JSON edit. The
 * `.js` extension (not `.mjs`) matches OpenCode's discovery glob; the file is
 * ESM and loaded via `pathToFileURL` + dynamic import. The config dir itself is
 * resolved per-platform at install time by {@link resolveOpenCodeConfigDir}.
 */
const OPENCODE_PLUGIN_FILE = "plugin/agent-quickpick-lifecycle.js";

/**
 * Resolve OpenCode's config directory across platforms. OpenCode itself uses
 * `xdg-basedir`, whose effective path is NOT `~/.config` on Windows or when an
 * override is set. Resolution order (matching OpenCode's source):
 *  1. `OPENCODE_CONFIG_DIR` env var — the explicit OpenCode override, always wins.
 *  2. `XDG_CONFIG_HOME` env var — the XDG override.
 *  3. On Windows: `%APPDATA%` (xdg-basedir's Windows fallback), then
 *     `%LOCALAPPDATA%`, then home — each joined with `opencode`.
 *  4. Otherwise (macOS/Linux): `~/.config/opencode`.
 *
 * The extension joins the result with {@link OPENCODE_ADAPTER.pluginPath}.
 */
export function resolveOpenCodeConfigDir(
  env: NodeJS.ProcessEnv,
  platform: string,
  homedir: string
): string {
  if (env.OPENCODE_CONFIG_DIR) return env.OPENCODE_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, "opencode");
  if (platform === "win32") {
    const root = env.APPDATA ?? env.LOCALAPPDATA ?? homedir;
    return path.join(root, "opencode");
  }
  return path.join(homedir, ".config", "opencode");
}

/**
 * Generate the OpenCode plugin source. Self-contained — reads the hook URL +
 * session from the env we inject per-terminal (the hook URL falls back to the
 * baked-in constant when `AQP_HOOK_URL` is absent), and POSTs to our server on
 * each lifecycle event. No-ops when `AQP_SESSION` is absent (an OpenCode
 * session we didn't launch), so the global plugin is inert everywhere except
 * the terminals we spawn.
 *
 * The `session` argument is accepted to satisfy the {@link LifecycleAdapter}
 * interface but isn't baked into the source — OpenCode reads it from
 * `AQP_SESSION` at runtime (unlike command-hook agents, where the session is
 * part of the emitted hook command).
 *
 * Uses dynamic `import("node:http")` rather than `require()` so the plugin is
 * valid under plain Node ESM as well as Bun (OpenCode's runtime). Bare
 * `require` is not defined in ESM under Node and would throw at module load,
 * permanently blacklisting the plugin for the session.
 */
export function buildOpenCodePluginSource(
  hookUrl: string,
  // Intentionally unused: see the JSDoc above.
  _session: string,
  portFilePath: string
): string {
  // Embed the marker so the file is unambiguously ours. Always regenerated
  // unconditionally on install/auto-upgrade (see installHook in extension.ts),
  // so there's no separate version tag to detect here — the file is simply
  // always current.
  return `// ${OPENCODE_PLUGIN_MARKER}
// Installed by Agent Quickpick. Remove via the "Remove Lifecycle Hooks" command
// or by deleting this file.
const HOOK_URL = ${JSON.stringify(hookUrl)};
const PORT_FILE_PATH = ${JSON.stringify(portFilePath)};
const MARKER = ${JSON.stringify(OPENCODE_PLUGIN_MARKER)};

async function post(status) {
  try {
    // Only report for sessions Agent Quickpick launched (env injected).
    const session = process.env.AQP_SESSION;
    if (!session) return;
    const body = JSON.stringify({ marker: MARKER, session, status, agentName: "OpenCode", cwd: process.cwd() });
    // Resolution order: the port file (rewritten with the current port on
    // every extension activation) → the frozen per-terminal env var (stale
    // after a restart) → the URL baked in at install time. Checking the file
    // first means a session launched before an extension restart still
    // reaches the new server, no relaunch needed.
    const fs = await import("node:fs");
    let fileUrl;
    try {
      fileUrl = JSON.parse(fs.readFileSync(PORT_FILE_PATH, "utf8")).url;
    } catch {}
    const u = new URL(fileUrl || process.env.AQP_HOOK_URL || HOOK_URL);
    const lib = await (u.protocol === "https:" ? import("node:https") : import("node:http"));
    await new Promise((resolve) => {
      const r = lib.request(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname,
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        },
        (res) => {
          // Drain so the socket can be reused/freed; resolve on end.
          res.on("data", () => {});
          res.on("end", resolve);
        }
      );
      r.setTimeout(2000, () => { r.destroy(); resolve(undefined); });
      r.on("error", () => resolve(undefined));
      r.end(body);
    });
  } catch {}
}

export const AgentQuickpickLifecyclePlugin = async () => ({
  event: async ({ event }) => {
    const type = event?.type;
    switch (type) {
      case "session.idle":
        post("finished");
        break;
      case "permission.asked":
      case "question.asked":
        post("waiting");
        break;
      case "session.error":
        post("failed");
        break;
      case "tool.execute.before":
      case "tool.execute.after":
      case "chat.message":
        post("running");
        break;
      default:
        break;
    }
  },
});
`;
}

export const OPENCODE_ADAPTER: PluginFileAdapter = {
  kind: "plugin-file",
  agentName: "OpenCode",
  marker: OPENCODE_PLUGIN_MARKER,
  pluginPath: OPENCODE_PLUGIN_FILE,
  buildSource: buildOpenCodePluginSource,
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * All lifecycle-aware adapters, keyed by agent display name (case-insensitive).
 * Matches the `name` field in BUILTIN_AGENTS.
 */
export const LIFECYCLE_ADAPTERS: Record<string, LifecycleAdapter> = {
  Claude: CLAUDE_ADAPTER,
  Droid: DROID_ADAPTER,
  OpenCode: OPENCODE_ADAPTER,
};

// Lowercased index so {@link getAdapter} / {@link isLifecycleAgent} honor their
// case-insensitive contract regardless of how a user spelled an agent name in
// their config (e.g. "claude" vs "Claude"). Frecency and install-detection
// already normalize via toLowerCase(); this keeps the lifecycle path consistent.
const LIFECYCLE_ADAPTERS_BY_LOWER_NAME: Record<string, LifecycleAdapter> =
  Object.fromEntries(
    Object.entries(LIFECYCLE_ADAPTERS).map(([name, adapter]) => [
      name.toLowerCase(),
      adapter,
    ])
  );

/**
 * Look up an adapter by agent name (case-insensitive). Returns undefined if the
 * agent has no lifecycle adapter.
 */
export function getAdapter(agentName: string): LifecycleAdapter | undefined {
  return LIFECYCLE_ADAPTERS_BY_LOWER_NAME[agentName.toLowerCase()];
}

/** True if an agent has a lifecycle adapter (case-insensitive). */
export function isLifecycleAgent(agentName: string): boolean {
  return agentName.toLowerCase() in LIFECYCLE_ADAPTERS_BY_LOWER_NAME;
}
