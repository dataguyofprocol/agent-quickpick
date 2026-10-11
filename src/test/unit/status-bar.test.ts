/**
 * Status-bar rendering helpers. Unit tier — no VS Code host needed.
 */

import * as assert from "assert";

import {
  type LifecycleStatus,
  countByStatus,
  statusBarText,
  statusBarTooltip,
  STATUS_LABEL,
  STATUS_GLYPH,
} from "../../lifecycle";
import { makeState } from "./helpers";

/** Build a complete status-counts record (all keys, zero by default). */
function counts(
  overrides: Partial<Record<LifecycleStatus, number>> = {}
): Record<LifecycleStatus, number> {
  return {
    idle: 0,
    working: 0,
    done: 0,
    blocked: 0,
    error: 0,
    unknown: 0,
    ...overrides,
  };
}

suite("countByStatus", () => {
  test("empty → all zero", () => {
    const c = countByStatus([]);
    assert.strictEqual(c.working, 0);
    assert.strictEqual(c.done, 0);
    assert.strictEqual(c.blocked, 0);
    assert.strictEqual(c.error, 0);
    assert.strictEqual(c.unknown, 0);
  });

  test("mixed statuses tallied correctly", () => {
    const c = countByStatus([
      makeState("Claude", "Claude", "working"),
      makeState("Codex", "Codex", "working"),
      makeState("Aider", "Aider", "done"),
      makeState("Gemini", "Gemini", "blocked"),
      makeState("Droid", "Droid", "error"),
    ]);
    assert.strictEqual(c.working, 2);
    assert.strictEqual(c.done, 1);
    assert.strictEqual(c.blocked, 1);
    assert.strictEqual(c.error, 1);
    assert.strictEqual(c.unknown, 0);
  });

  test("counts unknown separately", () => {
    const c = countByStatus([
      makeState("Claude", "Claude", "unknown"),
      makeState("Codex", "Codex", "unknown"),
      makeState("Aider", "Aider", "working"),
    ]);
    assert.strictEqual(c.unknown, 2);
    assert.strictEqual(c.working, 1);
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
      statusBarText(counts({ working: 2 })),
      "$(agent-quickpick) 2●"
    );
  });

  test("mixed → all non-zero groups", () => {
    assert.strictEqual(
      statusBarText(counts({ working: 1, done: 1, blocked: 1, error: 1 })),
      "$(agent-quickpick) 1⏸ 1✗ 1✓ 1●"
    );
  });

  test("finished only → ✓", () => {
    assert.strictEqual(
      statusBarText(counts({ done: 3 })),
      "$(agent-quickpick) 3✓"
    );
  });

  test("waiting only → ⏸", () => {
    assert.strictEqual(
      statusBarText(counts({ blocked: 1 })),
      "$(agent-quickpick) 1⏸"
    );
  });

  test("unknown only → ○ (reconnecting)", () => {
    assert.strictEqual(
      statusBarText(counts({ unknown: 2 })),
      "$(agent-quickpick) 2?"
    );
  });

  test("running + unknown are both shown, distinct glyphs", () => {
    assert.strictEqual(
      statusBarText(counts({ working: 1, unknown: 1 })),
      "$(agent-quickpick) 1● 1?"
    );
  });
});

suite("STATUS_LABEL", () => {
  test("maps each status to Herdr vocabulary", () => {
    assert.strictEqual(STATUS_LABEL.working, "working");
    assert.strictEqual(STATUS_LABEL.done, "done");
    assert.strictEqual(STATUS_LABEL.blocked, "blocked");
    assert.strictEqual(STATUS_LABEL.error, "error");
    assert.strictEqual(STATUS_LABEL.unknown, "unknown");
  });
});

suite("STATUS_GLYPH", () => {
  test("maps each status to a distinct glyph", () => {
    assert.strictEqual(STATUS_GLYPH.working, "●");
    assert.strictEqual(STATUS_GLYPH.done, "✓");
    assert.strictEqual(STATUS_GLYPH.blocked, "⏸");
    assert.strictEqual(STATUS_GLYPH.error, "✗");
    assert.strictEqual(STATUS_GLYPH.unknown, "?");
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
      makeState("Claude", "Claude", "working", 100),
      makeState("Codex (2)", "Codex", "done", 200),
    ]);
    assert.ok(tooltip.includes("Claude"));
    assert.ok(tooltip.includes("working"));
    assert.ok(tooltip.includes("Codex (2)"));
    assert.ok(tooltip.includes("done"));
  });

  test("uses Herdr vocabulary for waiting → blocked", () => {
    const tooltip = statusBarTooltip([
      makeState("Gemini", "Gemini", "blocked", 100),
    ]);
    assert.ok(tooltip.includes("blocked"));
  });

  test("reason-aware label for a waiting session", () => {
    const tooltip = statusBarTooltip([
      { ...makeState("Claude", "Claude", "blocked", 100), blockedKind: "permission" },
    ]);
    assert.ok(tooltip.includes("blocked · permission"));
  });

  test("sorts by most-recently-changed first", () => {
    const tooltip = statusBarTooltip([
      makeState("Claude", "Claude", "working", 100),
      makeState("Codex", "Codex", "done", 300),
      makeState("Gemini", "Gemini", "blocked", 200),
    ]);
    const codexIdx = tooltip.indexOf("Codex");
    const geminiIdx = tooltip.indexOf("Gemini");
    const claudeIdx = tooltip.indexOf("Claude");
    assert.ok(codexIdx < geminiIdx, "Codex (300) before Gemini (200)");
    assert.ok(geminiIdx < claudeIdx, "Gemini (200) before Claude (100)");
  });

  test("appends folder basename when cwd is set", () => {
    const tooltip = statusBarTooltip([
      makeState("Claude", "Claude", "working", 100, { cwd: "/Users/me/projects/my-app" }),
    ]);
    assert.ok(tooltip.includes("my-app"), "should append the folder basename");
  });

  test("appends folder basename when only launchedInFolder is set", () => {
    const tooltip = statusBarTooltip([
      makeState("Claude", "Claude", "working", 100, {
        launchedInFolder: "/home/parth/other-repo",
      }),
    ]);
    assert.ok(tooltip.includes("other-repo"), "should fall back to launch folder");
  });

  test("no suffix when neither cwd nor launchedInFolder is set", () => {
    const tooltip = statusBarTooltip([
      makeState("Claude", "Claude", "working", 100),
    ]);
    assert.ok(!tooltip.includes("·"), "should not append a folder suffix");
  });

  test("uses 'reconnecting' label for unknown status", () => {
    const tooltip = statusBarTooltip([
      makeState("Claude", "Claude", "unknown", 100),
    ]);
    assert.ok(tooltip.includes("unknown"));
  });
});
