import * as path from "path";
import { isAbsoluteForPlatform } from "./legacy-hooks";

export interface ReporterContext {
  extensionPath: string;
  platform: string;
  readFile(file: string): string | undefined;
}

export interface ReporterLaunch {
  args?: string;
}

export const CLAUDE_REPORTER_SETTINGS = path.join("reporters", "claude-settings.json");

export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
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
    default:
      return undefined;
  }
}
