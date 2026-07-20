import * as vscode from "vscode";

interface Agent {
  name: string;
  cmd: string;
  icon: string;
  colorId: string;
}

const AGENTS: Agent[] = [
  { name: "claude", cmd: "claude", icon: "claude.svg", colorId: "agentQuickpick.claude" },
  { name: "opencode", cmd: "opencode", icon: "opencode.svg", colorId: "agentQuickpick.opencode" },
  { name: "omp", cmd: "omp", icon: "omp.svg", colorId: "agentQuickpick.omp" },
  { name: "droid", cmd: "droid", icon: "droid.svg", colorId: "agentQuickpick.droid" },
];

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand("agentQuickpick.open", async () => {
    const items: (vscode.QuickPickItem & { agent: Agent })[] = AGENTS.map((agent) => ({
      label: `$(terminal) ${agent.name}`,
      description: agent.cmd,
      iconPath: vscode.Uri.joinPath(context.extensionUri, "icons", agent.icon),
      agent,
    }));

    const choice = await vscode.window.showQuickPick(items, {
      placeHolder: "Open agent terminal",
      matchOnDescription: true,
    });
    if (!choice) {
      return;
    }

    const agent = choice.agent;
    const iconUri = vscode.Uri.joinPath(context.extensionUri, "icons", agent.icon);

    const terminal = vscode.window.createTerminal({
      name: agent.name,
      iconPath: iconUri,
      color: new vscode.ThemeColor(agent.colorId),
      location: vscode.TerminalLocation.Editor,
    });

    terminal.show();
    terminal.sendText(agent.cmd);
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
