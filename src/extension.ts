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

export function resolveIconPath(icon: unknown, extensionUri: vscode.Uri): vscode.IconPath {
  const fallback = new vscode.ThemeIcon("terminal");
  if (typeof icon !== "string" || icon.trim() === "" || icon.trim().toLowerCase() === "terminal") {
    return fallback;
  }
  const trimmed = icon.trim();

  if (path.isAbsolute(trimmed)) {
    try {
      if (fs.existsSync(trimmed)) {
        return vscode.Uri.file(trimmed);
      }
    } catch {
    }
    return fallback;
  }

  const looksCodicon = /^[a-z][a-z0-9-]*$/i.test(trimmed) && !trimmed.includes(".");
  if (looksCodicon) {
    return new vscode.ThemeIcon(trimmed.toLowerCase());
  }

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
  }
  return fallback;
}

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

async function resolveAgents(
  configs: AgentConfig[],
  extensionUri: vscode.Uri,
  detect: boolean
): Promise<ResolvedAgent[]> {
  const resolved = await Promise.all(
    configs.map(async (c) => {
      const cmd = (c.cmd ?? "").trim();
      const launcher = (c.launcher ?? "").trim();
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

const pendingLaunchTimers = new Set<NodeJS.Timeout>();

function statusReportersEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("agentQuickpick")
    .get<boolean>("agentStatusReporters", true);
}

function readFileIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

async function launchAgent(
  agent: ResolvedAgent,
  state?: vscode.Memento,
  delayMs = 0,
  lifecycle?: LifecycleContext,
  extensionPath?: string
): Promise<vscode.Terminal> {
  const openNames = vscode.window.terminals.flatMap((t) => [
    t.name,
    terminalCreationName(t),
  ]);
  const tabName = uniqueTerminalName(agent.name, openNames);

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

  lifecycle?.trackSession(tabName, agent.name, activeWorkspaceFolder());

  const base = launchText(agent);
  const text = base !== "" && reporter?.args ? base + reporter.args : base;
  const delay = launchDelay(agent.isPlainTerminal, delayMs);
  if (text !== "") {
    if (delay > 0) {
      const timer: NodeJS.Timeout = setTimeout(() => {
        pendingLaunchTimers.delete(timer);
        try {
          terminal.sendText(text);
        } catch {
        }
      }, delay);
      pendingLaunchTimers.add(timer);
    } else {
      terminal.sendText(text);
    }
  }
  if (state) {
    try {
      recordLaunch(state, agent.name, Date.now());
    } catch {
    }
  }

  return terminal;
}

type LauncherItem = vscode.QuickPickItem & { agent?: ResolvedAgent };

type SessionItem = vscode.QuickPickItem & {
  terminal?: vscode.Terminal;
  launch?: boolean;
};

let sessionsPick: vscode.QuickPick<SessionItem> | undefined;

let lastActiveSessionItem: SessionItem | undefined;

let renameInFlight = false;

const RENAME_SESSION_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("edit"),
  tooltip: "Rename selected tab (R)",
};

let launcherPick: vscode.QuickPick<LauncherItem> | undefined;

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

async function runSessions(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration("agentQuickpick");
  const configs = loadAgents(config.get("agents"));
  const agentNames = new Set(configs.map((c) => c.name.toLowerCase()));

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

  if (sessions.length === 0) {
    return runLauncher(context);
  }

  const iconOf = (t: vscode.Terminal): vscode.IconPath | undefined => {
    const opts = t.creationOptions as vscode.TerminalOptions;
    return opts?.iconPath ?? new vscode.ThemeIcon("terminal");
  };

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

async function runLauncher(context: vscode.ExtensionContext): Promise<void> {
    const config = vscode.workspace.getConfiguration("agentQuickpick");
    const userAgents = config.get("agents");
    const detect = config.get<boolean>("detectInstalled", true);
    const launchDelayMs = config.get<number>("launchDelayMs", 300);

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

    if (launcherPick !== qp) {
      return;
    }

    const now = Date.now();
    const frecency = readFrecency(context.globalState);
    const sortedAgents = sortByFrecency(agents, (a) => {
      const e = frecency[a.name.toLowerCase()];
      return e ? frecencyScore(e.c, e.t, now) : 0;
    });

    const toItem = (agent: ResolvedAgent): LauncherItem => ({
      label: agent.name,
      description: agent.isPlainTerminal ? "shell" : launchText(agent) || agent.cmd,
      iconPath: agent.iconPath,
      agent,
    });

    const installedItems = sortedAgents.filter((a) => a.installed).map(toItem);
    const uninstalledItems = sortedAgents.filter((a) => !a.installed).map(toItem);

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

function hostBundleId(): string | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }
  const id = process.env.__CFBundleIdentifier;
  if (id) {
    return id;
  }
  switch (vscode.env.uriScheme) {
    case "vscode":
      return "com.microsoft.VSCode";
    case "vscode-insiders":
      return "com.microsoft.VSCodeInsiders";
    default:
      return undefined;
  }
}

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
    if (cached !== null && cached.endsWith(VENDORED_NOTIFIER_REL)) {
      try {
        fs.chmodSync(cached, 0o755);
      } catch {
      }
    }
    return cached ?? undefined;
  };
})();

function focusUri(extensionId: string, session: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: vscode.env.uriScheme,
    authority: extensionId,
    path: FOCUS_URI_PATH,
    query: new URLSearchParams({ [FOCUS_URI_SESSION_PARAM]: session }).toString(),
  });
}

export async function windowFocusUri(extensionId: string, session: string): Promise<string> {
  const plain = focusUri(extensionId, session);
  try {
    return (await vscode.env.asExternalUri(plain)).toString();
  } catch {
    return plain.toString();
  }
}

async function readIfExists(fsPath: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(fsPath, "utf8");
  } catch {
    return undefined;
  }
}

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

function configuredAgentNames(): Set<string> {
  return new Set(
    loadAgents(
      vscode.workspace.getConfiguration("agentQuickpick").get("agents")
    ).map((a) => a.name.toLowerCase())
  );
}

export class LifecycleContext {
  private readonly tracker = new SessionTracker();
  private readonly statusItem: vscode.StatusBarItem;
  private readonly context: vscode.ExtensionContext;
  private readonly pollTimer: NodeJS.Timeout;
  private readonly tickTimer: NodeJS.Timeout;
  private readonly shellDisposables: vscode.Disposable[] = [];
  private readonly closeDisposable: vscode.Disposable;
  private readonly agentsConfigDisposable: vscode.Disposable;
  private agentNames: Set<string>;

  constructor(context: vscode.ExtensionContext, statusItem: vscode.StatusBarItem) {
    this.context = context;
    this.statusItem = statusItem;
    this.agentNames = configuredAgentNames();
    this.syncFallbackSetting();

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
            return;
          }
          this.applyTransitions(this.tracker.execStart(session));

          const stream = execution.read();
          void (async () => {
            try {
              for await (const chunk of stream) {
                this.tracker.setCwd(session, execution.cwd?.fsPath);
                this.applyTransitions(this.tracker.output(session, chunk));
              }
            } catch {
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

    this.tickTimer = setInterval(() => {
      this.applyTransitions(this.tracker.tick());
    }, 500);

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

    this.closeDisposable = vscode.window.onDidCloseTerminal((t) => {
      if (this.tracker.forget(this.sessionKeyForTerminal(t))) {
        this.refreshStatusBar();
      }
    });

    this.agentsConfigDisposable = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("agentQuickpick.agents")) {
        this.agentNames = configuredAgentNames();
      }
      if (e.affectsConfiguration("agentQuickpick.fallbackDetection")) {
        this.syncFallbackSetting();
      }
    });
  }

  private syncFallbackSetting(): void {
    this.tracker.setFallbackEnabled(
      vscode.workspace
        .getConfiguration("agentQuickpick")
        .get<boolean>("fallbackDetection", true)
    );
  }

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

  trackSession(tabName: string, agentName: string, launchedInFolder?: string): void {
    this.tracker.track(tabName, agentName, launchedInFolder);
    this.refreshStatusBar();
  }

  getSessionState(tabName: string): SessionState | undefined {
    const direct = this.tracker.get(tabName);
    if (direct !== undefined) {
      return direct;
    }
    const terminal = vscode.window.terminals.find((t) => t.name === tabName);
    if (terminal === undefined) {
      return undefined;
    }
    return this.tracker.get(this.sessionKeyForTerminal(terminal));
  }

  renameSession(
    oldDisplayName: string,
    newDisplayName: string,
    stableSessionName: string
  ): void {
    if (this.tracker.rename(oldDisplayName, newDisplayName, stableSessionName)) {
      this.refreshStatusBar();
    }
  }

  findTerminalForSession(session: string): vscode.Terminal | undefined {
    return vscode.window.terminals.find(
      (t) => this.sessionKeyForTerminal(t) === session
    );
  }

  private sessionKeyForTerminal(t: vscode.Terminal): string {
    const resolved = this.tracker.resolve(t.name);
    return resolved !== t.name ? resolved : terminalCreationName(t);
  }

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

  refreshStatusBar(): void {
    const folder = activeWorkspaceFolder();
    const states = filterSessionsByFolder(this.tracker.all(), folder);
    const counts = countByStatus(states);
    this.statusItem.text = statusBarText(counts);
    this.statusItem.tooltip = statusBarTooltip(states);
  }

  private legacyIo(): LegacyIo {
    return {
      read: (file) => readIfExists(file),
      write: (file, text) => writeFileAtomic(file, text),
      remove: async (file) => {
        await fs.promises.unlink(file);
      },
    };
  }

  async removeAllHooks(): Promise<string[]> {
    return cleanupLegacyHooks(this.legacyIo(), process.env, process.platform, os.homedir());
  }

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

let lifecycleCtx: LifecycleContext | undefined;

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("agentQuickpick")) {
        clearInstallCache();
      }
    })
  );

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

  lifecycleCtx = new LifecycleContext(context, statusItem);
  context.subscriptions.push({
    dispose: () => {
      lifecycleCtx?.dispose();
      lifecycleCtx = undefined;
    },
  });

  lifecycleCtx.seedFromOpenTerminals(
    new Set(
      loadAgents(
        vscode.workspace.getConfiguration("agentQuickpick").get("agents")
      ).map((a) => a.name.toLowerCase())
    )
  );

  resolveAgents(
    loadAgents(vscode.workspace.getConfiguration("agentQuickpick").get("agents")),
    context.extensionUri,
    vscode.workspace
      .getConfiguration("agentQuickpick")
      .get<boolean>("detectInstalled", true)
  ).catch(() => {
  });

  context.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri: vscode.Uri) {
        let session: string | null = null;
        try {
          session = sessionFromFocusUri(uri.path, uri.query);
        } catch {
        }
        if (session) {
          const terminal = lifecycleCtx?.findTerminalForSession(session);
          if (terminal) {
            try {
              await terminal.show();
              return;
            } catch {
            }
          }
        }
        void vscode.commands.executeCommand("agentQuickpick.sessions");
      },
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      lifecycleCtx?.refreshStatusBar();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      lifecycleCtx?.refreshStatusBar();
    })
  );

  lifecycleCtx.migrateWorkspaceHooks().catch(() => {
  });

  lifecycleCtx.autoCleanupLegacyHooks().catch(() => {
  });

  context.subscriptions.push(
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
    vscode.commands.registerCommand("agentQuickpick.openKeybindings", () =>
      vscode.commands.executeCommand(
        "workbench.action.openGlobalKeybindings",
        "agentQuickpick.open"
      )
    )
  );
}

export function deactivate() {}
