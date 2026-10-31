import * as vscode from "vscode";
import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
  type SessionState,
  pollExitStatuses,
  countByStatus,
  statusBarText,
  statusBarTooltip,
  filterSessionsByFolder,
  folderOf,
  folderBasename,
  shouldNotify,
  notificationMessage,
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
  terminalCreationName,
} from "./lifecycle";
import { SessionTracker, type SessionTransition } from "./session-tracker";
import { type LegacyIo, cleanupLegacyHooks, stripWorkspaceLegacyHooks } from "./legacy-hooks";
import { loadAgents, isSessionTerminal, baseTerminalName } from "./agents";

export function activeWorkspaceFolder(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) {
      return folder.uri.fsPath;
    }
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function readFileIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
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

export function configuredAgentNames(): Set<string> {
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
      const terminals = vscode.window.terminals;
      const firstWithName = new Map<string, vscode.Terminal>();
      for (const t of terminals) {
        if (!firstWithName.has(t.name)) {
          firstWithName.set(t.name, t);
        }
      }
      const exited = pollExitStatuses(terminals, this.agentNames);
      const transitions: SessionTransition[] = [];
      for (const [name, exitCode] of exited) {
        const terminal = firstWithName.get(name);
        if (terminal === undefined) {
          continue;
        }
        transitions.push(
          ...this.tracker.execEnd(this.sessionKeyForTerminal(terminal), exitCode)
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
      if (!isSessionTerminal(key, agentNames)) {
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
