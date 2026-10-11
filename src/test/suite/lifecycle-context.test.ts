import * as assert from "assert";
import * as vscode from "vscode";

import { LifecycleContext } from "../../extension";
import type { SessionState } from "../../lifecycle";

function makeFakeContext(): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  return {
    globalState: {
      get: <T>(key: string) => store.get(key) as T | undefined,
      update: async (key: string, value: unknown) => { store.set(key, value); },
      keys: () => [...store.keys()],
    },
    extensionPath: "/tmp/agent-quickpick-test",
    extension: { id: "test.agent-quickpick" },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

function makeContext(): { ctx: LifecycleContext; statusItem: vscode.StatusBarItem; dispose(): void } {
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
  const ctx = new LifecycleContext(makeFakeContext(), statusItem);
  return { ctx, statusItem, dispose: () => { ctx.dispose(); statusItem.dispose(); } };
}

suite("LifecycleContext", () => {
  suiteSetup(async () => {
    const config = vscode.workspace.getConfiguration("agentQuickpick");
    await config.update("lifecycleNotifications", false, vscode.ConfigurationTarget.Global);
    await config.update("systemNotifications", "off", vscode.ConfigurationTarget.Global);
    await config.update("notificationSound", false, vscode.ConfigurationTarget.Global);
  });

  suiteTeardown(async () => {
    const config = vscode.workspace.getConfiguration("agentQuickpick");
    await config.update("lifecycleNotifications", undefined, vscode.ConfigurationTarget.Global);
    await config.update("systemNotifications", undefined, vscode.ConfigurationTarget.Global);
    await config.update("notificationSound", undefined, vscode.ConfigurationTarget.Global);
  });

  test("newly launched terminals start unknown until there is evidence", () => {
    const fx = makeContext();
    try {
      fx.ctx.trackSession("Claude", "Claude", "/repo/alpha");
      const state = fx.ctx.getSessionState("Claude");
      assert.strictEqual(state?.status, "unknown");
      assert.strictEqual(state?.launchedInFolder, "/repo/alpha");
    } finally { fx.dispose(); }
  });

  test("rename aliases display name to the same session", () => {
    const fx = makeContext();
    try {
      fx.ctx.trackSession("Claude", "Claude", "/repo/alpha");
      fx.ctx.renameSession("Claude", "My Claude", "Claude");
      assert.strictEqual(fx.ctx.getSessionState("My Claude")?.agentName, "Claude");
      assert.strictEqual(fx.ctx.getSessionState("My Claude")?.launchedInFolder, "/repo/alpha");
    } finally { fx.dispose(); }
  });

  test("status bar updates when sessions are added", () => {
    const fx = makeContext();
    try {
      fx.ctx.trackSession("Claude", "Claude");
      assert.ok(fx.statusItem.text.includes("1?"));
      fx.ctx.trackSession("Codex", "Codex");
      assert.ok(fx.statusItem.text.includes("2?"));
    } finally { fx.dispose(); }
  });

  test("seedFromOpenTerminals adopts matching terminals as unknown", () => {
    const fx = makeContext();
    const terminal = vscode.window.createTerminal({ name: "Claude" });
    try {
      fx.ctx.seedFromOpenTerminals(new Set(["claude"]));
      const state: SessionState | undefined = fx.ctx.getSessionState("Claude");
      assert.strictEqual(state?.status, "unknown");
      assert.strictEqual(state?.agentName, "Claude");
    } finally { terminal.dispose(); fx.dispose(); }
  });
});
