/**
 * The localhost lifecycle HTTP server — real-socket behavioral tests: request
 * handling, payload limits, error tolerance, and dispose semantics.
 * Unit tier — startLifecycleServer only uses node:http (no VS Code host).
 */

import * as assert from "assert";
import * as http from "http";

import { startLifecycleServer, type HookPayload } from "../../lifecycle";

/** POST JSON to a URL and resolve {status, body}. */
function post(
  url: string,
  body: string,
  headers: Record<string, string> = { "Content-Type": "application/json" }
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** GET a URL and resolve {status}. */
function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: "GET" },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

suite("startLifecycleServer", () => {
  test("url resolves to a real localhost port once listening", async () => {
    const server = startLifecycleServer(() => {});
    const url = await server.url;
    const u = new URL(url);
    assert.strictEqual(u.hostname, "127.0.0.1");
    assert.ok(Number(u.port) > 0, `port should be non-zero, got ${u.port}`);
    server.dispose();
  });

  test("POST valid JSON → onEvent receives the parsed payload, responds 200 {}", async () => {
    const payloads: HookPayload[] = [];
    const server = startLifecycleServer((p) => payloads.push(p));
    const url = await server.url;
    const res = await post(
      url,
      JSON.stringify({ marker: "agentQuickpick:claude", session: "Claude", status: "finished" })
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body, "{}");
    assert.strictEqual(payloads.length, 1);
    assert.strictEqual(payloads[0].session, "Claude");
    assert.strictEqual(payloads[0].status, "finished");
    server.dispose();
  });

  test("POST malformed JSON → no event, still 200", async () => {
    const payloads: HookPayload[] = [];
    const server = startLifecycleServer((p) => payloads.push(p));
    const url = await server.url;
    const res = await post(url, "{not json at all");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(payloads.length, 0);
    server.dispose();
  });

  test("POST non-object JSON (number) → no event", async () => {
    const payloads: HookPayload[] = [];
    const server = startLifecycleServer((p) => payloads.push(p));
    const url = await server.url;
    const res = await post(url, "42");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(payloads.length, 0);
    server.dispose();
  });

  test("GET → 405 (hooks only ever POST)", async () => {
    const server = startLifecycleServer(() => {});
    const url = await server.url;
    const res = await get(url);
    assert.strictEqual(res.status, 405);
    server.dispose();
  });

  test("oversized body (>64KB) → 413, destroyed, no event", async () => {
    const payloads: HookPayload[] = [];
    const server = startLifecycleServer((p) => payloads.push(p));
    const url = await server.url;
    const huge = "x".repeat(128 * 1024);
    // The connection is destroyed mid-body, so the request errors client-side
    // (ECONNRESET) or returns 413 — either way, no payload may be delivered.
    await post(url, huge).then(
      (res) => assert.strictEqual(res.status, 413),
      (err) => assert.ok(err, "expected the connection to be destroyed")
    );
    // Give any (wrongly) queued event a moment to fire.
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(payloads.length, 0);
    server.dispose();
  });

  test("rapid concurrent posts are all delivered", async () => {
    const payloads: HookPayload[] = [];
    const server = startLifecycleServer((p) => payloads.push(p));
    const url = await server.url;
    const N = 20;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        post(url, JSON.stringify({ session: `Claude (${i + 1})`, status: "running" }))
      )
    );
    assert.strictEqual(payloads.length, N);
    server.dispose();
  });

  test("payload fields survive intact (cwd, reason, message, agentName)", async () => {
    const payloads: HookPayload[] = [];
    const server = startLifecycleServer((p) => payloads.push(p));
    const url = await server.url;
    await post(
      url,
      JSON.stringify({
        marker: "agentQuickpick:opencode",
        session: "OpenCode (2)",
        status: "waiting",
        agentName: "OpenCode",
        cwd: "/Users/me/projects/my-app",
        reason: "permission",
        message: "needs your permission to use Bash",
      })
    );
    const p = payloads[0];
    assert.strictEqual(p.marker, "agentQuickpick:opencode");
    assert.strictEqual(p.session, "OpenCode (2)");
    assert.strictEqual(p.status, "waiting");
    assert.strictEqual(p.cwd, "/Users/me/projects/my-app");
    assert.strictEqual(p.reason, "permission");
    assert.strictEqual(p.message, "needs your permission to use Bash");
    server.dispose();
  });

  test("dispose closes the socket — subsequent requests refuse", async () => {
    const server = startLifecycleServer(() => {});
    const url = await server.url;
    const res = await post(url, JSON.stringify({ session: "Claude" }));
    assert.strictEqual(res.status, 200);
    server.dispose();
    // Give the close a beat to land, then confirm the port is dead.
    await new Promise((r) => setTimeout(r, 150));
    await assert.rejects(() => post(url, "{}"), "connection should be refused after dispose");
  });
});
