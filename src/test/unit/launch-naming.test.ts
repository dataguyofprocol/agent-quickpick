/**
 * Launch text/delay and terminal naming/session-matching helpers.
 * Unit tier — imports from ../../agents, no VS Code host needed.
 */

import * as assert from "assert";

import {
  launchText,
  launchDelay,
  uniqueTerminalName,
  baseTerminalName,
  isSessionTerminal,
  matchSessionTerminals,
} from "../../agents";

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
      launchText({ cmd: "aider", launcher: "uvx", isPlainTerminal: false }),
      "uvx aider"
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

suite("launchDelay", () => {
  test("agent terminal with positive delay → that value", () => {
    assert.strictEqual(launchDelay(false, 300), 300);
  });

  test("agent terminal with 0 → 0", () => {
    assert.strictEqual(launchDelay(false, 0), 0);
  });

  test("agent terminal with negative → 0 (clamped)", () => {
    assert.strictEqual(launchDelay(false, -50), 0);
  });

  test("plain terminal → 0 regardless of configured delay", () => {
    assert.strictEqual(launchDelay(true, 300), 0);
    assert.strictEqual(launchDelay(true, 0), 0);
    assert.strictEqual(launchDelay(true, 1000), 0);
  });
});

suite("uniqueTerminalName", () => {
  test("no collision → bare base name", () => {
    assert.strictEqual(uniqueTerminalName("Claude", []), "Claude");
    assert.strictEqual(uniqueTerminalName("Claude", ["Codex", "Aider"]), "Claude");
  });

  test("base taken → (2)", () => {
    assert.strictEqual(uniqueTerminalName("Claude", ["Claude"]), "Claude (2)");
  });

  test("base + (2) taken → (3)", () => {
    assert.strictEqual(
      uniqueTerminalName("Claude", ["Claude", "Claude (2)"]),
      "Claude (3)"
    );
  });

  test("reclaims bare name when it's free again", () => {
    // "Claude" closed, only "Claude (2)" remains → next reuses bare "Claude".
    assert.strictEqual(uniqueTerminalName("Claude", ["Claude (2)"]), "Claude");
  });

  test("reclaims lowest free numbered slot", () => {
    // "Claude" and "Claude (3)" open, "(2)" was closed → fills the (2) gap.
    assert.strictEqual(
      uniqueTerminalName("Claude", ["Claude", "Claude (3)"]),
      "Claude (2)"
    );
  });

  test("distinct base names don't interfere", () => {
    assert.strictEqual(
      uniqueTerminalName("Codex", ["Claude", "Claude (2)"]),
      "Codex"
    );
  });

  test("accepts a Set as the existing-names iterable", () => {
    assert.strictEqual(
      uniqueTerminalName("Claude", new Set(["Claude"])),
      "Claude (2)"
    );
  });
});

suite("baseTerminalName", () => {
  test("strips a trailing counter", () => {
    assert.strictEqual(baseTerminalName("Claude (2)"), "Claude");
    assert.strictEqual(baseTerminalName("Claude (13)"), "Claude");
  });

  test("leaves un-numbered names unchanged", () => {
    assert.strictEqual(baseTerminalName("Claude"), "Claude");
    assert.strictEqual(baseTerminalName("oh-my-pi"), "oh-my-pi");
  });

  test("only strips a counter at the very end", () => {
    assert.strictEqual(baseTerminalName("Claude (2) foo"), "Claude (2) foo");
  });

  test("does not strip parenthetical non-numbers", () => {
    assert.strictEqual(baseTerminalName("Claude (dev)"), "Claude (dev)");
  });
});

suite("isSessionTerminal", () => {
  const names = new Set(["claude", "codex", "oh-my-pi"]);

  test("matches a bare agent name (case-insensitive)", () => {
    assert.strictEqual(isSessionTerminal("Claude", names), true);
    assert.strictEqual(isSessionTerminal("CODEX", names), true);
  });

  test("matches a numbered session back to its agent", () => {
    assert.strictEqual(isSessionTerminal("Claude (2)", names), true);
    assert.strictEqual(isSessionTerminal("oh-my-pi (5)", names), true);
  });

  test("rejects unrelated terminal names", () => {
    assert.strictEqual(isSessionTerminal("zsh", names), false);
    assert.strictEqual(isSessionTerminal("node", names), false);
  });
});

// ---------------------------------------------------------------------------
// matchSessionTerminals — re-adopts agent terminals into the sessions Map
// after a window reload (Fix 1: reload-proof notifications).
// ---------------------------------------------------------------------------

suite("matchSessionTerminals (reload re-adoption)", () => {
  const names = new Set(["claude", "codex", "oh-my-pi"]);

  test("returns name + base-agentName pairs for matched terminals", () => {
    const matched = matchSessionTerminals(["Claude", "Codex (2)", "zsh"], names);
    assert.deepStrictEqual(matched, [
      { name: "Claude", agentName: "Claude" },
      { name: "Codex (2)", agentName: "Codex" },
    ]);
  });

  test("strips the (N) counter into the base agent name", () => {
    const matched = matchSessionTerminals(["oh-my-pi (5)"], names);
    assert.deepStrictEqual(matched, [{ name: "oh-my-pi (5)", agentName: "oh-my-pi" }]);
  });

  test("is case-insensitive on the agent match", () => {
    const matched = matchSessionTerminals(["CLAUDE", "codex"], names);
    assert.deepStrictEqual(matched, [
      { name: "CLAUDE", agentName: "CLAUDE" },
      { name: "codex", agentName: "codex" },
    ]);
  });

  test("skips non-agent terminals", () => {
    const matched = matchSessionTerminals(["zsh", "node", "PowerShell"], names);
    assert.deepStrictEqual(matched, []);
  });

  test("empty input → empty result", () => {
    assert.deepStrictEqual(matchSessionTerminals([], names), []);
  });
});
