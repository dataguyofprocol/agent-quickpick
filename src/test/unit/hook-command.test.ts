/**
 * Behavioral tests for the generated `node -e` hook command: we actually
 * execute it (shell-free: execFile("node", ["-e", script])) against a real
 * lifecycle server and assert on the POST it makes. This is the true contract
 * with Claude/Droid — string-level checks live in build-hook-command.test.ts.
 * Unit tier — no VS Code host needed.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import * as net from "net";

import {
  buildNodeHookCommand,
  startLifecycleServer,
  type HookPayload,
} from "../../lifecycle";

const MARKER = "agentQuickpick:claude";
const STATUS = "finished";

/**
 * The command is always `node -e "<script>"`. Peel off the wrapper so we can
 * exec the script directly, without a shell, on every platform.
 */
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

/** Execute a generated hook command with the given env + stdin JSON. */
function runHook(
  cmd: string,
  opts: { env?: Record<string, string>; stdin?: string } = {}
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath, // the same node running the tests
      ["-e", extractScript(cmd)],
      { env: { ...process.env, ...opts.env } },
      (_error, _stdout, stderr) => {
        // The callback fires on exit whatever the code; exitCode is the truth.
        resolve({ code: child.exitCode, stderr: String(stderr) });
      }
    );
    child.on("error", reject);
    if (opts.stdin !== undefined) {
      child.stdin?.end(opts.stdin);
    } else {
      child.stdin?.end();
    }
  });
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

suite("generated hook command (executed)", () => {
  test("no AQP_SESSION → no-op: no POST, exit 0", async () => {
    const payloads: HookPayload[] = [];
    const server = startLifecycleServer((p) => payloads.push(p));
    const url = await server.url;
    // The env is deliberately absent (a session we didn't launch), and the
    // baked URL points at the live server so any failure to guard would POST.
    const cmd = buildNodeHookCommand(url, "Claude", MARKER, STATUS, "/nonexistent/port-file.json");
    const res = await runHook(cmd, { stdin: JSON.stringify({ cwd: "/x" }) });
    assert.strictEqual(res.code, 0);
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(payloads.length, 0, "guard must prevent any POST");
    server.dispose();
  });

  test("AQP_SESSION + AQP_HOOK_URL → POSTs the full payload derived from stdin", async () => {
    const payloads: HookPayload[] = [];
    const server = startLifecycleServer((p) => payloads.push(p));
    const url = await server.url;
    const cmd = buildNodeHookCommand(
      "http://127.0.0.1:1/dead", // baked URL is dead on purpose
      "Claude",
      MARKER,
      STATUS,
      "/nonexistent/port-file.json"
    );
    const res = await runHook(cmd, {
      env: {
        AQP_SESSION: "Claude (2)",
        AQP_HOOK_URL: url,
      },
      stdin: JSON.stringify({
        session_id: "abc",
        hook_event_name: "Stop",
        cwd: "/Users/me/projects/my-app",
        message: "Claude needs your permission to use Bash",
      }),
    });
    assert.strictEqual(res.code, 0, `hook should exit cleanly, stderr: ${res.stderr}`);
    await waitFor(() => payloads.length === 1, 3000, "payload to arrive");
    const p = payloads[0];
    assert.strictEqual(p.marker, MARKER);
    assert.strictEqual(p.session, "Claude (2)"); // env wins over the baked session
    assert.strictEqual(p.status, STATUS);
    assert.strictEqual(p.agentName, "claude"); // marker.split(':')[1]
    assert.strictEqual(p.cwd, "/Users/me/projects/my-app");
    assert.strictEqual(p.message, "Claude needs your permission to use Bash");
    server.dispose();
  });

  test("stdin without cwd/message → defaults to empty strings", async () => {
    const payloads: HookPayload[] = [];
    const server = startLifecycleServer((p) => payloads.push(p));
    const url = await server.url;
    const cmd = buildNodeHookCommand(url, "Claude", MARKER, STATUS, "/nonexistent/port-file.json");
    await runHook(cmd, {
      env: { AQP_SESSION: "Claude", AQP_HOOK_URL: url },
      stdin: "{}",
    });
    await waitFor(() => payloads.length === 1, 3000, "payload to arrive");
    assert.strictEqual(payloads[0].cwd, "");
    assert.strictEqual(payloads[0].message, "");
    server.dispose();
  });

  test("empty stdin → still POSTs (parses to {})", async () => {
    const payloads: HookPayload[] = [];
    const server = startLifecycleServer((p) => payloads.push(p));
    const url = await server.url;
    const cmd = buildNodeHookCommand(url, "Claude", MARKER, STATUS, "/nonexistent/port-file.json");
    const res = await runHook(cmd, {
      env: { AQP_SESSION: "Claude", AQP_HOOK_URL: url },
      stdin: "",
    });
    assert.strictEqual(res.code, 0);
    await waitFor(() => payloads.length === 1, 3000, "payload to arrive");
    assert.strictEqual(payloads[0].session, "Claude");
    server.dispose();
  });

  test("port file with a live URL beats a stale AQP_HOOK_URL env", async () => {
    const payloads: HookPayload[] = [];
    const server = startLifecycleServer((p) => payloads.push(p));
    const liveUrl = await server.url;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aqp-hook-"));
    const portFile = path.join(dir, "hook-server.json");
    fs.writeFileSync(portFile, JSON.stringify({ url: liveUrl }));
    try {
      const cmd = buildNodeHookCommand(liveUrl, "Claude", MARKER, STATUS, portFile);
      await runHook(cmd, {
        env: {
          AQP_SESSION: "Claude",
          AQP_HOOK_URL: "http://127.0.0.1:1/dead-port", // stale: a pre-restart terminal env
        },
        stdin: "{}",
      });
      await waitFor(() => payloads.length === 1, 3000, "payload via port file");
      assert.strictEqual(payloads[0].session, "Claude");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      server.dispose();
    }
  });

  test("corrupt port file → falls back to AQP_HOOK_URL env", async () => {
    const payloads: HookPayload[] = [];
    const server = startLifecycleServer((p) => payloads.push(p));
    const url = await server.url;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aqp-hook-"));
    const portFile = path.join(dir, "hook-server.json");
    fs.writeFileSync(portFile, "{not json");
    try {
      const cmd = buildNodeHookCommand(url, "Claude", MARKER, STATUS, portFile);
      await runHook(cmd, {
        env: { AQP_SESSION: "Claude", AQP_HOOK_URL: url },
        stdin: "{}",
      });
      await waitFor(() => payloads.length === 1, 3000, "payload via env fallback");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      server.dispose();
    }
  });

  test("session env but no URL env, no port file → the URL baked at install time is used", async () => {
    const payloads: HookPayload[] = [];
    const server = startLifecycleServer((p) => payloads.push(p));
    const url = await server.url;
    // Only AQP_SESSION is set: the resolution chain must fall through the
    // (missing) port file and the (absent) env var to the baked literal.
    const cmd = buildNodeHookCommand(url, "Claude", MARKER, STATUS, "/nonexistent/port-file.json");
    await runHook(cmd, {
      env: { AQP_SESSION: "Claude" },
      stdin: "{}",
    });
    await waitFor(() => payloads.length === 1, 3000, "payload via baked URL");
    assert.strictEqual(payloads[0].session, "Claude");
    server.dispose();
  });

  test("hostile session name with quotes/backslashes round-trips intact", async () => {
    const payloads: HookPayload[] = [];
    const server = startLifecycleServer((p) => payloads.push(p));
    const url = await server.url;
    // A hostile tab name: quotes, backslashes, parens — must survive the
    // in-script string escaping byte-for-byte.
    const hostile = `Claude's "\\ (2)`;
    const cmd = buildNodeHookCommand(url, hostile, MARKER, STATUS, "/nonexistent/port-file.json");
    const res = await runHook(cmd, {
      env: { AQP_SESSION: hostile, AQP_HOOK_URL: url },
      stdin: "{}",
    });
    assert.strictEqual(res.code, 0, `script must not break on hostile input, stderr: ${res.stderr}`);
    await waitFor(() => payloads.length === 1, 3000, "payload to arrive");
    assert.strictEqual(payloads[0].session, hostile);
    server.dispose();
  });

  test("a server that never responds can't hang the hook past its 2s timeout", async () => {
    // Accept connections, read nothing, respond with nothing, hold them open.
    const blackHole = net.createServer((socket) => {
      socket.on("data", () => {
        /* swallow */
      });
    });
    await new Promise<void>((resolve) => blackHole.listen(0, "127.0.0.1", resolve));
    const port = (blackHole.address() as net.AddressInfo).port;
    try {
      const cmd = buildNodeHookCommand(
        `http://127.0.0.1:${port}`,
        "Claude",
        MARKER,
        STATUS,
        "/nonexistent/port-file.json"
      );
      const start = Date.now();
      const res = await runHook(cmd, {
        env: { AQP_SESSION: "Claude", AQP_HOOK_URL: `http://127.0.0.1:${port}` },
        stdin: "{}",
      });
      const elapsed = Date.now() - start;
      assert.strictEqual(res.code, 0);
      assert.ok(
        elapsed < 3500,
        `hook should exit via the 2s socket timeout, took ${elapsed}ms`
      );
    } finally {
      blackHole.close();
    }
  });
});
