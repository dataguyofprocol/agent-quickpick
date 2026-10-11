/**
 * Deterministic seeded fuzz — adversarial inputs through the legacy-hook strip
 * pipeline and the config JSON round-trip. Hand-rolled mulberry32 RNG so
 * failures are reproducible by seed, with zero new dependencies.
 * Unit tier — no VS Code host needed.
 */

import * as assert from "assert";

import {
  stripCommandHooks,
  stripNamedHooks,
  hasCommandHooks,
  readConfigJson,
  writeConfigJson,
} from "../../legacy-hooks";

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

const MARKER = "agentQuickpick:test";
const HOOK_NAME = "agent-quickpick";

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

suite("fuzz: legacy strip is marker-scoped and idempotent", () => {
  const ITERATIONS = 50;

  test(`strip(strip(x)) === strip(x) for ${ITERATIONS} random configs (fixed seed)`, () => {
    const r = rng(0x1234);
    for (let i = 0; i < ITERATIONS; i++) {
      const config = randomConfig(r);
      const once = stripCommandHooks(config, MARKER);
      const twice = stripCommandHooks(once, MARKER);
      assert.deepStrictEqual(twice, once, `iter ${i}: strip must be idempotent`);
    }
  });

  test("strip removes every one of our hooks, and leaves the rest alone", () => {
    const r = rng(0x5678);
    for (let i = 0; i < ITERATIONS; i++) {
      const config = randomConfig(r);
      const hadOurs = hasCommandHooks(config, MARKER);
      const stripped = stripCommandHooks(config, MARKER);
      assert.strictEqual(hasCommandHooks(stripped, MARKER), false, `iter ${i}: ours must be gone`);
      // A config that never carried one of ours must come back byte-identical:
      // this is the promise that a user's own hooks are never touched.
      if (!hadOurs) {
        assert.deepStrictEqual(stripped, config, `iter ${i}: must be untouched when ours are absent`);
      }
    }
  });

  test("user hooks always survive a strip", () => {
    const r = rng(0x2468);
    for (let i = 0; i < ITERATIONS; i++) {
      const config = randomConfig(r) as {
        hooks?: Record<string, Array<{ hooks?: Array<Record<string, unknown>> }>>;
      };
      const stripped = stripCommandHooks(config, MARKER) as {
        hooks?: Record<string, Array<{ hooks?: Array<Record<string, unknown>> }>>;
      };
      for (const event of Object.keys(config.hooks ?? {})) {
        const users = (config.hooks?.[event] ?? []).flatMap((entry) =>
          (entry?.hooks ?? []).filter(
            (h) => typeof h.command === "string" && !h.command.includes(MARKER)
          )
        );
        for (const user of users) {
          const kept = (stripped.hooks?.[event] ?? []).flatMap(
            (entry) => entry?.hooks ?? []
          );
          assert.ok(
            kept.some((h) => h.command === user.command),
            `iter ${i}: user hook "${user.command}" must survive`
          );
        }
      }
    }
  });

  test("named-registry strip is idempotent and never eats other named hooks", () => {
    const r = rng(0x9abc);
    for (let i = 0; i < ITERATIONS; i++) {
      const config = randomNamedConfig(r);
      const once = stripNamedHooks(config, HOOK_NAME, MARKER);
      const twice = stripNamedHooks(once, HOOK_NAME, MARKER);
      assert.deepStrictEqual(twice, once, `iter ${i}: strip must be idempotent`);
      assert.strictEqual(hasCommandHooks(once, MARKER), false, `iter ${i}: ours must be gone`);
      // Other named entries are never touched.
      for (const key of Object.keys(config)) {
        if (key === HOOK_NAME) continue;
        assert.deepStrictEqual(
          (once as Record<string, unknown>)[key],
          (config as Record<string, unknown>)[key],
          `iter ${i}: "${key}" must survive untouched`
        );
      }
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
