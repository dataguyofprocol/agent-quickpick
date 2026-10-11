import * as assert from "assert";

import {
  BUILTIN_AGENTS,
  loadAgents,
  programStatusEnv,
} from "../../agents";

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
    for (const expected of ["Codex", "Copilot", "Aider", "Goose", "Crush", "Amp", "Qwen", "Plandex", "Grok", "Cody", "Kilo", "Qodo"]) {
      assert.ok(names.includes(expected), `${expected} should be a default`);
    }
  });

  test("retired agents are not defaults", () => {
    const agents = loadAgents(undefined);
    for (const retired of ["Gemini", "Antigravity"]) {
      assert.ok(
        !agents.some((a) => a.name === retired),
        `${retired} should not be a built-in agent any more`
      );
    }
    assert.ok(!agents.some((a) => a.cmd === "agy"), "the agy CLI is no longer a default");
  });

  test("every agent with detection support is a built-in (launch wiring depends on it)", () => {
    const names = new Set(loadAgents(undefined).map((a) => a.name.toLowerCase()));
    for (const expected of ["claude", "droid", "codex", "opencode", "pi"]) {
      assert.ok(names.has(expected), `${expected} must be a built-in agent`);
    }
  });

  test("pi and oh-my-pi are distinct built-ins, pi immediately before it", () => {
    const agents = loadAgents(undefined);
    const pi = agents.findIndex((a) => a.name === "pi");
    const omp = agents.findIndex((a) => a.name === "oh-my-pi");
    assert.ok(pi >= 0, "pi should be a default");
    assert.ok(omp >= 0, "oh-my-pi should be a default");
    assert.strictEqual(omp, pi + 1, "pi should sit directly before oh-my-pi");
    assert.strictEqual(agents[pi].cmd, "pi");
    assert.strictEqual(agents[omp].cmd, "omp");
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
    assert.strictEqual(agents.length, BUILTIN_AGENTS.length);
  });

  test("user override is case-insensitive by name", () => {
    const agents = loadAgents([{ name: "claude", cmd: "my-claude" }]);
    const claude = agents.find((a) => a.name === "claude");
    assert.ok(claude);
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
    assert.ok(!crush!.launcher, "Crush must not carry a launcher");
  });

  test("built-in names are unique", () => {
    const names = loadAgents(undefined).map((a) => a.name.toLowerCase());
    assert.strictEqual(new Set(names).size, names.length, "built-in names must be unique");
  });
});

suite("programStatusEnv", () => {
  test("pi gets its documented OSC 7501 opt-in", () => {
    assert.deepStrictEqual(programStatusEnv("pi", {}), { PI_PROGRAM_STATUS: "1" });
    assert.deepStrictEqual(programStatusEnv("Pi", {}), { PI_PROGRAM_STATUS: "1" });
    assert.deepStrictEqual(programStatusEnv(" pi ", {}), { PI_PROGRAM_STATUS: "1" });
  });

  test("an explicit user choice is never overridden", () => {
    assert.strictEqual(programStatusEnv("pi", { PI_PROGRAM_STATUS: "0" }), undefined);
    assert.strictEqual(programStatusEnv("pi", { PI_PROGRAM_STATUS: "1" }), undefined);
    assert.deepStrictEqual(
      programStatusEnv("pi", { PI_PROGRAM_STATUS: "  " }),
      { PI_PROGRAM_STATUS: "1" },
      "a blank value is not a choice"
    );
  });

  test("no other agent gets env injected", () => {
    for (const name of ["Claude", "Codex", "OpenCode", "Droid", "Amp", "Terminal", "pi2", "oh-my-pi"]) {
      assert.strictEqual(programStatusEnv(name, {}), undefined, name);
    }
  });
});
