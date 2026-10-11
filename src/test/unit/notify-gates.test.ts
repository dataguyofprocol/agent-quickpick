/**
 * Notification gating logic — which statuses are announced, and how the three
 * channels (toast / OS notification / sound) are independently gated.
 * Unit tier — no VS Code host needed.
 */

import * as assert from "assert";

import {
  type LifecycleStatus,
  shouldNotify,
  shouldSystemNotify,
  shouldPlaySound,
  isAnnouncedStatus,
  notificationMessage,
  classifyWaitingMessage,
  waitingHeadline,
  waitingLabel,
} from "../../lifecycle";

const ANNOUNCED: LifecycleStatus[] = ["done", "blocked", "error"];
const SILENT: LifecycleStatus[] = ["working", "unknown"];

suite("shouldNotify", () => {
  test("fires on finished when active + setting on", () => {
    assert.ok(shouldNotify("done", false, true));
  });

  test("fires on waiting", () => {
    assert.ok(shouldNotify("blocked", false, true));
  });

  test("suppressed when terminal is active/focused", () => {
    assert.ok(!shouldNotify("done", true, true));
    assert.ok(!shouldNotify("blocked", true, true));
  });

  test("suppressed when setting is off", () => {
    assert.ok(!shouldNotify("done", false, false));
    assert.ok(!shouldNotify("blocked", false, false));
  });

  test("never fires on running", () => {
    assert.ok(!shouldNotify("working", false, true));
  });

  test("never fires on unknown (no confident state to announce)", () => {
    assert.ok(!shouldNotify("unknown", false, true));
    assert.ok(!shouldNotify("unknown", true, true));
    assert.ok(!shouldNotify("unknown", false, false));
  });

  test("fires on failed (crashes must be visible)", () => {
    assert.ok(shouldNotify("error", false, true));
  });

  test("failed suppressed when terminal is active/focused", () => {
    assert.ok(!shouldNotify("error", true, true));
  });

  test("failed suppressed when setting is off", () => {
    assert.ok(!shouldNotify("error", false, false));
  });
});

suite("shouldSystemNotify", () => {
  test("whenUnfocused: fires only while the window is unfocused", () => {
    for (const s of ANNOUNCED) {
      assert.ok(shouldSystemNotify("whenUnfocused", s, false, true), `${s} unfocused`);
      assert.ok(!shouldSystemNotify("whenUnfocused", s, true, true), `${s} focused`);
    }
  });

  test("always: fires regardless of focus", () => {
    for (const s of ANNOUNCED) {
      assert.ok(shouldSystemNotify("always", s, true, true));
      assert.ok(shouldSystemNotify("always", s, false, true));
    }
  });

  test("off: never fires", () => {
    for (const s of ANNOUNCED) {
      assert.ok(!shouldSystemNotify("off", s, false, true));
      assert.ok(!shouldSystemNotify("off", s, true, true));
    }
  });

  test("lifecycleNotifications off is a master switch", () => {
    for (const s of ANNOUNCED) {
      assert.ok(!shouldSystemNotify("always", s, false, false));
      assert.ok(!shouldSystemNotify("whenUnfocused", s, false, false));
    }
  });

  test("never fires for running/unknown", () => {
    for (const s of SILENT) {
      assert.ok(!shouldSystemNotify("always", s, false, true), s);
    }
  });

  test("ignores terminal focus by design — unfocused window still notifies", () => {
    // Regression guard: shouldNotify() suppresses on active terminal; the OS
    // path must NOT inherit that, or a backgrounded window goes silent.
    assert.ok(!shouldNotify("done", true, true));
    assert.ok(shouldSystemNotify("whenUnfocused", "done", false, true));
  });
});

suite("shouldPlaySound", () => {
  test("fires for every announced status", () => {
    for (const s of ANNOUNCED) {
      assert.ok(shouldPlaySound(true, s, true), s);
    }
  });

  test("silent for running/unknown", () => {
    for (const s of SILENT) {
      assert.ok(!shouldPlaySound(true, s, true), s);
    }
  });

  test("respects its own setting and the master switch", () => {
    assert.ok(!shouldPlaySound(false, "done", true));
    assert.ok(!shouldPlaySound(true, "done", false));
  });

  test("independent of where the notification renders", () => {
    // No focus/terminal params at all — the cue is the same wherever the
    // notification lands (in-editor toast or OS notification).
    assert.strictEqual(shouldPlaySound.length, 3);
  });
});

suite("isAnnouncedStatus", () => {
  test("finished/waiting/failed only", () => {
    for (const s of ANNOUNCED) assert.ok(isAnnouncedStatus(s), s);
    for (const s of SILENT) assert.ok(!isAnnouncedStatus(s), s);
  });
});

suite("notificationMessage", () => {
  test("finished → glyph + agent + repo + Show action", () => {
    const msg = notificationMessage("Claude", "done", "my-app");
    assert.ok(msg);
    assert.strictEqual(msg!.text, "✓ Claude done · my-app");
    assert.strictEqual(msg!.action, "Show");
  });

  test("waiting → glyph + agent + repo + Show action", () => {
    const msg = notificationMessage("OpenCode", "blocked", "my-app");
    assert.ok(msg);
    assert.strictEqual(msg!.text, "⏸ OpenCode is blocked · my-app");
    assert.strictEqual(msg!.action, "Show");
  });

  test("omits the repo suffix when repo is absent/empty", () => {
    assert.strictEqual(notificationMessage("Claude", "done")!.text, "✓ Claude done");
    assert.strictEqual(notificationMessage("Claude", "done", "")!.text, "✓ Claude done");
    assert.strictEqual(notificationMessage("Claude", "done", "  ")!.text, "✓ Claude done");
  });

  test("running → null", () => {
    assert.strictEqual(notificationMessage("Claude", "working"), null);
  });

  test("unknown → null", () => {
    assert.strictEqual(notificationMessage("Claude", "unknown"), null);
  });

  test("failed → glyph + crashed + Show action", () => {
    const msg = notificationMessage("Claude", "error", "my-app");
    assert.ok(msg);
    assert.strictEqual(msg!.text, "✗ Claude error · my-app");
    assert.strictEqual(msg!.action, "Show");
  });

  test("failed includes exit code when provided", () => {
    const msg = notificationMessage("Claude", "error", "my-app", 130);
    assert.ok(msg);
    assert.strictEqual(msg!.text, "✗ Claude error · my-app · exit 130");
  });

  test("failed omits repo suffix when repo absent, still shows exit code", () => {
    const msg = notificationMessage("Claude", "error", undefined, 1);
    assert.ok(msg);
    assert.strictEqual(msg!.text, "✗ Claude error · exit 1");
  });

  test("failed without exit code or repo", () => {
    const msg = notificationMessage("Claude", "error");
    assert.ok(msg);
    assert.strictEqual(msg!.text, "✗ Claude error");
  });
});

suite("waiting reasons — classifier (Claude message text)", () => {
  test("permission mention → permission", () => {
    assert.strictEqual(
      classifyWaitingMessage("Claude needs your permission to use Bash"),
      "permission"
    );
  });

  test("case-insensitive permission match", () => {
    assert.strictEqual(
      classifyWaitingMessage("CLAUDE NEEDS YOUR PERMISSION TO USE WebFetch"),
      "permission"
    );
  });

  test("waiting-for-input message → no reason (generic wait)", () => {
    assert.strictEqual(classifyWaitingMessage("Claude is waiting for your input"), undefined);
  });

  test("empty / non-string / missing message → no reason", () => {
    assert.strictEqual(classifyWaitingMessage(""), undefined);
    assert.strictEqual(classifyWaitingMessage(undefined), undefined);
    assert.strictEqual(classifyWaitingMessage(42), undefined);
    assert.strictEqual(classifyWaitingMessage(null), undefined);
  });
});

suite("waiting reasons — copy", () => {
  test("toast headline per reason", () => {
    assert.strictEqual(
      waitingHeadline("Claude", "permission"),
      "Claude is blocked on permission"
    );
    assert.strictEqual(
      waitingHeadline("OpenCode", "question"),
      "OpenCode is blocked on a question"
    );
    assert.strictEqual(waitingHeadline("Droid"), "Droid is blocked");
  });

  test("compact picker/tooltip label per reason", () => {
    assert.strictEqual(waitingLabel("permission"), "blocked · permission");
    assert.strictEqual(waitingLabel("question"), "blocked · question");
    assert.strictEqual(waitingLabel(undefined), "blocked");
  });

  test("notificationMessage threads the reason into the waiting toast", () => {
    const msg = notificationMessage("Claude", "blocked", "my-app", undefined, "permission");
    assert.ok(msg);
    assert.strictEqual(msg!.text, "⏸ Claude is blocked on permission · my-app");
  });

  test("notificationMessage waiting without a reason keeps the generic copy", () => {
    const msg = notificationMessage("Droid", "blocked", "my-app");
    assert.ok(msg);
    assert.strictEqual(msg!.text, "⏸ Droid is blocked · my-app");
  });

  test("reason is ignored for non-waiting statuses", () => {
    const msg = notificationMessage("Claude", "done", "my-app", undefined, "permission");
    assert.ok(msg);
    assert.strictEqual(msg!.text, "✓ Claude done · my-app");
  });
});
