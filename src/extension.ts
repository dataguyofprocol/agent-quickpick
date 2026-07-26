import * as vscode from "vscode";
import { exec } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
  type SessionState,
  type LifecycleStatus,
  type HookPayload,
  type LifecycleAdapter,
  readConfigJson,
  writeConfigJson,
  startLifecycleServer,
  pollExitStatuses,
  countByStatus,
  statusBarText,
  statusBarTooltip,
  STATUS_LABEL,
  STATUS_GLYPH,
  shouldNotify,
  notificationMessage,
  HOOK_ENV,
} from "./lifecycle";
import {
  LIFECYCLE_ADAPTERS,
  CLAUDE_ADAPTER,
  DROID_ADAPTER,
  getAdapter,
  isLifecycleAgent,
  resolveOpenCodeConfigDir,
} from "./lifecycle-adapters";

/**
 * The marker substring the old (workspace-local) OpenCode install left in
 * `opencode.json`'s `plugin[]`. Kept here (not in the adapter) because the
 * current OpenCode adapter is plugin-file based and no longer touches JSON;
 * this is migration-only.
 */
const OLD_OPENCODE_PLUGIN_MARKER = "agent-quickpick-lifecycle";

/** True if opencode.json's plugin[] still has our old file:// entry. */
function hasOldOpencodePlugin(parsed: unknown): boolean {
  const plugin = (parsed as { plugin?: unknown })?.plugin;
  return (
    Array.isArray(plugin) &&
    plugin.some((p) => typeof p === "string" && p.includes(OLD_OPENCODE_PLUGIN_MARKER))
  );
}

/** Remove our old file:// entry from opencode.json's plugin[]; prune if empty. */
function stripOldOpencodePlugin(parsed: unknown): unknown {
  const config = { ...(parsed as Record<string, unknown>) };
  if (!Array.isArray(config.plugin)) {
    return config;
  }
  const filtered = (config.plugin as unknown[]).filter(
    (p) => !(typeof p === "string" && p.includes(OLD_OPENCODE_PLUGIN_MARKER))
  );
  if (filtered.length === 0) {
    delete config.plugin;
  } else {
    config.plugin = filtered;
  }
  return config;
}

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
 * {@link LifecycleContext.seedFromOpenTerminals} to re-adopt agent sessions
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

/** Create + show a terminal for the given resolved agent. */
async function launchAgent(
  agent: ResolvedAgent,
  state?: vscode.Memento,
  delayMs = 0,
  lifecycle?: LifecycleContext
): Promise<vscode.Terminal> {
  const openNames = vscode.window.terminals.map((t) => t.name);
  const tabName = uniqueTerminalName(agent.name, openNames);

  // Inject lifecycle env for supported agents so their hooks can call back to
  // our server. Non-lifecycle agents get no env injection (byte-identical to
  // pre-lifecycle behavior). The server URL resolves only once the socket is
  // listening, so await it — it's bound within milliseconds of activate().
  const adapter = isLifecycleAgent(agent.name) ? getAdapter(agent.name) : undefined;
  const hookUrl = adapter && lifecycle ? await lifecycle.hookUrl() : undefined;
  const env =
    adapter && hookUrl ? HOOK_ENV(hookUrl, tabName) : undefined;

  const terminal = vscode.window.createTerminal({
    name: tabName,
    iconPath: agent.iconPath,
    color: agent.color,
    location: vscode.TerminalLocation.Editor,
    ...(env ? { env } : {}),
  });
  terminal.show();

  // Register the session so the status bar / notifications know about it.
  if (adapter && lifecycle) {
    lifecycle.trackSession(tabName, agent.name);
  }

  const text = launchText(agent);
  const delay = launchDelay(agent.isPlainTerminal, delayMs);
  if (text !== "") {
    if (delay > 0) {
      // Defer sendText so other extensions' terminal-startup injections
      // (venv activation, direnv, conda, …) land in the bare shell first.
      // Guard: the terminal may be disposed during the window.
      setTimeout(() => {
        try {
          terminal.sendText(text);
        } catch {
          // terminal disposed during delay — non-fatal
        }
      }, delay);
    } else {
      terminal.sendText(text);
    }
  }
  // Record frecency (global, persists + syncs). Defensive: ignore if no state.
  if (state) {
    try {
      recordLaunch(state, agent.name, Date.now());
    } catch {
      // globalState write failures are non-fatal — don't block the launch.
    }
  }

  // Prompt once to install the lifecycle hook globally (into the agent's
  // user-level config, keyed by marker — never per-workspace).
  if (adapter && lifecycle) {
    lifecycle.maybePromptInstall(adapter).catch(() => {
      // Prompt failures are non-fatal.
    });
  }

  return terminal;
}

/**
 * Show a quick pick of currently-running agent terminals (matched by name) and
 * focus the chosen one. When nothing is running, falls through to the launcher.
 * When sessions exist, a trailing "Launch new agent…" item re-enters the launcher.
 */
async function runSessions(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration("agentQuickpick");
  const configs = loadAgents(config.get("agents"));
  const agentNames = new Set(configs.map((c) => c.name.toLowerCase()));

  const sessions = vscode.window.terminals.filter((t) =>
    isSessionTerminal(t.name, agentNames)
  );

  // Nothing running → skip the empty list, go straight to launching.
  if (sessions.length === 0) {
    return runLauncher(context);
  }

  type Item = vscode.QuickPickItem & { terminal?: vscode.Terminal; launch?: boolean };

  const iconOf = (t: vscode.Terminal): vscode.IconPath | undefined => {
    const opts = t.creationOptions as vscode.TerminalOptions;
    return opts?.iconPath ?? new vscode.ThemeIcon("terminal");
  };

  // Sort attention-needing sessions to the top: blocked → failed → done → working.
  const order: Record<LifecycleStatus, number> = {
    waiting: 0,
    failed: 1,
    finished: 2,
    running: 3,
  };
  const statusOf = (t: vscode.Terminal): LifecycleStatus =>
    lifecycleCtx?.getSessionState(t.name)?.status ?? "running";

  const items: Item[] = [...sessions]
    .sort((a, b) => order[statusOf(a)] - order[statusOf(b)])
    .map((t) => {
      const status = statusOf(t);
      return {
        label: t.name,
        description: `${STATUS_GLYPH[status]} ${STATUS_LABEL[status]}`,
        iconPath: iconOf(t),
        terminal: t,
      };
    });
  items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: "$(add) Launch new agent…", launch: true });

  const choice = await vscode.window.showQuickPick(items, {
    placeHolder: "Switch to a running agent",
  });
  if (!choice) {
    return;
  }
  if (choice.launch) {
    return runLauncher(context);
  }
  choice.terminal?.show();
}

/** The launcher quick pick — pick an agent, open a terminal for it. */
async function runLauncher(context: vscode.ExtensionContext): Promise<void> {
    const config = vscode.workspace.getConfiguration("agentQuickpick");
    const userAgents = config.get("agents");
    const detect = config.get<boolean>("detectInstalled", true);
    const launchDelayMs = config.get<number>("launchDelayMs", 300);

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
        launchAgent(choice.agent, context.globalState, launchDelayMs, lifecycleCtx);
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
        launchAgent(sel.agent, context.globalState, launchDelayMs, lifecycleCtx);
      }
    });

    render();
    qp.show();
}

/**
 * Lifecycle awareness context — owns the HTTP server, session-state map, status
 * bar updates, notification toasts, and the prompt-once-globally hook install
 * flow. Created in activate(); passed to launchAgent via a module-level ref so
 * existing call sites don't all need an extra parameter.
 */
class LifecycleContext {
  /**
   * Resolves to the bound server URL once the socket is listening. The port
   * isn't known synchronously after `listen()`, so callers that need to inject
   * the URL into a terminal must `await` {@link hookUrl}.
   */
  private readonly serverUrlPromise: Promise<string>;
  private readonly sessions = new Map<string, SessionState>();
  private readonly statusItem: vscode.StatusBarItem;
  private readonly context: vscode.ExtensionContext;
  private readonly server: { url: Promise<string>; dispose: () => void };
  private readonly pollTimer: NodeJS.Timeout;
  private readonly closeDisposable: vscode.Disposable;

  constructor(context: vscode.ExtensionContext, statusItem: vscode.StatusBarItem) {
    this.context = context;
    this.statusItem = statusItem;

    this.server = startLifecycleServer((payload) => this.onHookEvent(payload));
    this.serverUrlPromise = this.server.url;

    // Universal fallback: poll exit statuses every 3s for agents whose process
    // has exited (detects finished/failed even without hooks). The agent set is
    // recomputed each tick so a runtime config change (adding a new agent entry)
    // is picked up without a window reload — matching the live-config behavior
    // the onDidChangeConfiguration handler elsewhere promises.
    this.pollTimer = setInterval(() => {
      const agentNames = new Set(
        loadAgents(
          vscode.workspace.getConfiguration("agentQuickpick").get("agents")
        ).map((a) => a.name.toLowerCase())
      );
      const exited = pollExitStatuses(
        vscode.window.terminals,
        this.sessions,
        agentNames
      );
      let changed = false;
      const now = Date.now();
      for (const [name, exit] of exited) {
        const prev = this.sessions.get(name);
        // Monotonic-failed: never demote a terminal failure (e.g. a late Stop
        // hook arriving after a non-zero exit must not flip failed → finished).
        if (prev && prev.status === "failed" && exit.status === "finished") {
          continue;
        }
        this.sessions.set(name, {
          name,
          agentName: prev?.agentName ?? name.replace(/ \(\d+\)$/, ""),
          status: exit.status,
          changedAt: now,
          exitCode: exit.exitCode,
        });
        changed = true;
        this.maybeNotify(name, exit.status, exit.exitCode);
      }
      if (changed) {
        this.refreshStatusBar();
      }
    }, 3000);

    // Clean up the session map when a terminal closes, so the status-bar count
    // doesn't drift upward over a long session. Without this, entries were
    // never removed (no eviction existed).
    this.closeDisposable = vscode.window.onDidCloseTerminal((t) => {
      if (this.sessions.delete(t.name)) {
        this.refreshStatusBar();
      }
    });
  }

  /**
   * Re-adopt agent terminals that survived a window reload into the in-memory
   * sessions Map. Without this, {@link onHookEvent} would drop every incoming
   * hook after a reload (the Map starts empty), silently disabling all
   * notifications — including "needs input" — until the user manually
   * relaunches each agent. Re-adopted sessions default to "running"; the next
   * hook (or the exit poller) corrects them.
   */
  seedFromOpenTerminals(agentNames: Set<string>): void {
    const matches = matchSessionTerminals(
      vscode.window.terminals.map((t) => t.name),
      agentNames
    );
    const now = Date.now();
    let changed = false;
    for (const { name, agentName } of matches) {
      if (!this.sessions.has(name)) {
        this.sessions.set(name, { name, agentName, status: "running", changedAt: now });
        changed = true;
      }
    }
    if (changed) {
      this.refreshStatusBar();
    }
  }

  /** Register a newly-launched agent terminal as a running session. */
  trackSession(tabName: string, agentName: string): void {
    this.sessions.set(tabName, {
      name: tabName,
      agentName,
      status: "running",
      changedAt: Date.now(),
    });
    this.refreshStatusBar();
  }

  /** Handle a hook payload POSTed by an agent's lifecycle hook. */
  private onHookEvent(payload: HookPayload): void {
    if (!payload.session || !payload.status) {
      return;
    }
    const status = payload.status as LifecycleStatus;
    const prev = this.sessions.get(payload.session);
    if (!prev) {
      return; // unknown session — ignore (e.g. from a different window)
    }
    // Monotonic-failed: a terminal failure (non-zero exit) must not be
    // overwritten by a late hook claiming success.
    if (prev.status === "failed" && status === "finished") {
      return;
    }
    this.sessions.set(payload.session, {
      ...prev,
      status,
      changedAt: Date.now(),
    });
    this.refreshStatusBar();
    this.maybeNotify(payload.session, status);
  }

  /** Fire a notification toast if appropriate for this status change. */
  private maybeNotify(session: string, status: LifecycleStatus, exitCode?: number): void {
    const settingOn = vscode.workspace
      .getConfiguration("agentQuickpick")
      .get<boolean>("lifecycleNotifications", true);
    const activeTerminal = vscode.window.activeTerminal;
    const isActive =
      !!activeTerminal && activeTerminal.name === session;
    if (!shouldNotify(status, isActive, settingOn)) {
      return;
    }
    const sessionState = this.sessions.get(session);
    const agentName = sessionState?.agentName ?? session;
    const repo = vscode.workspace.workspaceFolders?.[0]?.name;
    const msg = notificationMessage(agentName, status, repo, exitCode);
    if (!msg) {
      return;
    }
    const show = status === "failed"
      ? (t: string, ...a: string[]) => vscode.window.showErrorMessage(t, ...a)
      : (t: string, ...a: string[]) => vscode.window.showInformationMessage(t, ...a);
    show(msg.text, msg.action).then((choice) => {
      if (choice === msg.action) {
        const terminal = vscode.window.terminals.find((t) => t.name === session);
        terminal?.show();
      }
    });
  }

  /** Look up a tracked session's state by terminal/tab name. */
  getSessionState(tabName: string): SessionState | undefined {
    return this.sessions.get(tabName);
  }

  /** Recompute status-bar text + tooltip from the current sessions map. */
  refreshStatusBar(): void {
    const states = [...this.sessions.values()];
    const counts = countByStatus(states);
    this.statusItem.text = statusBarText(counts);
    this.statusItem.tooltip = statusBarTooltip(states);
  }

  /**
   * The absolute filesystem path we install/remove for an adapter — the JSON
   * config for command-hook agents, the plugin file for plugin-file agents.
   * Command-hook paths are home-relative; the OpenCode plugin path is relative
   * to OpenCode's config dir, which is resolved per-platform (NOT a hardcoded
   * `~/.config/opencode` — that's wrong on Windows and ignores
   * `OPENCODE_CONFIG_DIR`).
   */
  private adapterFsPath(adapter: LifecycleAdapter): string {
    if (adapter.kind === "command-hooks") {
      return path.join(os.homedir(), adapter.configPath);
    }
    const configDir = resolveOpenCodeConfigDir(process.env, process.platform, os.homedir());
    return path.join(configDir, adapter.pluginPath);
  }

  /**
   * A display path for the user. Command-hook adapters show `~/...`; the
   * OpenCode plugin shows the resolved config dir (which may not be under home
   * on Windows or when `OPENCODE_CONFIG_DIR` is set).
   */
  private adapterDisplayPath(adapter: LifecycleAdapter): string {
    if (adapter.kind === "command-hooks") {
      return `~/${adapter.configPath}`;
    }
    const configDir = resolveOpenCodeConfigDir(process.env, process.platform, os.homedir());
    return path.join(configDir, adapter.pluginPath);
  }

  /**
   * Prompt once (ever) to install the lifecycle hook for an adapter, globally.
   * Idempotent: remembered in globalState as "installed" or "declined", keyed by
   * marker alone (no workspace) — so a fresh repo never re-prompts.
   */
  async maybePromptInstall(adapter: LifecycleAdapter): Promise<void> {
    const flagKey = `hooks.${adapter.marker}.global`;
    const flag = this.context.globalState.get<string>(flagKey);
    if (flag === "installed" || flag === "declined") {
      return;
    }

    const choice = await vscode.window.showInformationMessage(
      `Get notified when ${adapter.agentName} finishes or needs input? Installs a lightweight ` +
        `hook, removable anytime.`,
      "Install",
      "Not now"
    );

    if (choice === "Install") {
      try {
        await this.installHook(adapter);
        this.context.globalState.update(flagKey, "installed");
        vscode.window.showInformationMessage(
          `Lifecycle hook installed in ${this.adapterDisplayPath(adapter)}.`
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to install lifecycle hook: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } else {
      this.context.globalState.update(flagKey, "declined");
    }
  }

  /**
   * Resolve the bound server URL. The port isn't known until the socket is
   * listening, so this awaits the listening event rather than reading
   * `server.address()` synchronously (which yields port 0).
   */
  hookUrl(): Promise<string> {
    return this.serverUrlPromise;
  }

  /** Write the hook into the adapter's global config / plugin file. */
  private async installHook(adapter: LifecycleAdapter): Promise<void> {
    const fsPath = this.adapterFsPath(adapter);
    const hookUrl = await this.hookUrl();

    if (adapter.kind === "plugin-file") {
      await fs.promises.mkdir(path.dirname(fsPath), { recursive: true });
      const source = adapter.buildSource(hookUrl, "");
      await fs.promises.writeFile(fsPath, source, "utf8");
      return;
    }

    // command-hooks: merge into the JSON config, preserving user content.
    let existing: unknown = {};
    try {
      const text = await fs.promises.readFile(fsPath, "utf8");
      existing = readConfigJson(text);
    } catch {
      // File doesn't exist yet — start from {}.
    }
    if (adapter.hasOurHooks(existing)) {
      return; // already installed (idempotent)
    }
    const merged = adapter.mergeHooks(existing, hookUrl, "");
    await fs.promises.mkdir(path.dirname(fsPath), { recursive: true });
    await fs.promises.writeFile(fsPath, writeConfigJson(merged), "utf8");
  }

  /**
   * Remove our hook from every adapter's global config / plugin file.
   * Used by the `agentQuickpick.removeHooks` command. Also resets every
   * adapter's install-prompt flag so the next launch re-prompts.
   */
  async removeAllHooks(): Promise<string[]> {
    const touched: string[] = [];

    for (const adapter of Object.values(LIFECYCLE_ADAPTERS)) {
      const fsPath = this.adapterFsPath(adapter);

      // Reset the install flag unconditionally — even when there is nothing to
      // strip (user previously declined, or the files were deleted by hand) —
      // otherwise a "declined" choice could never be undone via this command.
      this.context.globalState.update(`hooks.${adapter.marker}.global`, undefined);

      if (adapter.kind === "plugin-file") {
        try {
          await fs.promises.unlink(fsPath);
          touched.push(this.adapterDisplayPath(adapter));
        } catch {
          // not present — nothing to remove
        }
      } else {
        let text: string;
        try {
          text = await fs.promises.readFile(fsPath, "utf8");
        } catch {
          continue; // file doesn't exist — skip
        }
        const parsed = readConfigJson(text);
        if (!adapter.hasOurHooks(parsed)) {
          continue;
        }
        const stripped = adapter.stripHooks(parsed);
        await fs.promises.writeFile(fsPath, writeConfigJson(stripped), "utf8");
        touched.push(this.adapterDisplayPath(adapter));
      }
    }
    return touched;
  }

  /**
   * One-time-per-workspace cleanup of the older *workspace-local* hooks a
   * pre-global build wrote (`.claude/settings.local.json`, `.factory/settings.json`,
   * `opencode.json` + `.opencode/agent-quickpick-lifecycle.mjs`). Strips only
   * our own entries (by marker) and prunes the OpenCode plugin file. Silent — no
   * prompt, no error surface — since it's housekeeping, not a user action.
   */
  async migrateWorkspaceHooks(): Promise<void> {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) {
      return;
    }
    const wsKey = wsFolder.uri.fsPath.replace(/[^a-zA-Z0-9]/g, "_");
    const flagKey = `migration.workspaceHooks.${wsKey}`;
    if (this.context.globalState.get<boolean>(flagKey)) {
      return;
    }

    const baseDir = wsFolder.uri.fsPath;
    const stripJson = async (
      rel: string,
      strip: (parsed: unknown) => unknown,
      has: (parsed: unknown) => boolean
    ) => {
      const p = path.join(baseDir, rel);
      try {
        const parsed = readConfigJson(await fs.promises.readFile(p, "utf8"));
        if (has(parsed)) {
          await fs.promises.writeFile(p, writeConfigJson(strip(parsed)), "utf8");
        }
      } catch {
        // missing/unreadable — nothing to migrate
      }
    };

    // Claude & Droid: same marker/schema as the global adapters, just at the old
    // workspace paths.
    await stripJson(
      ".claude/settings.local.json",
      (c) => CLAUDE_ADAPTER.stripHooks(c),
      (c) => CLAUDE_ADAPTER.hasOurHooks(c)
    );
    await stripJson(
      ".factory/settings.json",
      (c) => DROID_ADAPTER.stripHooks(c),
      (c) => DROID_ADAPTER.hasOurHooks(c)
    );

    // OpenCode (old): a file:// entry in opencode.json's plugin[] + a plugin
    // .mjs on disk.
    const OLD_OPENCODE_PLUGIN = ".opencode/agent-quickpick-lifecycle.mjs";
    await stripJson(
      "opencode.json",
      (c) => stripOldOpencodePlugin(c),
      (c) => hasOldOpencodePlugin(c)
    );
    try {
      await fs.promises.unlink(path.join(baseDir, OLD_OPENCODE_PLUGIN));
    } catch {
      // already gone — fine
    }

    this.context.globalState.update(flagKey, true);
  }

  dispose(): void {
    clearInterval(this.pollTimer);
    this.closeDisposable.dispose();
    this.server.dispose();
  }
}

// Module-level lifecycle context, set in activate(). Null when the lifecycle
// feature is not active (e.g. in unit tests that don't call activate).
let lifecycleCtx: LifecycleContext | undefined;

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

  // Status bar button → shows running agent sessions (falls through to the
  // launcher when none are running). Visibility follows
  // agentQuickpick.showStatusBar (default true) and updates live on config change.
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
  statusItem.command = "agentQuickpick.sessions";
  statusItem.text = "$(agent-quickpick) Agent";
  statusItem.tooltip = "Running agents — switch or launch";
  const syncStatusBar = () => {
    const show = vscode.workspace
      .getConfiguration("agentQuickpick")
      .get<boolean>("showStatusBar", true);
    if (show) {
      statusItem.show();
    } else {
      statusItem.hide();
    }
  };
  syncStatusBar();
  context.subscriptions.push(
    statusItem,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("agentQuickpick.showStatusBar")) {
        syncStatusBar();
      }
    })
  );

  // Lifecycle awareness — HTTP server for agent hooks, session tracking, live
  // status-bar counts, and notification toasts. Owns its own poll timer.
  lifecycleCtx = new LifecycleContext(context, statusItem);
  context.subscriptions.push({ dispose: () => lifecycleCtx?.dispose() });

  // Re-adopt any agent terminals that survived a window reload, so lifecycle
  // hooks/notifications keep working without a manual relaunch. Without this,
  // the in-memory sessions Map starts empty on every reload and onHookEvent
  // would drop every incoming POST — silently disabling all notifications.
  lifecycleCtx.seedFromOpenTerminals(
    new Set(
      loadAgents(
        vscode.workspace.getConfiguration("agentQuickpick").get("agents")
      ).map((a) => a.name.toLowerCase())
    )
  );

  // One-time cleanup of any older workspace-local hooks a pre-global build left
  // in this repo. Silent housekeeping — never blocks activation.
  lifecycleCtx.migrateWorkspaceHooks().catch(() => {
    // migration failures are non-fatal
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("agentQuickpick.open", () => runLauncher(context)),
    vscode.commands.registerCommand("agentQuickpick.sessions", () => runSessions(context)),
    vscode.commands.registerCommand("agentQuickpick.removeHooks", async () => {
      if (!lifecycleCtx) {
        return;
      }
      const touched = await lifecycleCtx.removeAllHooks();
      if (touched.length === 0) {
        vscode.window.showInformationMessage(
          "No lifecycle hooks found to remove in this workspace."
        );
      } else {
        vscode.window.showInformationMessage(
          `Removed lifecycle hooks from: ${touched.join(", ")}`
        );
      }
    })
  );
}

export function deactivate() {}
