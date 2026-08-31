/**
 * Lifecycle adapters for each supported agent.
 *
 * Hooks are installed **globally** (once per agent, into the agent's user-level
 * config), never per-workspace — see the LifecycleAdapter docs in lifecycle.ts.
 *
 * Three mechanisms:
 *  - Claude Code, Droid, and Codex ("command-hooks", Claude schema): identical
 *      JSON shape `{ hooks: { <Event>: [ { hooks: [ { type:"command", command } ] } ] } }`
 *      in `~/.claude/settings.json`, `~/.factory/settings.json`, and
 *      `~/.codex/hooks.json` (Codex ≥ 0.124, where hooks are stable). Adapter
 *      paths are home-relative; the extension joins them with `os.homedir()`.
 *  - Antigravity ("command-hooks", named-registry schema): `hooks.json` maps
 *      *hook names* to definitions — `{ "<name>": { enabled?, <Event>: [...] } }`
 *      — in `~/.gemini/config/hooks.json` (all three AGY flavours read it).
 *      Shares the CommandHookAdapter interface; only the merge/strip internals
 *      differ (see mergeNamedHooks in lifecycle.ts). Events: Stop (payload
 *      distinguishes error / not-idle / finished), PreInvocation (running),
 *      PreToolUse matcher `ask_permission|ask_question` (waiting, with the
 *      reason derived from the tool name).
 *  - OpenCode ("plugin-file"): a self-contained ESM plugin dropped into
 *    OpenCode's config dir under `plugin/`, which OpenCode auto-loads (glob
 *    `{plugin,plugins}/*.{ts,js}`). No JSON config edit needed. The config dir
 *    is resolved per-platform by {@link resolveValidatedOpenCodeConfigDir} (NOT a
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
  type NamedHookEventSpec,
  mergeCommandHooks,
  stripCommandHooks,
  hasCommandHooks,
  hasCurrentCommandHooks,
  mergeNamedHooks,
  stripNamedHooks,
  hasCurrentNamedHooks,
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
// Codex (OpenAI)
// ---------------------------------------------------------------------------

/**
 * Codex CLI. Hooks live in the global `~/.codex/hooks.json` and use the **same
 * nested schema as Claude** (`{ matcher?, hooks: [{ type, command }] }`, one
 * entry array per event). Requires Codex ≥ 0.124, where hooks graduated from
 * the `codex_hooks` feature flag to stable.
 *
 * Events: `Stop` (turn finished), `PermissionRequest` (agent wants a tool or
 * command approved — a *typed* permission signal, so the hook reports the
 * waiting reason directly rather than classifying free text),
 * `UserPromptSubmit` (working again mid-turn).
 * stdin payload: `{ session_id, cwd, hook_event_name, turn_id? }`.
 */
export const CODEX_ADAPTER: CommandHookAdapter = commandHookAdapter(
  "Codex",
  ".codex/hooks.json",
  "agentQuickpick:codex",
  ["Stop", "PermissionRequest", "UserPromptSubmit"]
);

// ---------------------------------------------------------------------------
// Antigravity (named-registry schema)
// ---------------------------------------------------------------------------

/**
 * Create a command-hook adapter for an agent whose hooks file uses
 * Antigravity's **named-registry** schema. Satisfies the same
 * {@link CommandHookAdapter} interface as {@link commandHookAdapter}, so the
 * install/prompt/upgrade/remove plumbing in extension.ts needs no per-agent
 * code — only the merge/strip/detect internals route to the named-registry
 * helpers.
 */
function namedHookAdapter(
  agentName: string,
  configPath: string,
  marker: string,
  hookName: string,
  events: readonly NamedHookEventSpec[]
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
      return mergeNamedHooks(
        parsedConfig,
        hookName,
        events,
        hookUrl,
        session,
        marker,
        portFilePath
      );
    },

    stripHooks(parsedConfig: unknown): unknown {
      return stripNamedHooks(parsedConfig, hookName, marker);
    },

    hasOurHooks(parsedConfig: unknown): boolean {
      return hasCommandHooks(parsedConfig, marker);
    },

    hasCurrentHooks(parsedConfig: unknown): boolean {
      return hasCurrentNamedHooks(parsedConfig, hookName, marker, events);
    },
  };
}

/** The name our hook definition is registered under in Antigravity's hooks.json. */
const ANTIGRAVITY_HOOK_NAME = "agent-quickpick";

/**
 * Antigravity reports its working directory as `workspacePaths[0]` (camelCase
 * common field), not a top-level `cwd`.
 */
const ANTIGRAVITY_CWD_EXPR = "j?.workspacePaths?.[0]";

/**
 * Antigravity CLI (`agy`). Hooks live in the global
 * `~/.gemini/config/hooks.json` under a single named entry.
 *
 * Events:
 *  - `Stop` — the payload itself says how the run ended:
 *    `terminationReason === "error"` → **failed**; `fullyIdle === false`
 *    (background tasks still running) → keep **running**; otherwise
 *    **finished**. Richer than Claude's Stop, which is always "finished".
 *  - `PreInvocation` — before each model call → **running**.
 *  - `PreToolUse` with matcher `ask_permission|ask_question` → **waiting**,
 *    reason derived from `toolCall.name` ("wants a command approved" /
 *    "asked a question").
 *
 * stdin payload (camelCase): `{ conversationId, workspacePaths, toolCall?,
 * terminationReason?, fullyIdle? }`.
 */
const ANTIGRAVITY_EVENTS: readonly NamedHookEventSpec[] = [
  {
    event: "Stop",
    status: "finished",
    spec: {
      statusExpr:
        "j?.terminationReason==='error'?'failed':j?.fullyIdle===false?'running':'finished'",
      cwdExpr: ANTIGRAVITY_CWD_EXPR,
    },
  },
  {
    event: "PreInvocation",
    status: "running",
    spec: { cwdExpr: ANTIGRAVITY_CWD_EXPR },
  },
  {
    event: "PreToolUse",
    matcher: "ask_permission|ask_question",
    status: "waiting",
    spec: {
      reasonExpr:
        "j?.toolCall?.name==='ask_permission'?'permission':j?.toolCall?.name==='ask_question'?'question':undefined",
      cwdExpr: ANTIGRAVITY_CWD_EXPR,
    },
  },
];

export const ANTIGRAVITY_ADAPTER: CommandHookAdapter = namedHookAdapter(
  "Antigravity",
  ".gemini/config/hooks.json",
  "agentQuickpick:antigravity",
  ANTIGRAVITY_HOOK_NAME,
  ANTIGRAVITY_EVENTS
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
 * resolved per-platform at install time by {@link resolveValidatedOpenCodeConfigDir}.
 */
const OPENCODE_PLUGIN_FILE = "plugin/agent-quickpick-lifecycle.js";

/**
 * True when `fsPath` is an absolute path **on the given target platform** —
 * a drive letter on Windows, a leading `/` elsewhere. The target platform is
 * a parameter, not the host's, because hooks are written for agents that run
 * on this machine but the check must match the path shapes each platform's
 * overrides actually produce.
 */
export function isAbsoluteForPlatform(fsPath: string, platform: string): boolean {
  if (platform === "win32") {
    return /^[A-Za-z]:[\\/]/.test(fsPath);
  }
  return fsPath.startsWith("/");
}

/**
 * Resolve OpenCode's config directory across platforms, then verify the result
 * is absolute for the target platform before it is ever joined with the plugin
 * path. OpenCode itself uses `xdg-basedir`, whose effective path is NOT
 * `~/.config` on Windows or when an override is set. Resolution order (matching
 * OpenCode's source):
 *  1. `OPENCODE_CONFIG_DIR` env var — the explicit OpenCode override, always
 *     wins, and must be absolute: a relative value throws rather than being
 *     silently anchored somewhere the user didn't ask for.
 *  2. `XDG_CONFIG_HOME` env var — the XDG override (relative values are
 *     anchored to `homedir`).
 *  3. On Windows: `%APPDATA%` (xdg-basedir's Windows fallback), then
 *     `%LOCALAPPDATA%`, then home — each joined with `opencode`.
 *  4. Otherwise (macOS/Linux): `~/.config/opencode`.
 *
 * Every branch normalizes, so traversal segments in an accepted override are
 * collapsed, and the final absoluteness check guarantees
 * `path.join(result, pluginPath)` cannot be redirected to a relative location.
 * Throws on any violation. Pure (no `vscode` import); the extension feeds it
 * an env snapshot taken at module load.
 */
export function resolveValidatedOpenCodeConfigDir(
  env: NodeJS.ProcessEnv,
  platform: string,
  homedir: string
): string {
  let configDir: string;
  if (env.OPENCODE_CONFIG_DIR) {
    if (!isAbsoluteForPlatform(env.OPENCODE_CONFIG_DIR, platform)) {
      throw new Error("OPENCODE_CONFIG_DIR must be an absolute path");
    }
    configDir = path.normalize(env.OPENCODE_CONFIG_DIR);
  } else if (env.XDG_CONFIG_HOME) {
    const base = isAbsoluteForPlatform(env.XDG_CONFIG_HOME, platform)
      ? env.XDG_CONFIG_HOME
      : path.join(homedir, env.XDG_CONFIG_HOME);
    configDir = path.join(base, "opencode");
  } else if (platform === "win32") {
    const root = env.APPDATA ?? env.LOCALAPPDATA ?? homedir;
    configDir = path.join(root, "opencode");
  } else {
    configDir = path.resolve(path.join(homedir, ".config", "opencode"));
  }
  if (!isAbsoluteForPlatform(configDir, platform)) {
    throw new Error(`Resolved OpenCode config dir is not absolute: ${configDir}`);
  }
  return path.normalize(configDir);
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

async function post(status, reason) {
  try {
    // Only report for sessions Agent Quickpick launched (env injected).
    const session = process.env.AQP_SESSION;
    if (!session) return;
    // 'reason' is undefined for every status except waiting, where it says WHY
    // the agent is blocked (permission vs question) so the UI can say "wants a
    // command approved" instead of a generic "blocked".
    const body = JSON.stringify({ marker: MARKER, session, status, reason, agentName: "OpenCode", cwd: process.cwd() });
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
        post("waiting", "permission");
        break;
      case "question.asked":
        post("waiting", "question");
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
  Codex: CODEX_ADAPTER,
  Antigravity: ANTIGRAVITY_ADAPTER,
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
