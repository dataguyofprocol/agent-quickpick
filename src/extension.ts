import * as vscode from "vscode";
import { exec } from "child_process";
import * as path from "path";
import * as fs from "fs";

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
 */
export const BUILTIN_AGENTS: AgentConfig[] = [
  { name: "Terminal", cmd: "", icon: "terminal.svg", color: "agentQuickpick.terminal" },
  { name: "Claude", cmd: "claude", icon: "claude.svg", color: "agentQuickpick.claude" },
  { name: "Command Code", cmd: "cmd", icon: "commandcode.svg", color: "agentQuickpick.commandcode" },
  { name: "Codex", cmd: "codex", icon: "codex.svg", color: "terminal.ansiGreen" },
  { name: "Gemini", cmd: "gemini", icon: "gemini.svg", color: "terminal.ansiBlue" },
  { name: "Copilot", cmd: "gh copilot", icon: "copilot.svg", color: "terminal.ansiCyan" },
  { name: "OpenCode", cmd: "opencode", icon: "opencode.svg", color: "agentQuickpick.opencode" },
  { name: "Aider", cmd: "aider", icon: "aider.svg", color: "terminal.ansiRed" },
  { name: "Goose", cmd: "goose", icon: "goose.svg", color: "terminal.ansiYellow" },
  { name: "Crush", cmd: "crush", launcher: "uvx", icon: "crush.svg", color: "terminal.ansiMagenta" },
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

/** Read the frecency map from globalState (defensive against bad shapes). */
function readFrecency(state: vscode.Memento): FrecencyMap {
  const raw = state.get<unknown>(FRECENCY_KEY);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as FrecencyMap;
  }
  return {};
}

/** Increment an agent's launch count + last-used timestamp in globalState. */
export function recordLaunch(state: vscode.Memento, name: string, now: number): void {
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
 * Resolve an `icon` string to a vscode.IconPath.
 *
 * Resolution order (first match wins; any failure → ThemeIcon("terminal")):
 *  1. empty / "terminal"            → ThemeIcon("terminal")
 *  2. absolute path that exists     → Uri.file(icon)
 *  3. codicon id (a-z0-9-, no / .)  → ThemeIcon(icon)
 *  4. bundled filename that exists  → Uri.joinPath(extensionUri, "icons", icon)
 *  5. fallback                      → ThemeIcon("terminal")
 *
 * File paths are stat-checked — a missing absolute path or bundled filename
 * falls back to the terminal codicon instead of producing a broken icon.
 * Codicons can't be validated at runtime (VS Code renders a placeholder for
 * unknown ids), so those are returned as-is.
 */
export function resolveIconPath(icon: unknown, extensionUri: vscode.Uri): vscode.IconPath {
  const fallback = new vscode.ThemeIcon("terminal");
  if (typeof icon !== "string" || icon.trim() === "" || icon.trim().toLowerCase() === "terminal") {
    return fallback;
  }
  const trimmed = icon.trim();

  // Absolute path on disk — must exist.
  if (path.isAbsolute(trimmed)) {
    try {
      if (fs.existsSync(trimmed)) {
        return vscode.Uri.file(trimmed);
      }
    } catch {
      // ignore stat errors, fall through
    }
    return fallback;
  }

  // Codicon id: letters, digits and dashes only, no dot, no slash.
  const looksCodicon = /^[a-z][a-z0-9-]*$/i.test(trimmed) && !trimmed.includes(".");
  if (looksCodicon) {
    return new vscode.ThemeIcon(trimmed.toLowerCase());
  }

  // Otherwise: a filename bundled in the extension's icons folder — must exist.
  try {
    const fsPath = path.join(extensionUri.fsPath, "icons", trimmed);
    if (fs.existsSync(fsPath)) {
      return vscode.Uri.joinPath(extensionUri, "icons", trimmed);
    }
  } catch {
    // ignore, fall through
  }
  return fallback;
}

/**
 * Resolve a `color` string to a ThemeColor, or undefined.
 * Accepts built-in color ids and stock terminal.ansi* keys. Anything else → undefined.
 */
export function resolveColor(color: unknown): vscode.ThemeColor | undefined {
  if (typeof color !== "string" || color.trim() === "") {
    return undefined;
  }
  const trimmed = color.trim();
  if (!ALLOWED_COLORS.has(trimmed)) {
    return undefined;
  }
  return new vscode.ThemeColor(trimmed);
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
  const checker = process.platform === "win32" ? `where "${binary}"` : `command -v "${binary}"`;
  return new Promise<boolean>((resolve) => {
    exec(checker, (error) => {
      const installed = !error;
      installCache.set(binary, { installed, ts: now });
      resolve(installed);
    });
  });
}

/** Reset the install cache. Exposed for tests (also clears TTL timestamps). */
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
 * Build the list of resolved agents, running optional install detection.
 * Install checks run in parallel for fast quick-pick open.
 */
async function resolveAgents(
  configs: AgentConfig[],
  extensionUri: vscode.Uri,
  detect: boolean
): Promise<ResolvedAgent[]> {
  const resolved = await Promise.all(
    configs.map(async (c) => {
      const cmd = (c.cmd ?? "").trim();
      const launcher = (c.launcher ?? "").trim();
      // User-defined entries skip detection (aliases aren't on PATH); built-ins
      // are probed only when detection is enabled.
      const installed = detect && !c.userDefined ? await isCmdInstalled(cmd, launcher) : true;
      return {
        name: c.name,
        cmd,
        launcher,
        iconPath: resolveIconPath(c.icon, extensionUri),
        color: resolveColor(c.color),
        installed,
        isPlainTerminal: cmd === "",
      } as ResolvedAgent;
    })
  );
  return resolved;
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

/** Create + show a terminal for the given resolved agent. */
function launchAgent(agent: ResolvedAgent, state?: vscode.Memento): void {
  const terminal = vscode.window.createTerminal({
    name: agent.name,
    iconPath: agent.iconPath,
    color: agent.color,
    location: vscode.TerminalLocation.Editor,
  });
  terminal.show();
  const text = launchText(agent);
  if (text !== "") {
    terminal.sendText(text);
  }
  // Record frecency (global, persists + syncs). Defensive: ignore if no state.
  if (state) {
    try {
      recordLaunch(state, agent.name, Date.now());
    } catch {
      // globalState write failures are non-fatal — don't block the launch.
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  // Clear the install-detection cache whenever any agentQuickpick.* setting
  // changes, so toggling detectInstalled or editing the agents list is
  // reflected immediately without a window reload.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("agentQuickpick")) {
        installCache.clear();
      }
    })
  );

  const disposable = vscode.commands.registerCommand("agentQuickpick.open", async () => {
    const config = vscode.workspace.getConfiguration("agentQuickpick");
    const userAgents = config.get("agents");
    const detect = config.get<boolean>("detectInstalled", true);

    const configs = loadAgents(userAgents);
    const agents = await resolveAgents(configs, context.extensionUri, detect);

    // Sort by frecency (launch count + recency) so the most-used agents float
    // to the top. Stable sort → never-launched agents keep curated order.
    const now = Date.now();
    const frecency = readFrecency(context.globalState);
    const sortedAgents = sortByFrecency(agents, (a) => {
      const e = frecency[a.name.toLowerCase()];
      return e ? frecencyScore(e.c, e.t, now) : 0;
    });

    type Item = vscode.QuickPickItem & { agent?: ResolvedAgent };

    const toItem = (agent: ResolvedAgent): Item => ({
      label: agent.name,
      // Show the actual command that will be sent (incl. launcher prefix).
      description: agent.isPlainTerminal ? "shell" : launchText(agent) || agent.cmd,
      iconPath: agent.iconPath,
      agent,
    });

    // Plain Terminal is always considered installed; everything else depends on detection.
    const installedItems = sortedAgents.filter((a) => a.installed).map(toItem);
    const uninstalledItems = sortedAgents.filter((a) => !a.installed).map(toItem);

    // When detection is off (or nothing is uninstalled), we just show the flat list.
    const showToggle = detect && uninstalledItems.length > 0;

    if (!showToggle) {
      // Simpler path: no toggle needed, use the basic API.
      const choice = await vscode.window.showQuickPick(installedItems, {
        placeHolder: "Open agent terminal",
        matchOnDescription: true,
      });
      if (choice?.agent) {
        launchAgent(choice.agent, context.globalState);
      }
      return;
    }

    // Toggle path: a createQuickPick with an eye button to reveal uninstalled agents.
    const qp = vscode.window.createQuickPick<Item>();
    qp.placeholder = "Open agent terminal";
    qp.matchOnDescription = true;

    const separator: Item = {
      label: "Not installed",
      kind: vscode.QuickPickItemKind.Separator,
    };

    const showAllBtn: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon("eye-closed"),
      tooltip: "Show uninstalled",
    };
    const hideBtn: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon("eye"),
      tooltip: "Hide uninstalled",
    };

    let showAll = false;
    const render = () => {
      if (showAll) {
        qp.items = [...installedItems, separator, ...uninstalledItems];
        qp.buttons = [hideBtn];
      } else {
        qp.items = installedItems;
        qp.buttons = [showAllBtn];
      }
    };

    qp.onDidTriggerButton((btn) => {
      if (btn === showAllBtn) {
        showAll = true;
        render();
      } else if (btn === hideBtn) {
        showAll = false;
        render();
      }
    });

    qp.onDidAccept(() => {
      const sel = qp.selectedItems[0];
      if (sel?.agent) {
        qp.hide();
        launchAgent(sel.agent, context.globalState);
      }
    });

    render();
    qp.show();
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
