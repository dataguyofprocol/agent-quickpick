/**
 * The session state machine: source precedence, the fallback ladder, record
 * lifetime, and notification policy. Driven entirely with synthetic output and
 * a fake clock, which is the point of keeping it free of `vscode`.
 * Unit tier — no VS Code host needed.
 */

import * as assert from "assert";

import {
  ACTIVITY_MS,
  BLOCKED_QUIET_MS,
  SessionTracker,
  STARTUP_GRACE_MS,
} from "../../session-tracker";

const ST = "\u001b\\";
const BEL = "\u0007";
const osc = (body: string) => `\u001b]7501;${body}${ST}`;
const title = (value: string) => `\u001b]2;${value}${BEL}`;
const b64 = (text: string) => Buffer.from(text).toString("base64");

const T0 = 1_700_000_000_000;
/** Past the startup grace, so heuristics are live. */
const LIVE = T0 + STARTUP_GRACE_MS + 1_000;
const SPINNER = title("⠹ claude");

const PERMISSION_PROMPT = [
  "Bash command",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. No",
  "esc to cancel",
].join("\n");

function makeTracker(agent = "Claude"): SessionTracker {
  const tracker = new SessionTracker();
  tracker.track(agent, agent, undefined, T0);
  return tracker;
}

suite("SessionTracker: protocol precedence", () => {
  test("a new session is unknown until there is evidence", () => {
    assert.strictEqual(makeTracker().get("Claude")?.status, "unknown");
  });

  test("an OSC 7501 report wins over everything else", () => {
    const tracker = makeTracker();
    tracker.output("Claude", `${SPINNER}esc to interrupt`, LIVE);
    assert.strictEqual(tracker.get("Claude")?.status, "working", "heuristic working first");

    const transitions = tracker.output(
      "Claude",
      osc("state=blocked:kind=permission"),
      LIVE + 200
    );
    assert.strictEqual(transitions[0].status, "blocked");
    assert.strictEqual(transitions[0].source, "osc");
    assert.strictEqual(transitions[0].reason, "permission");
    assert.strictEqual(transitions[0].notify, true);
  });

  test("a later heuristic cannot override a protocol report", () => {
    const tracker = makeTracker();
    tracker.output("Claude", osc("state=idle"), LIVE);
    tracker.output("Claude", `${SPINNER}esc to interrupt`, LIVE + 200);
    assert.strictEqual(tracker.get("Claude")?.status, "idle");
  });

  test("protocol metadata is replaced, not merged, per report", () => {
    const tracker = makeTracker();
    tracker.output(
      "Claude",
      osc(`state=working:progress=40:msg=${b64("Refactoring")}:title=${b64("Task")}`),
      LIVE
    );
    let state = tracker.get("Claude");
    assert.strictEqual(state?.progress, 40);
    assert.strictEqual(state?.message, "Refactoring");
    assert.strictEqual(state?.title, "Task");

    tracker.output("Claude", osc("state=working"), LIVE + 200);
    state = tracker.get("Claude");
    assert.strictEqual(state?.progress, undefined, "a missing key is absent afterwards");
    assert.strictEqual(state?.message, undefined);
    assert.strictEqual(state?.title, undefined);
  });

  test("a query never changes state", () => {
    const tracker = makeTracker();
    // Inside the startup grace, so the only thing that *could* move state is a
    // protocol report — and a query is not one.
    assert.deepStrictEqual(tracker.output("Claude", `\u001b]7501;?${ST}`, T0 + 100), []);
    assert.strictEqual(tracker.get("Claude")?.status, "unknown");
    assert.strictEqual(tracker.get("Claude")?.source, "none");
  });
});

suite("SessionTracker: fallback ladder", () => {
  test("nothing is claimed during the startup grace", () => {
    const tracker = makeTracker();
    tracker.output("Claude", `${SPINNER}esc to interrupt`, T0 + 100);
    assert.strictEqual(tracker.get("Claude")?.status, "unknown");
  });

  test("output means working, and quiet decays to idle", () => {
    const tracker = makeTracker();
    const transitions = tracker.output("Claude", "building\n", LIVE);
    assert.strictEqual(transitions[0].status, "working");
    assert.strictEqual(transitions[0].source, "heuristic");
    assert.strictEqual(transitions[0].notify, false, "working never alerts");

    const decayed = tracker.tick(LIVE + ACTIVITY_MS + 1);
    assert.strictEqual(decayed[0].status, "idle");
  });

  test("a text-derived blocked claim waits for a quiet beat", () => {
    const tracker = makeTracker();
    tracker.output("Claude", "starting\n", LIVE);
    // The prompt arrives in the same chunk that is still being written: it must
    // not be believed yet, so the session stays on plain activity.
    tracker.output("Claude", PERMISSION_PROMPT, LIVE + 200);
    assert.strictEqual(tracker.get("Claude")?.status, "working");
    assert.strictEqual(tracker.get("Claude")?.source, "heuristic");
    assert.strictEqual(tracker.get("Claude")?.blockedKind, undefined);
    const settled = tracker.tick(LIVE + 200 + BLOCKED_QUIET_MS + 1);
    assert.strictEqual(settled[0].status, "blocked");
    assert.strictEqual(settled[0].reason, "permission");
    assert.strictEqual(settled[0].notify, true, "a blocker rule may alert");
  });

  test("an agent with no manifest still settles to idle rather than sticking", () => {
    const tracker = makeTracker("My Agent");
    tracker.output("My Agent", "work\n", LIVE);
    assert.strictEqual(tracker.get("My Agent")?.status, "working");
    assert.strictEqual(tracker.tick(LIVE + ACTIVITY_MS + 1)[0].status, "idle");
  });

  test("heuristics can be switched off for protocol-only users", () => {
    const tracker = makeTracker();
    tracker.setFallbackEnabled(false);
    assert.deepStrictEqual(tracker.output("Claude", `${SPINNER}esc to interrupt`, LIVE), []);
    assert.strictEqual(tracker.get("Claude")?.status, "unknown");
    // The protocol still works.
    tracker.output("Claude", osc("state=working"), LIVE + 1_000);
    assert.strictEqual(tracker.get("Claude")?.status, "working");
  });

  test("the rule table is not re-run for every repaint of a spinner", () => {
    const tracker = makeTracker();
    tracker.output("Claude", "one\n", LIVE);
    assert.deepStrictEqual(tracker.output("Claude", "glitch\n", LIVE + 10), []);
    // A protocol report bypasses the throttle.
    assert.strictEqual(tracker.output("Claude", osc("state=idle"), LIVE + 20)[0].status, "idle");
  });
});

suite("SessionTracker: process lifetime", () => {
  test("exit 0 mid-task is done and alerts; non-zero is error and alerts", () => {
    const clean = makeTracker();
    clean.output("Claude", osc("state=working"), LIVE);
    const done = clean.execEnd("Claude", 0, LIVE + 500);
    assert.strictEqual(done[0].status, "done");
    assert.strictEqual(done[0].source, "exit");
    assert.strictEqual(done[0].notify, true);
    assert.strictEqual(clean.get("Claude")?.exitCode, 0);

    const crashed = makeTracker();
    const error = crashed.execEnd("Claude", 1, LIVE);
    assert.strictEqual(error[0].status, "error");
    assert.strictEqual(error[0].exitCode, 1);
    assert.strictEqual(error[0].notify, true);
  });

  test("quitting an agent at rest records done without an alert", () => {
    // The user typed /q or /exit: they are looking at it. Each case: the state
    // the session was in when the clean exit arrived.
    const atRest: [string, (t: SessionTracker) => void][] = [
      ["never reported", () => {}],
      ["protocol idle (fresh, or after an interrupt)", (t) => t.output("Claude", osc("state=idle"), LIVE)],
      ["activity-only working (the quit's own redraw)", (t) => t.output("Claude", "bye\n", LIVE)],
    ];
    for (const [label, setup] of atRest) {
      const tracker = makeTracker();
      setup(tracker);
      const transitions = tracker.execEnd("Claude", 0, LIVE + 400);
      assert.strictEqual(tracker.get("Claude")?.status, "done", label);
      assert.ok(transitions.every((t) => !t.notify), `${label}: no alert`);
    }
  });

  test("a clean exit while blocked on a visible prompt still alerts", () => {
    const tracker = makeTracker();
    tracker.output("Claude", osc("state=blocked:kind=permission"), LIVE);
    assert.strictEqual(tracker.execEnd("Claude", 0, LIVE + 5_000)[0].notify, true);
  });

  test("a crash is reported even when the agent last said it was working", () => {
    // Regression: an OSC report used to latch the session, so the exit code was
    // ignored and a crashed session stayed "working" forever.
    const tracker = makeTracker();
    tracker.output("Claude", osc("state=working"), LIVE);
    const transitions = tracker.execEnd("Claude", 130, LIVE + 500);
    assert.strictEqual(transitions[0].status, "error");
  });

  test("a shell activation command's exit inside the grace is not the agent's", () => {
    const tracker = new SessionTracker();
    tracker.track("Claude", "Claude", undefined, T0);
    // The activation script the shell runs on a fresh terminal.
    tracker.execStart("Claude", T0 + 20);
    assert.deepStrictEqual(tracker.execEnd("Claude", 0, T0 + 60), []);
    assert.strictEqual(tracker.get("Claude")?.status, "unknown");

    // The agent itself, started later, is reported normally.
    tracker.execStart("Claude", T0 + 1_000);
    assert.strictEqual(tracker.execEnd("Claude", 0, T0 + 30_000)[0].status, "done");
  });

  test("an agent that fails immediately is still reported once past the grace", () => {
    const tracker = new SessionTracker();
    tracker.track("Claude", "Claude", undefined, T0);
    tracker.execStart("Claude", T0 + 10);
    assert.strictEqual(
      tracker.execEnd("Claude", 127, T0 + STARTUP_GRACE_MS + 10)[0].status,
      "error"
    );
  });

  test("a protocol done survives a clean exit but not a crash", () => {
    const clean = makeTracker();
    clean.output("Claude", osc(`state=done:msg=${b64("Upgraded 12 packages")}`), LIVE);
    assert.deepStrictEqual(clean.execEnd("Claude", 0, LIVE + 500), []);
    assert.strictEqual(clean.get("Claude")?.status, "done");
    assert.strictEqual(clean.get("Claude")?.message, "Upgraded 12 packages");

    const crashed = makeTracker();
    crashed.output("Claude", osc("state=done"), LIVE);
    assert.strictEqual(crashed.execEnd("Claude", 1, LIVE + 500)[0].status, "error");
  });

  test("a finished session cannot be dragged back to working by stale text", () => {
    const tracker = makeTracker();
    tracker.output("Claude", "work\n", LIVE);
    tracker.execEnd("Claude", 0, LIVE + 500);
    tracker.output("Claude", `${SPINNER}esc to interrupt`, LIVE + 1_000);
    tracker.tick(LIVE + 5_000);
    assert.strictEqual(tracker.get("Claude")?.status, "done");
  });

  test("a new command drops transient state but keeps a done record", () => {
    const transient = makeTracker();
    transient.output("Claude", osc("state=working"), LIVE);
    assert.strictEqual(transient.execStart("Claude", LIVE + 2_000)[0].status, "unknown");
    // And the stale record does not come back on the next chunk.
    transient.output("Claude", "new command\n", LIVE + 2_100);
    assert.notStrictEqual(transient.get("Claude")?.status, "working");

    const finished = makeTracker();
    finished.output("Claude", osc("state=done"), LIVE);
    assert.deepStrictEqual(finished.execStart("Claude", LIVE + 2_000), []);
    assert.strictEqual(finished.get("Claude")?.status, "done");
  });
});

suite("SessionTracker: notification policy", () => {
  test("only a blocker rule, the protocol, or an exit may alert", () => {
    const heuristic = makeTracker();
    assert.strictEqual(heuristic.output("Claude", `${SPINNER}working`, LIVE)[0].notify, false);

    const protocol = makeTracker();
    assert.strictEqual(
      protocol.output("Claude", osc("state=working"), LIVE)[0].notify,
      false,
      "working does not alert even from the protocol"
    );

    const blocked = makeTracker();
    assert.strictEqual(
      blocked.output("Claude", osc("state=blocked:kind=question"), LIVE)[0].notify,
      true
    );
  });

  test("alerts are rate-limited per session", () => {
    const tracker = makeTracker();
    assert.strictEqual(
      tracker.output("Claude", osc("state=blocked:kind=permission"), LIVE)[0].notify,
      true
    );
    assert.strictEqual(
      tracker.execEnd("Claude", 1, LIVE + 500)[0].notify,
      false,
      "a second alert inside the window is suppressed"
    );
    // Status still moves even when the alert is suppressed.
    assert.strictEqual(tracker.get("Claude")?.status, "error");
  });
});

suite("SessionTracker: session bookkeeping", () => {
  test("rename aliases a new display name onto the same session", () => {
    const tracker = makeTracker();
    assert.strictEqual(tracker.rename("Claude", "My Claude", "Claude"), true);
    assert.strictEqual(tracker.resolve("My Claude"), "Claude");
    assert.strictEqual(tracker.get("My Claude")?.agentName, "Claude");
    assert.strictEqual(tracker.rename("My Claude", "My Claude", "Claude"), false);
    // Renaming back to the creation name drops the alias.
    assert.strictEqual(tracker.rename("My Claude", "Claude", "Claude"), true);
    assert.deepStrictEqual(tracker.keys(), ["Claude"]);
  });

  test("output addressed by display name reaches the session", () => {
    const tracker = makeTracker();
    tracker.rename("Claude", "My Claude", "Claude");
    tracker.output("My Claude", osc("state=blocked"), LIVE);
    assert.strictEqual(tracker.get("Claude")?.status, "blocked");
  });

  test("cwd is recorded and forget removes the session and its alias", () => {
    const tracker = makeTracker();
    assert.strictEqual(tracker.setCwd("Claude", "/repo/a"), true);
    assert.strictEqual(tracker.setCwd("Claude", "/repo/a"), false, "no-op for an unchanged cwd");
    assert.strictEqual(tracker.get("Claude")?.cwd, "/repo/a");

    tracker.rename("Claude", "My Claude", "Claude");
    assert.strictEqual(tracker.forget("My Claude"), true);
    assert.strictEqual(tracker.get("Claude"), undefined);
    assert.strictEqual(tracker.resolve("My Claude"), "My Claude");
  });

  test("seed adopts surviving terminals and aliases renamed tabs", () => {
    const tracker = new SessionTracker();
    assert.strictEqual(
      tracker.seed(
        [
          { key: "Claude", name: "Claude", agentName: "Claude" },
          { key: "Codex", name: "My Codex", agentName: "Codex" },
        ],
        T0
      ),
      true
    );
    assert.strictEqual(tracker.get("Claude")?.status, "unknown");
    assert.strictEqual(tracker.resolve("My Codex"), "Codex");
    assert.strictEqual(tracker.get("My Codex")?.agentName, "Codex");
    // Idempotent.
    assert.strictEqual(
      tracker.seed(
        [
          { key: "Claude", name: "Claude", agentName: "Claude" },
          { key: "Codex", name: "My Codex", agentName: "Codex" },
        ],
        T0 + 1
      ),
      false
    );
  });
});
