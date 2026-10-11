import * as assert from "assert";
import * as vscode from "vscode";

const COMMANDS = [
  "agentQuickpick.open",
  "agentQuickpick.sessions",
  "agentQuickpick.removeHooks",
  "agentQuickpick.openKeybindings",
];

suite("activate", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("dataguyofprocol.agent-quickpick");
    assert.ok(ext, "extension under test should be loadable");
    await ext!.activate();
  });

  test("all contributed commands are registered", async () => {
    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = COMMANDS.filter((cmd) => !registered.has(cmd));
    assert.deepStrictEqual(
      missing,
      [],
      `contributed commands missing from getCommands(): ${missing.join(", ")}`
    );
  });

  test("agentQuickpick.sessions executes without rejecting (smoke)", async () => {
    await vscode.commands.executeCommand("agentQuickpick.sessions");
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(true);
  });

  test("agentQuickpick.open executes without rejecting (smoke)", async () => {
    await vscode.commands.executeCommand("agentQuickpick.open");
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(true);
  });

  test("double-tap agentQuickpick.open routes to the sessions picker (no throw)", async () => {
    await vscode.commands.executeCommand("agentQuickpick.open");
    await vscode.commands.executeCommand("agentQuickpick.open");
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(true);
  });

  test("agentQuickpick.openKeybindings executes without rejecting (smoke)", async () => {
    await vscode.commands.executeCommand("agentQuickpick.openKeybindings");
    await new Promise((r) => setTimeout(r, 200));
    try {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    } catch {
    }
    assert.ok(true);
  });
});
