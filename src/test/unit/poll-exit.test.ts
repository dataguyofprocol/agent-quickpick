import * as assert from "assert";
import type * as vscode from "vscode";

import { pollExitStatuses } from "../../lifecycle";

function terminal(name: string, exitCode?: number): vscode.Terminal {
  return {
    name,
    ...(exitCode !== undefined ? { exitStatus: { code: exitCode } } : {}),
  } as vscode.Terminal;
}

function renamedTerminal(
  currentName: string,
  creationName: string,
  exitCode?: number
): vscode.Terminal {
  return {
    name: currentName,
    creationOptions: { name: creationName },
    ...(exitCode !== undefined ? { exitStatus: { code: exitCode } } : {}),
  } as vscode.Terminal;
}

const AGENTS = new Set(["claude", "codex", "oh-my-pi", "opencode"]);

suite("pollExitStatuses", () => {
  test("empty terminals → empty map", () => {
    assert.strictEqual(pollExitStatuses([], AGENTS).size, 0);
  });

  test("agent terminal exited 0 → done with exitCode", () => {
    const result = pollExitStatuses([terminal("Claude", 0)], AGENTS);
    assert.deepStrictEqual(result.get("Claude"), { status: "done", exitCode: 0 });
  });

  test("agent terminal exited non-zero → error with exitCode", () => {
    const result = pollExitStatuses([terminal("Claude", 130)], AGENTS);
    assert.deepStrictEqual(result.get("Claude"), { status: "error", exitCode: 130 });
  });

  test("numbered sessions match their agent (counter stripped)", () => {
    const result = pollExitStatuses([terminal("Claude (2)", 0)], AGENTS);
    assert.ok(result.has("Claude (2)"), "keyed by the full tab name");
  });

  test("agent match is case-insensitive", () => {
    assert.ok(pollExitStatuses([terminal("CLAUDE", 0)], AGENTS).has("CLAUDE"));
  });

  test("renamed tab still matches its original creation name", () => {
    const result = pollExitStatuses([renamedTerminal("My Claude", "Claude", 0)], AGENTS);
    assert.deepStrictEqual(result.get("My Claude"), { status: "done", exitCode: 0 });
  });

  test("non-agent terminals are ignored", () => {
    const result = pollExitStatuses(
      [terminal("zsh", 0), terminal("node", 1), terminal("PowerShell", 0)],
      AGENTS
    );
    assert.strictEqual(result.size, 0);
  });

  test("still-running terminals (no exitStatus) are not reported", () => {
    const result = pollExitStatuses([terminal("Claude"), terminal("Codex")], AGENTS);
    assert.strictEqual(result.size, 0);
  });

  test("exitStatus with undefined code is treated as still running", () => {
    const t = { name: "Claude", exitStatus: { code: undefined } } as vscode.Terminal;
    assert.strictEqual(pollExitStatuses([t], AGENTS).size, 0);
  });

  test("agent names come from the live config — custom user agents are polled", () => {
    const custom = new Set(["claude", "my-agent"]);
    assert.ok(pollExitStatuses([terminal("my-agent", 0)], custom).has("my-agent"));
  });
});
