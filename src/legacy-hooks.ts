import * as path from "path";

export function isAbsoluteForPlatform(fsPath: string, platform: string): boolean {
  if (platform === "win32") return /^[A-Za-z]:[\\/]/.test(fsPath);
  return fsPath.startsWith("/");
}

export function readConfigJson(text: string): unknown {
  if (typeof text !== "string" || text.trim() === "") return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeConfigJson(parsed: unknown): string {
  return JSON.stringify(parsed, null, 2) + "\n";
}

function cloneObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  return {};
}

function hookCommand(hook: unknown): string | undefined {
  if (!hook || typeof hook !== "object") return undefined;
  const command = (hook as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
}

function isOurHook(hook: unknown, marker: string): boolean {
  return hookCommand(hook)?.includes(marker) ?? false;
}

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
      if (isOurHook(item, marker)) return true;
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const hooks = (item as Record<string, unknown>).hooks;
        if (Array.isArray(hooks) && hooks.some((h) => isOurHook(h, marker))) return true;
      }
    }
  }
  return false;
}

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

export function shouldRemovePluginFile(existing: string | undefined, marker: string): boolean {
  return existing !== undefined && existing.includes(marker);
}

export interface LegacyCommandHookTarget {
  kind: "command-hooks";
  agentName: string;
  marker: string;
  configPath: string;
  schema: "nested" | "named";
  hookName?: string;
}

export interface LegacyPluginFileTarget {
  kind: "plugin-file";
  agentName: string;
  marker: string;
  pluginPath: string;
  resolveBaseDir(env: NodeJS.ProcessEnv, platform: string, homedir: string): string;
}

export type LegacyTarget = LegacyCommandHookTarget | LegacyPluginFileTarget;

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

export function targetPath(
  target: LegacyTarget,
  env: NodeJS.ProcessEnv,
  platform: string,
  homedir: string
): string {
  if (target.kind === "command-hooks") return path.join(homedir, target.configPath);
  return path.join(target.resolveBaseDir(env, platform, homedir), target.pluginPath);
}

export function displayPath(
  target: LegacyTarget,
  env: NodeJS.ProcessEnv,
  platform: string,
  homedir: string
): string {
  if (target.kind === "command-hooks") return `~/${target.configPath}`;
  return targetPath(target, env, platform, homedir);
}

export interface LegacyIo {
  read(file: string): Promise<string | undefined>;
  write(file: string, text: string): Promise<void>;
  remove(file: string): Promise<void>;
}

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
    }
  }
  return touched;
}

export const WORKSPACE_LEGACY_JSON: readonly { relPath: string; marker: string }[] = [
  { relPath: ".claude/settings.local.json", marker: "agentQuickpick:claude" },
  { relPath: ".factory/settings.json", marker: "agentQuickpick:droid" },
];

export const WORKSPACE_LEGACY_OPENCODE_JSON = "opencode.json";
export const WORKSPACE_LEGACY_OPENCODE_PLUGIN = ".opencode/agent-quickpick-lifecycle.mjs";
const OLD_OPENCODE_PLUGIN_MARKER = "agent-quickpick-lifecycle";

export function hasOldOpencodePlugin(parsed: unknown): boolean {
  const plugin = (parsed as { plugin?: unknown })?.plugin;
  return (
    Array.isArray(plugin) &&
    plugin.some((p) => typeof p === "string" && p.includes(OLD_OPENCODE_PLUGIN_MARKER))
  );
}

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
  }
}
