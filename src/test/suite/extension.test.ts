import * as assert from "assert";
import * as vscode from "vscode";
import * as path from "path";

import {
  BUILTIN_AGENTS,
  loadAgents,
  resolveIconPath,
  resolveColor,
  isCmdInstalled,
  isSafeBinaryName,
  _resetInstallCacheForTests,
} from "../../extension";

const EXTENSION_URI = vscode.Uri.file(path.resolve(__dirname, "../../.."));

suite("loadAgents", () => {
  test("returns built-in defaults when config is undefined", () => {
    const agents = loadAgents(undefined);
    assert.strictEqual(agents.length, BUILTIN_AGENTS.length);
    assert.strictEqual(agents[0].name, "Terminal");
    assert.strictEqual(agents[1].name, "Claude");
    assert.strictEqual(agents[agents.length - 1].name, "oh-my-pi");
  });

  test("returns built-in defaults when config is not an array", () => {
    const agents = loadAgents({ foo: "bar" });
    assert.strictEqual(agents.length, BUILTIN_AGENTS.length);
  });

  test("personal aliases are NOT in the defaults", () => {
    const agents = loadAgents(undefined);
    const names = agents.map((a) => a.name);
    assert.ok(!names.includes("Claude Proxy"), "claude-proxy should not be a default");
    assert.ok(!names.includes("Claude GLM"), "claude-glm should not be a default");
  });

  test("Command Code IS a default", () => {
    const agents = loadAgents(undefined);
    assert.ok(agents.find((a) => a.name === "Command Code"), "Command Code should be a default");
  });

  test("canonical agents ARE in the defaults", () => {
    const agents = loadAgents(undefined);
    const names = agents.map((a) => a.name);
    for (const expected of ["Codex", "Gemini", "Copilot", "Aider", "Goose", "Crush", "Amp", "Qwen", "Plandex", "Grok", "Cody", "Kilo", "Qodo"]) {
      assert.ok(names.includes(expected), `${expected} should be a default`);
    }
  });

  test("user override merges by name", () => {
    const agents = loadAgents([
      { name: "Claude", cmd: "my-claude", icon: "rocket", color: "terminal.ansiRed" },
    ]);
    const claude = agents.find((a) => a.name === "Claude");
    assert.ok(claude);
    assert.strictEqual(claude!.cmd, "my-claude");
    assert.strictEqual(claude!.icon, "rocket");
    assert.strictEqual(claude!.color, "terminal.ansiRed");
    // Same total count (overrode, didn't add)
    assert.strictEqual(agents.length, BUILTIN_AGENTS.length);
  });

  test("user override is case-insensitive by name", () => {
    const agents = loadAgents([{ name: "claude", cmd: "my-claude" }]);
    const claude = agents.find((a) => a.name === "claude");
    assert.ok(claude);
    // Built-in "Claude" replaced (only one claude entry survives)
    assert.strictEqual(agents.filter((a) => a.name.toLowerCase() === "claude").length, 1);
  });

  test("hidden:true removes a built-in", () => {
    const agents = loadAgents([{ name: "Droid", hidden: true }]);
    assert.strictEqual(agents.find((a) => a.name === "Droid"), undefined);
    assert.strictEqual(agents.length, BUILTIN_AGENTS.length - 1);
  });

  test("user adds a brand-new agent at the end", () => {
    const agents = loadAgents([
      { name: "My Agent", cmd: "myagent", icon: "beaker" },
    ]);
    assert.strictEqual(agents.length, BUILTIN_AGENTS.length + 1);
    assert.strictEqual(agents[agents.length - 1].name, "My Agent");
  });

  test("user entries missing name are skipped", () => {
    const agents = loadAgents([
      { cmd: "noname" },
      { name: "", cmd: "empty" },
      { name: "Real", cmd: "real" },
    ]);
    assert.strictEqual(agents.length, BUILTIN_AGENTS.length + 1);
    assert.ok(agents.find((a) => a.name === "Real"));
    assert.strictEqual(agents.find((a) => a.name === ""), undefined);
  });

  test("non-object user entries are skipped", () => {
    const agents = loadAgents([null, "string", 42, { name: "Real", cmd: "real" }]);
    assert.strictEqual(agents.length, BUILTIN_AGENTS.length + 1);
  });
});

suite("resolveIconPath", () => {
  test("empty → ThemeIcon terminal", () => {
    const icon = resolveIconPath(undefined, EXTENSION_URI);
    assert.ok(icon instanceof vscode.ThemeIcon);
    assert.strictEqual((icon as vscode.ThemeIcon).id, "terminal");
  });

  test('"terminal" → ThemeIcon terminal', () => {
    const icon = resolveIconPath("terminal", EXTENSION_URI);
    assert.ok(icon instanceof vscode.ThemeIcon);
    assert.strictEqual((icon as vscode.ThemeIcon).id, "terminal");
  });

  test("absolute path that exists → Uri.file", () => {
    // Use a file we know exists: one of the bundled icons.
    const abs = path.join(EXTENSION_URI.fsPath, "icons", "claude.svg");
    const icon = resolveIconPath(abs, EXTENSION_URI);
    assert.ok(icon instanceof vscode.Uri);
  });

  test("absolute path that does NOT exist → ThemeIcon terminal (fallback)", () => {
    const abs = process.platform === "win32"
      ? "C:\\definitely\\does\\not\\exist.svg"
      : "/definitely/does/not/exist.svg";
    const icon = resolveIconPath(abs, EXTENSION_URI);
    assert.ok(icon instanceof vscode.ThemeIcon, "expected fallback to ThemeIcon");
    assert.strictEqual((icon as vscode.ThemeIcon).id, "terminal");
  });

  test("codicon id → ThemeIcon", () => {
    const icon = resolveIconPath("rocket", EXTENSION_URI);
    assert.ok(icon instanceof vscode.ThemeIcon);
    assert.strictEqual((icon as vscode.ThemeIcon).id, "rocket");
  });

  test("codicon id is lowercased", () => {
    const icon = resolveIconPath("Rocket", EXTENSION_URI);
    assert.ok(icon instanceof vscode.ThemeIcon);
    assert.strictEqual((icon as vscode.ThemeIcon).id, "rocket");
  });

  test("bundled filename that exists → Uri to icons folder", () => {
    const icon = resolveIconPath("claude.svg", EXTENSION_URI);
    assert.ok(icon instanceof vscode.Uri);
    assert.ok((icon as vscode.Uri).fsPath.includes("icons"));
    assert.ok((icon as vscode.Uri).fsPath.includes("claude.svg"));
  });

  test("bundled filename that does NOT exist → ThemeIcon terminal (fallback)", () => {
    const icon = resolveIconPath("definitely-not-a-real-icon.svg", EXTENSION_URI);
    assert.ok(icon instanceof vscode.ThemeIcon, "expected fallback to ThemeIcon");
    assert.strictEqual((icon as vscode.ThemeIcon).id, "terminal");
  });

  test("non-string falls back to ThemeIcon terminal", () => {
    const icon = resolveIconPath(123, EXTENSION_URI);
    assert.ok(icon instanceof vscode.ThemeIcon);
    assert.strictEqual((icon as vscode.ThemeIcon).id, "terminal");
  });
});

suite("resolveColor", () => {
  test("undefined → undefined", () => {
    assert.strictEqual(resolveColor(undefined), undefined);
  });

  test("empty → undefined", () => {
    assert.strictEqual(resolveColor(""), undefined);
  });

  test("built-in color id → ThemeColor", () => {
    const c = resolveColor("agentQuickpick.claude");
    assert.ok(c instanceof vscode.ThemeColor);
    assert.strictEqual(c!.id, "agentQuickpick.claude");
  });

  test("stock terminal.ansi* key → ThemeColor", () => {
    const c = resolveColor("terminal.ansiBlue");
    assert.ok(c instanceof vscode.ThemeColor);
    assert.strictEqual(c!.id, "terminal.ansiBlue");
  });

  test("bright ansi key → ThemeColor", () => {
    const c = resolveColor("terminal.ansiBrightMagenta");
    assert.ok(c instanceof vscode.ThemeColor);
    assert.strictEqual(c!.id, "terminal.ansiBrightMagenta");
  });

  test("garbage → undefined (does not throw)", () => {
    assert.strictEqual(resolveColor("not.a.real.color"), undefined);
    assert.strictEqual(resolveColor("#FF0000"), undefined);
    assert.strictEqual(resolveColor("red"), undefined);
  });
});

suite("isCmdInstalled", () => {
  setup(() => _resetInstallCacheForTests());
  teardown(() => _resetInstallCacheForTests());

  test("empty cmd → true (plain terminal)", async () => {
    assert.strictEqual(await isCmdInstalled(""), true);
    assert.strictEqual(await isCmdInstalled("   "), true);
  });

  test("a definitely-present binary → true", async () => {
    // `node` is running this test, so it must be on PATH.
    assert.strictEqual(await isCmdInstalled("node"), true);
  });

  test("a definitely-absent binary → false", async () => {
    assert.strictEqual(await isCmdInstalled("definitely-not-a-real-cli-xyz123"), false);
  });

  test("multi-word cmd checks only the first token", async () => {
    // `gh` itself may or may not be installed, but the check must not try to
    // resolve the literal string "gh copilot" as a binary name.
    const result = await isCmdInstalled("gh copilot");
    // Whatever the result, it should equal checking `gh` alone.
    assert.strictEqual(result, await isCmdInstalled("gh"));
  });

  test("unsafe binary names are rejected without hitting the shell", async () => {
    // Shell metacharacters → treat as not installed, never exec.
    assert.strictEqual(await isCmdInstalled('foo"; rm -rf /'), false);
    assert.strictEqual(await isCmdInstalled("foo && bar"), false);
    assert.strictEqual(await isCmdInstalled("foo$(evil)"), false);
    assert.strictEqual(await isCmdInstalled("foo | bar"), false);
  });

  test("caches results", async () => {
    // First call hits the shell.
    const first = await isCmdInstalled("node");
    // Second call should return from cache without re-running.
    const second = await isCmdInstalled("node");
    assert.strictEqual(first, second);
  });
});

suite("isSafeBinaryName", () => {
  test("allows normal binary names", () => {
    assert.strictEqual(isSafeBinaryName("claude"), true);
    assert.strictEqual(isSafeBinaryName("claude-glm"), true);
    assert.strictEqual(isSafeBinaryName("my_tool"), true);
    assert.strictEqual(isSafeBinaryName("tool2"), true);
    assert.strictEqual(isSafeBinaryName("foo.bar"), true);
  });

  test("rejects shell metacharacters", () => {
    assert.strictEqual(isSafeBinaryName('foo"bar'), false);
    assert.strictEqual(isSafeBinaryName("foo;bar"), false);
    assert.strictEqual(isSafeBinaryName("foo && bar"), false);
    assert.strictEqual(isSafeBinaryName("foo$(x)"), false);
    assert.strictEqual(isSafeBinaryName("foo|bar"), false);
    assert.strictEqual(isSafeBinaryName("foo>bar"), false);
    assert.strictEqual(isSafeBinaryName("foo bar"), false); // space → multi-token
  });

  test("rejects empty", () => {
    assert.strictEqual(isSafeBinaryName(""), false);
  });
});
