import * as path from "path";
import { isAbsoluteForPlatform, resolveOpenCodeConfigDir } from "./legacy-hooks";

export interface ReporterContext {
  extensionPath: string;
  platform: string;
  env: NodeJS.ProcessEnv;
  homedir: string;
  readFile(file: string): string | undefined;
}

export interface ReporterLaunch {
  env?: Record<string, string>;
  args?: string;
}

export const CLAUDE_REPORTER_SETTINGS = path.join("reporters", "claude-settings.json");
export const OPENCODE_REPORTER_DIR = path.join("reporters", "opencode");

export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

export function parseJsonc(text: string): Record<string, unknown> | undefined {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  try {
    const parsed: unknown = JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function userOpenCodePlugins(ctx: ReporterContext): unknown[] | undefined {
  let configDir: string;
  try {
    configDir = resolveOpenCodeConfigDir(ctx.env, ctx.platform, ctx.homedir);
  } catch {
    return undefined;
  }
  const text = ctx.readFile(path.join(configDir, "cli.json"));
  if (text === undefined) return [];
  const config = parseJsonc(text);
  if (!config) return undefined;
  if (config.plugins === undefined) return [];
  if (!Array.isArray(config.plugins)) return undefined;

  const absolute = (spec: string): string =>
    spec.startsWith("./") || spec.startsWith("../")
      ? path.resolve(configDir, spec)
      : spec;
  const plugins: unknown[] = [];
  for (const entry of config.plugins) {
    if (typeof entry === "string") plugins.push(absolute(entry));
    else if (Array.isArray(entry) && typeof entry[0] === "string") {
      plugins.push([absolute(entry[0]), ...entry.slice(1)]);
    } else return undefined;
  }
  return plugins;
}

function program(cmd: string): string {
  const first = cmd.trim().split(/\s+/)[0] ?? "";
  return first.slice(first.lastIndexOf("/") + 1);
}

export function reporterLaunch(
  cmd: string,
  launcher: string | undefined,
  ctx: ReporterContext
): ReporterLaunch | undefined {
  if (ctx.platform === "win32" || launcher) return undefined;
  if (!isAbsoluteForPlatform(ctx.extensionPath, ctx.platform)) return undefined;

  switch (program(cmd)) {
    case "claude": {
      if (/(^|\s)--settings(\s|=|$)/.test(cmd)) return undefined;
      const settings = path.join(ctx.extensionPath, CLAUDE_REPORTER_SETTINGS);
      if (ctx.readFile(settings) === undefined) return undefined;
      return { args: ` --settings ${shellQuote(settings)}` };
    }
    case "opencode": {
      const existing = ctx.env.OPENCODE_CLI_CONFIG_CONTENT;
      if (existing !== undefined && existing.trim() !== "") return undefined;
      const pluginDir = path.join(ctx.extensionPath, OPENCODE_REPORTER_DIR);
      if (ctx.readFile(path.join(pluginDir, "tui.js")) === undefined) return undefined;
      const plugins = userOpenCodePlugins(ctx);
      if (plugins === undefined) return undefined;
      return {
        env: { OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ plugins: [...plugins, pluginDir] }) },
      };
    }
    default:
      return undefined;
  }
}
