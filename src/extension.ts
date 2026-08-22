import * as vscode from "vscode";
import { spawn } from "child_process";
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
  filterSessionsByFolder,
  STATUS_LABEL,
  STATUS_GLYPH,
  shouldNotify,
  notificationMessage,
  classifyWaitingMessage,
  waitingLabel,
  HOOK_ENV,
  type SystemNotifyMode,
  type SpawnSpec,
  type WaitingReason,
  shouldSystemNotify,
  shouldPlaySound,
  systemNotifyCommand,
  notifierCandidates,
  sanitizeArgvText,
  soundPlayCommand,
  SOUND_FILE_DEFAULT,
  VENDORED_NOTIFIER_REL,
  FOCUS_URI_PATH,
  FOCUS_URI_SESSION_PARAM,
  sessionFromFocusUri,
} from "./lifecycle";
import {
  LIFECYCLE_ADAPTERS,
  CLAUDE_ADAPTER,
  DROID_ADAPTER,
  getAdapter,
  isLifecycleAgent,
  isAbsoluteForPlatform,
  resolveValidatedOpenCodeConfigDir,
} from "./lifecycle-adapters";
import {
  type AgentConfig,
  type ResolvedAgent,
  ALLOWED_COLORS,
  loadAgents,
  readFrecency,
  recordLaunch,
  frecencyScore,
  sortByFrecency,
  isCmdInstalled,
  isSessionTerminal,
  clearInstallCache,
  launchText,
  launchDelay,
  uniqueTerminalName,
  matchSessionTerminals,
} from "./agents";

/**
 * The marker substring the old (workspace-local) OpenCode install left in
 * `opencode.json`'s `plugin[]`. Kept here (not in the adapter) because the
 * current OpenCode adapter is plugin-file based and no longer touches JSON;
 * this is migration-only.
 */
const OLD_OPENCODE_PLUGIN_MARKER = "agent-quickpick-lifecycle";

// Capture OpenCode-related env vars once at module load so the rest of the
// code uses stable constants rather than repeatedly reading `process.env`.
const OPENCODE_CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR;
const XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
const APPDATA = process.env.APPDATA;
const LOCALAPPDATA = process.env.LOCALAPPDATA;

/**
 * The four OpenCode/XDG overrides as a snapshot object, fed to the pure
 * {@link resolveValidatedOpenCodeConfigDir} so config-dir resolution never
 * reads `process.env` outside module load.
 */
const OPENCODE_ENV_SNAPSHOT = {
  OPENCODE_CONFIG_DIR,
  XDG_CONFIG_HOME,
  APPDATA,
  LOCALAPPDATA,
};

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

  // Otherwise: a filename bundled in the extension's icons folder — must exist
  // and stay inside that folder (no path traversal).
  try {
    const root = path.resolve(extensionUri.fsPath, "icons");
    const fsPath = path.resolve(root, trimmed);
    if (
      (fsPath === root || fsPath.startsWith(root + path.sep)) &&
      fs.existsSync(fsPath)
    ) {
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
 * Resolve the workspace folder the status bar / sessions picker should be
 * scoped to. Prefers the folder of the active editor (so the bar follows the
 * file you're looking at in a multi-root workspace), then falls back to the
 * first workspace folder, then `undefined` when no workspace is open (in which
 * case the bar aggregates everything, preserving pre-filter behavior).
 */
function activeWorkspaceFolder(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) {
      return folder.uri.fsPath;
    }
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
    lifecycle.trackSession(tabName, agent.name, activeWorkspaceFolder());
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

type LauncherItem = vscode.QuickPickItem & { agent?: ResolvedAgent };

/**
 * The currently-open launcher quick pick, if any. A second ⌘⇧A press while
 * it's open swaps it for the sessions picker (see the agentQuickpick.open
 * handler). Undefined whenever the launcher isn't showing.
 */
let launcherPick: vscode.QuickPick<LauncherItem> | undefined;

/**
 * Double-tap window: a second press of the agentQuickpick.open command within
 * this interval opens the sessions picker instead of the agent launcher.
 * Matches OS double-click timing. Detection is keyed to the command, not the
 * physical key, so it follows whatever key the user rebound the command to.
 * Hardcoded per design (no user setting).
 */
const OPEN_DOUBLE_TAP_MS = 250;
let openTapTimer: NodeJS.Timeout | undefined;
let lastOpenTapAt = 0;

/**
 * Show a quick pick of currently-running agent terminals (matched by name) and
 * focus the chosen one. When nothing is running, falls through to the launcher.
 * When sessions exist, a trailing "Launch new agent…" item re-enters the launcher.
 */
async function runSessions(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration("agentQuickpick");
  const configs = loadAgents(config.get("agents"));
  const agentNames = new Set(configs.map((c) => c.name.toLowerCase()));

  // Match against all agent terminals, then filter by the active workspace
  // folder — same predicate as the status bar (`folderOf`) — so the picker
  // shows only this repo's sessions. Re-adopted sessions without a known
  // folder are excluded when an active folder is set.
  const folder = activeWorkspaceFolder();
  const sessions = vscode.window.terminals.filter((t) => {
    if (!isSessionTerminal(t.name, agentNames)) {
      return false;
    }
    const state = lifecycleCtx?.getSessionState(t.name);
    if (!state) {
      return folder === undefined;
    }
    const attributed = state.cwd ?? state.launchedInFolder;
    return folder === undefined || attributed === folder;
  });

  // Nothing running in this repo → skip the empty list, go straight to launching.
  if (sessions.length === 0) {
    return runLauncher(context);
  }

  type Item = vscode.QuickPickItem & { terminal?: vscode.Terminal; launch?: boolean };

  const iconOf = (t: vscode.Terminal): vscode.IconPath | undefined => {
    const opts = t.creationOptions as vscode.TerminalOptions;
    return opts?.iconPath ?? new vscode.ThemeIcon("terminal");
  };

  // Sort attention-needing sessions to the top:
  // blocked → failed → done → working → reconnecting.
  const order: Record<LifecycleStatus, number> = {
    waiting: 0,
    failed: 1,
    finished: 2,
    running: 3,
    unknown: 4,
  };
  const statusOf = (t: vscode.Terminal): LifecycleStatus =>
    lifecycleCtx?.getSessionState(t.name)?.status ?? "running";

  const items: Item[] = [...sessions]
    .sort((a, b) => order[statusOf(a)] - order[statusOf(b)])
    .map((t) => {
      const state = lifecycleCtx?.getSessionState(t.name);
      const status = state?.status ?? "running";
      // Reason-aware wait label, so the picker says "⏸ wants a command approved"
      // instead of a generic "⏸ blocked" when the agent is blocked on an approval.
      const label = status === "waiting"
        ? waitingLabel(state?.waitingReason)
        : STATUS_LABEL[status];
      return {
        label: t.name,
        description: `${STATUS_GLYPH[status]} ${label}`,
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

    // Show the pick immediately (busy while install detection resolves) so the
    // handle exists synchronously — a second ⌘⇧A press can swap it for the
    // sessions picker even mid-resolution.
    const qp = vscode.window.createQuickPick<LauncherItem>();
    qp.placeholder = "Open agent terminal";
    qp.matchOnDescription = true;
    qp.busy = true;
    qp.items = [];
    launcherPick = qp;

    qp.onDidAccept(() => {
      const sel = qp.selectedItems[0];
      if (sel?.agent) {
        qp.hide();
        launchAgent(sel.agent, context.globalState, launchDelayMs, lifecycleCtx);
      }
    });
    qp.onDidHide(() => {
      if (launcherPick === qp) {
        launcherPick = undefined;
      }
      qp.dispose();
    });

    qp.show();

    const configs = loadAgents(userAgents);
    const agents = await resolveAgents(configs, context.extensionUri, detect);

    // Superseded while resolving (second ⌘⇧A press hid this pick) — don't
    // populate or re-show it.
    if (launcherPick !== qp) {
      return;
    }

    // Sort by frecency (launch count + recency) so the most-used agents float
    // to the top. Stable sort → never-launched agents keep curated order.
    const now = Date.now();
    const frecency = readFrecency(context.globalState);
    const sortedAgents = sortByFrecency(agents, (a) => {
      const e = frecency[a.name.toLowerCase()];
      return e ? frecencyScore(e.c, e.t, now) : 0;
    });

    const toItem = (agent: ResolvedAgent): LauncherItem => ({
      label: agent.name,
      // Show the actual command that will be sent (incl. launcher prefix).
      description: agent.isPlainTerminal ? "shell" : launchText(agent) || agent.cmd,
      iconPath: agent.iconPath,
      agent,
    });

    // Plain Terminal is always considered installed; everything else depends on detection.
    const installedItems = sortedAgents.filter((a) => a.installed).map(toItem);
    const uninstalledItems = sortedAgents.filter((a) => !a.installed).map(toItem);

    // When detection is off (or nothing is uninstalled), show the flat list
    // with no eye toggle.
    const showToggle = detect && uninstalledItems.length > 0;

    const separator: LauncherItem = {
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
        qp.buttons = showToggle ? [showAllBtn] : [];
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

    qp.busy = false;
    render();
}

/**
 * Lifecycle awareness context — owns the HTTP server, session-state map, status
 * bar updates, notification toasts, and the prompt-once-globally hook install
 * flow. Created in activate(); passed to launchAgent via a module-level ref so
 * existing call sites don't all need an extra parameter.
 */
/**
 * Spawn a {@link SpawnSpec} without waiting on it and without ever throwing.
 *
 * Notifications and sounds are cosmetic: a missing `notify-send`, a locked audio
 * device, or a PowerShell execution policy must not surface an error or block
 * the lifecycle pipeline. Errors are swallowed; `fallback` gets exactly one try
 * (Linux has no single guaranteed audio player). `unref()` so a stuck child
 * never keeps the extension host alive.
 */
function fireAndForget(spec: SpawnSpec | null): void {
  if (!spec) {
    return;
  }
  try {
    const child = spawn(spec.file, spec.args, {
      stdio: "ignore",
      env: spec.env ? { ...process.env, ...spec.env } : process.env,
      windowsHide: true,
    });
    child.on("error", () => fireAndForget(spec.fallback ?? null));
    child.unref();
  } catch {
    fireAndForget(spec.fallback ?? null);
  }
}

/**
 * The bundle identifier of the running editor, for attributing macOS
 * notifications via `-sender`. macOS sets `__CFBundleIdentifier` in the
 * environment of any app launched from its bundle, which covers VS Code,
 * Insiders, VSCodium, Cursor, Windsurf, and Trae without hardcoding a list.
 *
 * If `__CFBundleIdentifier` is unset (a sanitized env, or a non-GUI launch) we
 * only assume VS Code when `vscode.env.uriScheme` agrees — otherwise a fork
 * would wrongly wear VS Code's icon. With no safe guess we return `undefined`
 * and `systemNotifyCommand` falls back to `osascript`. Never an error:
 * notification playback is fire-and-forget.
 */
function hostBundleId(): string | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }
  const id = process.env.__CFBundleIdentifier;
  if (id) {
    return id;
  }
  // No bundle id from the env. Only guess VS Code when the URI scheme agrees, so
  // a fork (cursor/trae/windsurf) never wears VS Code's icon by mistake.
  switch (vscode.env.uriScheme) {
    case "vscode":
      return "com.microsoft.VSCode";
    case "vscode-insiders":
      return "com.microsoft.VSCodeInsiders";
    default:
      return undefined;
  }
}

/**
 * Absolute path to `terminal-notifier`, or `undefined` if none is available.
 *
 * Prefers a user-installed copy (Homebrew/MacPorts); falls back to the
 * universal `.app` bundled with the extension so a fresh install still posts a
 * banner that wears the running editor's icon rather than Script Editor's.
 * `$PATH` is deliberately not probed: an editor launched from Finder/Dock
 * inherits launchd's PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), which has neither
 * Homebrew prefix, so probing would only add noise (and env-derived taint).
 * Probed once per window (an install/uninstall mid-session is not worth a stat
 * per notification). Off macOS this always resolves to `undefined` —
 * `terminal-notifier` is darwin-only.
 */
const notifierPath = (() => {
  let cached: string | null | undefined;
  let cachedFor: string | undefined;
  return (extensionPath: string): string | undefined => {
    if (cached !== undefined && cachedFor === extensionPath) {
      return cached ?? undefined;
    }
    cachedFor = extensionPath;
    cached =
      notifierCandidates(extensionPath, process.platform).find(
        (p) => {
          try {
            return fs.statSync(p).isFile();
          } catch {
            return false;
          }
        }
      ) ?? null;
    // An unpacker can strip the executable bit off the bundled Mach-O; restore it
    // best-effort so the first notification posts instead of silently ENOEXEC-ing
    // down to the Script Editor fallback. Only the vendored binary is ours to fix.
    if (cached !== null && cached.endsWith(VENDORED_NOTIFIER_REL)) {
      try {
        fs.chmodSync(cached, 0o755);
      } catch {
        // ignore — fire-and-forget spawn still tries, then falls back to osascript
      }
    }
    return cached ?? undefined;
  };
})();

/**
 * The URI that focuses a session's terminal when its OS notification is clicked,
 * parsed back by the handler via {@link sessionFromFocusUri}. Uses
 * `vscode.env.uriScheme` so it resolves to whichever editor is running (`vscode`,
 * `vscode-insiders`, `cursor`, …) rather than hardcoding stable VS Code. Opening
 * this URI on click is also what raises the editor window: LaunchServices
 * activates the app that registered the scheme.
 */
function focusUri(extensionId: string, session: string): string {
  const q = new URLSearchParams({
    [FOCUS_URI_SESSION_PARAM]: session,
  });
  return `${vscode.env.uriScheme}://${extensionId}${FOCUS_URI_PATH}?${q.toString()}`;
}

/**
 * Write a file by writing a sibling temp file and renaming it over the target.
 * The rename is atomic on the same filesystem, so a crash or a concurrent reader
 * never sees a half-written file — this matters because the targets are the
 * user's own `~/.claude/settings.json` / `~/.factory/settings.json`, which a
 * truncated write would break for every agent session, not just ours.
 *
 * The temp name is unique per call (pid + counter) so two windows installing at
 * once can't collide on it. Falls back to a plain write if the rename fails
 * (e.g. an exotic filesystem), since a best-effort write beats none.
 */
let atomicWriteSeq = 0;
async function writeFileAtomic(fsPath: string, content: string): Promise<void> {
  const tmpPath = `${fsPath}.aqp-${process.pid}-${atomicWriteSeq++}.tmp`;
  try {
    await fs.promises.writeFile(tmpPath, content, "utf8");
    await fs.promises.rename(tmpPath, fsPath);
  } catch {
    await fs.promises.unlink(tmpPath).catch(() => {});
    await fs.promises.writeFile(fsPath, content, "utf8");
  }
}

export class LifecycleContext {
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

    // Persist the current URL to a stable, install-time-baked path so a hook
    // command written before this activation (frozen `AQP_HOOK_URL` env, dead
    // port) can still find the live server — see the resolution order
    // documented on `buildNodeHookCommand`. Best-effort: a write failure just
    // means stale-terminal recovery falls back to the frozen env var, same as
    // before this existed.
    this.serverUrlPromise
      .then(async (url) => {
        try {
          await fs.promises.mkdir(path.dirname(this.portFilePath()), {
            recursive: true,
          });
          await writeFileAtomic(
            this.portFilePath(),
            JSON.stringify({ url })
          );
        } catch {
          // Non-fatal — see comment above.
        }
      })
      .catch(() => {
        // Server failed to bind — nothing to persist.
      });

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
          // Preserve any repo-association fields we already had so a
          // hook-reported cwd or the launch folder survives a poller update.
          ...(prev?.launchedInFolder ? { launchedInFolder: prev.launchedInFolder } : {}),
          ...(prev?.cwd ? { cwd: prev.cwd } : {}),
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
    * relaunches each agent. Re-adopted sessions default to "unknown" (we know
    * the tab exists, but not its real state); the next hook (or the exit
    * poller) promotes them. Neither `cwd` nor `launchedInFolder` is known for
    * re-adopted sessions, so they're hidden from the repo-scoped bar until a
    * hook arrives carrying `cwd`.
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
         this.sessions.set(name, { name, agentName, status: "unknown", changedAt: now });
         changed = true;
       }
     }
     if (changed) {
       this.refreshStatusBar();
     }
   }

   /**
    * Register a newly-launched agent terminal as a running session. The
    * launching workspace folder is captured once and treated as immutable — it
    * is the fallback for repo-scoping until a hook arrives with the agent's
    * real `cwd`.
    */
   trackSession(tabName: string, agentName: string, launchedInFolder?: string): void {
     this.sessions.set(tabName, {
       name: tabName,
       agentName,
       status: "running",
       changedAt: Date.now(),
       ...(launchedInFolder ? { launchedInFolder } : {}),
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
     // A hook carrying `cwd` is the source of truth for the session's repo
     // (accounts for `cd` inside the agent). Empty/absent cwd is ignored so we
     // never clobber an existing value with nothing.
     const cwd = typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : prev.cwd;
     // Why the agent is waiting, when the payload can tell: OpenCode sends a
     // typed reason; Claude only a free-text message we classify. A typed
     // reason always wins; the classifier is the fallback. Only meaningful
     // while waiting — cleared on every other transition so a stale reason
     // can't outlive its wait.
     const waitingReason: WaitingReason | undefined =
       status === "waiting"
         ? payload.reason ?? classifyWaitingMessage(payload.message)
         : undefined;
     this.sessions.set(payload.session, {
       ...prev,
       status,
       changedAt: Date.now(),
       ...(cwd ? { cwd } : {}),
       waitingReason,
     });
     this.refreshStatusBar();
     this.maybeNotify(payload.session, status, undefined, waitingReason);
   }

  /**
   * Announce a status change across the three channels: in-editor toast, native
   * OS notification, and the Agent Quickpick sound.
   *
   * Each channel is gated independently — the toast is suppressed when the
   * agent's terminal is already focused, the OS notification is gated on window
   * focus, and the sound fires for any announced status. So a status change can
   * legitimately produce a sound + OS notification and no toast (VS Code in the
   * background), or a toast + sound and no OS notification (window focused).
   */
  private maybeNotify(session: string, status: LifecycleStatus, exitCode?: number, waitingReason?: WaitingReason): void {
    const config = vscode.workspace.getConfiguration("agentQuickpick");
    const settingOn = config.get<boolean>("lifecycleNotifications", true);
    const systemMode = config.get<SystemNotifyMode>(
      "systemNotifications",
      "always"
    );
    const soundOn = config.get<boolean>("notificationSound", true);

    const activeTerminal = vscode.window.activeTerminal;
    const isActive = !!activeTerminal && activeTerminal.name === session;

    const sessionState = this.sessions.get(session);
    const agentName = sessionState?.agentName ?? session;
    const repo = vscode.workspace.workspaceFolders?.[0]?.name;
    const msg = notificationMessage(agentName, status, repo, exitCode, waitingReason);
    if (!msg) {
      return;
    }

    if (shouldNotify(status, isActive, settingOn)) {
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

    if (
      shouldSystemNotify(systemMode, status, vscode.window.state.focused, settingOn)
    ) {
      // Title carries the product name (an OS notification has no VS Code
      // chrome to identify it); the body reuses the toast copy verbatim. The
      // bundle id (macOS only) makes the banner wear the editor's icon instead
      // of Script Editor's, and the URI makes a click land on this agent's
      // terminal — see `systemNotifyCommand`.
      // Sanitize the rendered body in this file as well so static taint is killed
      // before it reaches the subprocess helper.
      const safeBody = sanitizeArgvText(msg.text);
      fireAndForget(
        systemNotifyCommand(process.platform, "Agent Quickpick", safeBody, {
          bundleId: hostBundleId(),
          notifierPath: notifierPath(this.context.extensionPath),
          openUrl: focusUri(this.context.extension.id, session),
        })
      );
    }

    if (shouldPlaySound(soundOn, status, settingOn)) {
      this.playSound();
    }
  }

  /**
   * Play the notification cue. One bundled sound for every announced status,
   * honoring a user-supplied absolute path from
   * `agentQuickpick.notificationSoundPath`. Silent no-op when the resolved file
   * is missing — a bad path must never break the lifecycle pipeline.
   */
  private playSound(): void {
    const custom = vscode.workspace
      .getConfiguration("agentQuickpick")
      .get<string>("notificationSoundPath", "")
      .trim();

    const soundPath = custom
      ? custom
      : path.join(this.context.extensionPath, SOUND_FILE_DEFAULT);

    try {
      if (!fs.statSync(soundPath).isFile()) {
        return;
      }
    } catch {
      return;
    }
    fireAndForget(soundPlayCommand(process.platform, soundPath));
  }

  /** Look up a tracked session's state by terminal/tab name. */
  getSessionState(tabName: string): SessionState | undefined {
    return this.sessions.get(tabName);
  }

  /**
   * Recompute status-bar text + tooltip from the current sessions map,
   * filtered to the active workspace folder. When no workspace is open, all
   * sessions are shown (preserves pre-filter behavior). Also re-scoped on
   * editor focus changes — see the onDidChangeActiveTextEditor subscription
   * wired in activate().
   */
   refreshStatusBar(): void {
     const folder = activeWorkspaceFolder();
     const all = [...this.sessions.values()];
     const states = filterSessionsByFolder(all, folder);
     const counts = countByStatus(states);
     this.statusItem.text = statusBarText(counts);
     this.statusItem.tooltip = statusBarTooltip(states);
   }

  /**
   * Resolve OpenCode's config dir once per call site group, verifying the
   * result is absolute **here at the sink**. The resolver itself already
   * throws on non-absolute results, but the invariant is re-asserted locally
   * so a future refactor of the resolver can never let an env-derived
   * relative path reach the path.join → filesystem-write below.
   */
  private opencodeConfigDir(): string {
    const configDir = resolveValidatedOpenCodeConfigDir(
      OPENCODE_ENV_SNAPSHOT,
      process.platform,
      os.homedir()
    );
    if (!isAbsoluteForPlatform(configDir, process.platform)) {
      throw new Error(`OpenCode config dir must be absolute: ${configDir}`);
    }
    return configDir;
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
    return path.join(this.opencodeConfigDir(), adapter.pluginPath);
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
    return path.join(this.opencodeConfigDir(), adapter.pluginPath);
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
   * Silently upgrade every already-installed lifecycle hook to the current
   * {@link HOOK_SCHEMA_VERSION}, with no prompt. Called once from `activate()`
   * on every window (cheap no-op once everything's current). Deliberately
   * scoped to adapters the user already opted into: an adapter that was never
   * installed, or whose install was explicitly declined, is left untouched —
   * this is an upgrade path, not a way to sneak past a decline. Per-adapter
   * failures are swallowed so one broken config can't block the others.
   */
  async autoUpgradeHooks(): Promise<void> {
    for (const adapter of Object.values(LIFECYCLE_ADAPTERS)) {
      const flagKey = `hooks.${adapter.marker}.global`;
      if (this.context.globalState.get<string>(flagKey) !== "installed") {
        continue;
      }
      try {
        await this.installHook(adapter);
      } catch {
        // Non-fatal — same posture as installHook's other callers.
      }
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

  /**
   * Stable path (survives every restart, unlike the port itself) where the
   * current server URL is persisted — see the constructor. Generated hook
   * commands/plugin sources are given this exact path at install/upgrade time
   * so they can find the live server even when their own frozen env var
   * (`AQP_HOOK_URL`, baked into a terminal already open before a restart) is
   * stale. Under `globalStorageUri` since that's the one directory this
   * extension already owns per-install, independent of any workspace.
   */
  private portFilePath(): string {
    return path.join(this.context.globalStorageUri.fsPath, "hook-server.json");
  }

  /**
   * Write the hook into the adapter's global config / plugin file — installing
   * fresh, or silently upgrading a stale install (written by an older
   * extension version) to the current {@link HOOK_SCHEMA_VERSION}. Idempotent:
   * a no-op when the current version is already present.
   *
   * Called both from the one-time install prompt ({@link maybePromptInstall})
   * and from {@link autoUpgradeHooks} (which re-invokes it, unprompted, for
   * every adapter the user already has installed — so a version bump reaches
   * existing users on their next activation with no action on their part).
   */
  private async installHook(adapter: LifecycleAdapter): Promise<void> {
    const fsPath = this.adapterFsPath(adapter);
    const hookUrl = await this.hookUrl();
    const portFilePath = this.portFilePath();

    if (adapter.kind === "plugin-file") {
      // Always regenerated — see buildOpenCodePluginSource's doc comment.
      await fs.promises.mkdir(path.dirname(fsPath), { recursive: true });
      const source = adapter.buildSource(hookUrl, "", portFilePath);
      await writeFileAtomic(fsPath, source);
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
    if (adapter.hasCurrentHooks(existing)) {
      return; // already installed and current (idempotent)
    }
    // Strip a stale (older-schema) install of ours before re-merging the
    // current form, so upgrading doesn't leave the old hook entries alongside
    // the new ones.
    const base = adapter.hasOurHooks(existing)
      ? adapter.stripHooks(existing)
      : existing;
    const merged = adapter.mergeHooks(base, hookUrl, "", portFilePath);
    await fs.promises.mkdir(path.dirname(fsPath), { recursive: true });
    await writeFileAtomic(fsPath, writeConfigJson(merged));
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
        await writeFileAtomic(fsPath, writeConfigJson(stripped));
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
        clearInstallCache();
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

  // Clicking an OS notification opens `<scheme>://<extension-id>/focus?session=…`,
  // which lands here. The banner is posted with `-open <focusUri>` (we avoid
  // `-sender` for clickable notifications because macOS commonly swallows the
  // click action when it attributes the banner to another app). LaunchServices
  // raises the app that registered the scheme, and this handler then reveals the
  // specific agent's terminal. A session whose terminal is gone (closed, or in
  // another window this host can't see) falls through to the sessions picker
  // rather than no-op. Wrapped so a malformed URI never throws.
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri: vscode.Uri) {
        let session: string | null = null;
        try {
          session = sessionFromFocusUri(uri.path, uri.query);
        } catch {
          // malformed query — fall through to the picker below
        }
        if (session) {
          const terminal = vscode.window.terminals.find(
            (t) => t.name === session
          );
          if (terminal) {
            // Reveal + focus this agent's terminal. The URI open has already
            // raised the window; this puts the right terminal on top of it.
            try {
              await terminal.show();
              return;
            } catch {
              // Terminal was disposed concurrently — fall through to sessions picker.
            }
          }
        }
        void vscode.commands.executeCommand("agentQuickpick.sessions");
      },
    })
  );

  // Re-scope the status bar whenever the active editor changes: in a
  // multi-root workspace the active folder (and therefore the set of "this
  // repo's agents") follows the file the user is looking at.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      lifecycleCtx?.refreshStatusBar();
    })
  );

  // Re-scope when folders are added/removed (multi-root changes shift the
  // fallback workspace folder used when no editor is focused).
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      lifecycleCtx?.refreshStatusBar();
    })
  );

  // One-time cleanup of any older workspace-local hooks a pre-global build left
  // in this repo. Silent housekeeping — never blocks activation.
  lifecycleCtx.migrateWorkspaceHooks().catch(() => {
    // migration failures are non-fatal
  });

  // Bring already-installed hooks up to the current schema, with no prompt —
  // so a version bump (new events, new URL-resolution strategy) reaches
  // existing users automatically. Non-fatal, never blocks activation.
  lifecycleCtx.autoUpgradeHooks().catch(() => {
    // upgrade failures are non-fatal
  });

  context.subscriptions.push(
    // Clear any pending single-tap timer on deactivate so a deferred
    // launcher launch can't fire after the extension unloads.
    { dispose: () => { if (openTapTimer) { clearTimeout(openTapTimer); } } }
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentQuickpick.open", () => {
      // If the launcher is already open, a fresh press swaps it for the
      // sessions picker immediately (preserves the pre-double-tap swap UX;
      // orthogonal to the timer because the launcher only opens after the
      // 250ms window has elapsed).
      if (launcherPick) {
        const qp = launcherPick;
        launcherPick = undefined;
        qp.hide();
        return runSessions(context);
      }
      // Double-tap detection: a second press within OPEN_DOUBLE_TAP_MS
      // cancels the pending launcher launch and opens the sessions picker.
      const now = Date.now();
      if (openTapTimer && now - lastOpenTapAt < OPEN_DOUBLE_TAP_MS) {
        clearTimeout(openTapTimer);
        openTapTimer = undefined;
        return runSessions(context);
      }
      // Single tap: defer the launcher by the tap window so a quick second
      // press can promote this tap into a sessions-picker open.
      lastOpenTapAt = now;
      openTapTimer = setTimeout(() => {
        openTapTimer = undefined;
        void runLauncher(context);
      }, OPEN_DOUBLE_TAP_MS);
    }),
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
    }),
    // Open VS Code's Keyboard Shortcuts editor pre-filtered to our binding,
    // so users can rebind agentQuickpick.open to any key/chord. The built-in
    // command takes the search query as its first positional string arg.
    // Double-tap and the launcher-swap gesture follow automatically — they're
    // keyed to the command, not the physical key.
    vscode.commands.registerCommand("agentQuickpick.openKeybindings", () =>
      vscode.commands.executeCommand(
        "workbench.action.openGlobalKeybindings",
        "agentQuickpick.open"
      )
    )
  );
}

export function deactivate() {}
