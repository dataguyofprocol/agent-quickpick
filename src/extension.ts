import * as vscode from "vscode";
import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
  type SessionState,
  type LifecycleStatus,
  pollExitStatuses,
  countByStatus,
  statusBarText,
  statusBarTooltip,
  filterSessionsByFolder,
  folderOf,
  folderBasename,
  STATUS_LABEL,
  STATUS_GLYPH,
  shouldNotify,
  notificationMessage,
  waitingLabel,
  type SystemNotifyMode,
  type SpawnSpec,
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
  terminalCreationName,
} from "./lifecycle";
import { SessionTracker, type SessionTransition } from "./session-tracker";
import { type LegacyIo, cleanupLegacyHooks, stripWorkspaceLegacyHooks } from "./legacy-hooks";
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
  baseTerminalName,
  clearInstallCache,
  launchText,
  launchDelay,
  uniqueTerminalName,
  programStatusEnv,
} from "./agents";
import { reporterLaunch } from "./agent-reporters";

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

/**
 * Launch-delay timers currently pending (see launchAgent). Tracked so
 * deactivation can clear them — a deferred sendText firing after the
 * extension unloads would hit a disposed terminal.
 */
const pendingLaunchTimers = new Set<NodeJS.Timeout>();

/** The `agentStatusReporters` setting. */
function statusReportersEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("agentQuickpick")
    .get<boolean>("agentStatusReporters", true);
}

/** A file's contents, or `undefined` when it cannot be read. */
function readFileIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Create + show a terminal for the given resolved agent. */
async function launchAgent(
  agent: ResolvedAgent,
  state?: vscode.Memento,
  delayMs = 0,
  lifecycle?: LifecycleContext,
  extensionPath?: string
): Promise<vscode.Terminal> {
  // Include both the current display name and the frozen creation name:
  // after a user renames "Claude" to "My Claude", the original session key
  // (used by hooks) must not be handed to a new launch, or the two sessions
  // would collide in the lifecycle map.
  const openNames = vscode.window.terminals.flatMap((t) => [
    t.name,
    terminalCreationName(t),
  ]);
  const tabName = uniqueTerminalName(agent.name, openNames);

  // Some agents gate their OSC 7501 reports behind a feature-detection query the
  // terminal has to answer, which VS Code cannot; `programStatusEnv` supplies the
  // agent's own documented opt-in where one exists (pi), and nothing otherwise.
  // Claude Code and OpenCode get a launch-time reporter that emits OSC 7501 from
  // their own lifecycle events (see `agent-reporters.ts`); nothing is written to
  // their configuration.
  const reporter =
    extensionPath !== undefined && !agent.isPlainTerminal && statusReportersEnabled()
      ? reporterLaunch(agent.cmd, agent.launcher, {
          extensionPath,
          platform: process.platform,
          env: process.env,
          homedir: os.homedir(),
          readFile: readFileIfExists,
        })
      : undefined;
  const env = { ...programStatusEnv(agent.name), ...reporter?.env };

  const terminal = vscode.window.createTerminal({
    name: tabName,
    iconPath: agent.iconPath,
    color: agent.color,
    location: vscode.TerminalLocation.Editor,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  });
  terminal.show();

  // Track agent terminals immediately; status becomes known from OSC, fallback
  // heuristics, or the process exit poller.
  lifecycle?.trackSession(tabName, agent.name, activeWorkspaceFolder());

  const base = launchText(agent);
  const text = base !== "" && reporter?.args ? base + reporter.args : base;
  const delay = launchDelay(agent.isPlainTerminal, delayMs);
  if (text !== "") {
    if (delay > 0) {
      // Defer sendText so other extensions' terminal-startup injections
      // (venv activation, direnv, conda, …) land in the bare shell first.
      // Guard: the terminal may be disposed during the window.
      const timer: NodeJS.Timeout = setTimeout(() => {
        pendingLaunchTimers.delete(timer);
        try {
          terminal.sendText(text);
        } catch {
          // terminal disposed during delay — non-fatal
        }
      }, delay);
      pendingLaunchTimers.add(timer);
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

  return terminal;
}

type LauncherItem = vscode.QuickPickItem & { agent?: ResolvedAgent };

type SessionItem = vscode.QuickPickItem & {
  terminal?: vscode.Terminal;
  launch?: boolean;
};

/** Currently-open sessions picker, if any (used by the R rename shortcut). */
let sessionsPick: vscode.QuickPick<SessionItem> | undefined;

/** Last session with a terminal selected in the sessions picker. */
let lastActiveSessionItem: SessionItem | undefined;

/** Guards against double-triggering the rename prompt from R. */
let renameInFlight = false;

/** Title-bar action for the sessions picker (always visible, mouse friendly). */
const RENAME_SESSION_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("edit"),
  tooltip: "Rename selected tab (R)",
};

/**
 * The currently-open launcher quick pick, if any. A second ⌘⇧A press while
 * it's open swaps it for the sessions picker (see the agentQuickpick.open
 * handler). Undefined whenever the launcher isn't showing.
 */
let launcherPick: vscode.QuickPick<LauncherItem> | undefined;

/**
 * Prompt for a new tab name. Rejects empty names and names already used by
 * another terminal (including its frozen creation name, which is the lifecycle
 * session key and must stay unique).
 */
async function promptRenameTerminal(
  terminal: vscode.Terminal
): Promise<string | undefined> {
  const current = terminal.name;
  const value = await vscode.window.showInputBox({
    title: "Rename terminal tab",
    prompt: "Enter a new name for this agent tab",
    value: current,
    valueSelection: [0, current.length],
    validateInput: (input) => {
      const name = input.trim();
      if (name.length === 0) {
        return "Tab name cannot be empty.";
      }
      if (name === terminal.name) {
        return undefined;
      }
      const taken = vscode.window.terminals.some((t) => {
        if (t === terminal) {
          return false;
        }
        return t.name === name || terminalCreationName(t) === name;
      });
      return taken ? "Another terminal already uses that name." : undefined;
    },
  });
  if (value === undefined) {
    return undefined;
  }
  const name = value.trim();
  return name.length > 0 && name !== terminal.name ? name : undefined;
}

/**
 * Prompt, validate, and perform a tab rename. Returns the new name on success.
 */
async function renameTerminalTab(
  terminal: vscode.Terminal
): Promise<string | undefined> {
  const oldName = terminal.name;
  const newName = await promptRenameTerminal(terminal);
  if (newName === undefined) {
    return undefined;
  }
  try {
    terminal.show();
    await vscode.commands.executeCommand(
      "workbench.action.terminal.renameWithArg",
      { name: newName }
    );
  } catch {
    void vscode.window.showErrorMessage(
      "Could not rename the terminal tab. Your editor may not support this command."
    );
    return undefined;
  }
  lifecycleCtx?.renameSession(
    oldName,
    newName,
    terminalCreationName(terminal)
  );
  return newName;
}

/**
 * Rename the session currently selected in the sessions picker. Invoked by the
 * picker title-bar button and the R keybinding.
 */
async function renameSelectedSession(): Promise<void> {
  if (renameInFlight) {
    return;
  }
  const qp = sessionsPick;
  const selected = qp?.selectedItems[0];
  const item = selected ?? lastActiveSessionItem;
  if (qp === undefined || item?.terminal === undefined) {
    return;
  }
  renameInFlight = true;
  try {
    const newName = await renameTerminalTab(item.terminal);
    if (newName !== undefined && sessionsPick === qp) {
      item.label = newName;
      qp.items = [...qp.items];
    }
  } finally {
    renameInFlight = false;
  }
}

/**
 * Show a quick pick of currently-running agent terminals and focus the chosen
 * one. A title-bar edit button renames the selected session, and pressing R
 * does the same when the filter is empty. Matching uses the terminal's frozen
 * creation name, so tabs the user renamed are still listed. When nothing is
 * running, falls through to the launcher. When sessions exist, a trailing
 * "Launch new agent…" item re-enters the launcher.
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
    if (isSessionTerminal(terminalCreationName(t), agentNames) === false) {
      return false;
    }
    const state = lifecycleCtx?.getSessionState(t.name);
    if (state === undefined) {
      return folder === undefined;
    }
    const attributed = state.cwd ?? state.launchedInFolder;
    return folder === undefined || attributed === folder;
  });

  // Nothing running in this repo → skip the empty list, go straight to launching.
  if (sessions.length === 0) {
    return runLauncher(context);
  }

  const iconOf = (t: vscode.Terminal): vscode.IconPath | undefined => {
    const opts = t.creationOptions as vscode.TerminalOptions;
    return opts?.iconPath ?? new vscode.ThemeIcon("terminal");
  };

  // Sort attention-needing sessions to the top, then active and idle states.
  const order: Record<LifecycleStatus, number> = {
    blocked: 0, error: 1, done: 2, working: 3, idle: 4, unknown: 5,
  };
  const statusOf = (t: vscode.Terminal): LifecycleStatus =>
    lifecycleCtx?.getSessionState(t.name)?.status ?? "unknown";

  const items: SessionItem[] = [...sessions]
    .sort((a, b) => order[statusOf(a)] - order[statusOf(b)])
    .map((t) => {
      const state = lifecycleCtx?.getSessionState(t.name);
      const status = state?.status ?? "unknown";
      // Include OSC's standard blocked kind when the agent reports one.
      const label = status === "blocked" && state?.blockedKind
        ? waitingLabel(state.blockedKind)
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

  const qp = vscode.window.createQuickPick<SessionItem>();
  qp.title = "Running agents";
  qp.placeholder = "Switch to a running agent — press R to rename";
  qp.items = items;
  qp.buttons = [RENAME_SESSION_BUTTON];
  sessionsPick = qp;
  lastActiveSessionItem = items[0];
  void vscode.commands.executeCommand(
    "setContext",
    "agentQuickpick.sessionsOpen",
    true
  );
  // Last value sent for sessionsInputEmpty, so onDidChangeValue only pays the
  // setContext round-trip when emptiness actually changes — not per keystroke.
  let inputEmpty = true;
  void vscode.commands.executeCommand(
    "setContext",
    "agentQuickpick.sessionsInputEmpty",
    true
  );
  void vscode.commands.executeCommand(
    "setContext",
    "agentQuickpick.sessionsRenameAvailable",
    lastActiveSessionItem?.terminal !== undefined
  );

  qp.onDidChangeActive((activeItems) => {
    if (activeItems.length > 0) {
      lastActiveSessionItem = activeItems[0];
    }
    void vscode.commands.executeCommand(
      "setContext",
      "agentQuickpick.sessionsRenameAvailable",
      lastActiveSessionItem?.terminal !== undefined
    );
  });

  qp.onDidChangeValue((value) => {
    const empty = value.length === 0;
    if (empty !== inputEmpty) {
      inputEmpty = empty;
      void vscode.commands.executeCommand(
        "setContext",
        "agentQuickpick.sessionsInputEmpty",
        empty
      );
    }
    if (
      value.trim().toLowerCase() === "r" &&
      lastActiveSessionItem?.terminal !== undefined
    ) {
      qp.value = "";
      void renameSelectedSession();
    }
  });

  qp.onDidHide(() => {
    if (sessionsPick === qp) {
      sessionsPick = undefined;
      lastActiveSessionItem = undefined;
      void vscode.commands.executeCommand(
        "setContext",
        "agentQuickpick.sessionsOpen",
        false
      );
      void vscode.commands.executeCommand(
        "setContext",
        "agentQuickpick.sessionsInputEmpty",
        false
      );
      inputEmpty = false;
      void vscode.commands.executeCommand(
        "setContext",
        "agentQuickpick.sessionsRenameAvailable",
        false
      );
    }
    qp.dispose();
  });

  qp.onDidAccept(() => {
    const choice = qp.selectedItems[0];
    if (choice === undefined) {
      return;
    }
    if (choice.launch === true) {
      qp.hide();
      void runLauncher(context);
      return;
    }
    choice.terminal?.show();
    qp.hide();
  });

  qp.onDidTriggerButton((button) => {
    if (button === RENAME_SESSION_BUTTON) {
      void renameSelectedSession();
    }
  });

  qp.show();
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
        launchAgent(
          sel.agent,
          context.globalState,
          launchDelayMs,
          lifecycleCtx,
          context.extensionPath
        );
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
 * would wrongly wear VS Code's icon. With no safe guess we return `undefined`;
 * click-to-focus still works via the focus URI, without attributing the banner
 * to the wrong app. Notification playback is fire-and-forget.
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
    // down to the unavailable-notifier case. Only the vendored binary is ours to fix.
    if (cached !== null && cached.endsWith(VENDORED_NOTIFIER_REL)) {
      try {
        fs.chmodSync(cached, 0o755);
      } catch {
        // ignore — fire-and-forget spawn still tries; no misleading fallback banner
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
function focusUri(extensionId: string, session: string): vscode.Uri {
  // Built from parts, not parsed: `Uri.parse` would decode the query's own
  // percent-escapes, so a session name containing `&` or `=` wouldn't survive.
  return vscode.Uri.from({
    scheme: vscode.env.uriScheme,
    authority: extensionId,
    path: FOCUS_URI_PATH,
    query: new URLSearchParams({ [FOCUS_URI_SESSION_PARAM]: session }).toString(),
  });
}

/**
 * {@link focusUri}, stamped so a click comes back to *this* window.
 *
 * The OS hands a URI to the editor app, which by default delivers it to the
 * most recently focused window — with several windows open, usually one that
 * doesn't own the terminal (and may own a different one with the same name).
 * For the editor's own scheme, `asExternalUri` appends `windowId=<this window>`,
 * which the main process's URL router uses to deliver the URI to that window
 * (verified in VS Code and Trae). Falls back to the plain URI if it fails.
 */
export async function windowFocusUri(extensionId: string, session: string): Promise<string> {
  const plain = focusUri(extensionId, session);
  try {
    return (await vscode.env.asExternalUri(plain)).toString();
  } catch {
    return plain.toString();
  }
}

/**
 * Read a file's text, or `undefined` when it doesn't exist. Any other read
 * failure (permissions, a directory in the way) also yields `undefined`, which
 * the plugin-file marker guards treat as "absent" — the subsequent write or
 * unlink then fails loudly on its own rather than being pre-judged here.
 */
async function readIfExists(fsPath: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(fsPath, "utf8");
  } catch {
    return undefined;
  }
}

let atomicWriteSeq = 0;
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

/** Lowercased names of the configured agents — the poller's match set. */
function configuredAgentNames(): Set<string> {
  return new Set(
    loadAgents(
      vscode.workspace.getConfiguration("agentQuickpick").get("agents")
    ).map((a) => a.name.toLowerCase())
  );
}

/**
 * Lifecycle awareness context — owns the HTTP server, session-state map, status
 * bar updates, notification toasts, and the prompt-once-globally hook install
 * flow. Created in activate(); passed to launchAgent via a module-level ref so
 * existing call sites don't all need an extra parameter.
 */
export class LifecycleContext {
  /**
   * The status brain. It owns every terminal's OSC parser, signal buffer and
   * session state, and is free of `vscode` so the unit tier can drive it.
   */
  private readonly tracker = new SessionTracker();
  private readonly statusItem: vscode.StatusBarItem;
  private readonly context: vscode.ExtensionContext;
  private readonly pollTimer: NodeJS.Timeout;
  private readonly tickTimer: NodeJS.Timeout;
  /** Disposables for the shell-integration subscriptions (absent below 1.93). */
  private readonly shellDisposables: vscode.Disposable[] = [];
  private readonly closeDisposable: vscode.Disposable;
  /** Disposes the agentQuickpick.agents subscription created in the constructor. */
  private readonly agentsConfigDisposable: vscode.Disposable;
  private agentNames: Set<string>;

  constructor(context: vscode.ExtensionContext, statusItem: vscode.StatusBarItem) {
    this.context = context;
    this.statusItem = statusItem;
    this.agentNames = configuredAgentNames();
    this.syncFallbackSetting();

    // Shell integration is how an agent's output reaches us at all: the OSC 7501
    // reports the protocol defines, the window title and `OSC 9` progress the
    // fallback rules read, and the text tail they match. It exists on VS Code
    // 1.93+ and only for shells with integration enabled, so every use is
    // guarded and the exit-status poll below stays as the universal backstop.
    const onStart = vscode.window.onDidStartTerminalShellExecution;
    const onEnd = vscode.window.onDidEndTerminalShellExecution;

    if (typeof onStart === "function") {
      this.shellDisposables.push(
        onStart((event) => {
          const terminal = event.terminal;
          const execution = event.execution as vscode.TerminalShellExecution & {
            read?: () => AsyncIterable<string>;
          };
          if (typeof execution.read !== "function") {
            return;
          }
          const session = this.sessionKeyForTerminal(terminal);
          if (this.tracker.get(session) === undefined) {
            return; // not a terminal we launched
          }
          this.applyTransitions(this.tracker.execStart(session));

          // `read()` must be called synchronously — data written before the
          // first call is not replayed — so the stream is opened here and
          // drained in the background.
          const stream = execution.read();
          void (async () => {
            try {
              for await (const chunk of stream) {
                this.tracker.setCwd(session, execution.cwd?.fsPath);
                this.applyTransitions(this.tracker.output(session, chunk));
              }
            } catch {
              // Shell integration can end before its output stream does.
            }
          })();
        })
      );
    }

    if (typeof onEnd === "function") {
      this.shellDisposables.push(
        onEnd((event) => {
          const session = this.sessionKeyForTerminal(event.terminal);
          this.applyTransitions(this.tracker.execEnd(session, event.exitCode));
        })
      );
    }

    // Quiet-driven decay: a text-derived "working" has to fall back to idle once
    // the agent stops repainting. The tracker skips sessions that never produced
    // output, so an idle window costs nothing.
    this.tickTimer = setInterval(() => {
      this.applyTransitions(this.tracker.tick());
    }, 500);

    // Universal backstop for terminals where shell integration never came up.
    this.pollTimer = setInterval(() => {
      const exited = pollExitStatuses(vscode.window.terminals, this.agentNames);
      const transitions: SessionTransition[] = [];
      for (const [name, exit] of exited) {
        const terminal = vscode.window.terminals.find((t) => t.name === name);
        if (terminal === undefined) {
          continue;
        }
        transitions.push(
          ...this.tracker.execEnd(this.sessionKeyForTerminal(terminal), exit.exitCode)
        );
      }
      this.applyTransitions(transitions);
    }, 3000);

    // Clean up the session map when a terminal closes, so the status-bar count
    // doesn't drift upward over a long session.
    this.closeDisposable = vscode.window.onDidCloseTerminal((t) => {
      if (this.tracker.forget(this.sessionKeyForTerminal(t))) {
        this.refreshStatusBar();
      }
    });

    // Keep the poller's agent set live across settings edits (adding/removing
    // agent entries), and honor a change to fallback detection immediately.
    this.agentsConfigDisposable = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("agentQuickpick.agents")) {
        this.agentNames = configuredAgentNames();
      }
      if (e.affectsConfiguration("agentQuickpick.fallbackDetection")) {
        this.syncFallbackSetting();
      }
    });
  }

  /** Apply the `fallbackDetection` setting to the tracker. */
  private syncFallbackSetting(): void {
    this.tracker.setFallbackEnabled(
      vscode.workspace
        .getConfiguration("agentQuickpick")
        .get<boolean>("fallbackDetection", true)
    );
  }

  /**
   * Re-adopt agent terminals that survived a window reload into the session map.
   * Without this the status bar would show nothing for a window full of running
   * agents until each one happened to print again. Re-adopted sessions start
   * `unknown` (we know the tab exists, but nothing about its state); the next
   * protocol report, rule match, or exit promotes them.
   */
  seedFromOpenTerminals(agentNames: Set<string>): void {
    const candidates: { key: string; name: string; agentName: string }[] = [];
    for (const t of vscode.window.terminals) {
      const key = terminalCreationName(t);
      if (isSessionTerminal(key, agentNames) === false) {
        continue;
      }
      candidates.push({ key, name: t.name, agentName: baseTerminalName(key) });
    }
    if (this.tracker.seed(candidates)) {
      this.refreshStatusBar();
    }
  }

  /**
   * Register a newly-launched agent terminal as a session. The launching
   * workspace folder is captured once and treated as immutable — it is the
   * fallback for repo-scoping until shell integration reports the agent's real
   * working directory.
   */
  trackSession(tabName: string, agentName: string, launchedInFolder?: string): void {
    this.tracker.track(tabName, agentName, launchedInFolder);
    this.refreshStatusBar();
  }

  /**
   * Look up a tracked session's state by the terminal's current display name. A
   * renamed tab is resolved back to its stable creation-time session key.
   */
  getSessionState(tabName: string): SessionState | undefined {
    const direct = this.tracker.get(tabName);
    if (direct !== undefined) {
      return direct;
    }
    // Fallback for a terminal renamed outside our picker: derive the stable key
    // from the live terminal itself.
    const terminal = vscode.window.terminals.find((t) => t.name === tabName);
    if (terminal === undefined) {
      return undefined;
    }
    return this.tracker.get(this.sessionKeyForTerminal(terminal));
  }

  /**
   * Record a user-driven tab rename. The session key stays the terminal's
   * creation-time name; the new display name is aliased to it, so the status
   * bar, notifications, and click-to-focus all keep following the rename.
   */
  renameSession(
    oldDisplayName: string,
    newDisplayName: string,
    stableSessionName: string
  ): void {
    if (this.tracker.rename(oldDisplayName, newDisplayName, stableSessionName)) {
      this.refreshStatusBar();
    }
  }

  /** Find the live terminal backing a stable session key (even after rename). */
  findTerminalForSession(session: string): vscode.Terminal | undefined {
    return vscode.window.terminals.find(
      (t) => this.sessionKeyForTerminal(t) === session
    );
  }

  /** Stable per-terminal key: display-name alias when renamed, else creation name. */
  private sessionKeyForTerminal(t: vscode.Terminal): string {
    const resolved = this.tracker.resolve(t.name);
    return resolved !== t.name ? resolved : terminalCreationName(t);
  }

  /**
   * Render status changes: notify for the ones flagged as user-facing, then
   * recompute the status bar. All status decisions were already made by the
   * tracker; this is presentation only.
   */
  private applyTransitions(transitions: SessionTransition[]): void {
    if (transitions.length === 0) {
      return;
    }
    for (const transition of transitions) {
      if (transition.notify) {
        this.maybeNotify(transition);
      }
    }
    this.refreshStatusBar();
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
  private maybeNotify(transition: SessionTransition): void {
    const config = vscode.workspace.getConfiguration("agentQuickpick");
    const settingOn = config.get<boolean>("lifecycleNotifications", true);
    const systemMode = config.get<SystemNotifyMode>(
      "systemNotifications",
      "always"
    );
    const soundOn = config.get<boolean>("notificationSound", true);

    const activeTerminal = vscode.window.activeTerminal;
    const isActive =
      activeTerminal !== undefined &&
      this.sessionKeyForTerminal(activeTerminal) === transition.session;

    const sessionState = this.tracker.get(transition.session);
    const agentName = sessionState?.agentName ?? transition.session;
    // Attribute the toast to the session's own folder (matching the status
    // bar/tooltip), not workspaceFolders[0]: in a multi-root window a session
    // in folder B must not toast "· folder-a", and a re-adopted session with
    // no known folder omits the repo suffix.
    const sessionFolder = sessionState ? folderOf(sessionState) : undefined;
    const repo = sessionFolder ? folderBasename(sessionFolder) : undefined;
    const msg = notificationMessage(
      agentName,
      transition.status,
      repo,
      transition.exitCode,
      transition.reason,
      transition.detail
    );
    if (!msg) {
      return;
    }

    if (shouldNotify(transition.status, isActive, settingOn)) {
      const show = transition.status === "error"
        ? (t: string, ...a: string[]) => vscode.window.showErrorMessage(t, ...a)
        : (t: string, ...a: string[]) => vscode.window.showInformationMessage(t, ...a);
      show(msg.text, msg.action).then((choice) => {
        if (choice === msg.action) {
          const terminal = this.findTerminalForSession(transition.session);
          terminal?.show();
        }
      });
    }

    if (
      shouldSystemNotify(systemMode, transition.status, vscode.window.state.focused, settingOn)
    ) {
      // Title carries the product name (an OS notification has no VS Code
      // chrome to identify it); the body reuses the toast copy verbatim. The
      // bundle id (macOS only) makes the banner wear the editor's icon, and the
      // URI makes a click land on this agent's terminal.
      // Sanitize the rendered body in this file as well so static taint is killed
      // before it reaches the subprocess helper.
      const safeBody = sanitizeArgvText(msg.text);
      void windowFocusUri(this.context.extension.id, transition.session).then((openUrl) =>
        fireAndForget(
          systemNotifyCommand(process.platform, "Agent Quickpick", safeBody, {
            bundleId: hostBundleId(),
            notifierPath: notifierPath(this.context.extensionPath),
            openUrl,
          })
        )
      );
    }

    if (shouldPlaySound(soundOn, transition.status, settingOn)) {
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
    fireAndForget(soundPlayCommand(process.platform, soundPath));
  }

  /**
   * Recompute status-bar text + tooltip from the current sessions, filtered to
   * the active workspace folder. When no workspace is open, all sessions are
   * shown (preserves pre-filter behavior). Also re-scoped on editor focus
   * changes — see the onDidChangeActiveTextEditor subscription in activate().
   */
  refreshStatusBar(): void {
    const folder = activeWorkspaceFolder();
    const states = filterSessionsByFolder(this.tracker.all(), folder);
    const counts = countByStatus(states);
    this.statusItem.text = statusBarText(counts);
    this.statusItem.tooltip = statusBarTooltip(states);
  }

  /** Filesystem access for legacy cleanup. */
  private legacyIo(): LegacyIo {
    return {
      read: (file) => readIfExists(file),
      write: (file, text) => writeFileAtomic(file, text),
      remove: async (file) => {
        await fs.promises.unlink(file);
      },
    };
  }

  /** Remove hooks and plugins that older versions installed. */
  async removeAllHooks(): Promise<string[]> {
    return cleanupLegacyHooks(this.legacyIo(), process.env, process.platform, os.homedir());
  }

  /**
   * Strip legacy hooks once per extension version, silently. Without this, an
   * upgrading user keeps spawning a `node` process on every agent turn for a
   * hook that can no longer do anything. Silent because it is housekeeping, not
   * a user action.
   */
  async autoCleanupLegacyHooks(): Promise<void> {
    const flagKey = "legacyHooks.cleanedVersion";
    const version = this.context.extension?.packageJSON?.version ?? "unknown";
    if (this.context.globalState.get<string>(flagKey) === version) {
      return;
    }
    const touched = await this.removeAllHooks();
    await this.context.globalState.update(flagKey, version);
    if (touched.length > 0) {
      console.log(
        `Agent Quickpick: removed lifecycle hooks left by an older version (${touched.join(", ")}).`
      );
    }
  }

  /**
   * One-time-per-workspace cleanup of the older *workspace-local* hooks a
   * pre-global build wrote. Silent — housekeeping, not a user action.
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
    await stripWorkspaceLegacyHooks(this.legacyIo(), wsFolder.uri.fsPath);
    this.context.globalState.update(flagKey, true);
  }

  dispose(): void {
    clearInterval(this.pollTimer);
    clearInterval(this.tickTimer);
    for (const disposable of this.shellDisposables) {
      disposable.dispose();
    }
    this.closeDisposable.dispose();
    this.agentsConfigDisposable.dispose();
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

  // Lifecycle awareness — terminal output parsing, session tracking, live
  // status-bar counts, and notifications. Owns its poll timer.
  lifecycleCtx = new LifecycleContext(context, statusItem);
  // Clear the module ref on disposal.
  context.subscriptions.push({
    dispose: () => {
      lifecycleCtx?.dispose();
      lifecycleCtx = undefined;
    },
  });

  // Re-adopt agent terminals that survived a window reload. Their status is
  // unknown until new terminal evidence arrives.
  lifecycleCtx.seedFromOpenTerminals(
    new Set(
      loadAgents(
        vscode.workspace.getConfiguration("agentQuickpick").get("agents")
      ).map((a) => a.name.toLowerCase())
    )
  );

  // Fire-and-forget: warm the install-detection cache so the first launcher
  // open doesn't pay the ~20-probe PATH burst behind a busy spinner. The
  // resolved list is discarded — only the cached probe results matter.
  resolveAgents(
    loadAgents(vscode.workspace.getConfiguration("agentQuickpick").get("agents")),
    context.extensionUri,
    vscode.workspace
      .getConfiguration("agentQuickpick")
      .get<boolean>("detectInstalled", true)
  ).catch(() => {
    // prewarm failures are non-fatal — the picker re-probes on open
  });

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
          const terminal = lifecycleCtx?.findTerminalForSession(session);
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

  // Strip hooks and plugins older versions installed, once per extension
  // version. Silent, and never blocks activation.
  lifecycleCtx.autoCleanupLegacyHooks().catch(() => {
    // cleanup failures are non-fatal
  });

  // Bring already-installed hooks up to the current schema, with no prompt —
  // so a version bump (new events, new URL-resolution strategy) reaches
  // existing users automatically. Non-fatal, never blocks activation.

  context.subscriptions.push(
    // Clear pending launch-delay timers on deactivate so a deferred sendText
    // can't fire at a disposed terminal after the extension unloads.
    {
      dispose: () => {
        for (const timer of pendingLaunchTimers) {
          clearTimeout(timer);
        }
        pendingLaunchTimers.clear();
      },
    }
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentQuickpick.open", () => {
      // Press 1 opens the launcher instantly; press 2 while it's still open
      // (the old double-tap outcome) swaps it for the sessions picker.
      if (launcherPick) {
        const qp = launcherPick;
        launcherPick = undefined;
        qp.hide();
        return runSessions(context);
      }
      void runLauncher(context);
    }),
    vscode.commands.registerCommand("agentQuickpick.sessions", () => runSessions(context)),
    vscode.commands.registerCommand("agentQuickpick.renameSession", async () => {
      if (sessionsPick === undefined) {
        await runSessions(context);
        return;
      }
      await renameSelectedSession();
    }),
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
