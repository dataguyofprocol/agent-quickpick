/**
 * Launch-time status reporters for agents that can't report OSC 7501 in VS Code.
 *
 * Claude Code only emits the Program Status Protocol after the terminal answers
 * its feature-detection query, which VS Code cannot; OpenCode doesn't emit it at
 * all yet. Both expose lifecycle events, so for the terminals *we launch* we hand
 * each one a tiny reporter that turns those events into OSC 7501 reports written
 * to its own terminal. `session-tracker.ts` already believes those reports, so
 * nothing downstream changes — and nothing is written to either agent's config:
 *
 * - **Claude Code** gets `--settings <reporters/claude-settings.json>`. Settings
 *   passed this way are layered on the user's own, and their hooks run alongside
 *   the user's hooks. Claude runs hooks detached from the terminal (`/dev/tty`
 *   fails), so each hook writes to its parent process's tty instead.
 * - **OpenCode (V2)** gets `OPENCODE_CLI_CONFIG_CONTENT` naming the
 *   `reporters/opencode` TUI plugin. That variable's `plugins` list *replaces*
 *   the one in the user's `cli.json` rather than merging with it, so the user's
 *   own plugins are copied in first; if their `cli.json` can't be read safely we
 *   skip the reporter rather than drop their plugins.
 *
 * Both are shims until the agents report natively in VS Code. Free of runtime
 * `vscode` usage so the unit tier can drive it.
 */

import * as path from "path";
import { isAbsoluteForPlatform, resolveOpenCodeConfigDir } from "./legacy-hooks";

export interface ReporterContext {
  /** The extension's install directory (where `reporters/` ships). */
  extensionPath: string;
  platform: string;
  env: NodeJS.ProcessEnv;
  homedir: string;
  /** A file's contents, or `undefined` when it can't be read. */
  readFile(file: string): string | undefined;
}

export interface ReporterLaunch {
  /** Extra environment for the terminal. */
  env?: Record<string, string>;
  /** Text appended to the launch command, leading space included. */
  args?: string;
}

export const CLAUDE_REPORTER_SETTINGS = path.join("reporters", "claude-settings.json");
export const OPENCODE_REPORTER_DIR = path.join("reporters", "opencode");

/** Quote a word for a POSIX shell. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * Parse JSONC (comments, trailing commas) the way OpenCode reads `cli.json`.
 * Returns `undefined` for anything that isn't a JSON object.
 */
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

/**
 * The user's `cli.json` plugin list, made absolute so it still resolves from an
 * environment variable. `[]` when there is no `cli.json`; `undefined` when there
 * is one we can't read safely (the caller must then leave OpenCode alone).
 */
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
    } else return undefined; // a shape we don't understand: don't guess
  }
  return plugins;
}

/** The program a launch command runs: its first word, without a directory. */
function program(cmd: string): string {
  const first = cmd.trim().split(/\s+/)[0] ?? "";
  return first.slice(first.lastIndexOf("/") + 1);
}

/**
 * The reporter for launching `cmd`, or `undefined` when it gets none.
 *
 * Deliberately narrow: only a command that *is* `claude` / `opencode` (a wrapper
 * such as a proxy script might not accept the flag or forward the env), never
 * under a `launcher`, never on Windows (the hooks are POSIX shell), and never
 * when the user already set the same knob themselves.
 */
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
