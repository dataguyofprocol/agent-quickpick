/**
 * Removal of hooks and plugins installed by *older* versions of Agent Quickpick.
 *
 * Status no longer depends on anything being installed — agents report their own
 * state with `OSC 7501` (see `./program-status`) and heuristics cover the rest
 * (see `./detect-manifests`). But earlier releases wrote hooks into six agent
 * configs, and those hooks spawn a `node` process on every agent turn. Leaving
 * them behind would be worse than the feature they provided, so this module
 * exists solely to *strip* them.
 *
 * Nothing here installs anything, so the merge/report/plugin-source half of the
 * old adapter layer is gone. What remains is the tested removal path plus the
 * marker/path facts needed to find what to remove.
 *
 * Marker-scoped removal is the safety contract: only hooks whose command carries
 * our marker are ever deleted, and a plugin file is only ever unlinked when its
 * own contents prove we wrote it. A user's own hook or same-named plugin
 * survives every path through this file.
 */

import * as path from "path";

/** True when `fsPath` is absolute **on the given target platform**. */
export function isAbsoluteForPlatform(fsPath: string, platform: string): boolean {
  if (platform === "win32") return /^[A-Za-z]:[\\/]/.test(fsPath);
  return fsPath.startsWith("/");
}

// ---------------------------------------------------------------------------
// JSON config helpers
// ---------------------------------------------------------------------------

/** Parse a JSON config, tolerating missing/malformed/non-object input → `{}`. */
export function readConfigJson(text: string): unknown {
  if (typeof text !== "string" || text.trim() === "") return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Pretty-print a config as 2-space JSON with a trailing newline. */
export function writeConfigJson(parsed: unknown): string {
  return JSON.stringify(parsed, null, 2) + "\n";
}

/** Shallow-clone an object-typed config value; non-objects → `{}`. */
function cloneObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  return {};
}

// ---------------------------------------------------------------------------
// Command-hook strip (Claude/Droid/Codex nested schema, Antigravity named)
// ---------------------------------------------------------------------------

/** `{ type: "command", command }` → the command string, else undefined. */
function hookCommand(hook: unknown): string | undefined {
  if (!hook || typeof hook !== "object") return undefined;
  const command = (hook as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
}

/** True when this hook object is one of ours (any schema version). */
function isOurHook(hook: unknown, marker: string): boolean {
  return hookCommand(hook)?.includes(marker) ?? false;
}

/**
 * Rewrite each entry's inner `hooks` array with `keepHook`, dropping only
 * entries our filtering left empty. Entries with no hook of ours — and any other
 * keys they carry, such as `matcher` — pass through untouched, so a user hook
 * sharing an entry with ours survives.
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
      result.push(entry);
      continue;
    }
    const kept = hooks.filter((h) => !isOurHook(h, marker) || keepHook(h));
    if (kept.length === 0) continue;
    result.push({ ...record, hooks: kept });
  }
  return result;
}

/** True when a config contains one of our command hooks (any version). */
export function hasCommandHooks(parsedConfig: unknown, marker: string): boolean {
  if (!parsedConfig || typeof parsedConfig !== "object") return false;
  const hooksSection = (parsedConfig as Record<string, unknown>).hooks;
  if (!hooksSection || typeof hooksSection !== "object") return false;
  for (const value of Object.values(hooksSection as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const hooks = (entry as Record<string, unknown>).hooks;
      if (Array.isArray(hooks) && hooks.some((h) => isOurHook(h, marker))) return true;
    }
  }
  return false;
}

/**
 * True when a named-registry config (Antigravity) holds one of our commands.
 *
 * `hasCommandHooks` only understands the nested `hooks.<Event>[].hooks[]` shape,
 * so the named shape needs its own detector — without it, an Antigravity hook
 * written by an older version would never be found, and never removed.
 */
export function hasNamedHooks(
  parsedConfig: unknown,
  hookName: string,
  marker: string
): boolean {
  if (!parsedConfig || typeof parsedConfig !== "object") return false;
  const entry = (parsedConfig as Record<string, unknown>)[hookName];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const record = entry as Record<string, unknown>;

  for (const value of Object.values(record)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (isOurHook(item, marker)) return true; // flat handler
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const hooks = (item as Record<string, unknown>).hooks; // matcher entry
        if (Array.isArray(hooks) && hooks.some((h) => isOurHook(h, marker))) return true;
      }
    }
  }
  return false;
}

/**
 * Strip our hooks (by marker, any version) from a Claude/Droid/Codex-shaped
 * config. Idempotent; prunes events and the whole `hooks` section once empty,
 * and leaves events that never contained one of ours byte-for-byte intact.
 */
export function stripCommandHooks(parsedConfig: unknown, marker: string): unknown {
  const config = cloneObject(parsedConfig);
  const hooksSection = cloneObject(config.hooks);

  for (const event of Object.keys(hooksSection)) {
    const arr = hooksSection[event];
    if (!Array.isArray(arr)) continue;
    const hasOurs = arr.some(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        Array.isArray((entry as Record<string, unknown>).hooks) &&
        ((entry as Record<string, unknown>).hooks as unknown[]).some((h) =>
          isOurHook(h, marker)
        )
    );
    if (!hasOurs) continue;

    const filtered = filterEventEntries(arr, marker, () => false);
    if (filtered.length === 0) delete hooksSection[event];
    else hooksSection[event] = filtered;
  }

  if (Object.keys(hooksSection).length === 0) delete config.hooks;
  else config.hooks = hooksSection;
  return config;
}

/**
 * Strip our hook from an Antigravity-shaped `hooks.json` named registry.
 * Removes only commands carrying our marker, from both the matcher-entry and
 * flat-handler shapes, then drops the registry entry once no events remain.
 */
export function stripNamedHooks(
  parsedConfig: unknown,
  hookName: string,
  marker: string
): unknown {
  const config = cloneObject(parsedConfig);
  const entry = config[hookName];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return config;
  const record = { ...(entry as Record<string, unknown>) };

  for (const event of Object.keys(record)) {
    const arr = record[event];
    if (!Array.isArray(arr)) continue;
    const afterEntries = filterEventEntries(arr, marker, () => false);
    const stripped = afterEntries.filter((h) => !isOurHook(h, marker));
    if (stripped.length === 0) delete record[event];
    else record[event] = stripped;
  }

  const hasEvents = Object.keys(record).some((key) => Array.isArray(record[key]));
  if (!hasEvents) delete config[hookName];
  else config[hookName] = record;
  return config;
}

/**
 * True when it is safe to delete a plugin file: only a file whose contents carry
 * the marker we generate is ever ours. `shouldWritePluginFile` has no successor
 * here — this module never writes.
 */
export function shouldRemovePluginFile(existing: string | undefined, marker: string): boolean {
  return existing !== undefined && existing.includes(marker);
}

// ---------------------------------------------------------------------------
// Where older versions installed
// ---------------------------------------------------------------------------

export interface LegacyCommandHookTarget {
  kind: "command-hooks";
  agentName: string;
  marker: string;
  /** Home-relative config path, e.g. `.claude/settings.json`. */
  configPath: string;
  /** `nested` = `hooks.<Event>[].hooks[]`; `named` = a registry entry. */
  schema: "nested" | "named";
  /** Registry key for the `named` schema. */
  hookName?: string;
}

export interface LegacyPluginFileTarget {
  kind: "plugin-file";
  agentName: string;
  marker: string;
  /** Path relative to the resolved base dir. */
  pluginPath: string;
  /** Resolve the absolute base dir from an env snapshot. */
  resolveBaseDir(env: NodeJS.ProcessEnv, platform: string, homedir: string): string;
}

export type LegacyTarget = LegacyCommandHookTarget | LegacyPluginFileTarget;

/** OpenCode's config dir, matching its own `xdg-basedir` resolution order. */
export function resolveOpenCodeConfigDir(
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

/** pi's agent dir, matching its own `getAgentDir()` (including `~` expansion). */
export function resolvePiAgentDir(
  env: NodeJS.ProcessEnv,
  platform: string,
  homedir: string
): string {
  let agentDir: string;
  const override = env.PI_CODING_AGENT_DIR;
  if (override) {
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
  return path.normalize(agentDir);
}

/**
 * Everything older versions of this extension could have installed, and the
 * facts needed to remove it. Keeping this list means the "Remove Lifecycle
 * Hooks" command and the one-time automatic cleanup share one source of truth.
 *
 * This list is not just the agents we ship: Antigravity is no longer a built-in,
 * but a hook an older version wrote into `~/.gemini/config/hooks.json` would
 * otherwise keep spawning a process on every turn forever, so its target stays.
 * Retired agents belong here; new ones do not.
 */
export const LEGACY_TARGETS: readonly LegacyTarget[] = [
  {
    kind: "command-hooks",
    agentName: "Claude",
    marker: "agentQuickpick:claude",
    configPath: ".claude/settings.json",
    schema: "nested",
  },
  {
    kind: "command-hooks",
    agentName: "Droid",
    marker: "agentQuickpick:droid",
    configPath: ".factory/settings.json",
    schema: "nested",
  },
  {
    kind: "command-hooks",
    agentName: "Codex",
    marker: "agentQuickpick:codex",
    configPath: ".codex/hooks.json",
    schema: "nested",
  },
  {
    kind: "command-hooks",
    agentName: "Antigravity",
    marker: "agentQuickpick:antigravity",
    configPath: ".gemini/config/hooks.json",
    schema: "named",
    hookName: "agent-quickpick",
  },
  {
    kind: "plugin-file",
    agentName: "OpenCode",
    marker: "agentQuickpick:opencode",
    pluginPath: "plugin/agent-quickpick-lifecycle.js",
    resolveBaseDir: resolveOpenCodeConfigDir,
  },
  {
    // The OpenCode V2 port of the same plugin, which V2 loads from `plugins/`.
    kind: "plugin-file",
    agentName: "OpenCode",
    marker: "agentQuickpick:opencode",
    pluginPath: "plugins/agent-quickpick-lifecycle.js",
    resolveBaseDir: resolveOpenCodeConfigDir,
  },
  {
    kind: "plugin-file",
    agentName: "pi",
    marker: "agentQuickpick:pi",
    pluginPath: "extensions/agent-quickpick-lifecycle.js",
    resolveBaseDir: resolvePiAgentDir,
  },
];

/** Absolute path a target lives at. */
export function targetPath(
  target: LegacyTarget,
  env: NodeJS.ProcessEnv,
  platform: string,
  homedir: string
): string {
  if (target.kind === "command-hooks") return path.join(homedir, target.configPath);
  return path.join(target.resolveBaseDir(env, platform, homedir), target.pluginPath);
}

/** A user-facing `~/…` path for command hooks, or the absolute path. */
export function displayPath(
  target: LegacyTarget,
  env: NodeJS.ProcessEnv,
  platform: string,
  homedir: string
): string {
  if (target.kind === "command-hooks") return `~/${target.configPath}`;
  return targetPath(target, env, platform, homedir);
}

/** Filesystem access, injected so cleanup is testable without touching disk. */
export interface LegacyIo {
  read(file: string): Promise<string | undefined>;
  write(file: string, text: string): Promise<void>;
  remove(file: string): Promise<void>;
}

/** Strip one target. Returns true when something of ours was actually removed. */
export async function stripTarget(
  target: LegacyTarget,
  io: LegacyIo,
  env: NodeJS.ProcessEnv,
  platform: string,
  homedir: string
): Promise<boolean> {
  const fsPath = targetPath(target, env, platform, homedir);

  if (target.kind === "plugin-file") {
    const existing = await io.read(fsPath);
    if (!shouldRemovePluginFile(existing, target.marker)) return false;
    await io.remove(fsPath);
    return true;
  }

  const text = await io.read(fsPath);
  if (text === undefined) return false;
  const parsed = readConfigJson(text);
  const hookName = target.hookName ?? "agent-quickpick";
  const present =
    target.schema === "named"
      ? hasNamedHooks(parsed, hookName, target.marker)
      : hasCommandHooks(parsed, target.marker);
  if (!present) return false;
  const stripped =
    target.schema === "named"
      ? stripNamedHooks(parsed, hookName, target.marker)
      : stripCommandHooks(parsed, target.marker);
  await io.write(fsPath, writeConfigJson(stripped));
  return true;
}

/**
 * Remove every legacy install. Returns the display paths that were touched, so
 * a caller can log or (for the explicit command) report them.
 *
 * Per-target failures are swallowed: one unreadable config must not stop the
 * others from being cleaned up, and a failure here is never fatal.
 */
export async function cleanupLegacyHooks(
  io: LegacyIo,
  env: NodeJS.ProcessEnv,
  platform: string,
  homedir: string
): Promise<string[]> {
  const touched: string[] = [];
  for (const target of LEGACY_TARGETS) {
    try {
      if (await stripTarget(target, io, env, platform, homedir)) {
        touched.push(displayPath(target, env, platform, homedir));
      }
    } catch {
      // Non-fatal — see above.
    }
  }
  return touched;
}

// ---------------------------------------------------------------------------
// Workspace-local leftovers
// ---------------------------------------------------------------------------

/**
 * JSON configs a pre-global build wrote *inside the workspace*. These are
 * migrated once per workspace by `LifecycleContext.migrateWorkspaceHooks()`.
 */
export const WORKSPACE_LEGACY_JSON: readonly { relPath: string; marker: string }[] = [
  { relPath: ".claude/settings.local.json", marker: "agentQuickpick:claude" },
  { relPath: ".factory/settings.json", marker: "agentQuickpick:droid" },
];

/** The old workspace-local OpenCode install: a `file://` entry in `opencode.json`. */
export const WORKSPACE_LEGACY_OPENCODE_JSON = "opencode.json";
export const WORKSPACE_LEGACY_OPENCODE_PLUGIN = ".opencode/agent-quickpick-lifecycle.mjs";
const OLD_OPENCODE_PLUGIN_MARKER = "agent-quickpick-lifecycle";

/** True if `opencode.json`'s `plugin[]` still has our old `file://` entry. */
export function hasOldOpencodePlugin(parsed: unknown): boolean {
  const plugin = (parsed as { plugin?: unknown })?.plugin;
  return (
    Array.isArray(plugin) &&
    plugin.some((p) => typeof p === "string" && p.includes(OLD_OPENCODE_PLUGIN_MARKER))
  );
}

/** Remove our old `file://` entry from `plugin[]`; prune the key if it empties. */
export function stripOldOpencodePlugin(parsed: unknown): unknown {
  const config = { ...(parsed as Record<string, unknown>) };
  if (!Array.isArray(config.plugin)) return config;
  const filtered = (config.plugin as unknown[]).filter(
    (p) => !(typeof p === "string" && p.includes(OLD_OPENCODE_PLUGIN_MARKER))
  );
  if (filtered.length === 0) delete config.plugin;
  else config.plugin = filtered;
  return config;
}

/**
 * Strip workspace-local hooks a pre-global build left behind. Marker-scoped, so
 * a user's own hooks in the same files survive.
 */
export async function stripWorkspaceLegacyHooks(io: LegacyIo, baseDir: string): Promise<void> {
  for (const { relPath, marker } of WORKSPACE_LEGACY_JSON) {
    const fsPath = path.join(baseDir, relPath);
    const text = await io.read(fsPath);
    if (text === undefined) continue;
    const parsed = readConfigJson(text);
    if (!hasCommandHooks(parsed, marker)) continue;
    await io.write(fsPath, writeConfigJson(stripCommandHooks(parsed, marker)));
  }

  const opencodePath = path.join(baseDir, WORKSPACE_LEGACY_OPENCODE_JSON);
  const opencodeText = await io.read(opencodePath);
  if (opencodeText !== undefined) {
    const parsed = readConfigJson(opencodeText);
    if (hasOldOpencodePlugin(parsed)) {
      await io.write(opencodePath, writeConfigJson(stripOldOpencodePlugin(parsed)));
    }
  }

  try {
    await io.remove(path.join(baseDir, WORKSPACE_LEGACY_OPENCODE_PLUGIN));
  } catch {
    // Already gone — the common case.
  }
}
