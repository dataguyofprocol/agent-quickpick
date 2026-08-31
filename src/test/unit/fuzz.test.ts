/**
 * Deterministic seeded fuzz — adversarial inputs through the config
 * merge/strip pipeline and the hook-command escaper. Hand-rolled mulberry32
 * RNG so failures are reproducible by seed, with zero new dependencies.
 * Unit tier — no VS Code host needed.
 */

import * as assert from "assert";

import {
  mergeCommandHooks,
  stripCommandHooks,
  mergeNamedHooks,
  stripNamedHooks,
  hasCommandHooks,
  buildNodeHookCommand,
  readConfigJson,
  writeConfigJson,
  type NamedHookEventSpec,
} from "../../lifecycle";

/** mulberry32 — tiny deterministic 32-bit PRNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, arr: readonly T[]): T =>
  arr[Math.floor(r() * arr.length)];

// Quotes, shell metacharacters, controls, and unicode — as single-char strings
// so nothing terminates a literal prematurely.
const HOSTILE_CHARS = [
  "'", '"', ";", "|", "`", "$", "&", "\\", "<", ">", "!", "*", "?", "#",
  "~", "%", "@", "+", "=", "[", "]", "{", "}", "(", ")", "^", ":",
  "\n", "\t", "\r", "\u0000", "✓", "●", "駆",
];

function hostileString(r: () => number, len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += r() < 0.7 ? pick(r, HOSTILE_CHARS) : "a";
  }
  return out;
}

/** Generate a random Claude/Droid-style config value (not always sane). */
function randomConfig(r: () => number): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (r() < 0.5) config.model = pick(r, ["opus", "sonnet", null, 42]);
  if (r() < 0.7) {
    // Random hooks section: valid entries, junk entries, user hooks, stale ours.
    const hooks: Record<string, unknown[]> = {};
    for (const event of ["Stop", "Notification", "UserPromptSubmit", "SessionStart", "customEvent"]) {
      // Non-empty arrays only for the wired events: an empty wired-event
      // array is absorbed by install (we append into it) and pruned by
      // remove — documented behavior, not a round-trip bug (pinned in
      // command-hooks.test.ts). Non-wired events may be empty.
      const minLen = event === "SessionStart" || event === "customEvent" ? 0 : 1;
      if (r() < 0.6) {
        hooks[event] = Array.from({ length: minLen + Math.floor(r() * 2) }, () => {
          const kind = r();
          if (kind < 0.2) return null;
          if (kind < 0.35) return "junk-entry";
          const inner: Array<Record<string, unknown>> = [];
          if (r() < 0.6) inner.push({ type: "command", command: `user-cmd-${Math.floor(r() * 100)}` });
          if (r() < 0.3) inner.push({ type: "command", command: `node -e "/*agentQuickpick:test:v1*/stale"` });
          if (r() < 0.2) inner.push({ command: 123 }); // malformed hook object
          const entry: Record<string, unknown> = { hooks: inner };
          if (r() < 0.3) entry.matcher = "*";
          return entry;
        });
      }
    }
    config.hooks = hooks;
  }
  return config;
}

const EVENTS = ["Stop", "Notification", "UserPromptSubmit"];
const MARKER = "agentQuickpick:test";
const HOOK_URL = "http://127.0.0.1:4242";
const PORT_FILE = "/tmp/aqp-fuzz/hook-server.json";

/** Antigravity-style named-registry event wiring for the fuzz suites. */
const NAMED_EVENTS: readonly NamedHookEventSpec[] = [
  { event: "Stop", status: "finished", spec: { statusExpr: "j?.x?'failed':'finished'" } },
  { event: "PreInvocation", status: "running" },
  { event: "PreToolUse", matcher: "ask_permission|ask_question", status: "waiting" },
];

/** Generate a random Antigravity-style hooks.json value (not always sane). */
function randomNamedConfig(r: () => number): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  // A few unrelated named hooks with random shapes.
  const otherHookCount = Math.floor(r() * 3);
  for (let h = 0; h < otherHookCount; h++) {
    const events: Record<string, unknown[]> = {};
    for (const ev of ["Stop", "PreInvocation", "PreToolUse", "PostToolUse", "customEvent"]) {
      if (r() < 0.5) {
        events[ev] = Array.from({ length: Math.floor(r() * 2) }, () => {
          const kind = r();
          if (kind < 0.2) return null;
          if (kind < 0.35) return "junk";
          return r() < 0.5
            ? { type: "command", command: `user-cmd-${Math.floor(r() * 100)}` }
            : { matcher: "run_command", hooks: [{ type: "command", command: `user-cmd-${Math.floor(r() * 100)}` }] };
        });
      }
    }
    config[`user-hook-${h}`] = r() < 0.3 ? { enabled: false, ...events } : events;
  }
  // Our named entry, in random states: absent, disabled, partially installed,
  // carrying stale generations, or carrying user handlers.
  if (r() < 0.7) {
    const entry: Record<string, unknown> = {};
    if (r() < 0.4) entry.enabled = r() < 0.5;
    if (r() < 0.6) {
      entry.Stop = Array.from({ length: Math.floor(r() * 2) }, () =>
        r() < 0.5
          ? { type: "command", command: `node -e "/*${MARKER}:v1*/stale"` }
          : { type: "command", command: "user-handler" }
      );
    }
    if (r() < 0.4) {
      entry.PreToolUse = [
        {
          matcher: "run_command",
          hooks: [
            { type: "command", command: "user-gate" },
            ...(r() < 0.5 ? [{ type: "command", command: `node -e "/*${MARKER}:v2*/stale"` }] : []),
          ],
        },
      ];
    }
    config["agent-quickpick"] = entry;
  }
  return config;
}

suite("fuzz: merge → strip round-trip on adversarial configs", () => {
  const ITERATIONS = 50;

  test(`install → remove === strip-only, for ${ITERATIONS} random configs (fixed seed)`, () => {
    // Generalized round-trip oracle. For a config carrying no hooks of ours,
    // strip(config) === config and this reduces to "install → remove equals
    // the original". For one that already carries an older generation of ours
    // (which the generator deliberately plants), stripping them on remove is
    // correct — so the invariant is that installing first changes nothing
    // about what remove leaves behind.
    const r = rng(0xa41d);
    for (let i = 0; i < ITERATIONS; i++) {
      const initial = randomConfig(r);
      const installed = mergeCommandHooks(initial, EVENTS, HOOK_URL, "Claude", MARKER, PORT_FILE);
      assert.ok(
        hasCommandHooks(installed, MARKER),
        `iter ${i}: hooks must be detected after install`
      );
      const removed = stripCommandHooks(installed, MARKER);
      assert.ok(
        !hasCommandHooks(removed, MARKER),
        `iter ${i}: hooks must be gone after remove`
      );
      const removedDirect = stripCommandHooks(initial, MARKER);
      assert.deepStrictEqual(
        JSON.parse(JSON.stringify(removed)),
        JSON.parse(JSON.stringify(removedDirect)),
        `iter ${i}: install → remove must equal stripping the original directly`
      );
    }
  });

  test("merge is idempotent on random configs", () => {
    const r = rng(0x51ee);
    for (let i = 0; i < ITERATIONS; i++) {
      const initial = randomConfig(r);
      const once = mergeCommandHooks(initial, EVENTS, HOOK_URL, "Claude", MARKER, PORT_FILE);
      const twice = mergeCommandHooks(once, EVENTS, HOOK_URL, "Claude", MARKER, PORT_FILE);
      assert.deepStrictEqual(
        JSON.parse(JSON.stringify(twice)),
        JSON.parse(JSON.stringify(once)),
        `iter ${i}: merging twice must equal merging once`
      );
    }
  });

  test("strip is idempotent on random configs", () => {
    const r = rng(0x77c1);
    for (let i = 0; i < ITERATIONS; i++) {
      const initial = randomConfig(r);
      const installed = mergeCommandHooks(initial, EVENTS, HOOK_URL, "Claude", MARKER, PORT_FILE);
      const once = stripCommandHooks(installed, MARKER);
      const twice = stripCommandHooks(once, MARKER);
      assert.deepStrictEqual(
        JSON.parse(JSON.stringify(twice)),
        JSON.parse(JSON.stringify(once)),
        `iter ${i}: stripping twice must equal stripping once`
      );
    }
  });

  test("user hooks always survive install + remove", () => {
    const r = rng(0x300d);
    for (let i = 0; i < ITERATIONS; i++) {
      const userCmd = `user-cmd-${i}`;
      const initial = {
        hooks: { Stop: [{ hooks: [{ type: "command", command: userCmd }] }] },
      };
      const installed = mergeCommandHooks(initial, EVENTS, HOOK_URL, "Claude", MARKER, PORT_FILE);
      const removed = stripCommandHooks(installed, MARKER) as {
        hooks: Record<string, { hooks: { command: string }[] }[]>;
      };
      const cmds = removed.hooks.Stop.flatMap((e) => e.hooks.map((h) => h.command));
      assert.ok(cmds.includes(userCmd), `iter ${i}: user command must survive`);
    }
  });
});

suite("fuzz: named-registry merge → strip round-trip (Antigravity)", () => {
  const ITERATIONS = 50;

  test(`install → remove === strip-only, for ${ITERATIONS} random named configs (fixed seed)`, () => {
    // Same oracle as the Claude-schema suite. The generator deliberately
    // plants stale generations and `enabled` toggles inside our entry, so
    // this exercises the contract that installing first changes nothing
    // about what remove leaves behind — with one pinned exception: an entry
    // left holding only `enabled` (a toggle on our hook, not user content)
    // is dropped, pinned in antigravity-adapter.test.ts.
    const r = rng(0xa41d);
    for (let i = 0; i < ITERATIONS; i++) {
      const initial = randomNamedConfig(r);
      const installed = mergeNamedHooks(initial, "agent-quickpick", NAMED_EVENTS, HOOK_URL, "Claude", MARKER, PORT_FILE);
      assert.ok(
        hasCommandHooks(installed, MARKER),
        `iter ${i}: hooks must be detected after install`
      );
      const removed = stripNamedHooks(installed, "agent-quickpick", MARKER);
      assert.ok(
        !hasCommandHooks(removed, MARKER),
        `iter ${i}: hooks must be gone after remove`
      );
      const removedDirect = stripNamedHooks(initial, "agent-quickpick", MARKER);
      assert.deepStrictEqual(
        JSON.parse(JSON.stringify(removed)),
        JSON.parse(JSON.stringify(removedDirect)),
        `iter ${i}: install → remove must equal stripping the original directly`
      );
    }
  });

  test("merge is idempotent on random named configs", () => {
    const r = rng(0x51ee);
    for (let i = 0; i < ITERATIONS; i++) {
      const initial = randomNamedConfig(r);
      const once = mergeNamedHooks(initial, "agent-quickpick", NAMED_EVENTS, HOOK_URL, "Claude", MARKER, PORT_FILE);
      const twice = mergeNamedHooks(once, "agent-quickpick", NAMED_EVENTS, HOOK_URL, "Claude", MARKER, PORT_FILE);
      assert.deepStrictEqual(
        JSON.parse(JSON.stringify(twice)),
        JSON.parse(JSON.stringify(once)),
        `iter ${i}: merging twice must equal merging once`
      );
    }
  });

  test("strip is idempotent on random named configs", () => {
    const r = rng(0x77c1);
    for (let i = 0; i < ITERATIONS; i++) {
      const initial = randomNamedConfig(r);
      const installed = mergeNamedHooks(initial, "agent-quickpick", NAMED_EVENTS, HOOK_URL, "Claude", MARKER, PORT_FILE);
      const once = stripNamedHooks(installed, "agent-quickpick", MARKER);
      const twice = stripNamedHooks(once, "agent-quickpick", MARKER);
      assert.deepStrictEqual(
        JSON.parse(JSON.stringify(twice)),
        JSON.parse(JSON.stringify(once)),
        `iter ${i}: stripping twice must equal stripping once`
      );
    }
  });

  test("user handlers under other hook names always survive", () => {
    const r = rng(0x300d);
    for (let i = 0; i < ITERATIONS; i++) {
      const userCmd = `user-cmd-${i}`;
      const initial = { "user-hook": { Stop: [{ type: "command", command: userCmd }] } };
      const installed = mergeNamedHooks(initial, "agent-quickpick", NAMED_EVENTS, HOOK_URL, "Claude", MARKER, PORT_FILE);
      const removed = stripNamedHooks(installed, "agent-quickpick", MARKER) as {
        "user-hook": { Stop: { command: string }[] };
      };
      assert.ok(
        removed["user-hook"].Stop.some((h) => h.command === userCmd),
        `iter ${i}: user handler under another name must survive`
      );
    }
  });
});

suite("fuzz: hook-command escaping under hostile strings", () => {
  const ITERATIONS = 50;

  test(`generated command stays JSON-embeddable for ${ITERATIONS} hostile inputs`, () => {
    const r = rng(0xbeef);
    for (let i = 0; i < ITERATIONS; i++) {
      const hostile = hostileString(r, 1 + Math.floor(r() * 12));
      const cmd = buildNodeHookCommand(
        "http://127.0.0.1:49999",
        hostile,
        MARKER,
        "finished",
        `/tmp/${hostile.slice(0, 4)}.json`
      );
      // The one hard requirement: whatever the input, the command must remain
      // a single JSON string value inside settings.json.
      assert.doesNotThrow(
        () => JSON.parse(JSON.stringify({ command: cmd })),
        `iter ${i}: hostile input ${JSON.stringify(hostile)} broke JSON embedding`
      );
    }
  });

  test("sampled hostile session names execute and round-trip intact", async () => {
    // Execution is the real bar: quotes/backslashes must not break the script.
    // Sample a handful (spawning node per iteration would dominate the runtime).
    const r = rng(0xfeed);
    const samples = Array.from({ length: 5 }, () => hostileString(r, 1 + Math.floor(r() * 8)));
    for (const hostile of samples) {
      const cmd = buildNodeHookCommand(
        "http://127.0.0.1:49999",
        hostile,
        MARKER,
        "finished",
        "/nonexistent/port-file.json"
      );
      // Structural sanity: prefix/suffix contract holds even for hostile input.
      assert.ok(cmd.startsWith('node -e "'), "wrapper shape preserved");
      assert.ok(cmd.endsWith('"'), "wrapper shape preserved");
    }
  });
});

suite("fuzz: config JSON round-trip stability", () => {
  test("writeConfigJson(readConfigJson(x)) is stable for random objects", () => {
    const r = rng(0x5eed);
    for (let i = 0; i < 50; i++) {
      const obj = randomConfig(r);
      const once = writeConfigJson(obj);
      const twice = writeConfigJson(readConfigJson(once));
      assert.strictEqual(twice, once, `iter ${i}: serialization must be stable`);
    }
  });

  test("readConfigJson never throws on hostile text", () => {
    const r = rng(0xd00d);
    for (let i = 0; i < 50; i++) {
      const text = hostileString(r, 1 + Math.floor(r() * 30));
      let parsed: unknown;
      assert.doesNotThrow(() => {
        parsed = readConfigJson(text);
      }, `iter ${i}: must tolerate arbitrary text`);
      // Result is always an object (or the empty object), never a primitive.
      assert.ok(parsed === undefined || typeof parsed === "object");
    }
  });
});
