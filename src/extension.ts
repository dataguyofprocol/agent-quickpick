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
    const picks = AGENTS.map((a) => a.name);
    const choice = await vscode.window.showQuickPick(picks, {
      placeHolder: "Open agent terminal",
    });
    if (!choice) {
      return;
    }

    const agent = AGENTS.find((a) => a.name === choice);
    if (!agent) {
      return;
    }

    const iconUri = vscode.Uri.joinPath(context.extensionUri, "icons", agent.icon);

    const terminal = await vscode.window.createTerminal({
      name: agent.name,
      iconPath: iconUri,
      color: new vscode.ThemeColor(agent.colorId),
      location: vscode.TerminalLocation.Editor,
    });

    terminal.sendText(agent.cmd);
    terminal.show();
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
