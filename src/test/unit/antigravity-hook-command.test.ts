/**
 * Behavioral tests for payload-derived hook reports: we execute the actual
 * `node -e` commands generated for Antigravity (expression specs) and Codex
 * (constant reason) against a real lifecycle server and assert on the POST.
 * Mirrors hook-command.test.ts's execution harness.
 * Unit tier — no VS Code host needed.
 */

import * as assert from "assert";
import { execFile } from "child_process";

import {
  startLifecycleServer,
  type HookPayload,
} from "../../lifecycle";
import {
  ANTIGRAVITY_ADAPTER,
  CODEX_ADAPTER,
} from "../../lifecycle-adapters";

const HOOK_URL = "http://127.0.0.1:49998";
const PORT_FILE = "/nonexistent/port-file.json";

/** Commands of ours inside a merged config, keyed by event, from the adapter's own output. */
function commandsOf(
  adapter: typeof ANTIGRAVITY_ADAPTER,
  event: string
): string[] {
  const merged = adapter.mergeHooks(
    {},
    HOOK_URL,
    "Antigravity",
    PORT_FILE
  ) as Record<string, Record<string, unknown>>;
  const hookName = "agent-quickpick";
  const entry = merged[hookName] as Record<string, unknown>;
  const arr = entry[event] as unknown[];
  return arr.flatMap((item) => {
    const rec = item as Record<string, unknown>;
    if (typeof rec.command === "string") return [rec.command];
    if (Array.isArray(rec.hooks)) {
      return (rec.hooks as { command?: string }[]).map((h) => h.command ?? "");
    }
    return [];
  });
}

/** Pull a specific command by the report it embeds (e.g. status/reason markers). */
function commandContaining(cmds: string[], needle: string): string {
  const found = cmds.find((c) => c.includes(needle));
  assert.ok(found, `expected a command containing ${needle}`);
  return found;
}

function extractScript(cmd: string): string {
  const prefix = 'node -e "';
  assert.ok(cmd.startsWith(prefix), `command should start with ${prefix}`);
  assert.ok(cmd.endsWith('"'), "command should end with a double quote");
  return cmd.slice(prefix.length, -1);
}

interface RunResult {
  code: number | null;
  stderr: string;
}

function runHook(
  cmd: string,
  opts: { env?: Record<string, string>; stdin?: string } = {}
): Promise<RunResult> {
  // Hermetic: strip ambient AQP_* env inherited from the test process (tests
  // may run inside a terminal agent-quickpick launched — those vars belong
  // to the editor session, not to us).
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  delete env.AQP_SESSION;
  delete env.AQP_HOOK_URL;
  Object.assign(env, opts.env);
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ["-e", extractScript(cmd)],
      { env },
      () => {
        resolve({ code: child.exitCode, stderr: "" });
      }
    );
    child.on("error", reject);
    child.stdin?.end(opts.stdin ?? "");
  });
}

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

/** Run one command against a fresh server and return the single POST it made. */
async function postFrom(
  cmd: string,
  stdin: string,
  session = "Antigravity"
): Promise<HookPayload> {
  const payloads: HookPayload[] = [];
  const server = startLifecycleServer((p) => payloads.push(p));
  const url = await server.url;
  try {
    const res = await runHook(cmd, {
      env: { AQP_SESSION: session, AQP_HOOK_URL: url },
      stdin,
    });
    assert.strictEqual(res.code, 0);
    await waitFor(() => payloads.length === 1, 3000, "payload to arrive");
    return payloads[0];
  } finally {
    server.dispose();
  }
}

suite("antigravity generated commands (executed)", () => {
  test("Stop with terminationReason 'error' → failed", async () => {
    const cmd = commandContaining(commandsOf(ANTIGRAVITY_ADAPTER, "Stop"), "terminationReason");
    const p = await postFrom(cmd, JSON.stringify({
      conversationId: "ec33",
      workspacePaths: ["/workspace/project"],
      terminationReason: "error",
      error: "boom",
      fullyIdle: true,
    }));
    assert.strictEqual(p.status, "failed");
    assert.strictEqual(p.cwd, "/workspace/project");
  });

  test("Stop with fullyIdle false (background tasks running) → running, not finished", async () => {
    const cmd = commandContaining(commandsOf(ANTIGRAVITY_ADAPTER, "Stop"), "terminationReason");
    const p = await postFrom(cmd, JSON.stringify({
      workspacePaths: ["/workspace/project"],
      terminationReason: "model_stop",
      fullyIdle: false,
    }));
    assert.strictEqual(p.status, "running");
  });

  test("Stop clean → finished", async () => {
    const cmd = commandContaining(commandsOf(ANTIGRAVITY_ADAPTER, "Stop"), "terminationReason");
    const p = await postFrom(cmd, JSON.stringify({
      workspacePaths: ["/w"],
      terminationReason: "model_stop",
      fullyIdle: true,
    }));
    assert.strictEqual(p.status, "finished");
    assert.strictEqual(p.reason, undefined, "no waiting reason on a clean stop");
  });

  test("Stop without workspacePaths → cwd falls back to empty string", async () => {
    const cmd = commandContaining(commandsOf(ANTIGRAVITY_ADAPTER, "Stop"), "terminationReason");
    const p = await postFrom(cmd, JSON.stringify({ terminationReason: "model_stop", fullyIdle: true }));
    assert.strictEqual(p.cwd, "");
  });

  test("PreToolUse ask_permission → waiting + reason 'permission'", async () => {
    const cmds = commandsOf(ANTIGRAVITY_ADAPTER, "PreToolUse");
    const cmd = commandContaining(cmds, "ask_permission");
    const p = await postFrom(cmd, JSON.stringify({
      workspacePaths: ["/w"],
      toolCall: { name: "ask_permission", args: { Action: "request", Target: "command(npm test)" } },
      stepIdx: 3,
    }));
    assert.strictEqual(p.status, "waiting");
    assert.strictEqual(p.reason, "permission");
  });

  test("PreToolUse ask_question → waiting + reason 'question'", async () => {
    const cmds = commandsOf(ANTIGRAVITY_ADAPTER, "PreToolUse");
    const cmd = commandContaining(cmds, "ask_permission");
    const p = await postFrom(cmd, JSON.stringify({
      workspacePaths: ["/w"],
      toolCall: { name: "ask_question", args: { questions: [] } },
      stepIdx: 7,
    }));
    assert.strictEqual(p.status, "waiting");
    assert.strictEqual(p.reason, "question");
  });

  test("PreInvocation → running", async () => {
    const cmds = commandsOf(ANTIGRAVITY_ADAPTER, "PreInvocation");
    assert.strictEqual(cmds.length, 1);
    const p = await postFrom(cmds[0], JSON.stringify({
      workspacePaths: ["/w"],
      invocationNum: 0,
      initialNumSteps: 0,
    }));
    assert.strictEqual(p.status, "running");
    assert.strictEqual(p.agentName, "antigravity");
  });

  test("no AQP_SESSION → no-op even with a live server", async () => {
    const payloads: HookPayload[] = [];
    const server = startLifecycleServer((p) => payloads.push(p));
    const url = await server.url;
    try {
      const cmd = commandContaining(commandsOf(ANTIGRAVITY_ADAPTER, "Stop"), "terminationReason");
      // AQP_SESSION deliberately absent; only the hook URL is live.
      const res = await runHook(cmd, {
        env: { AQP_HOOK_URL: url },
        stdin: JSON.stringify({ terminationReason: "model_stop", fullyIdle: true }),
      });
      assert.strictEqual(res.code, 0);
      await new Promise((r) => setTimeout(r, 150));
      assert.strictEqual(payloads.length, 0, "guard must prevent any POST");
    } finally {
      server.dispose();
    }
  });
});

suite("codex generated commands (executed)", () => {
  test("PermissionRequest → waiting + reason 'permission' (typed, no classification)", async () => {
    // Codex uses the Claude-schema merge; pull the PermissionRequest command
    // from its merged config and execute it.
    const merged = CODEX_ADAPTER.mergeHooks({}, HOOK_URL, "Codex", PORT_FILE) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    const cmd = merged.hooks.PermissionRequest[0].hooks[0].command;
    const p = await postFrom(cmd, JSON.stringify({
      session_id: "s1",
      cwd: "/repo",
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
    }), "Codex");
    assert.strictEqual(p.status, "waiting");
    assert.strictEqual(p.reason, "permission");
    assert.strictEqual(p.cwd, "/repo");
  });

  test("Stop → finished, reason unset", async () => {
    const merged = CODEX_ADAPTER.mergeHooks({}, HOOK_URL, "Codex", PORT_FILE) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    const cmd = merged.hooks.Stop[0].hooks[0].command;
    const p = await postFrom(cmd, JSON.stringify({
      session_id: "s1",
      cwd: "/repo",
      hook_event_name: "Stop",
    }), "Codex");
    assert.strictEqual(p.status, "finished");
    assert.strictEqual(p.reason, undefined);
  });
});
