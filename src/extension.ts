import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
  type LifecycleStatus,
  folderOf,
  STATUS_LABEL,
  STATUS_GLYPH,
  waitingLabel,
  sessionFromFocusUri,
  terminalCreationName,
} from "./lifecycle";
import {
  type AgentConfig,
  type ResolvedAgent,
  ALLOWED_COLORS,
  loadAgents,
  recordLaunch,
  sortedByLaunchFrecency,
  isCmdInstalled,
  isSessionTerminal,
  probeBinary,
  clearInstallCache,
  launchText,
  launchDelay,
  uniqueTerminalName,
  programStatusEnv,
} from "./agents";
import {
  LifecycleContext,
  activeWorkspaceFolder,
  readFileIfExists,
  configuredAgentNames,
} from "./lifecycle-context";
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

const pendingLaunchTimers = new Set<NodeJS.Timeout>();

function statusReportersEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("agentQuickpick")
    .get<boolean>("agentStatusReporters", true);
}

async function launchAgent(
  agent: ResolvedAgent,
  state: vscode.Memento,
  delayMs: number,
  lifecycle: LifecycleContext,
  extensionPath: string
): Promise<vscode.Terminal> {
  const openNames = vscode.window.terminals.flatMap((t) => [
    t.name,
    terminalCreationName(t),
  ]);
  const tabName = uniqueTerminalName(agent.name, openNames);

  const reporter =
    !agent.isPlainTerminal && statusReportersEnabled()
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

  lifecycle.trackSession(tabName, agent.name, activeWorkspaceFolder());

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
  try {
    recordLaunch(state, agent.name, Date.now());
  } catch {
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
  const agentNames = configuredAgentNames();

  const folder = activeWorkspaceFolder();
  const sessions = vscode.window.terminals.filter((t) => {
    if (!isSessionTerminal(terminalCreationName(t), agentNames)) {
      return false;
    }
    const state = lifecycleCtx?.getSessionState(t.name);
    if (state === undefined) {
      return folder === undefined;
    }
    return folder === undefined || folderOf(state) === folder;
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
      if (sel?.agent && lifecycleCtx !== undefined) {
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

    const sortedAgents = sortedByLaunchFrecency(agents, context.globalState, Date.now());

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

  lifecycleCtx.seedFromOpenTerminals(configuredAgentNames());

  const warmInstallCache = (configs: AgentConfig[]): void => {
    const probed = new Set<string>();
    for (const c of configs) {
      if (c.userDefined) {
        continue;
      }
      const binary = probeBinary(c.cmd ?? "", c.launcher);
      if (binary === "" || probed.has(binary)) {
        continue;
      }
      probed.add(binary);
      void isCmdInstalled(c.cmd ?? "", c.launcher);
    }
  };
  if (
    vscode.workspace
      .getConfiguration("agentQuickpick")
      .get<boolean>("detectInstalled", true)
  ) {
    warmInstallCache(
      loadAgents(
        vscode.workspace.getConfiguration("agentQuickpick").get("agents")
      )
    );
  }

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
