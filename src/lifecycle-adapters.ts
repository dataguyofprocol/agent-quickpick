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
 *  - pi ("plugin-file"): a self-contained ESM extension dropped into pi's
 *    `extensions/` dir, which pi auto-loads (no JSON config surface exists).
 *    The agent dir is resolved by {@link resolveValidatedPiAgentDir}, honoring
 *    `PI_CODING_AGENT_DIR`. pi's own status signals are weaker than Claude's:
 *    `agent_settled` (not `agent_end`) is the turn boundary, and "waiting"
 *    comes from `ui_prompt_start`/`ui_prompt_end` plus a name sniff on pi's
 *    ask-the-user tool, since pi has no per-tool permission dialog.
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
  HOOK_TIMEOUT_MS,
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

/**
 * The self-contained `post(status, reason)` body shared verbatim by the two
 * generated plugin files (OpenCode + pi) — one canonical copy so the two
 * surfaces can't drift. Interpolates the agent name and the shared
 * {@link HOOK_TIMEOUT_MS} socket timeout.
 */
function postSource(agentName: string): string {
  return `async function post(status, reason) {
  try {
    // Only report for sessions Agent Quickpick launched (env injected).
    const session = process.env.AQP_SESSION;
    if (!session) return;
    // 'reason' is undefined for every status except waiting, where it says WHY
    // the agent is blocked (permission vs question) so the UI can say "wants a
    // command approved" instead of a generic "blocked".
    const body = JSON.stringify({ marker: MARKER, session, status, reason, agentName: ${JSON.stringify(
      agentName
    )}, cwd: process.cwd() });
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
      r.setTimeout(${HOOK_TIMEOUT_MS}, () => { r.destroy(); resolve(undefined); });
      r.on("error", () => resolve(undefined));
      r.end(body);
    });
  } catch {}
}`;
}

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

${postSource("OpenCode")}

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
  resolveBaseDir: resolveValidatedOpenCodeConfigDir,
};

// ---------------------------------------------------------------------------
// pi (@earendil-works/pi-coding-agent)
// ---------------------------------------------------------------------------

/** Marker embedded in the generated pi extension so the file is provably ours. */
const PI_EXTENSION_MARKER = "agentQuickpick:pi";

/**
 * Bumped when the generated pi extension's *shape* changes. Purely
 * informational for a human reading the installed file (and for anyone
 * diagnosing a stale install by hand): plugin-file installs are regenerated
 * unconditionally on every `installHook`, so nothing detects this value.
 */
const PI_INTEGRATION_VERSION = 1;

/**
 * Where the extension lands, relative to pi's agent dir. pi auto-loads
 * `extensions/*.{ts,js}`, and an `index.{ts,js}` one directory deeper —
 * `.js`, not `.mjs`, because the loader only recognizes those two extensions;
 * `.js` also means the exact generated bytes are importable by plain Node in
 * the unit tier (pi loads them through jiti, which accepts ESM in `.js`).
 */
const PI_EXTENSION_FILE = "extensions/agent-quickpick-lifecycle.js";

/**
 * Resolve pi's agent dir, then verify the result is absolute for the target
 * platform before it is ever joined with the extension path. Mirrors pi's own
 * `getAgentDir()` (`dist/config.js`):
 *  1. `PI_CODING_AGENT_DIR` — pi's explicit override, tilde-expanded exactly as
 *     pi expands it (`~`, `~/x`, and on Windows `~\x`). A *relative* override
 *     throws rather than being silently anchored somewhere the user didn't ask
 *     for (same posture as `OPENCODE_CONFIG_DIR`).
 *  2. Otherwise `<home>/.pi/agent`. pi has no XDG lookup and no Windows branch,
 *     so neither does this.
 *
 * Every branch normalizes, so traversal segments in an accepted override are
 * collapsed. Pure (no `vscode` import); the extension feeds it an env snapshot
 * taken at module load.
 */
export function resolveValidatedPiAgentDir(
  env: NodeJS.ProcessEnv,
  platform: string,
  homedir: string
): string {
  let agentDir: string;
  const override = env.PI_CODING_AGENT_DIR;
  if (override) {
    // pi expands a leading `~` itself, so an override of "~/x" is legal even
    // though it isn't absolute as written. Expand first, validate after.
    const expanded =
      override === "~"
        ? homedir
        : override.startsWith("~/") || (platform === "win32" && override.startsWith("~\\"))
          ? path.join(homedir, override.slice(2))
          : override;
    if (!isAbsoluteForPlatform(expanded, platform)) {
      throw new Error("PI_CODING_AGENT_DIR must be an absolute path");
    }
    agentDir = path.normalize(expanded);
  } else {
    agentDir = path.normalize(path.join(homedir, ".pi", "agent"));
  }
  if (!isAbsoluteForPlatform(agentDir, platform)) {
    throw new Error(`Resolved pi agent dir is not absolute: ${agentDir}`);
  }
  return agentDir;
}

/**
 * Generate the pi extension source. Same envelope, URL-resolution order, and
 * `AQP_SESSION` inertness guard as {@link buildOpenCodePluginSource} — see its
 * doc comment; `session` is likewise accepted only to satisfy the interface and
 * read from the env at runtime instead.
 *
 * pi differs from OpenCode in three ways that shape the generated code, each
 * learned from an existing OSS pi integration (herdr, cmux, orca):
 *  - **Mode gate.** pi runs the same extension in `tui`, `rpc`, `json`, and
 *    `print` modes; only `tui` is a terminal a user is watching, and `rpc`
 *    still reports `hasUI: true`, so `ctx.mode` is the only reliable gate.
 *  - **`ctx.isIdle()` can throw** once a session-switching modal invalidates
 *    the runner (it calls `assertActive` internally), so every call is wrapped
 *    and our own turn tracking is the floor, not the fallback.
 *  - **`agent_end` is not a turn boundary** — retries, auto-compaction, and
 *    queued follow-ups run after it. `agent_settled` is authoritative, and
 *    `agent_end` is only honoured as a boundary while we have never seen an
 *    `agent_settled` (older pi builds don't emit it).
 */
export function buildPiExtensionSource(
  hookUrl: string,
  // Intentionally unused: see the JSDoc above.
  _session: string,
  portFilePath: string
): string {
  return `// @ts-nocheck
// ${PI_EXTENSION_MARKER}
// AQP_PI_INTEGRATION_VERSION=${PI_INTEGRATION_VERSION}
// Installed by Agent Quickpick, and overwritten whenever it updates. Put your
// own pi extensions in sibling files rather than editing this one; remove it
// via the "Remove Lifecycle Hooks" command or by deleting the file.
const HOOK_URL = ${JSON.stringify(hookUrl)};
const PORT_FILE_PATH = ${JSON.stringify(portFilePath)};
const MARKER = ${JSON.stringify(PI_EXTENSION_MARKER)};

// Tools that block on a human answer. pi has no per-tool permission dialog, so
// its own ask-the-user tool is the main way a turn stalls on the user; a name
// sniff is the only signal available (orca does the same, and paseo turns the
// same tool into a first-class permission request).
const ASK_TOOL_NAMES = new Set(["ask_user", "ask_user_question", "ask"]);

${postSource("pi")}

export default function (pi) {
  // Nothing here may start a timer, socket, or watcher: pi loads every
  // extension in-process on every run, in every repo, and documents the
  // factory as side-effect free.
  let tui = false;
  let turnInFlight = false;
  let promptDepth = 0;
  let askTools = 0;
  let settledSupported = false;

  // Serial FIFO with a collapse rule, not fire-and-forget: pi emits a
  // tool_execution_start per tool, and unawaited POSTs can land out of order —
  // a stale "running" arriving after "finished" would leave the status bar
  // wrong until the next event. Consecutive "running" reports collapse into
  // one; a terminal status is never dropped, only queued behind what preceded
  // it.
  const pending = [];
  let lastQueued;
  let draining = false;

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (pending.length > 0) {
        const next = pending.shift();
        await post(next.status, next.reason);
      }
    } finally {
      draining = false;
    }
  }

  function report(status, reason) {
    if (!tui) return;
    // Collapse against the last status queued, not the queue tail: by the time
    // the second tool of a burst starts, the first "running" has usually
    // already been shifted off for delivery.
    if (status === "running" && lastQueued === "running") return;
    lastQueued = status;
    pending.push({ status, reason });
    void drain();
  }

  // "tui" latches on the first ctx that reports it. A ctx without a mode (an
  // older build, or a handler pi calls with no context) neither enables nor
  // disables reporting — it inherits whatever session_start established.
  function gate(ctx) {
    const mode = ctx && ctx.mode;
    if (typeof mode === "string") tui = mode === "tui";
    return tui;
  }

  // undefined when pi cannot answer (a modal invalidated the runner, so
  // isIdle() throws). Callers must treat undefined as "no new information".
  function idle(ctx) {
    try {
      const v = ctx && typeof ctx.isIdle === "function" ? ctx.isIdle() : undefined;
      return typeof v === "boolean" ? v : undefined;
    } catch {
      return undefined;
    }
  }

  function blocked() {
    return promptDepth > 0 || askTools > 0;
  }

  pi.on("session_start", (_event, ctx) => {
    if (!gate(ctx)) return;
    // /reload can swap this extension in mid-turn without a fresh agent_start,
    // and /new, /resume and /fork rebind the session in place — so resync from
    // pi rather than assuming an idle start.
    promptDepth = 0;
    askTools = 0;
    turnInFlight = idle(ctx) === false;
    if (turnInFlight) report("running");
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (!gate(ctx)) return;
    turnInFlight = true;
    report("running");
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!gate(ctx)) return;
    turnInFlight = true;
    report("running");
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (!gate(ctx)) return;
    turnInFlight = true;
    if (event && ASK_TOOL_NAMES.has(event.toolName)) {
      askTools += 1;
      report("waiting", "question");
      return;
    }
    report("running");
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (!gate(ctx)) return;
    if (!event || !ASK_TOOL_NAMES.has(event.toolName)) return;
    askTools = Math.max(0, askTools - 1);
    if (!blocked()) report("running");
  });

  // Depth-counted, not a boolean: prompts nest (an extension can prompt from
  // inside another prompt's handler), and only the outermost transition is a
  // change in what the user sees.
  pi.on("ui_prompt_start", (event, ctx) => {
    if (!gate(ctx)) return;
    promptDepth += 1;
    if (promptDepth > 1) return;
    // "confirm" is the yes/no shape pi's permission-style extensions use;
    // every other kind is a question needing an actual answer.
    report("waiting", event && event.kind === "confirm" ? "permission" : "question");
  });

  pi.on("ui_prompt_end", (_event, ctx) => {
    if (!gate(ctx)) return;
    if (promptDepth === 0) return;
    promptDepth -= 1;
    if (blocked()) return;
    // A definite answer from pi wins; our own turn tracking is the floor for
    // when pi can't answer, since with no turn in flight nothing later will
    // arrive to correct an optimistic "running".
    const answer = idle(ctx);
    const isIdle = answer === undefined ? !turnInFlight : answer;
    if (isIdle) {
      turnInFlight = false;
      report("finished");
    } else {
      report("running");
    }
  });

  pi.on("message_end", (event, ctx) => {
    if (!gate(ctx)) return;
    const message = event && event.message;
    if (!message || message.role !== "assistant") return;
    if (message.stopReason === "error") {
      turnInFlight = false;
      report("failed");
    }
  });

  pi.on("agent_end", (event, ctx) => {
    if (!gate(ctx)) return;
    // A run can end with a retry, compaction, or queued follow-up still to
    // come; agent_settled is the authoritative boundary. Honour agent_end only
    // while this pi build has never emitted one.
    if (settledSupported) return;
    if (event && (event.willContinue === true || event.willRetry === true)) return;
    if (idle(ctx) === false) return;
    if (blocked()) return;
    turnInFlight = false;
    report("finished");
  });

  pi.on("agent_settled", (_event, ctx) => {
    settledSupported = true;
    if (!gate(ctx)) return;
    if (idle(ctx) === false) return;
    if (blocked()) return;
    turnInFlight = false;
    report("finished");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (!gate(ctx)) return;
    // Reset only, deliberately no report. pi tears an open dialog down without
    // resolving its promise, so a replaced session never emits the matching
    // ui_prompt_end and a "waiting" would stick forever. Shutdown is also not a
    // turn boundary — it fires on /new, /resume and /fork — and real process
    // exit is already covered by the host's exit-status poller, which knows the
    // exit code as well.
    promptDepth = 0;
    askTools = 0;
    turnInFlight = false;
  });
}
`;
}

export const PI_ADAPTER: PluginFileAdapter = {
  kind: "plugin-file",
  agentName: "pi",
  marker: PI_EXTENSION_MARKER,
  pluginPath: PI_EXTENSION_FILE,
  buildSource: buildPiExtensionSource,
  resolveBaseDir: resolveValidatedPiAgentDir,
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
  pi: PI_ADAPTER,
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
