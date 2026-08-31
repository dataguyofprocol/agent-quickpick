/**
 * Agent registry merging (loadAgents) + built-in defaults.
 * Unit tier — imports from ../../agents, no VS Code host needed.
 */

import * as assert from "assert";

import { BUILTIN_AGENTS, loadAgents } from "../../agents";

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
    for (const expected of ["Codex", "Antigravity", "Copilot", "Aider", "Goose", "Crush", "Amp", "Qwen", "Plandex", "Grok", "Cody", "Kilo", "Qodo"]) {
      assert.ok(names.includes(expected), `${expected} should be a default`);
    }
  });

  test("Gemini is NOT a default (replaced by Antigravity when Gemini CLI sunset)", () => {
    const agents = loadAgents(undefined);
    assert.ok(!agents.some((a) => a.name === "Gemini"), "Gemini should not be a built-in");
    assert.ok(agents.some((a) => a.cmd === "agy"), "Antigravity (agy) should be a built-in");
  });

  test("every lifecycle-aware agent is a built-in (launch wiring depends on it)", () => {
    // getAdapter/LIFECYCLE_ADAPTERS names must exist in the defaults, else
    // launching that agent from the picker would skip hook env injection.
    const names = new Set(loadAgents(undefined).map((a) => a.name.toLowerCase()));
    for (const expected of ["claude", "droid", "codex", "antigravity", "opencode"]) {
      assert.ok(names.has(expected), `${expected} must be a built-in agent`);
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

  test("user-added entries are marked userDefined; built-ins are not", () => {
    const agents = loadAgents([{ name: "Claude Proxy", cmd: "claude-proxy" }]);
    const proxy = agents.find((a) => a.name === "Claude Proxy");
    assert.ok(proxy, "user entry should be present");
    assert.strictEqual(proxy!.userDefined, true);
    const claude = agents.find((a) => a.name === "Claude");
    assert.ok(claude, "built-in Claude should be present");
    assert.notStrictEqual(claude!.userDefined, true);
  });

  test("overriding a built-in by name marks it userDefined (always shown)", () => {
    const agents = loadAgents([{ name: "Claude", cmd: "claude-glm" }]);
    const claude = agents.find((a) => a.name.toLowerCase() === "claude");
    assert.ok(claude);
    assert.strictEqual(claude!.userDefined, true);
  });

  test("built-in Crush is a plain binary with no launcher", () => {
    const agents = loadAgents(undefined);
    const crush = agents.find((a) => a.name === "Crush");
    assert.ok(crush, "Crush should be a built-in");
    assert.strictEqual(crush!.cmd, "crush");
    // Crush is a Go binary distributed via brew/npm/go/apt — not a uvx/PyPI
    // package. Detection must probe `crush` itself, not a launcher.
    assert.ok(!crush!.launcher, "Crush must not carry a launcher");
  });

  test("built-in names are unique", () => {
    const names = loadAgents(undefined).map((a) => a.name.toLowerCase());
    assert.strictEqual(new Set(names).size, names.length, "built-in names must be unique");
  });
});
