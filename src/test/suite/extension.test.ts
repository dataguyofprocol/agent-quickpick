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
  frecencyScore,
  sortByFrecency,
  launchText,
  _resetInstallCacheForTests,
  _poisonInstallCacheForTests,
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

  test("launcher field survives the merge", () => {
    const agents = loadAgents([
      { name: "My Agent", cmd: "myagent", launcher: "npx", icon: "beaker" },
    ]);
    const mine = agents.find((a) => a.name === "My Agent");
    assert.ok(mine, "My Agent should be present");
    assert.strictEqual(mine!.launcher, "npx");
  });

  test("built-in Crush ships with uvx launcher", () => {
    const agents = loadAgents(undefined);
    const crush = agents.find((a) => a.name === "Crush");
    assert.ok(crush, "Crush should be a built-in");
    assert.strictEqual(crush!.launcher, "uvx");
    assert.strictEqual(crush!.cmd, "crush");
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

  test("declared-but-unused built-in color ids resolve (claudeProxy, claudeGlm)", () => {
    // These ids are declared in contributes.colors and referenced by the
    // README's custom-agent example, but no longer used by BUILTIN_AGENTS —
    // they must still resolve, not silently fall back to undefined.
    const proxy = resolveColor("agentQuickpick.claudeProxy");
    assert.ok(proxy instanceof vscode.ThemeColor);
    assert.strictEqual(proxy!.id, "agentQuickpick.claudeProxy");

    const glm = resolveColor("agentQuickpick.claudeGlm");
    assert.ok(glm instanceof vscode.ThemeColor);
    assert.strictEqual(glm!.id, "agentQuickpick.claudeGlm");
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

  test("launcher probes the launcher binary, not the first token of cmd", async () => {
    // `node` is on PATH; the check should probe `node` regardless of `cmd`.
    const result = await isCmdInstalled("crush", "node");
    assert.strictEqual(result, true);
    // An absent launcher should report not installed even if `cmd` would be.
    const absent = await isCmdInstalled("crush", "definitely-not-a-real-cli-xyz123");
    assert.strictEqual(absent, false);
  });

  test("unsafe launcher names are rejected without hitting the shell", async () => {
    assert.strictEqual(await isCmdInstalled("crush", "uvx; rm -rf /"), false);
    assert.strictEqual(await isCmdInstalled("crush", "npx && evil"), false);
    assert.strictEqual(await isCmdInstalled("crush", "foo$(x)"), false);
  });

  test("cache entries expire after the TTL and get re-probed", async () => {
    // Poison with an old timestamp claiming `node` is NOT installed.
    _poisonInstallCacheForTests("node", false, Date.now() - 10 * 60 * 1000); // 10 min ago
    const stale = await isCmdInstalled("node");
    assert.strictEqual(stale, true, "expired cache entry should re-probe and find node");
    // Fresh entries are honored.
    _poisonInstallCacheForTests("node", true, Date.now());
    const fresh = await isCmdInstalled("node");
    assert.strictEqual(fresh, true);
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

suite("frecencyScore", () => {
  const NOW = 1_700_000_000_000;
  const DAY = 86_400_000;

  test("zero count → score 0", () => {
    assert.strictEqual(frecencyScore(0, NOW, NOW), 0);
    assert.strictEqual(frecencyScore(0, 0, NOW), 0);
  });

  test("negative count → score 0", () => {
    assert.strictEqual(frecencyScore(-3, NOW, NOW), 0);
  });

  test("freshly launched: score == count", () => {
    // age = 0 → decay factor = 1.
    assert.strictEqual(frecencyScore(5, NOW, NOW), 5);
    assert.strictEqual(frecencyScore(42, NOW, NOW), 42);
  });

  test("older launches score lower than newer ones at equal count", () => {
    const fresh = frecencyScore(10, NOW - 1 * DAY, NOW);
    const stale = frecencyScore(10, NOW - 30 * DAY, NOW);
    assert.ok(fresh > stale, `fresh (${fresh}) should beat stale (${stale})`);
  });

  test("decay is roughly halved per 10-day half-life", () => {
    const now = frecencyScore(10, NOW - 10 * DAY, NOW);
    // 2^(-1) ≈ 0.5 → ~5.0, allow small float slack.
    assert.ok(Math.abs(now - 5) < 0.01, `expected ~5, got ${now}`);
  });

  test("higher count can overcome recency advantage", () => {
    // A 100-launch agent 30 days ago still beats a 1-launch agent from today.
    const heavyOld = frecencyScore(100, NOW - 30 * DAY, NOW);
    const lightNew = frecencyScore(1, NOW, NOW);
    assert.ok(heavyOld > lightNew, "frequent old should beat rare new");
  });
});

suite("sortByFrecency", () => {
  const NOW = 1_700_000_000_000;
  const DAY = 86_400_000;

  test("stable when all scores equal: preserves input order", () => {
    const items = ["a", "b", "c", "d"];
    const sorted = sortByFrecency(items, () => 0);
    assert.deepStrictEqual(sorted, ["a", "b", "c", "d"]);
  });

  test("higher scores sort first", () => {
    const items = [
      { name: "low", score: 1 },
      { name: "high", score: 100 },
      { name: "mid", score: 10 },
    ];
    const sorted = sortByFrecency(items, (x) => x.score).map((x) => x.name);
    assert.deepStrictEqual(sorted, ["high", "mid", "low"]);
  });

  test("ties keep original relative order (stability)", () => {
    const items = [
      { name: "first", score: 5 },
      { name: "second", score: 5 },
      { name: "third", score: 5 },
    ];
    const sorted = sortByFrecency(items, (x) => x.score).map((x) => x.name);
    assert.deepStrictEqual(sorted, ["first", "second", "third"]);
  });

  test("mixed zero and non-zero scores: zeros keep input order at the tail", () => {
    const items = [
      { name: "B", score: 0 },
      { name: "A", score: 3 },
      { name: "C", score: 0 },
      { name: "D", score: 0 },
    ];
    const sorted = sortByFrecency(items, (x) => x.score).map((x) => x.name);
    // A (score 3) first, then B/C/D in original order.
    assert.deepStrictEqual(sorted, ["A", "B", "C", "D"]);
  });

  test("simulated frecency sort matches expected decay behavior", () => {
    // Claude: launched 20×, last 1 day ago.
    // Codex: launched 5×, last 0 days ago.
    // Gemini: never launched (score 0).
    // Terminal: launched 1×, 20 days ago.
    const agents = [
      { name: "Terminal", c: 1, t: NOW - 20 * DAY },
      { name: "Claude", c: 20, t: NOW - 1 * DAY },
      { name: "Codex", c: 5, t: NOW },
      { name: "Gemini", c: 0, t: 0 },
    ];
    const sorted = sortByFrecency(agents, (a) => frecencyScore(a.c, a.t, NOW)).map((a) => a.name);
    // Claude's high count dominates despite Codex being fresher.
    assert.strictEqual(sorted[0], "Claude");
    assert.strictEqual(sorted[sorted.length - 1], "Gemini"); // never launched → last
  });
});

suite("launchText", () => {
  test("plain terminal → empty string", () => {
    assert.strictEqual(
      launchText({ cmd: "", launcher: "", isPlainTerminal: true }),
      ""
    );
  });

  test("plain cmd, no launcher → the cmd itself", () => {
    assert.strictEqual(
      launchText({ cmd: "claude", launcher: "", isPlainTerminal: false }),
      "claude"
    );
  });

  test("multi-word cmd is preserved verbatim", () => {
    assert.strictEqual(
      launchText({ cmd: "gh copilot", launcher: "", isPlainTerminal: false }),
      "gh copilot"
    );
  });

  test("launcher prefixes the cmd", () => {
    assert.strictEqual(
      launchText({ cmd: "crush", launcher: "uvx", isPlainTerminal: false }),
      "uvx crush"
    );
  });

  test("launcher with multi-word cmd composes correctly", () => {
    assert.strictEqual(
      launchText({ cmd: "aider --model gpt-4o", launcher: "uvx", isPlainTerminal: false }),
      "uvx aider --model gpt-4o"
    );
  });

  test("plain terminal ignores launcher", () => {
    assert.strictEqual(
      launchText({ cmd: "", launcher: "uvx", isPlainTerminal: true }),
      ""
    );
  });
});
