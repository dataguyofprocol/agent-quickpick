/**
 * LifecycleContext — the orchestrator (session map, hook pipeline, status
 * bar, port file, dispose). Runs in the VS Code host tier because it drives
 * real vscode APIs (status bar, terminals, configuration).
 *
 * Safety notes:
 *  - suiteSetup disables all notification channels so a passing test run
 *    doesn't fire real OS notifications / sounds on the dev machine.
 *  - These tests never call the hook *install* paths — those write to the
 *    real `~/.claude/settings.json` et al., which belongs to the developer.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { LifecycleContext } from "../../extension";
import type { SessionState } from "../../lifecycle";

/** POST JSON to a URL; resolves status, rejects on connection error. */
function post(url: string, body: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: "POST" },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** Wait until predicate() is truthy, polling every 25ms up to `ms`. */
function waitFor(predicate: () => boolean, ms = 5000, what = "condition"): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > ms) {
        return reject(new Error(`timed out after ${ms}ms waiting for ${what}`));
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

/** Map-backed fake of the ExtensionContext fields LifecycleContext touches. */
function makeFakeContext(storageDir: string): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  return {
    globalState: {
      get: <T>(key: string) => store.get(key) as T | undefined,
      update: async (key: string, value: unknown) => {
        store.set(key, value);
      },
      keys: () => [...store.keys()],
    },
    globalStorageUri: vscode.Uri.file(storageDir),
    extensionPath: storageDir,
    extension: { id: "test.agent-quickpick" },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

interface Ctx {
  ctx: LifecycleContext;
  statusItem: vscode.StatusBarItem;
  storageDir: string;
  dispose(): Promise<void>;
}

/** A fresh LifecycleContext + temp global-storage dir; auto-disposed. */
async function makeContext(): Promise<Ctx> {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "aqp-ctx-"));
  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    0
  );
  const ctx = new LifecycleContext(makeFakeContext(storageDir), statusItem);
  await ctx.hookUrl(); // server is listening
  return {
    ctx,
    statusItem,
    storageDir,
    dispose: async () => {
      ctx.dispose();
      statusItem.dispose();
      fs.rmSync(storageDir, { recursive: true, force: true });
    },
  };
}

suite("LifecycleContext", () => {
  suiteSetup(async () => {
    // Silence every channel for the duration of the suite (restored in
    // teardown) — assertions here are about session state, not toasts.
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

  test("trackSession registers a running session with its launch folder", async () => {
    const fx = await makeContext();
    try {
      fx.ctx.trackSession("Claude", "Claude", "/repo/alpha");
      const state = fx.ctx.getSessionState("Claude");
      assert.ok(state, "session should be tracked");
      assert.strictEqual(state!.status, "running");
      assert.strictEqual(state!.agentName, "Claude");
      assert.strictEqual(state!.launchedInFolder, "/repo/alpha");
    } finally {
      await fx.dispose();
    }
  });

  test("hook POST drives the session state end-to-end (the real pipeline)", async () => {
    const fx = await makeContext();
    try {
      fx.ctx.trackSession("Claude", "Claude", "/repo/alpha");
      const url = await fx.ctx.hookUrl();
      await post(
        url,
        JSON.stringify({
          marker: "agentQuickpick:claude",
          session: "Claude",
          status: "waiting",
          reason: "permission",
          cwd: "/repo/beta",
        })
      );
      await waitFor(() => fx.ctx.getSessionState("Claude")?.status === "waiting");
      const state = fx.ctx.getSessionState("Claude")!;
      assert.strictEqual(state.waitingReason, "permission");
      assert.strictEqual(state.cwd, "/repo/beta"); // hook cwd wins over launch folder
    } finally {
      await fx.dispose();
    }
  });

  test("hook POST for an unknown session is ignored", async () => {
    const fx = await makeContext();
    try {
      const url = await fx.ctx.hookUrl();
      await post(url, JSON.stringify({ session: "NotTracked", status: "finished" }));
      await new Promise((r) => setTimeout(r, 200));
      assert.strictEqual(fx.ctx.getSessionState("NotTracked"), undefined);
    } finally {
      await fx.dispose();
    }
  });

  test("hook POST without session/status is ignored", async () => {
    const fx = await makeContext();
    try {
      fx.ctx.trackSession("Claude", "Claude");
      const url = await fx.ctx.hookUrl();
      await post(url, JSON.stringify({ marker: "x" }));
      await new Promise((r) => setTimeout(r, 200));
      assert.strictEqual(fx.ctx.getSessionState("Claude")!.status, "running");
    } finally {
      await fx.dispose();
    }
  });

  test("monotonic-failed: a late 'finished' hook can't demote 'failed'", async () => {
    const fx = await makeContext();
    try {
      fx.ctx.trackSession("Claude", "Claude");
      const url = await fx.ctx.hookUrl();
      await post(url, JSON.stringify({ session: "Claude", status: "failed" }));
      await waitFor(() => fx.ctx.getSessionState("Claude")?.status === "failed");
      await post(url, JSON.stringify({ session: "Claude", status: "finished" }));
      await new Promise((r) => setTimeout(r, 200));
      assert.strictEqual(fx.ctx.getSessionState("Claude")!.status, "failed");
    } finally {
      await fx.dispose();
    }
  });

  test("waitingReason is cleared on transition away from waiting", async () => {
    const fx = await makeContext();
    try {
      fx.ctx.trackSession("Claude", "Claude");
      const url = await fx.ctx.hookUrl();
      await post(
        url,
        JSON.stringify({ session: "Claude", status: "waiting", reason: "permission" })
      );
      await waitFor(() => fx.ctx.getSessionState("Claude")?.waitingReason === "permission");
      await post(url, JSON.stringify({ session: "Claude", status: "running" }));
      await waitFor(() => fx.ctx.getSessionState("Claude")?.status === "running");
      assert.strictEqual(fx.ctx.getSessionState("Claude")!.waitingReason, undefined);
    } finally {
      await fx.dispose();
    }
  });

  test("free-text message is classified when no typed reason is sent (Claude path)", async () => {
    const fx = await makeContext();
    try {
      fx.ctx.trackSession("Claude", "Claude");
      const url = await fx.ctx.hookUrl();
      await post(
        url,
        JSON.stringify({
          session: "Claude",
          status: "waiting",
          message: "Claude needs your permission to use Bash",
        })
      );
      await waitFor(() => fx.ctx.getSessionState("Claude")?.status === "waiting");
      assert.strictEqual(fx.ctx.getSessionState("Claude")!.waitingReason, "permission");
    } finally {
      await fx.dispose();
    }
  });

  test("typed reason beats the classified message (OpenCode path)", async () => {
    const fx = await makeContext();
    try {
      fx.ctx.trackSession("OpenCode", "OpenCode");
      const url = await fx.ctx.hookUrl();
      await post(
        url,
        JSON.stringify({
          session: "OpenCode",
          status: "waiting",
          reason: "question",
          message: "needs your permission to use Bash", // would classify as permission
        })
      );
      await waitFor(() => fx.ctx.getSessionState("OpenCode")?.status === "waiting");
      assert.strictEqual(fx.ctx.getSessionState("OpenCode")!.waitingReason, "question");
    } finally {
      await fx.dispose();
    }
  });

  test("empty cwd never clobbers an existing cwd", async () => {
    const fx = await makeContext();
    try {
      fx.ctx.trackSession("Claude", "Claude", "/repo/alpha");
      const url = await fx.ctx.hookUrl();
      await post(url, JSON.stringify({ session: "Claude", status: "finished", cwd: "/repo/beta" }));
      await waitFor(() => fx.ctx.getSessionState("Claude")?.cwd === "/repo/beta");
      await post(url, JSON.stringify({ session: "Claude", status: "waiting", cwd: "" }));
      await waitFor(() => fx.ctx.getSessionState("Claude")?.status === "waiting");
      assert.strictEqual(fx.ctx.getSessionState("Claude")!.cwd, "/repo/beta");
    } finally {
      await fx.dispose();
    }
  });

  test("the server URL is persisted to globalStorage (port file)", async () => {
    const fx = await makeContext();
    try {
      const url = await fx.ctx.hookUrl();
      const portFile = path.join(fx.storageDir, "hook-server.json");
      await waitFor(() => fs.existsSync(portFile), 5000, "port file to be written");
      const parsed = JSON.parse(fs.readFileSync(portFile, "utf8")) as { url: string };
      assert.strictEqual(parsed.url, url);
    } finally {
      await fx.dispose();
    }
  });

  test("refreshStatusBar renders live counts in the status item", async () => {
    const fx = await makeContext();
    try {
      fx.ctx.trackSession("Claude", "Claude");
      // No workspace folder is open in the test host → all sessions aggregate.
      await waitFor(() => fx.statusItem.text.includes("1●"));
      fx.ctx.trackSession("Codex", "Codex");
      await waitFor(() => fx.statusItem.text.includes("2●"));
    } finally {
      await fx.dispose();
    }
  });

  test("seedFromOpenTerminals adopts a matching terminal as unknown", async () => {
    const fx = await makeContext();
    const terminal = vscode.window.createTerminal({ name: "FrecencySeedClaude" });
    try {
      // The name must look like an agent terminal for adoption to happen.
      const t2 = vscode.window.createTerminal({ name: "Claude" });
      try {
        fx.ctx.seedFromOpenTerminals(new Set(["claude"]));
        const state: SessionState | undefined = fx.ctx.getSessionState("Claude");
        assert.ok(state, "matched terminal should be adopted");
        assert.strictEqual(state!.status, "unknown");
        assert.strictEqual(state!.agentName, "Claude");
        assert.strictEqual(
          fx.ctx.getSessionState("FrecencySeedClaude"),
          undefined,
          "non-agent terminals must not be adopted"
        );
      } finally {
        t2.dispose();
      }
    } finally {
      terminal.dispose();
      await fx.dispose();
    }
  });

  test("dispose closes the hook server", async () => {
    const fx = await makeContext();
    const url = await fx.ctx.hookUrl();
    await fx.dispose();
    await assert.rejects(() => post(url, "{}"), "server should refuse after dispose");
  });
});
