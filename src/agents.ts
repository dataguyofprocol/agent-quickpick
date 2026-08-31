/**
 * Agent registry + resolution helpers — the vscode-free half of extension.ts.
 *
 * Pure data + pure functions (the only `vscode` usage is in type positions,
 * which tsc elides from the CommonJS emit), so this module is unit-testable
 * without a VS Code host — the same convention as the pure helpers in
 * lifecycle.ts. The vscode-coupled halves (icon/color resolution, which
 * construct runtime vscode objects, and everything UI/terminal) stay in
 * extension.ts.
 */

import { execFile } from "child_process";
import * as vscode from "vscode";

/**
 * An agent entry as it appears in settings.json (`agentQuickpick.agents[]`)
 * or in the built-in defaults. All fields except `name` are optional.
 */
export interface AgentConfig {
  name: string;
  cmd?: string;
  /** Optional prefix binary (e.g. "uvx", "npx", "pipx"). */
  launcher?: string;
  icon?: string;
  color?: string;
  hidden?: boolean;
  /**
   * Internal, computed by loadAgents — true when the entry came from the
   * user's `agentQuickpick.agents` setting (not a built-in). User entries skip
   * install detection: the user added them on purpose (often shell aliases
   * that a non-interactive `command -v` probe can't see), so they always show.
   * Not intended to be set in settings.json.
   */
  userDefined?: boolean;
}

/**
 * An agent after resolution: an IconPath and ThemeColor the terminal API accepts,
 * plus whether the CLI looks installed.
 */
export interface ResolvedAgent {
  name: string;
  cmd: string;
  launcher: string;
  iconPath: vscode.IconPath;
  color?: vscode.ThemeColor;
  installed: boolean;
  /** true for the plain-terminal built-in (cmd === "") */
  isPlainTerminal: boolean;
}

/**
 * The curated built-ins — real, installable terminal-native coding-agent CLIs
 * (plus a plain Terminal first). Order here = order shown in the quick pick.
 *
 * Custom theme colors (agentQuickpick.*) are declared in package.json under
 * contributes.colors; stock terminal.ansi* keys are built into VS Code.
 *
 * Personal aliases like `claude-proxy` / `claude-glm` are intentionally NOT
 * here — they belong in the user's settings. Their SVGs are still shipped so
 * the user can reference them by filename (`claude-proxy.svg`) if they want.
 * The same goes for `gemini` (dropped when Gemini CLI transitioned to
 * Antigravity): `gemini.svg` remains shipped for settings-defined entries.
 */
export const BUILTIN_AGENTS: AgentConfig[] = [
  { name: "Terminal", cmd: "", icon: "terminal.svg", color: "agentQuickpick.terminal" },
  { name: "Claude", cmd: "claude", icon: "claude.svg", color: "agentQuickpick.claude" },
  { name: "Command Code", cmd: "cmd", icon: "commandcode.svg", color: "agentQuickpick.commandcode" },
  { name: "Codex", cmd: "codex", icon: "codex.svg", color: "terminal.ansiGreen" },
  { name: "Antigravity", cmd: "agy", icon: "antigravity.svg", color: "terminal.ansiBlue" },
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
  { name: "oh-my-pi", cmd: "omp", icon: "omp.svg", color: "agentQuickpick.omp" },
];

/**
 * The custom `agentQuickpick.*` theme colors declared in package.json under
 * `contributes.colors`. Kept as an explicit list (not derived from
 * BUILTIN_AGENTS) so it stays in sync with what VS Code actually registers —
 * claudeProxy/claudeGlm are declared (and usable from user settings) even
 * though they're no longer used by any built-in agent.
 */
const BUILTIN_COLOR_IDS = new Set([
  "agentQuickpick.claude",
  "agentQuickpick.claudeProxy",
  "agentQuickpick.claudeGlm",
  "agentQuickpick.commandcode",
  "agentQuickpick.opencode",
  "agentQuickpick.omp",
  "agentQuickpick.droid",
  "agentQuickpick.terminal",
]);

/** Stock terminal tab colors VS Code ships. Recommended by the API docs. */
const ANSI_COLOR_IDS = new Set([
  "terminal.ansiBlack", "terminal.ansiRed", "terminal.ansiGreen", "terminal.ansiYellow",
  "terminal.ansiBlue", "terminal.ansiMagenta", "terminal.ansiCyan", "terminal.ansiWhite",
  "terminal.ansiBrightBlack", "terminal.ansiBrightRed", "terminal.ansiBrightGreen", "terminal.ansiBrightYellow",
  "terminal.ansiBrightBlue", "terminal.ansiBrightMagenta", "terminal.ansiBrightCyan", "terminal.ansiBrightWhite",
]);

export const ALLOWED_COLORS = new Set<string>([...BUILTIN_COLOR_IDS, ...ANSI_COLOR_IDS]);

/**
 * Frecency: a score combining launch count and recency, used to sort the
 * quick-pick list so a user's most-used agents float to the top while
 * never-launched agents keep the curated order. Roughly a 10-day half-life.
 *
 * Stored in globalState (persists across restarts, syncs across machines via
 * Settings Sync) as { [lowercaseName]: { c: number, t: number } }.
 */
export interface FrecencyEntry {
  /** launch count */
  c: number;
  /** last-used epoch ms */
  t: number;
}
export type FrecencyMap = Record<string, FrecencyEntry>;

const FRECENCY_KEY = "frecency.v1";
const FRECENCY_HALF_LIFE_DAYS = 10;

/**
 * Pure score function. `now` is injected so tests don't depend on wall clock.
 * Returns 0 for never-launched agents (count === 0).
 */
export function frecencyScore(count: number, lastUsedMs: number, now: number): number {
  if (count <= 0) {
    return 0;
  }
  const ageDays = Math.max(0, (now - lastUsedMs) / 86_400_000);
  // count × 2^(-age/halfLife) — equivalent to count × exp(-age × ln2 / halfLife).
  const decay = Math.pow(2, -ageDays / FRECENCY_HALF_LIFE_DAYS);
  return count * decay;
}

/**
 * The structural slice of `vscode.Memento` the frecency helpers need. Declared
 * locally so this module (and its tests) never need the vscode module at
 * runtime; a real Memento satisfies it structurally.
 */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | void;
}

/** Read the frecency map from globalState (defensive against bad shapes). */
export function readFrecency(state: MementoLike): FrecencyMap {
  const raw = state.get<unknown>(FRECENCY_KEY);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as FrecencyMap;
  }
  return {};
}

/** Increment an agent's launch count + last-used timestamp in globalState. */
export function recordLaunch(state: MementoLike, name: string, now: number): void {
  const map = readFrecency(state);
  const key = name.toLowerCase();
  const prev = map[key];
  map[key] = { c: (prev?.c ?? 0) + 1, t: now };
  state.update(FRECENCY_KEY, map);
}

/**
 * Stable sort by frecency score desc; agents with score 0 keep their input
 * order (so the curated order is preserved for never-launched agents).
 */
export function sortByFrecency<T>(
  items: T[],
  scoreOf: (item: T) => number
): T[] {
  // Decorated stable sort: keep original index as tiebreaker.
  return items
    .map((item, idx) => ({ item, idx, score: scoreOf(item) }))
    .sort((a, b) => (b.score - a.score) || (a.idx - b.idx))
    .map((d) => d.item);
}

/**
 * Merge built-in defaults with the user's `agentQuickpick.agents` setting.
 * Rules:
 *  - User entries override built-ins with the same `name` (case-insensitive).
 *  - An entry with `hidden: true` is dropped entirely.
 *  - User entries missing `name` are skipped.
 *  - Order: built-ins first (in their original order), then user-only entries.
 *  - `undefined`/non-array config → defaults only.
 */
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

  // Built-ins first, in their curated order.
  for (const b of BUILTIN_AGENTS) {
    add({ ...b });
  }

  // Then user entries (override by name, append new ones at the end).
  // Mark them userDefined so resolution can skip install detection for them.
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

/**
 * Check whether a command appears on PATH (or is empty = plain terminal).
 * For multi-word commands like `gh copilot`, only the first token (the actual
 * binary) is checked. If `launcher` is set (e.g. "uvx", "npx"), that binary is
 * probed instead of the first token of `cmd`. Binary names are validated
 * against a safe-character allowlist to prevent shell injection through user
 * settings — anything containing quotes, semicolons, pipes, etc. is treated as
 * "not installed" rather than being passed to the shell.
 *
 * Results are cached per session with a 5-minute TTL, so an agent installed
 * (or uninstalled) while the window is open is picked up on the next picker
 * open after the TTL elapses. The cache is also cleared whenever any
 * `agentQuickpick.*` setting changes.
 */
interface InstallCacheEntry {
  installed: boolean;
  ts: number;
}
const INSTALL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const installCache = new Map<string, InstallCacheEntry>();

/** A safe binary name: letters, digits, dash, underscore, dot, plus only. */
const SAFE_BINARY_RE = /^[A-Za-z0-9._-]+$/;

export function isSafeBinaryName(binary: string): boolean {
  return SAFE_BINARY_RE.test(binary);
}

export async function isCmdInstalled(cmd: string, launcher?: string): Promise<boolean> {
  // Empty command = plain terminal, always considered installed.
  if ((cmd ?? "").trim() === "") {
    return true;
  }
  // If a launcher (e.g. "uvx") is set, probe that binary on PATH instead of
  // the first token of `cmd`. The full `${launcher} ${cmd}` is sent to the
  // terminal at launch time.
  let binary: string;
  const trimmedLauncher = (launcher ?? "").trim();
  if (trimmedLauncher !== "") {
    if (!isSafeBinaryName(trimmedLauncher)) {
      return false; // unsafe launcher → refuse to exec
    }
    binary = trimmedLauncher;
  } else {
    // For `gh copilot` etc., the installable binary is the first token.
    binary = (cmd ?? "").trim().split(/\s+/)[0];
    if (!isSafeBinaryName(binary)) {
      return false; // unsafe input → refuse to exec
    }
  }
  const cached = installCache.get(binary);
  const now = Date.now();
  if (cached && now - cached.ts < INSTALL_CACHE_TTL_MS) {
    return cached.installed;
  }
  const cmdName = process.platform === "win32" ? "where" : "command";
  const args = process.platform === "win32" ? [binary] : ["-v", binary];
  return new Promise<boolean>((resolve) => {
    execFile(cmdName, args, (error) => {
      const installed = !error;
      installCache.set(binary, { installed, ts: now });
      resolve(installed);
    });
  });
}

/**
 * Clear the install-detection cache (also clears TTL timestamps). Called by
 * activate() whenever any `agentQuickpick.*` setting changes, and by tests.
 */
export function clearInstallCache(): void {
  installCache.clear();
}

/** Reset the install cache. Exposed for tests (alias of clearInstallCache). */
export function _resetInstallCacheForTests(): void {
  installCache.clear();
}

/**
 * Poison the cache with an explicit result + timestamp. Exposed for tests so
 * we can verify the TTL read path without waiting for real time to elapse.
 */
export function _poisonInstallCacheForTests(binary: string, installed: boolean, ts: number): void {
  installCache.set(binary, { installed, ts });
}

/**
 * The text to send to the terminal to start the agent. Empty for the plain
 * terminal (no command). When `launcher` is set, it prefixes `cmd`.
 */
export function launchText(agent: Pick<ResolvedAgent, "cmd" | "launcher" | "isPlainTerminal">): string {
  if (agent.isPlainTerminal) {
    return "";
  }
  return agent.launcher ? `${agent.launcher} ${agent.cmd}` : agent.cmd;
}

/**
 * Ms to wait before sending the launch command. 0 means send immediately.
 *
 * Plain terminals never send text (see launchText), so the delay never
 * applies to them. Non-positive configured delays are clamped to 0.
 *
 * The delay lets other extensions' terminal-startup injections — most
 * notably the Python extension's `source .../venv/bin/activate` — land in
 * the bare shell before the agent takes over stdin. Without it, those
 * injections arrive after the agent's TUI has started and get fed into the
 * agent's input box instead of the shell.
 */
export function launchDelay(isPlainTerminal: boolean, delayMs: number): number {
  if (isPlainTerminal) {
    return 0;
  }
  return delayMs > 0 ? delayMs : 0;
}

/**
 * Pick a terminal tab name that doesn't collide with already-open terminals.
 * Bare-first, then " (2)", " (3)", … — matching VS Code's native convention.
 * Numbers are reclaimed: if "Claude" is free again (its tab was closed) it's
 * reused before "Claude (2)". Pure + injectable for testing.
 */
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

/**
 * Strip a trailing " (N)" collision counter from a terminal name, so
 * "Claude (2)" → "Claude". Names without a counter are returned unchanged.
 * Used to match a live terminal back to the agent that spawned it.
 */
export function baseTerminalName(name: string): string {
  return name.replace(/ \(\d+\)$/, "");
}

/**
 * True when a terminal name looks like one we launched — its base name (minus
 * any " (N)" counter) matches a known agent name (case-insensitive). This is
 * how the sessions list re-adopts terminals after a window reload, without any
 * in-memory tracking.
 */
export function isSessionTerminal(terminalName: string, agentNames: Set<string>): boolean {
  return agentNames.has(baseTerminalName(terminalName).toLowerCase());
}

/**
 * Given a set of live terminal names, return those that look like agent
 * sessions we launched — as `{ name, agentName }` pairs (base name = agent
 * name). Pure + host-free so it's unit-testable; used by
 * `LifecycleContext.seedFromOpenTerminals` to re-adopt agent sessions
 * into the in-memory Map after a window reload, so hooks/notifications keep
 * working without a manual relaunch.
 */
export function matchSessionTerminals(
  names: readonly string[],
  agentNames: Set<string>
): { name: string; agentName: string }[] {
  const matched: { name: string; agentName: string }[] = [];
  for (const name of names) {
    const agentName = baseTerminalName(name);
    if (agentNames.has(agentName.toLowerCase())) {
      matched.push({ name, agentName });
    }
  }
  return matched;
}
