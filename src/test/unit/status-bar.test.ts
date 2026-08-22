/**
 * Status-bar rendering helpers. Unit tier — no VS Code host needed.
 */

import * as assert from "assert";

import {
  type SessionState,
  type LifecycleStatus,
  countByStatus,
  statusBarText,
  statusBarTooltip,
  STATUS_LABEL,
  STATUS_GLYPH,
} from "../../lifecycle";

function makeState(
  name: string,
  agentName: string,
  status: LifecycleStatus,
  changedAt = Date.now(),
  extra: Partial<Pick<SessionState, "cwd" | "launchedInFolder">> = {}
): SessionState {
  return { name, agentName, status, changedAt, ...extra };
}

/** Build a complete status-counts record (all keys, zero by default). */
function counts(
  overrides: Partial<Record<LifecycleStatus, number>> = {}
): Record<LifecycleStatus, number> {
  return {
    running: 0,
    finished: 0,
    waiting: 0,
    failed: 0,
    unknown: 0,
    ...overrides,
  };
}

suite("countByStatus", () => {
  test("empty → all zero", () => {
    const c = countByStatus([]);
    assert.strictEqual(c.running, 0);
    assert.strictEqual(c.finished, 0);
    assert.strictEqual(c.waiting, 0);
    assert.strictEqual(c.failed, 0);
    assert.strictEqual(c.unknown, 0);
  });

  test("mixed statuses tallied correctly", () => {
    const c = countByStatus([
      makeState("Claude", "Claude", "running"),
      makeState("Codex", "Codex", "running"),
      makeState("Aider", "Aider", "finished"),
      makeState("Gemini", "Gemini", "waiting"),
      makeState("Droid", "Droid", "failed"),
    ]);
    assert.strictEqual(c.running, 2);
    assert.strictEqual(c.finished, 1);
    assert.strictEqual(c.waiting, 1);
    assert.strictEqual(c.failed, 1);
    assert.strictEqual(c.unknown, 0);
  });

  test("counts unknown separately", () => {
    const c = countByStatus([
      makeState("Claude", "Claude", "unknown"),
      makeState("Codex", "Codex", "unknown"),
      makeState("Aider", "Aider", "running"),
    ]);
    assert.strictEqual(c.unknown, 2);
    assert.strictEqual(c.running, 1);
  });
});

suite("statusBarText", () => {
  test("all-zero → static default", () => {
    assert.strictEqual(
      statusBarText(counts()),
      "$(agent-quickpick) Agent"
    );
  });

  test("running only → count with ●", () => {
    assert.strictEqual(
      statusBarText(counts({ running: 2 })),
      "$(agent-quickpick) 2●"
    );
  });

  test("mixed → all non-zero groups", () => {
    assert.strictEqual(
      statusBarText(counts({ running: 1, finished: 1, waiting: 1, failed: 1 })),
      "$(agent-quickpick) 1● 1✓ 1⏸ 1✗"
    );
  });

  test("finished only → ✓", () => {
    assert.strictEqual(
      statusBarText(counts({ finished: 3 })),
      "$(agent-quickpick) 3✓"
    );
  });

  test("waiting only → ⏸", () => {
    assert.strictEqual(
      statusBarText(counts({ waiting: 1 })),
      "$(agent-quickpick) 1⏸"
    );
  });

  test("unknown only → ○ (reconnecting)", () => {
    assert.strictEqual(
      statusBarText(counts({ unknown: 2 })),
      "$(agent-quickpick) 2○"
    );
  });

  test("running + unknown are both shown, distinct glyphs", () => {
    assert.strictEqual(
      statusBarText(counts({ running: 1, unknown: 1 })),
      "$(agent-quickpick) 1● 1○"
    );
  });
});

suite("STATUS_LABEL", () => {
  test("maps each status to Herdr vocabulary", () => {
    assert.strictEqual(STATUS_LABEL.running, "working");
    assert.strictEqual(STATUS_LABEL.finished, "done");
    assert.strictEqual(STATUS_LABEL.waiting, "blocked");
    assert.strictEqual(STATUS_LABEL.failed, "failed");
    assert.strictEqual(STATUS_LABEL.unknown, "reconnecting");
  });
});

suite("STATUS_GLYPH", () => {
  test("maps each status to a distinct glyph", () => {
    assert.strictEqual(STATUS_GLYPH.running, "●");
    assert.strictEqual(STATUS_GLYPH.finished, "✓");
    assert.strictEqual(STATUS_GLYPH.waiting, "⏸");
    assert.strictEqual(STATUS_GLYPH.failed, "✗");
    assert.strictEqual(STATUS_GLYPH.unknown, "○");
  });

  test("glyphs are pairwise distinct", () => {
    const glyphs = Object.values(STATUS_GLYPH);
    assert.strictEqual(new Set(glyphs).size, glyphs.length);
  });
});

suite("statusBarTooltip", () => {
  test("empty → generic description", () => {
    assert.strictEqual(
      statusBarTooltip([]),
      "Agent Quickpick — running agents"
    );
  });

  test("lists sessions with status labels", () => {
    const tooltip = statusBarTooltip([
      makeState("Claude", "Claude", "running", 100),
      makeState("Codex (2)", "Codex", "finished", 200),
    ]);
    assert.ok(tooltip.includes("Claude"));
    assert.ok(tooltip.includes("working"));
    assert.ok(tooltip.includes("Codex (2)"));
    assert.ok(tooltip.includes("done"));
  });

  test("uses Herdr vocabulary for waiting → blocked", () => {
    const tooltip = statusBarTooltip([
      makeState("Gemini", "Gemini", "waiting", 100),
    ]);
    assert.ok(tooltip.includes("blocked"));
  });

  test("reason-aware label for a waiting session", () => {
    const tooltip = statusBarTooltip([
      { ...makeState("Claude", "Claude", "waiting", 100), waitingReason: "permission" },
    ]);
    assert.ok(tooltip.includes("wants a command approved"));
  });

  test("sorts by most-recently-changed first", () => {
    const tooltip = statusBarTooltip([
      makeState("Claude", "Claude", "running", 100),
      makeState("Codex", "Codex", "finished", 300),
      makeState("Gemini", "Gemini", "waiting", 200),
    ]);
    const codexIdx = tooltip.indexOf("Codex");
    const geminiIdx = tooltip.indexOf("Gemini");
    const claudeIdx = tooltip.indexOf("Claude");
    assert.ok(codexIdx < geminiIdx, "Codex (300) before Gemini (200)");
    assert.ok(geminiIdx < claudeIdx, "Gemini (200) before Claude (100)");
  });

  test("appends folder basename when cwd is set", () => {
    const tooltip = statusBarTooltip([
      makeState("Claude", "Claude", "running", 100, { cwd: "/Users/me/projects/my-app" }),
    ]);
    assert.ok(tooltip.includes("my-app"), "should append the folder basename");
  });

  test("appends folder basename when only launchedInFolder is set", () => {
    const tooltip = statusBarTooltip([
      makeState("Claude", "Claude", "running", 100, {
        launchedInFolder: "/home/parth/other-repo",
      }),
    ]);
    assert.ok(tooltip.includes("other-repo"), "should fall back to launch folder");
  });

  test("no suffix when neither cwd nor launchedInFolder is set", () => {
    const tooltip = statusBarTooltip([
      makeState("Claude", "Claude", "running", 100),
    ]);
    assert.ok(!tooltip.includes("·"), "should not append a folder suffix");
  });

  test("uses 'reconnecting' label for unknown status", () => {
    const tooltip = statusBarTooltip([
      makeState("Claude", "Claude", "unknown", 100),
    ]);
    assert.ok(tooltip.includes("reconnecting"));
  });
});
