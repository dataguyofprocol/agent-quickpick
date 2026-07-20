import * as vscode from "vscode";

interface Agent {
  name: string;
  cmd: string;
  icon: string;
  colorId: string;
}

// Order here = order shown in the quick pick. Terminal stays first.
const AGENTS: Agent[] = [
  { name: "Terminal", cmd: "", icon: "terminal.svg", colorId: "agentQuickpick.terminal" },
  { name: "Claude", cmd: "claude", icon: "claude.svg", colorId: "agentQuickpick.claude" },
  { name: "Opencode", cmd: "opencode", icon: "opencode.svg", colorId: "agentQuickpick.opencode" },
  { name: "Claude Proxy", cmd: "claude-proxy", icon: "claude-proxy.svg", colorId: "agentQuickpick.claudeProxy" },
  { name: "Claude GLM", cmd: "claude-glm", icon: "claude-glm.svg", colorId: "agentQuickpick.claudeGlm" },
  { name: "Command Code", cmd: "cmd", icon: "commandcode.svg", colorId: "agentQuickpick.commandcode" },
  { name: "oh-my-pi", cmd: "omp", icon: "omp.svg", colorId: "agentQuickpick.omp" },
  { name: "Droid", cmd: "droid", icon: "droid.svg", colorId: "agentQuickpick.droid" },
];

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand("agentQuickpick.open", async () => {
    const items: (vscode.QuickPickItem & { agent: Agent })[] = AGENTS.map((agent) => ({
      label: agent.name,
      description: agent.cmd || "shell",
      iconPath: vscode.Uri.joinPath(context.extensionUri, "icons", agent.icon),
      agent,
    }));

    const choice = await vscode.window.showQuickPick(items, {
      placeHolder: "Open agent terminal",
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
    if (agent.cmd) {
      terminal.sendText(agent.cmd);
    }
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
