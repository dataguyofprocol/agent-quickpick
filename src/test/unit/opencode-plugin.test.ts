/**
 * Behavioral tests for the generated OpenCode plugin: the source is written
 * to a temp file, imported as real ESM under plain Node (proving the plugin
 * loads — the #1 way a bad plugin could silently blacklist itself), then
 * driven event-by-event against a real lifecycle server.
 * Unit tier — no VS Code host needed.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";

import { buildOpenCodePluginSource } from "../../lifecycle-adapters";
import { startLifecycleServer, type HookPayload } from "../../lifecycle";

type Plugin = { event: (evt: { event: { type: string } }) => Promise<void> };

interface Fixture {
  plugin: Plugin;
  payloads: HookPayload[];
  serverUrl: string;
  dispose: () => Promise<void>;
  tmpDir: string;
}

/** Wait until predicate() is truthy, polling every 25ms up to `ms`. */
function waitFor(predicate: () => boolean, ms = 3000, what = "condition"): Promise<void> {
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

/**
 * Real ESM dynamic import. tsc downlevels `await import(x)` to require() under
 * commonjs — which can't load file:// URLs — so route through the Function
 * constructor to keep a genuine import() in the emitted JS.
 */
const dynamicImport = new Function(
  "s",
  "return import(s)"
) as (specifier: string) => Promise<{ AgentQuickpickLifecyclePlugin: () => Promise<Plugin> }>;

/**
 * Build a live fixture: real server + imported plugin module pointed at it.
 * The plugin reads AQP_SESSION/AQP_HOOK_URL from the *test* process env when
 * its event handler runs, so callers control them per-test via `envPatch`.
 */
async function makeFixture(envPatch: Record<string, string> = {}): Promise<Fixture> {
  const payloads: HookPayload[] = [];
  const server = startLifecycleServer((p) => payloads.push(p));
  const serverUrl = await server.url;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aqp-oc-plugin-"));
  // No port file (nonexistent path) → resolution falls to AQP_HOOK_URL env.
  const source = buildOpenCodePluginSource(
    serverUrl,
    "",
    path.join(tmpDir, "missing-port-file.json")
  );
  const pluginFile = path.join(tmpDir, "agent-quickpick-lifecycle.js");
  fs.writeFileSync(pluginFile, source);

  let instance: Plugin;
  try {
    const mod = await dynamicImport(pathToFileURL(pluginFile).href);
    instance = await mod.AgentQuickpickLifecyclePlugin();
  } catch (err) {
    // Setup failed before the caller's try/finally exists — clean up here so
    // a broken plugin source can never leak the server handle.
    server.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }

  const prevEnv: Record<string, string | undefined> = {};
  const applyEnv = (patch: Record<string, string>) => {
    for (const [k, v] of Object.entries(patch)) {
      prevEnv[k] = process.env[k];
      process.env[k] = v;
    }
  };
  applyEnv({ AQP_HOOK_URL: serverUrl, ...envPatch });

  return {
    plugin: instance,
    payloads,
    serverUrl,
    tmpDir,
    dispose: async () => {
      // Restore env.
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      server.dispose();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

suite("generated OpenCode plugin (imported + driven)", () => {
  test("plugin source is importable as ESM under plain Node", async () => {
    // The import inside makeFixture IS the assertion — a require()/syntax
    // regression throws here. Drive one event so the pipeline is warm.
    const fx = await makeFixture({ AQP_SESSION: "OpenCode" });
    try {
      await fx.plugin.event({ event: { type: "session.idle" } });
      await waitFor(() => fx.payloads.length === 1, 3000, "session.idle POST");
    } finally {
      await fx.dispose();
    }
  });

  test("no AQP_SESSION → silent (a session we didn't launch)", async () => {
    const fx = await makeFixture({ AQP_SESSION: "" });
    try {
      await fx.plugin.event({ event: { type: "session.idle" } });
      await new Promise((r) => setTimeout(r, 200));
      assert.strictEqual(fx.payloads.length, 0, "must not POST without AQP_SESSION");
    } finally {
      await fx.dispose();
    }
  });

  test("event → status mapping table", async () => {
    const cases: Array<{ type: string; status: string; reason?: string }> = [
      { type: "session.idle", status: "finished" },
      { type: "permission.asked", status: "waiting", reason: "permission" },
      { type: "question.asked", status: "waiting", reason: "question" },
      { type: "session.error", status: "failed" },
      { type: "tool.execute.before", status: "running" },
      { type: "tool.execute.after", status: "running" },
      { type: "chat.message", status: "running" },
    ];
    const fx = await makeFixture({ AQP_SESSION: "OpenCode (3)" });
    try {
      for (const c of cases) {
        await fx.plugin.event({ event: { type: c.type } });
      }
      // Each case fires exactly one POST; wait for the full count so the
      // unknown-event assertion below isn't racing in-flight deliveries.
      await waitFor(() => fx.payloads.length === cases.length, 3000, "all mapping POSTs");
      // Unknown event types are ignored.
      await fx.plugin.event({ event: { type: "something.else" } });
      await new Promise((r) => setTimeout(r, 200));
      assert.strictEqual(fx.payloads.length, cases.length, "unknown event must not POST");

      // Every delivered payload carries the fixed envelope fields.
      const waiting = fx.payloads.find((p) => p.status === "waiting" && p.reason === "permission");
      assert.ok(waiting, "permission.asked payload with reason should exist");
      for (const p of fx.payloads) {
        assert.strictEqual(p.marker, "agentQuickpick:opencode");
        assert.strictEqual(p.agentName, "OpenCode");
        assert.strictEqual(p.session, "OpenCode (3)");
        assert.strictEqual(p.cwd, process.cwd());
      }
    } finally {
      await fx.dispose();
    }
  });

  test("port file with a live URL beats a stale AQP_HOOK_URL", async () => {
    // Server A (live, referenced by the port file) vs env pointing at a dead port.
    const payloads: HookPayload[] = [];
    const liveServer = startLifecycleServer((p) => payloads.push(p));
    const liveUrl = await liveServer.url;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aqp-oc-plugin-"));
    const portFile = path.join(tmpDir, "hook-server.json");
    fs.writeFileSync(portFile, JSON.stringify({ url: liveUrl }));
    const source = buildOpenCodePluginSource(liveUrl, "", portFile);
    const pluginFile = path.join(tmpDir, "agent-quickpick-lifecycle.js");
    fs.writeFileSync(pluginFile, source);
    let instance: Plugin;
    try {
      const mod = await dynamicImport(pathToFileURL(pluginFile).href);
      instance = await mod.AgentQuickpickLifecyclePlugin();
    } catch (err) {
      liveServer.dispose();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw err;
    }
    const prevSession = process.env.AQP_SESSION;
    const prevUrl = process.env.AQP_HOOK_URL;
    process.env.AQP_SESSION = "OpenCode";
    process.env.AQP_HOOK_URL = "http://127.0.0.1:1/dead";
    try {
      await instance.event({ event: { type: "session.idle" } });
      await waitFor(() => payloads.length === 1, 3000, "POST via port file");
      assert.strictEqual(payloads[0].session, "OpenCode");
    } finally {
      process.env.AQP_SESSION = prevSession;
      if (prevUrl === undefined) delete process.env.AQP_HOOK_URL;
      else process.env.AQP_HOOK_URL = prevUrl;
      liveServer.dispose();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
