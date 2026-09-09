/**
 * Behavioral tests for the generated pi extension: the source is written to a
 * temp file, imported as real ESM under plain Node (proving it loads AND that
 * its default export is a function — pi silently ignores a non-function
 * default, so a regression there would be invisible in production), then
 * driven event-by-event against a real lifecycle server.
 *
 * Most cases here exist because an existing OSS pi integration (herdr, cmux,
 * orca) shipped the bug first: a throwing `ctx.isIdle()`, nested UI prompts,
 * a dialog torn down without its `ui_prompt_end`, and `agent_end` firing
 * before a retry.
 * Unit tier — no VS Code host needed.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";

import { buildPiExtensionSource } from "../../lifecycle-adapters";
import { startLifecycleServer, type HookPayload } from "../../lifecycle";

type Handler = (event: unknown, ctx: unknown) => void;

/** Minimal stand-in for pi's extension context. */
interface Ctx {
  mode?: string;
  isIdle?: () => boolean;
}

const TUI: Ctx = { mode: "tui", isIdle: () => true };
const TUI_BUSY: Ctx = { mode: "tui", isIdle: () => false };

interface Fixture {
  emit: (type: string, event?: unknown, ctx?: unknown) => void;
  payloads: HookPayload[];
  handlers: Map<string, Handler[]>;
  dispose: () => Promise<void>;
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

/** Settle time for "assert nothing was POSTed" cases. */
function quiet(): Promise<void> {
  return new Promise((r) => setTimeout(r, 200));
}

/**
 * Real ESM dynamic import — see the same helper in opencode-plugin.test.ts for
 * why the Function constructor is needed under commonjs output.
 */
const dynamicImport = new Function("s", "return import(s)") as (
  specifier: string
) => Promise<{ default: (pi: unknown) => void }>;

/**
 * Build a live fixture: real server + imported extension registered against a
 * fake `pi` that records handlers so tests can drive events directly.
 */
async function makeFixture(
  envPatch: Record<string, string> = {},
  portFileUrl?: string
): Promise<Fixture> {
  const payloads: HookPayload[] = [];
  const server = startLifecycleServer((p) => payloads.push(p));
  const serverUrl = await server.url;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aqp-pi-ext-"));
  const portFile = path.join(tmpDir, "hook-server.json");
  if (portFileUrl !== undefined) {
    fs.writeFileSync(portFile, JSON.stringify({ url: portFileUrl }));
  }
  // With no port file written, resolution falls through to AQP_HOOK_URL.
  const source = buildPiExtensionSource(serverUrl, "", portFile);
  const extFile = path.join(tmpDir, "agent-quickpick-lifecycle.js");
  fs.writeFileSync(extFile, source);

  const handlers = new Map<string, Handler[]>();
  const prevEnv: Record<string, string | undefined> = {};
  const cleanup = () => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    server.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };

  try {
    const mod = await dynamicImport(pathToFileURL(extFile).href);
    assert.strictEqual(
      typeof mod.default,
      "function",
      "pi silently ignores a non-function default export"
    );
    // Env must be in place before the factory runs, in case a future version
    // reads it there.
    for (const [k, v] of Object.entries({ AQP_HOOK_URL: serverUrl, ...envPatch })) {
      prevEnv[k] = process.env[k];
      process.env[k] = v;
    }
    mod.default({
      on: (type: string, handler: Handler) => {
        const list = handlers.get(type) ?? [];
        list.push(handler);
        handlers.set(type, list);
      },
    });
  } catch (err) {
    cleanup();
    throw err;
  }

  return {
    payloads,
    handlers,
    emit: (type, event = {}, ctx: unknown = TUI) => {
      for (const h of handlers.get(type) ?? []) {
        h(event, ctx);
      }
    },
    dispose: async () => cleanup(),
  };
}

suite("generated pi extension (imported + driven)", () => {
  test("source is importable ESM with a function default export", async () => {
    const fx = await makeFixture({ AQP_SESSION: "pi" });
    try {
      // The import + typeof assertion in makeFixture IS the assertion; drive
      // one event so the delivery pipeline is warm too.
      fx.emit("agent_settled", {}, TUI);
      await waitFor(() => fx.payloads.length === 1, 3000, "agent_settled POST");
      assert.strictEqual(fx.payloads[0].status, "finished");
    } finally {
      await fx.dispose();
    }
  });

  test("no AQP_SESSION → silent (a session we didn't launch)", async () => {
    const fx = await makeFixture({ AQP_SESSION: "" });
    try {
      fx.emit("agent_start", {}, TUI_BUSY);
      fx.emit("agent_settled", {}, TUI);
      await quiet();
      assert.strictEqual(fx.payloads.length, 0, "must not POST without AQP_SESSION");
    } finally {
      await fx.dispose();
    }
  });

  test("non-tui modes are inert (rpc reports hasUI:true, so mode is the gate)", async () => {
    for (const mode of ["rpc", "json", "print"]) {
      const fx = await makeFixture({ AQP_SESSION: "pi" });
      try {
        const ctx = { mode, isIdle: () => false };
        fx.emit("session_start", {}, ctx);
        fx.emit("agent_start", {}, ctx);
        fx.emit("agent_settled", {}, ctx);
        await quiet();
        assert.strictEqual(fx.payloads.length, 0, `mode ${mode} must not POST`);
      } finally {
        await fx.dispose();
      }
    }
  });

  test("a missing ctx never throws and never reports", async () => {
    const fx = await makeFixture({ AQP_SESSION: "pi" });
    try {
      // Call handlers directly: fx.emit's default ctx would mask the case.
      for (const list of fx.handlers.values()) {
        for (const h of list) {
          h({}, undefined);
          h(undefined, undefined);
        }
      }
      await quiet();
      assert.strictEqual(fx.payloads.length, 0, "no mode latched → nothing reported");
    } finally {
      await fx.dispose();
    }
  });

  test("running events report, and consecutive running collapses", async () => {
    const fx = await makeFixture({ AQP_SESSION: "pi (2)" });
    try {
      fx.emit("before_agent_start", {}, TUI_BUSY);
      fx.emit("agent_start", {}, TUI_BUSY);
      fx.emit("tool_execution_start", { toolName: "bash" }, TUI_BUSY);
      fx.emit("tool_execution_start", { toolName: "read" }, TUI_BUSY);
      fx.emit("tool_execution_start", { toolName: "edit" }, TUI_BUSY);
      // The queue collapses adjacent running reports, so far fewer than 5
      // POSTs land — but at least the first one must, and it must be running.
      await waitFor(() => fx.payloads.length >= 1, 3000, "running POST");
      await quiet();
      assert.strictEqual(
        fx.payloads.length,
        1,
        "consecutive running reports must collapse to one POST"
      );
      for (const p of fx.payloads) {
        assert.strictEqual(p.status, "running");
      }
      // Envelope.
      assert.strictEqual(fx.payloads[0].marker, "agentQuickpick:pi");
      assert.strictEqual(fx.payloads[0].agentName, "pi");
      assert.strictEqual(fx.payloads[0].session, "pi (2)");
      assert.strictEqual(fx.payloads[0].cwd, process.cwd());
    } finally {
      await fx.dispose();
    }
  });

  test("session_start resyncs mid-turn after /reload", async () => {
    const fx = await makeFixture({ AQP_SESSION: "pi" });
    try {
      // Busy at load: pi was mid-turn when the extension was swapped in.
      fx.emit("session_start", {}, TUI_BUSY);
      await waitFor(() => fx.payloads.length === 1, 3000, "resync POST");
      assert.strictEqual(fx.payloads[0].status, "running");
    } finally {
      await fx.dispose();
    }
  });

  test("session_start on an idle session reports nothing", async () => {
    const fx = await makeFixture({ AQP_SESSION: "pi" });
    try {
      fx.emit("session_start", {}, TUI);
      await quiet();
      assert.strictEqual(fx.payloads.length, 0);
    } finally {
      await fx.dispose();
    }
  });

  test("ask-the-user tool blocks, and its end unblocks", async () => {
    const fx = await makeFixture({ AQP_SESSION: "pi" });
    try {
      fx.emit("tool_execution_start", { toolName: "ask_user" }, TUI_BUSY);
      await waitFor(() => fx.payloads.length === 1, 3000, "waiting POST");
      assert.strictEqual(fx.payloads[0].status, "waiting");
      assert.strictEqual(fx.payloads[0].reason, "question");

      fx.emit("tool_execution_end", { toolName: "ask_user" }, TUI_BUSY);
      await waitFor(() => fx.payloads.length === 2, 3000, "unblock POST");
      assert.strictEqual(fx.payloads[1].status, "running");
    } finally {
      await fx.dispose();
    }
  });

  test("a non-ask tool's end reports nothing", async () => {
    const fx = await makeFixture({ AQP_SESSION: "pi" });
    try {
      fx.emit("tool_execution_end", { toolName: "bash" }, TUI_BUSY);
      await quiet();
      assert.strictEqual(fx.payloads.length, 0);
    } finally {
      await fx.dispose();
    }
  });

  test("ui_prompt kind → waiting reason", async () => {
    const cases: Array<[string, string]> = [
      ["confirm", "permission"],
      ["select", "question"],
      ["input", "question"],
      ["editor", "question"],
      ["custom", "question"],
    ];
    for (const [kind, reason] of cases) {
      const fx = await makeFixture({ AQP_SESSION: "pi" });
      try {
        fx.emit("ui_prompt_start", { kind }, TUI_BUSY);
        await waitFor(() => fx.payloads.length === 1, 3000, `${kind} POST`);
        assert.strictEqual(fx.payloads[0].status, "waiting");
        assert.strictEqual(fx.payloads[0].reason, reason, `kind ${kind}`);
      } finally {
        await fx.dispose();
      }
    }
  });

  test("nested ui_prompts report once, and clear only at depth 0", async () => {
    const fx = await makeFixture({ AQP_SESSION: "pi" });
    try {
      fx.emit("ui_prompt_start", { kind: "select" }, TUI_BUSY);
      fx.emit("ui_prompt_start", { kind: "confirm" }, TUI_BUSY);
      await waitFor(() => fx.payloads.length === 1, 3000, "single waiting POST");
      await quiet();
      assert.strictEqual(fx.payloads.length, 1, "inner prompt must not re-report");

      fx.emit("ui_prompt_end", { kind: "confirm" }, TUI_BUSY);
      await quiet();
      assert.strictEqual(fx.payloads.length, 1, "still blocked at depth 1");

      fx.emit("ui_prompt_end", { kind: "select" }, TUI_BUSY);
      await waitFor(() => fx.payloads.length === 2, 3000, "unblock POST");
      assert.strictEqual(fx.payloads[1].status, "running", "still mid-turn");
    } finally {
      await fx.dispose();
    }
  });

  test("an unmatched ui_prompt_end can't drive the depth negative", async () => {
    const fx = await makeFixture({ AQP_SESSION: "pi" });
    try {
      fx.emit("ui_prompt_end", { kind: "select" }, TUI);
      await quiet();
      assert.strictEqual(fx.payloads.length, 0, "no prompt was open");
      // A real prompt afterwards must still report.
      fx.emit("ui_prompt_start", { kind: "select" }, TUI_BUSY);
      await waitFor(() => fx.payloads.length === 1, 3000, "waiting POST");
      assert.strictEqual(fx.payloads[0].status, "waiting");
    } finally {
      await fx.dispose();
    }
  });

  test("session_shutdown clears a stuck prompt without reporting", async () => {
    // pi tears an open dialog down without resolving its promise, so the
    // matching ui_prompt_end never arrives.
    const fx = await makeFixture({ AQP_SESSION: "pi" });
    try {
      fx.emit("ui_prompt_start", { kind: "confirm" }, TUI_BUSY);
      await waitFor(() => fx.payloads.length === 1, 3000, "waiting POST");

      fx.emit("session_shutdown", {}, TUI);
      await quiet();
      assert.strictEqual(fx.payloads.length, 1, "shutdown is not a turn boundary");

      // The replaced session settles normally — proof the block was cleared.
      fx.emit("session_start", {}, TUI);
      fx.emit("agent_settled", {}, TUI);
      await waitFor(() => fx.payloads.length === 2, 3000, "finished POST");
      assert.strictEqual(fx.payloads[1].status, "finished");
    } finally {
      await fx.dispose();
    }
  });

  test("a throwing ctx.isIdle() falls back to local turn state", async () => {
    const fx = await makeFixture({ AQP_SESSION: "pi" });
    const angry: Ctx = {
      mode: "tui",
      isIdle: () => {
        throw new Error("runner invalidated by a session-switching modal");
      },
    };
    try {
      fx.emit("session_start", {}, angry);
      fx.emit("agent_settled", {}, angry);
      await waitFor(() => fx.payloads.length === 1, 3000, "finished POST");
      assert.strictEqual(fx.payloads[0].status, "finished");
    } finally {
      await fx.dispose();
    }
  });

  test("assistant message_end with stopReason error → failed", async () => {
    const fx = await makeFixture({ AQP_SESSION: "pi" });
    try {
      fx.emit(
        "message_end",
        { message: { role: "assistant", stopReason: "error" } },
        TUI_BUSY
      );
      await waitFor(() => fx.payloads.length === 1, 3000, "failed POST");
      assert.strictEqual(fx.payloads[0].status, "failed");
    } finally {
      await fx.dispose();
    }
  });

  test("benign stopReasons and non-assistant roles report nothing", async () => {
    const fx = await makeFixture({ AQP_SESSION: "pi" });
    try {
      for (const stopReason of ["stop", "aborted", "toolUse", "length"]) {
        fx.emit("message_end", { message: { role: "assistant", stopReason } }, TUI_BUSY);
      }
      fx.emit("message_end", { message: { role: "user" } }, TUI_BUSY);
      fx.emit("message_end", { message: { role: "toolResult", stopReason: "error" } }, TUI_BUSY);
      fx.emit("message_end", {}, TUI_BUSY);
      await quiet();
      assert.strictEqual(fx.payloads.length, 0);
    } finally {
      await fx.dispose();
    }
  });

  test("agent_end is the boundary only until agent_settled proves it exists", async () => {
    const fx = await makeFixture({ AQP_SESSION: "pi" });
    try {
      // Older pi: no agent_settled ever, so agent_end must terminate the turn.
      fx.emit("agent_end", { messages: [] }, TUI);
      await waitFor(() => fx.payloads.length === 1, 3000, "finished POST");
      assert.strictEqual(fx.payloads[0].status, "finished");

      // Once a settle has been seen, agent_end stops being honoured.
      fx.emit("agent_settled", {}, TUI);
      await waitFor(() => fx.payloads.length === 2, 3000, "settled POST");
      fx.emit("agent_end", { messages: [] }, TUI);
      await quiet();
      assert.strictEqual(fx.payloads.length, 2, "agent_end must defer to agent_settled");
    } finally {
      await fx.dispose();
    }
  });

  test("agent_end that will continue is not a boundary", async () => {
    const fx = await makeFixture({ AQP_SESSION: "pi" });
    try {
      fx.emit("agent_end", { messages: [], willContinue: true }, TUI);
      fx.emit("agent_end", { messages: [], willRetry: true }, TUI);
      // Still mid-run per pi itself, even without the flags.
      fx.emit("agent_end", { messages: [] }, TUI_BUSY);
      await quiet();
      assert.strictEqual(fx.payloads.length, 0, "a continuing run has not finished");

      fx.emit("agent_settled", {}, TUI);
      await waitFor(() => fx.payloads.length === 1, 3000, "finished POST");
      assert.strictEqual(fx.payloads[0].status, "finished");
    } finally {
      await fx.dispose();
    }
  });

  test("agent_settled while blocked does not clear the block", async () => {
    const fx = await makeFixture({ AQP_SESSION: "pi" });
    try {
      fx.emit("ui_prompt_start", { kind: "confirm" }, TUI_BUSY);
      await waitFor(() => fx.payloads.length === 1, 3000, "waiting POST");
      fx.emit("agent_settled", {}, TUI);
      await quiet();
      assert.strictEqual(fx.payloads.length, 1, "the user is still being asked");
    } finally {
      await fx.dispose();
    }
  });

  test("a mixed burst preserves arrival order and posts one terminal status", async () => {
    const fx = await makeFixture({ AQP_SESSION: "pi" });
    try {
      fx.emit("agent_start", {}, TUI_BUSY);
      fx.emit("tool_execution_start", { toolName: "bash" }, TUI_BUSY);
      fx.emit("ui_prompt_start", { kind: "confirm" }, TUI_BUSY);
      fx.emit("ui_prompt_end", { kind: "confirm" }, TUI_BUSY);
      fx.emit("agent_settled", {}, TUI);
      await waitFor(
        () => fx.payloads.some((p) => p.status === "finished"),
        3000,
        "finished POST"
      );
      await quiet();
      const statuses = fx.payloads.map((p) => p.status);
      assert.deepStrictEqual(
        statuses,
        ["running", "waiting", "running", "finished"],
        `unexpected sequence: ${statuses.join(",")}`
      );
    } finally {
      await fx.dispose();
    }
  });

  test("port file with a live URL beats a stale AQP_HOOK_URL", async () => {
    // The fixture's own server is the live one the port file points at; the
    // env is aimed at a dead port.
    const payloads: HookPayload[] = [];
    const server = startLifecycleServer((p) => payloads.push(p));
    const liveUrl = await server.url;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aqp-pi-ext-"));
    const portFile = path.join(tmpDir, "hook-server.json");
    fs.writeFileSync(portFile, JSON.stringify({ url: liveUrl }));
    const extFile = path.join(tmpDir, "agent-quickpick-lifecycle.js");
    fs.writeFileSync(extFile, buildPiExtensionSource(liveUrl, "", portFile));

    const prevSession = process.env.AQP_SESSION;
    const prevUrl = process.env.AQP_HOOK_URL;
    try {
      const mod = await dynamicImport(pathToFileURL(extFile).href);
      const handlers = new Map<string, Handler[]>();
      mod.default({
        on: (type: string, handler: Handler) => {
          const list = handlers.get(type) ?? [];
          list.push(handler);
          handlers.set(type, list);
        },
      });
      process.env.AQP_SESSION = "pi";
      process.env.AQP_HOOK_URL = "http://127.0.0.1:1/dead";
      for (const h of handlers.get("agent_settled") ?? []) {
        h({}, TUI);
      }
      await waitFor(() => payloads.length === 1, 3000, "POST via port file");
      assert.strictEqual(payloads[0].session, "pi");
      assert.strictEqual(payloads[0].status, "finished");
    } finally {
      if (prevSession === undefined) delete process.env.AQP_SESSION;
      else process.env.AQP_SESSION = prevSession;
      if (prevUrl === undefined) delete process.env.AQP_HOOK_URL;
      else process.env.AQP_HOOK_URL = prevUrl;
      server.dispose();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
