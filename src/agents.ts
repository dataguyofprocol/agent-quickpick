import { execFile } from "child_process";
import * as vscode from "vscode";

export interface AgentConfig {
  name: string;
  cmd?: string;
  launcher?: string;
  icon?: string;
  color?: string;
  hidden?: boolean;
  userDefined?: boolean;
}

export interface ResolvedAgent {
  name: string;
  cmd: string;
  launcher: string;
  iconPath: vscode.IconPath;
  color?: vscode.ThemeColor;
  installed: boolean;
  isPlainTerminal: boolean;
}

export const BUILTIN_AGENTS: AgentConfig[] = [
  { name: "Terminal", cmd: "", icon: "terminal.svg", color: "agentQuickpick.terminal" },
  { name: "Claude", cmd: "claude", icon: "claude.svg", color: "agentQuickpick.claude" },
  { name: "Command Code", cmd: "cmd", icon: "commandcode.svg", color: "agentQuickpick.commandcode" },
  { name: "Codex", cmd: "codex", icon: "codex.svg", color: "terminal.ansiGreen" },
  { name: "Copilot", cmd: "gh copilot", icon: "copilot.svg", color: "terminal.ansiCyan" },
  { name: "OpenCode", cmd: "opencode", icon: "opencode.svg", color: "agentQuickpick.opencode" },
  { name: "Aider", cmd: "aider", icon: "aider.svg", color: "terminal.ansiRed" },
  { name: "Goose", cmd: "goose", icon: "goose.svg", color: "terminal.ansiYellow" },
  { name: "Crush", cmd: "crush", icon: "crush.svg", color: "terminal.ansiMagenta" },
  { name: "Amp", cmd: "amp", icon: "amp.svg", color: "terminal.ansiBrightMagenta" },
  { name: "Droid", cmd: "droid", icon: "droid.svg", color: "agentQuickpick.droid" },
  { name: "Qwen", cmd: "qwen", icon: "qwen.svg", color: "terminal.ansiCyan" },
  { name: "Plandex", cmd: "plandex", icon: "plandex.svg", color: "terminal.ansiBlue" },
  { name: "Grok", cmd: "grok", icon: "grok.svg", color: "terminal.ansiWhite" },
  { name: "Cody", cmd: "cody", icon: "cody.svg", color: "terminal.ansiBrightMagenta" },
  { name: "Kilo", cmd: "kilo", icon: "kilo.svg", color: "terminal.ansiBrightBlue" },
  { name: "Qodo", cmd: "qodo", icon: "qodo.svg", color: "terminal.ansiBrightGreen" },
  { name: "pi", cmd: "pi", icon: "pi.svg", color: "agentQuickpick.pi" },
  { name: "oh-my-pi", cmd: "omp", icon: "omp.svg", color: "agentQuickpick.omp" },
];

const BUILTIN_COLOR_IDS = new Set([
  "agentQuickpick.claude",
  "agentQuickpick.claudeProxy",
  "agentQuickpick.claudeGlm",
  "agentQuickpick.commandcode",
  "agentQuickpick.opencode",
  "agentQuickpick.pi",
  "agentQuickpick.omp",
  "agentQuickpick.droid",
  "agentQuickpick.terminal",
]);

const ANSI_COLOR_IDS = new Set([
  "terminal.ansiBlack", "terminal.ansiRed", "terminal.ansiGreen", "terminal.ansiYellow",
  "terminal.ansiBlue", "terminal.ansiMagenta", "terminal.ansiCyan", "terminal.ansiWhite",
  "terminal.ansiBrightBlack", "terminal.ansiBrightRed", "terminal.ansiBrightGreen", "terminal.ansiBrightYellow",
  "terminal.ansiBrightBlue", "terminal.ansiBrightMagenta", "terminal.ansiBrightCyan", "terminal.ansiBrightWhite",
]);

export const ALLOWED_COLORS = new Set<string>([...BUILTIN_COLOR_IDS, ...ANSI_COLOR_IDS]);

export interface FrecencyEntry {
  c: number;
  t: number;
}
export type FrecencyMap = Record<string, FrecencyEntry>;

const FRECENCY_KEY = "frecency.v1";
const FRECENCY_HALF_LIFE_DAYS = 10;
const FRECENCY_MAX_AGE_MS = 180 * 86_400_000;

export function frecencyScore(count: number, lastUsedMs: number, now: number): number {
  if (count <= 0) {
    return 0;
  }
  const ageDays = Math.max(0, (now - lastUsedMs) / 86_400_000);
  const decay = Math.pow(2, -ageDays / FRECENCY_HALF_LIFE_DAYS);
  return count * decay;
}

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | void;
}

export function readFrecency(state: MementoLike): FrecencyMap {
  const raw = state.get<unknown>(FRECENCY_KEY);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as FrecencyMap;
  }
  return {};
}

export function pruneFrecency(
  map: FrecencyMap,
  now: number,
  maxAgeMs = FRECENCY_MAX_AGE_MS
): FrecencyMap {
  for (const key of Object.keys(map)) {
    const entry = map[key];
    if (!entry || now - entry.t > maxAgeMs) {
      delete map[key];
    }
  }
  return map;
}

export function recordLaunch(state: MementoLike, name: string, now: number): void {
  const map = readFrecency(state);
  pruneFrecency(map, now);
  const key = name.toLowerCase();
  const prev = map[key];
  map[key] = { c: (prev?.c ?? 0) + 1, t: now };
  state.update(FRECENCY_KEY, map);
}

export function sortByFrecency<T>(
  items: T[],
  scoreOf: (item: T) => number
): T[] {
  return items
    .map((item, idx) => ({ item, idx, score: scoreOf(item) }))
    .sort((a, b) => (b.score - a.score) || (a.idx - b.idx))
    .map((d) => d.item);
}

export function loadAgents(userAgents: unknown): AgentConfig[] {
  const byName = new Map<string, AgentConfig>();
  const order: string[] = [];

  const add = (entry: AgentConfig) => {
    if (!entry || typeof entry.name !== "string" || entry.name.trim() === "") {
      return;
    }
    const key = entry.name.toLowerCase();
    if (!byName.has(key)) {
      order.push(key);
    }
    byName.set(key, entry);
  };

  for (const b of BUILTIN_AGENTS) {
    add({ ...b });
  }

  if (Array.isArray(userAgents)) {
    for (const raw of userAgents) {
      if (raw && typeof raw === "object") {
        add({ ...(raw as AgentConfig), userDefined: true });
      }
    }
  }

  const result: AgentConfig[] = [];
  for (const key of order) {
    const entry = byName.get(key);
    if (entry && !entry.hidden) {
      result.push(entry);
    }
  }
  return result;
}

interface InstallCacheEntry {
  installed: boolean;
  ts: number;
}
const INSTALL_CACHE_TTL_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 5000;
const installCache = new Map<string, InstallCacheEntry>();

const SAFE_BINARY_RE = /^[A-Za-z0-9._-]+$/;

export function isSafeBinaryName(binary: string): boolean {
  return SAFE_BINARY_RE.test(binary);
}

export async function isCmdInstalled(cmd: string, launcher?: string): Promise<boolean> {
  if ((cmd ?? "").trim() === "") {
    return true;
  }
  let binary: string;
  const trimmedLauncher = (launcher ?? "").trim();
  if (trimmedLauncher !== "") {
    if (!isSafeBinaryName(trimmedLauncher)) {
      return false;
    }
    binary = trimmedLauncher;
  } else {
    binary = (cmd ?? "").trim().split(/\s+/)[0];
    if (!isSafeBinaryName(binary)) {
      return false;
    }
  }
  const cached = installCache.get(binary);
  const now = Date.now();
  if (cached) {
    if (now - cached.ts < INSTALL_CACHE_TTL_MS) {
      return cached.installed;
    }
    installCache.delete(binary);
  }
  const cmdName = process.platform === "win32" ? "where" : "command";
  const args = process.platform === "win32" ? [binary] : ["-v", binary];
  return new Promise<boolean>((resolve) => {
    execFile(cmdName, args, { timeout: PROBE_TIMEOUT_MS }, (error) => {
      const installed = !error;
      installCache.set(binary, { installed, ts: Date.now() });
      resolve(installed);
    });
  });
}

export function clearInstallCache(): void {
  installCache.clear();
}

export function _poisonInstallCacheForTests(binary: string, installed: boolean, ts: number): void {
  installCache.set(binary, { installed, ts });
}

export function launchText(agent: Pick<ResolvedAgent, "cmd" | "launcher" | "isPlainTerminal">): string {
  if (agent.isPlainTerminal) {
    return "";
  }
  return agent.launcher ? `${agent.launcher} ${agent.cmd}` : agent.cmd;
}

export function launchDelay(isPlainTerminal: boolean, delayMs: number): number {
  if (isPlainTerminal) {
    return 0;
  }
  return delayMs > 0 ? delayMs : 0;
}

export function uniqueTerminalName(base: string, existing: Iterable<string>): string {
  const taken = new Set<string>(existing);
  if (!taken.has(base)) {
    return base;
  }
  let n = 2;
  while (taken.has(`${base} (${n})`)) {
    n++;
  }
  return `${base} (${n})`;
}

export function programStatusEnv(
  agentName: string,
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> | undefined {
  if (agentName.trim().toLowerCase() !== "pi") return undefined;
  const existing = env.PI_PROGRAM_STATUS;
  if (existing !== undefined && existing.trim() !== "") return undefined;
  return { PI_PROGRAM_STATUS: "1" };
}

export function baseTerminalName(name: string): string {
  return name.replace(/ \(\d+\)$/, "");
}

export function isSessionTerminal(terminalName: string, agentNames: Set<string>): boolean {
  return agentNames.has(baseTerminalName(terminalName).toLowerCase());
}
