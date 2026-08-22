/**
 * OpenCode plugin-file adapter: generated source contract, registry
 * invariants, and per-platform config-dir resolution.
 * Unit tier — no VS Code host needed.
 */

import * as assert from "assert";
import * as path from "path";

import {
  buildOpenCodePluginSource,
  resolveValidatedOpenCodeConfigDir,
  isAbsoluteForPlatform,
  OPENCODE_ADAPTER,
  LIFECYCLE_ADAPTERS,
  getAdapter,
  isLifecycleAgent,
  CLAUDE_ADAPTER,
  DROID_ADAPTER,
} from "../../lifecycle-adapters";

const HOOK_URL = "http://127.0.0.1:99999";
const SESSION = "Claude";
const PORT_FILE_PATH = "/home/user/.config/agent-quickpick/hook-server.json";

suite("OpenCode adapter (plugin-file)", () => {
  const adapter = OPENCODE_ADAPTER;

  test("is a plugin-file adapter (no JSON config edit)", () => {
    assert.strictEqual(adapter.kind, "plugin-file");
  });

  test("plugin path is a config-dir-relative fragment", () => {
    assert.ok(adapter.kind === "plugin-file");
    // Path is relative to OpenCode's config dir (resolved per-platform), not to
    // home — so it's a bare "plugin/..." fragment. The extension joins it with
    // resolveValidatedOpenCodeConfigDir(...) at install time.
    assert.strictEqual(
      adapter.pluginPath,
      "plugin/agent-quickpick-lifecycle.js"
    );
    assert.ok(adapter.pluginPath.endsWith(".js"), "must be .js for OpenCode's discovery glob");
  });

  test("buildSource embeds URL + marker and guards on AQP_SESSION", () => {
    assert.ok(adapter.kind === "plugin-file");
    const src = adapter.buildSource(HOOK_URL, SESSION, PORT_FILE_PATH);
    assert.ok(src.includes("127.0.0.1"), "should embed the server URL");
    assert.ok(src.includes("agentQuickpick:opencode"), "should contain the marker");
    assert.ok(src.includes("AQP_SESSION"), "should guard on the injected session env");
  });
});

suite("buildOpenCodePluginSource", () => {
  test("produces ESM with the marker comment", () => {
    const src = buildOpenCodePluginSource(HOOK_URL, SESSION, PORT_FILE_PATH);
    assert.ok(src.includes("agentQuickpick:opencode"), "should contain marker");
  });

  test("exports the plugin factory", () => {
    const src = buildOpenCodePluginSource(HOOK_URL, SESSION, PORT_FILE_PATH);
    assert.ok(
      src.includes("AgentQuickpickLifecyclePlugin"),
      "should export the plugin name"
    );
  });

  test("maps lifecycle events to statuses", () => {
    const src = buildOpenCodePluginSource(HOOK_URL, SESSION, PORT_FILE_PATH);
    assert.ok(src.includes("session.idle"), "should handle session.idle");
    assert.ok(src.includes("permission.asked"), "should handle permission.asked");
    assert.ok(src.includes("question.asked"), "should handle question.asked");
    assert.ok(src.includes("session.error"), "should handle session.error");
  });

  test("embeds the hook URL", () => {
    const src = buildOpenCodePluginSource(HOOK_URL, SESSION, PORT_FILE_PATH);
    assert.ok(src.includes("127.0.0.1"), "should embed the server URL");
  });

  test("forwards process.cwd() in the POST body for repo attribution", () => {
    const src = buildOpenCodePluginSource(HOOK_URL, SESSION, PORT_FILE_PATH);
    assert.ok(
      src.includes("cwd: process.cwd()"),
      "should include process.cwd() in the POST body so sessions can be repo-scoped"
    );
  });

  test("uses dynamic import() not require() for http", () => {
    const src = buildOpenCodePluginSource(HOOK_URL, SESSION, PORT_FILE_PATH);
    assert.ok(
      src.includes('import("node:http")'),
      "plugin should use dynamic import('node:http') for Node-ESM compatibility"
    );
    assert.ok(
      !src.includes('require("http")'),
      "plugin should not use require() — bare require throws under Node ESM"
    );
  });

  test("arms a 2s socket timeout", () => {
    const src = buildOpenCodePluginSource(HOOK_URL, SESSION, PORT_FILE_PATH);
    assert.ok(src.includes("setTimeout(2000"), "plugin should arm a 2s socket timeout");
  });

  test("posts typed reasons for the two ask events", () => {
    const src = buildOpenCodePluginSource(HOOK_URL, SESSION, PORT_FILE_PATH);
    assert.ok(src.includes('post("waiting", "permission")'), "permission.asked → waiting/permission");
    assert.ok(src.includes('post("waiting", "question")'), "question.asked → waiting/question");
    assert.ok(src.includes("status, reason,"), "POST body should include the reason field");
  });
});

suite("adapter registry", () => {
  test("has all three adapters", () => {
    assert.ok(LIFECYCLE_ADAPTERS.Claude);
    assert.ok(LIFECYCLE_ADAPTERS.Droid);
    assert.ok(LIFECYCLE_ADAPTERS.OpenCode);
  });

  test("getAdapter returns by name", () => {
    assert.strictEqual(getAdapter("Claude"), CLAUDE_ADAPTER);
    assert.strictEqual(getAdapter("Droid"), DROID_ADAPTER);
    assert.strictEqual(getAdapter("OpenCode"), OPENCODE_ADAPTER);
  });

  test("getAdapter returns undefined for unsupported agent", () => {
    assert.strictEqual(getAdapter("Codex"), undefined);
  });

  test("isLifecycleAgent is correct", () => {
    assert.ok(isLifecycleAgent("Claude"));
    assert.ok(isLifecycleAgent("Droid"));
    assert.ok(isLifecycleAgent("OpenCode"));
    assert.ok(!isLifecycleAgent("Codex"));
    assert.ok(!isLifecycleAgent("Terminal"));
  });

  test("each adapter has a unique marker", () => {
    const markers = Object.values(LIFECYCLE_ADAPTERS).map((a) => a.marker);
    assert.strictEqual(new Set(markers).size, markers.length, "markers must be unique");
  });

  test("each adapter targets a unique, relative path", () => {
    const paths = Object.values(LIFECYCLE_ADAPTERS).map((a) =>
      a.kind === "command-hooks" ? a.configPath : a.pluginPath
    );
    assert.strictEqual(new Set(paths).size, paths.length, "target paths must be unique");
    // Command-hook paths are home-relative; OpenCode's plugin path is relative
    // to its config dir. Both are relative fragments (no leading slash, no ~).
    for (const p of paths) {
      assert.ok(!p.startsWith("/") && !p.startsWith("~"), `${p} should be a relative fragment`);
    }
  });
});

suite("isAbsoluteForPlatform", () => {
  test("unix: leading slash is absolute", () => {
    assert.strictEqual(isAbsoluteForPlatform("/abs/path", "linux"), true);
    assert.strictEqual(isAbsoluteForPlatform("/abs/path", "darwin"), true);
    assert.strictEqual(isAbsoluteForPlatform("rel/path", "linux"), false);
    assert.strictEqual(isAbsoluteForPlatform("", "linux"), false);
  });

  test("win32: drive letter (+ slash or backslash) is absolute", () => {
    assert.strictEqual(isAbsoluteForPlatform("C:\\Users\\me", "win32"), true);
    assert.strictEqual(isAbsoluteForPlatform("D:/oc", "win32"), true);
    assert.strictEqual(isAbsoluteForPlatform("C:oc", "win32"), false);
    assert.strictEqual(isAbsoluteForPlatform("/unix/style", "win32"), false);
    assert.strictEqual(isAbsoluteForPlatform("relative", "win32"), false);
  });

  test("drive-letter casing is irrelevant", () => {
    assert.strictEqual(isAbsoluteForPlatform("c:\\lower", "win32"), true);
    assert.strictEqual(isAbsoluteForPlatform("Z:\\upper", "win32"), true);
  });
});

suite("resolveValidatedOpenCodeConfigDir", () => {
  const home = "/home/user";
  const winHome = "C:\\Users\\me";

  test("absolute OPENCODE_CONFIG_DIR always wins, traversal collapsed", () => {
    assert.strictEqual(
      resolveValidatedOpenCodeConfigDir(
        { OPENCODE_CONFIG_DIR: "/custom/../custom/oc", XDG_CONFIG_HOME: "/xdg" },
        "linux",
        home
      ),
      "/custom/oc"
    );
  });

  test("relative OPENCODE_CONFIG_DIR throws instead of being anchored", () => {
    assert.throws(
      () =>
        resolveValidatedOpenCodeConfigDir(
          { OPENCODE_CONFIG_DIR: "../../etc" },
          "linux",
          home
        ),
      /OPENCODE_CONFIG_DIR must be an absolute path/
    );
  });

  test("XDG_CONFIG_HOME used when OPENCODE_CONFIG_DIR absent", () => {
    assert.strictEqual(
      resolveValidatedOpenCodeConfigDir({ XDG_CONFIG_HOME: "/xdg" }, "linux", home),
      path.join("/xdg", "opencode")
    );
  });

  test("trailing-slash XDG_CONFIG_HOME normalizes cleanly", () => {
    assert.strictEqual(
      resolveValidatedOpenCodeConfigDir({ XDG_CONFIG_HOME: "/xdg/" }, "linux", home),
      path.join("/xdg", "opencode")
    );
  });

  test("XDG traversal segments are collapsed before the join", () => {
    assert.strictEqual(
      resolveValidatedOpenCodeConfigDir({ XDG_CONFIG_HOME: "/xdg/a/../b" }, "linux", home),
      path.join("/xdg/b", "opencode")
    );
  });

  test("relative XDG_CONFIG_HOME is anchored to homedir", () => {
    assert.strictEqual(
      resolveValidatedOpenCodeConfigDir({ XDG_CONFIG_HOME: ".xdg" }, "linux", home),
      path.join(home, ".xdg", "opencode")
    );
  });

  test("empty-string env values are treated as unset", () => {
    // A set-but-empty override must not win over the platform default.
    assert.strictEqual(
      resolveValidatedOpenCodeConfigDir(
        { OPENCODE_CONFIG_DIR: "", XDG_CONFIG_HOME: "" },
        "darwin",
        home
      ),
      path.join(home, ".config", "opencode")
    );
  });

  test("Windows uses APPDATA (xdg-basedir's Windows fallback)", () => {
    assert.strictEqual(
      resolveValidatedOpenCodeConfigDir(
        { APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
        "win32",
        winHome
      ),
      path.join("C:\\Users\\me\\AppData\\Roaming", "opencode")
    );
  });

  test("Windows falls back to LOCALAPPDATA then home", () => {
    assert.strictEqual(
      resolveValidatedOpenCodeConfigDir({ LOCALAPPDATA: "C:\\local" }, "win32", winHome),
      path.join("C:\\local", "opencode")
    );
    assert.strictEqual(
      resolveValidatedOpenCodeConfigDir({}, "win32", winHome),
      path.join(winHome, "opencode")
    );
  });

  test("macOS/Linux default → ~/.config/opencode", () => {
    assert.strictEqual(
      resolveValidatedOpenCodeConfigDir({}, "darwin", home),
      path.join(home, ".config", "opencode")
    );
    assert.strictEqual(
      resolveValidatedOpenCodeConfigDir({}, "linux", home),
      path.join(home, ".config", "opencode")
    );
  });

  test("OPENCODE_CONFIG_DIR wins even on Windows", () => {
    assert.strictEqual(
      resolveValidatedOpenCodeConfigDir(
        { OPENCODE_CONFIG_DIR: "D:\\oc", APPDATA: "C:\\AppData\\Roaming" },
        "win32",
        winHome
      ),
      "D:\\oc"
    );
  });

  test("a resolved dir that is not absolute for the platform throws", () => {
    // A relative XDG anchored to a non-drive-letter home can never satisfy
    // the win32 check — the final guard catches it before any join happens.
    assert.throws(
      () => resolveValidatedOpenCodeConfigDir({ XDG_CONFIG_HOME: "rel" }, "win32", home),
      /not absolute/
    );
  });
});
