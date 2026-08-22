/**
 * The universal exit-status poller fallback — detects finished/failed for
 * agents whose hooks never fire. Uses fake terminals ({name, exitStatus}):
 * pollExitStatuses only touches those two fields of vscode.Terminal.
 * Unit tier — no VS Code host needed.
 */

import * as assert from "assert";
import type * as vscode from "vscode";

import { type SessionState, pollExitStatuses } from "../../lifecycle";

/** Structural fake of vscode.Terminal — only name + exitStatus are read. */
function terminal(name: string, exitCode?: number): vscode.Terminal {
  return {
    name,
    ...(exitCode !== undefined ? { exitStatus: { code: exitCode } } : {}),
  } as vscode.Terminal;
}

function session(name: string, status: SessionState["status"]): SessionState {
  return { name, agentName: name, status, changedAt: 0 };
}

const AGENTS = new Set(["claude", "codex", "oh-my-pi", "opencode"]);

suite("pollExitStatuses", () => {
  test("empty terminals → empty map", () => {
    const result = pollExitStatuses([], new Map(), AGENTS);
    assert.strictEqual(result.size, 0);
  });

  test("agent terminal exited 0 → finished with exitCode", () => {
    const result = pollExitStatuses([terminal("Claude", 0)], new Map(), AGENTS);
    assert.deepStrictEqual(result.get("Claude"), { status: "finished", exitCode: 0 });
  });

  test("agent terminal exited non-zero → failed with exitCode", () => {
    const result = pollExitStatuses([terminal("Claude", 130)], new Map(), AGENTS);
    assert.deepStrictEqual(result.get("Claude"), { status: "failed", exitCode: 130 });
  });

  test("numbered sessions match their agent (counter stripped)", () => {
    const result = pollExitStatuses([terminal("Claude (2)", 0)], new Map(), AGENTS);
    assert.ok(result.has("Claude (2)"), "keyed by the full tab name");
  });

  test("agent match is case-insensitive", () => {
    const result = pollExitStatuses([terminal("CLAUDE", 0)], new Map(), AGENTS);
    assert.ok(result.has("CLAUDE"));
  });

  test("non-agent terminals are ignored", () => {
    const result = pollExitStatuses(
      [terminal("zsh", 0), terminal("node", 1), terminal("PowerShell", 0)],
      new Map(),
      AGENTS
    );
    assert.strictEqual(result.size, 0);
  });

  test("still-running terminals (no exitStatus) are not reported", () => {
    const result = pollExitStatuses([terminal("Claude"), terminal("Codex")], new Map(), AGENTS);
    assert.strictEqual(result.size, 0);
  });

  test("exitStatus with undefined code is treated as still running", () => {
    const t = { name: "Claude", exitStatus: { code: undefined } } as vscode.Terminal;
    const result = pollExitStatuses([t], new Map(), AGENTS);
    assert.strictEqual(result.size, 0);
  });

  test("sessions already finished or failed are skipped (no re-report)", () => {
    const sessions = new Map<string, SessionState>([
      ["Claude", session("Claude", "finished")],
      ["Codex", session("Codex", "failed")],
      ["OpenCode", session("OpenCode", "running")],
    ]);
    const result = pollExitStatuses(
      [terminal("Claude", 0), terminal("Codex", 1), terminal("OpenCode", 0)],
      sessions,
      AGENTS
    );
    assert.strictEqual(result.size, 1);
    assert.ok(result.has("OpenCode"), "only the non-final session is re-reported");
  });

  test("unknown (re-adopted) sessions ARE polled — their real state is discovered", () => {
    const sessions = new Map<string, SessionState>([
      ["Claude", session("Claude", "unknown")],
    ]);
    const result = pollExitStatuses([terminal("Claude", 0)], sessions, AGENTS);
    assert.deepStrictEqual(result.get("Claude"), { status: "finished", exitCode: 0 });
  });

  test("waiting sessions are polled too (a crashed agent must not stay 'blocked')", () => {
    const sessions = new Map<string, SessionState>([
      ["Claude", session("Claude", "waiting")],
    ]);
    const result = pollExitStatuses([terminal("Claude", 1)], sessions, AGENTS);
    assert.deepStrictEqual(result.get("Claude"), { status: "failed", exitCode: 1 });
  });

  test("agent names come from the live config — custom user agents are polled", () => {
    const custom = new Set(["claude", "my-agent"]);
    const result = pollExitStatuses([terminal("my-agent", 0)], new Map(), custom);
    assert.ok(result.has("my-agent"));
  });
});
