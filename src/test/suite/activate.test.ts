/**
 * Activation smoke tests — the contributed commands exist and execute without
 * rejecting. Runs in the VS Code host tier (the extension is activated by the
 * test harness before the suite runs).
 *
 * NOTE: agentQuickpick.removeHooks is only checked for registration here —
 * executing it would strip the developer's real ~/.claude/settings.json hooks.
 */

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
    // The manifest's only activation event is `onUri`, so nothing in the
    // bare test host activates the extension — do it explicitly. This also
    // runs the real activate() path (migrate/auto-upgrade are no-ops in the
    // sandboxed test profile: no workspace folder, fresh globalState).
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
    // With no agent terminals running this falls through to the launcher,
    // which opens a quick pick — the smoke assertion is just "no throw".
    await vscode.commands.executeCommand("agentQuickpick.sessions");
    await new Promise((r) => setTimeout(r, 400)); // let the deferred launcher resolve
    assert.ok(true);
  });

  test("agentQuickpick.open executes without rejecting (smoke)", async () => {
    // Single press: defers the launcher by the 250ms double-tap window.
    await vscode.commands.executeCommand("agentQuickpick.open");
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(true);
  });

  test("double-tap agentQuickpick.open routes to the sessions picker (no throw)", async () => {
    // Two rapid presses cancel the pending launcher and open sessions instead.
    await vscode.commands.executeCommand("agentQuickpick.open");
    await vscode.commands.executeCommand("agentQuickpick.open");
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(true);
  });

  test("agentQuickpick.openKeybindings executes without rejecting (smoke)", async () => {
    await vscode.commands.executeCommand("agentQuickpick.openKeybindings");
    await new Promise((r) => setTimeout(r, 200));
    // Close whatever editor surface opened, so later suites start clean.
    try {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    } catch {
      // best-effort only
    }
    assert.ok(true);
  });
});
