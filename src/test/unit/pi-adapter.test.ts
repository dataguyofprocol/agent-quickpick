/**
 * pi plugin-file adapter: generated source contract, agent-dir resolution
 * across platforms, and registry wiring.
 * Unit tier — no VS Code host needed.
 */

import * as assert from "assert";
import * as path from "path";

import {
  buildPiExtensionSource,
  resolveValidatedPiAgentDir,
  PI_ADAPTER,
  OPENCODE_ADAPTER,
  getAdapter,
  LIFECYCLE_ADAPTERS,
} from "../../lifecycle-adapters";

const HOOK_URL = "http://127.0.0.1:54321/hook";
const SESSION = "pi-session-42";
const PORT_FILE_PATH = "/home/user/.config/agent-quickpick/hook-server.json";

suite("pi adapter (plugin-file)", () => {
  const adapter = PI_ADAPTER;

  test("is a plugin-file adapter (pi has no hooks JSON at all)", () => {
    assert.strictEqual(adapter.kind, "plugin-file");
    assert.strictEqual(adapter.agentName, "pi");
    assert.strictEqual(adapter.marker, "agentQuickpick:pi");
  });

  test("extension path is an agent-dir-relative .js fragment", () => {
    assert.ok(adapter.kind === "plugin-file");
    assert.strictEqual(adapter.pluginPath, "extensions/agent-quickpick-lifecycle.js");
    // pi's auto-loader only recognizes `.ts` and `.js` — an `.mjs` file in
    // extensions/ is never loaded, so this suffix is load-bearing.
    assert.ok(adapter.pluginPath.endsWith(".js"), "must be .js for pi's loader");
    assert.ok(
      !adapter.pluginPath.startsWith("/") && !adapter.pluginPath.startsWith("~"),
      "must be a relative fragment joined with the resolved agent dir"
    );
  });

  test("does not collide with OpenCode's plugin path or marker", () => {
    assert.ok(OPENCODE_ADAPTER.kind === "plugin-file" && adapter.kind === "plugin-file");
    assert.notStrictEqual(adapter.pluginPath, OPENCODE_ADAPTER.pluginPath);
    assert.notStrictEqual(adapter.marker, OPENCODE_ADAPTER.marker);
  });

  test("resolveBaseDir is pi's agent-dir resolver", () => {
    assert.ok(adapter.kind === "plugin-file");
    assert.strictEqual(adapter.resolveBaseDir, resolveValidatedPiAgentDir);
  });

  test("registry exposes pi case-insensitively", () => {
    assert.strictEqual(LIFECYCLE_ADAPTERS.pi, adapter);
    assert.strictEqual(getAdapter("pi"), adapter);
    assert.strictEqual(getAdapter("PI"), adapter);
    assert.strictEqual(getAdapter("Pi"), adapter);
    // oh-my-pi (`omp`) is a separate launch-only built-in.
    assert.strictEqual(getAdapter("oh-my-pi"), undefined);
    assert.strictEqual(getAdapter("omp"), undefined);
  });
});

suite("resolveValidatedPiAgentDir", () => {
  test("defaults to <home>/.pi/agent on every platform", () => {
    // pi has no XDG lookup and no Windows branch, so neither does this.
    assert.strictEqual(
      resolveValidatedPiAgentDir({}, "darwin", "/Users/me"),
      path.normalize("/Users/me/.pi/agent")
    );
    assert.strictEqual(
      resolveValidatedPiAgentDir({}, "linux", "/home/me"),
      path.normalize("/home/me/.pi/agent")
    );
    const win = resolveValidatedPiAgentDir({}, "win32", "C:\\Users\\me");
    assert.ok(win.startsWith("C:"), `expected a drive-rooted path, got ${win}`);
    assert.ok(win.includes(".pi"), win);
  });

  test("XDG_CONFIG_HOME is ignored (pi doesn't read it)", () => {
    assert.strictEqual(
      resolveValidatedPiAgentDir({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/me"),
      path.normalize("/home/me/.pi/agent")
    );
  });

  test("an absolute PI_CODING_AGENT_DIR wins", () => {
    assert.strictEqual(
      resolveValidatedPiAgentDir(
        { PI_CODING_AGENT_DIR: "/opt/pi-agent" },
        "linux",
        "/home/me"
      ),
      path.normalize("/opt/pi-agent")
    );
  });

  test("a leading ~ is expanded exactly as pi expands it", () => {
    assert.strictEqual(
      resolveValidatedPiAgentDir({ PI_CODING_AGENT_DIR: "~" }, "linux", "/home/me"),
      path.normalize("/home/me")
    );
    assert.strictEqual(
      resolveValidatedPiAgentDir(
        { PI_CODING_AGENT_DIR: "~/pi-agent" },
        "linux",
        "/home/me"
      ),
      path.normalize("/home/me/pi-agent")
    );
    // Backslash form only on Windows, where it's a path separator.
    assert.strictEqual(
      resolveValidatedPiAgentDir(
        { PI_CODING_AGENT_DIR: "~\\pi-agent" },
        "win32",
        "C:\\Users\\me"
      ),
      path.normalize(path.join("C:\\Users\\me", "pi-agent"))
    );
  });

  test("a relative override throws rather than being silently anchored", () => {
    assert.throws(
      () => resolveValidatedPiAgentDir({ PI_CODING_AGENT_DIR: "pi" }, "linux", "/home/me"),
      /absolute/
    );
    assert.throws(
      () =>
        resolveValidatedPiAgentDir(
          { PI_CODING_AGENT_DIR: "../../etc" },
          "linux",
          "/home/me"
        ),
      /absolute/
    );
    // "~foo" is not a home reference — pi only expands "~" and "~/".
    assert.throws(
      () =>
        resolveValidatedPiAgentDir({ PI_CODING_AGENT_DIR: "~foo" }, "linux", "/home/me"),
      /absolute/
    );
  });

  test("an override absolute for the wrong platform is rejected", () => {
    assert.throws(
      () =>
        resolveValidatedPiAgentDir(
          { PI_CODING_AGENT_DIR: "/abs/pi" },
          "win32",
          "C:\\Users\\me"
        ),
      /absolute/
    );
    assert.throws(
      () =>
        resolveValidatedPiAgentDir(
          { PI_CODING_AGENT_DIR: "C:\\pi" },
          "linux",
          "/home/me"
        ),
      /absolute/
    );
  });

  test("traversal inside an accepted override is normalized away", () => {
    assert.strictEqual(
      resolveValidatedPiAgentDir(
        { PI_CODING_AGENT_DIR: "/opt/pi/../pi-agent/./x" },
        "linux",
        "/home/me"
      ),
      path.normalize("/opt/pi-agent/x")
    );
  });
});

suite("buildPiExtensionSource", () => {
  const src = buildPiExtensionSource(HOOK_URL, SESSION, PORT_FILE_PATH);

  test("carries the marker and version header", () => {
    assert.ok(src.includes("agentQuickpick:pi"), "marker must be present so the");
    assert.ok(src.includes("AQP_PI_INTEGRATION_VERSION="), "version header");
    assert.ok(src.startsWith("// @ts-nocheck"), "must not be typechecked by a user's tsc");
  });

  test("embeds the URL, port file, and the AQP_SESSION guard", () => {
    assert.ok(src.includes(HOOK_URL), "should embed the server URL");
    assert.ok(src.includes(PORT_FILE_PATH), "should embed the port file path");
    assert.ok(src.includes("AQP_SESSION"), "should guard on the injected session env");
    // The session argument is deliberately NOT baked in — it's read from the
    // env at runtime, so one file serves every terminal.
    assert.ok(!src.includes(`"${SESSION}"`), "session must not be baked into the source");
  });

  test("is ESM with a default-exported factory (pi ignores anything else)", () => {
    assert.ok(src.includes("export default function"), "pi requires a function default");
    assert.ok(!/\brequire\(/.test(src), "bare require() throws in ESM and blacklists the file");
    assert.ok(src.includes('import("node:http")'), "must use dynamic import");
  });

  test("contains no TypeScript syntax (it lands as .js)", () => {
    assert.ok(!/:\s*(string|number|boolean|unknown|any)\b/.test(src), "no type annotations");
    assert.ok(!/\binterface\s+\w+\s*\{/.test(src), "no interfaces");
    assert.ok(!/\bas\s+(const|string|number)\b/.test(src), "no as-casts");
  });

  test("gates on tui mode and never starts background work in the factory", () => {
    assert.ok(src.includes('=== "tui"'), "must gate on ctx.mode");
    assert.ok(!/setInterval|createConnection|fs\.watch/.test(src), "no background resources");
  });

  test("wires agent_settled as the boundary, not just agent_end", () => {
    for (const event of [
      "session_start",
      "before_agent_start",
      "agent_start",
      "tool_execution_start",
      "tool_execution_end",
      "ui_prompt_start",
      "ui_prompt_end",
      "message_end",
      "agent_end",
      "agent_settled",
      "session_shutdown",
    ]) {
      assert.ok(src.includes(`pi.on("${event}"`), `should subscribe to ${event}`);
    }
    assert.ok(src.includes("settledSupported"), "agent_end must defer to agent_settled");
  });

  test("names pi as the agent and sends the reason field", () => {
    assert.ok(src.includes('agentName: "pi"'), "payload agentName");
    assert.ok(src.includes("status, reason,"), "POST body should include the reason field");
  });
});
