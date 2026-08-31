/**
 * Named-registry (Antigravity `hooks.json`) adapter guarantees: install ⇄
 * remove symmetry, idempotency, `enabled:false` preservation, stale-generation
 * replacement, and per-event staleness detection. Mirrors the guarantees
 * command-hooks.test.ts pins for the Claude schema.
 * Unit tier — no VS Code host needed.
 */

import * as assert from "assert";

import {
  HOOK_SCHEMA_VERSION,
  type CommandHookAdapter,
} from "../../lifecycle";
import { ANTIGRAVITY_ADAPTER } from "../../lifecycle-adapters";

const HOOK_URL = "http://127.0.0.1:99999";
const SESSION = "Antigravity";
const PORT_FILE_PATH = "/home/user/.config/agent-quickpick/hook-server.json";
const MARKER = "agentQuickpick:antigravity";
const HOOK_NAME = "agent-quickpick";

/** Our entry inside a parsed hooks.json. */
function ourEntry(config: unknown): Record<string, unknown> {
  const entry = (config as Record<string, unknown>)[HOOK_NAME];
  assert.ok(entry && typeof entry === "object", "our named entry should exist");
  return entry as Record<string, unknown>;
}

function eventCommands(entry: Record<string, unknown>, event: string): string[] {
  const arr = entry[event] as unknown[];
  assert.ok(Array.isArray(arr), `${event} should be an array`);
  return arr.flatMap((item) => {
    const rec = item as Record<string, unknown>;
    if (typeof rec.command === "string") return [rec.command];
    if (Array.isArray(rec.hooks)) {
      return (rec.hooks as { command?: string }[]).map((h) => h.command ?? "");
    }
    return [];
  });
}

function assertInstallRemoveSymmetry(initial: unknown, label: string): void {
  const adapter: CommandHookAdapter = ANTIGRAVITY_ADAPTER;
  const installed = adapter.mergeHooks(initial, HOOK_URL, SESSION, PORT_FILE_PATH);
  assert.ok(
    adapter.hasOurHooks(installed),
    `${label}: hooks should be present after install`
  );
  const removed = adapter.stripHooks(installed);
  assert.ok(
    !adapter.hasOurHooks(removed),
    `${label}: hooks should be absent after remove`
  );
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(removed)),
    JSON.parse(JSON.stringify(initial)),
    `${label}: install → remove should equal original`
  );
}

suite("antigravity adapter symmetry", () => {
  const adapter = ANTIGRAVITY_ADAPTER;

  test("install → remove on empty config", () => {
    assertInstallRemoveSymmetry({}, "empty");
  });

  test("install → remove leaves other named hooks untouched", () => {
    const config = {
      "my-linter-hook": {
        PostToolUse: [
          { matcher: "run_command", hooks: [{ type: "command", command: "./scripts/lint.sh", timeout: 10 }] },
        ],
      },
      "reminder": {
        PreInvocation: [{ type: "command", command: "./scripts/reminder.sh" }],
      },
    };
    assertInstallRemoveSymmetry(config, "other-named-hooks");
  });

  test("install → remove preserves user handlers inside our entry", () => {
    const config = {
      [HOOK_NAME]: {
        PreInvocation: [{ type: "command", command: "user-handler" }],
      },
    };
    assertInstallRemoveSymmetry(config, "user-handlers-in-our-entry");
  });

  test("install → remove preserves a user matcher entry sharing our PreToolUse", () => {
    const config = {
      [HOOK_NAME]: {
        PreToolUse: [
          { matcher: "run_command", hooks: [{ type: "command", command: "user-gate" }] },
        ],
      },
    };
    assertInstallRemoveSymmetry(config, "shared-pretooluse");
  });

  test("an entry holding only `enabled` is dropped on remove (pinned contract)", () => {
    // `enabled` is a toggle on OUR hook (agy's /hooks disable), not user
    // content — after removing our hooks, an empty shell entry is litter.
    // Same "absent == empty" posture the Claude schema pins for wired events.
    const installed = adapter.mergeHooks({}, HOOK_URL, SESSION, PORT_FILE_PATH);
    const withEnabled = {
      ...(installed as Record<string, unknown>),
      [HOOK_NAME]: { ...(ourEntry(installed)), enabled: false },
    };
    const removed = adapter.stripHooks(withEnabled);
    assert.ok(!((removed as Record<string, unknown>)[HOOK_NAME]), "shell entry should be dropped");
  });

  test("install is idempotent (merge twice === merge once)", () => {
    const once = adapter.mergeHooks({}, HOOK_URL, SESSION, PORT_FILE_PATH);
    const twice = adapter.mergeHooks(once, HOOK_URL, SESSION, PORT_FILE_PATH);
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(twice)),
      JSON.parse(JSON.stringify(once))
    );
  });

  test("remove is idempotent (strip twice === strip once)", () => {
    const installed = adapter.mergeHooks({}, HOOK_URL, SESSION, PORT_FILE_PATH);
    const once = adapter.stripHooks(installed);
    const twice = adapter.stripHooks(once);
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(twice)),
      JSON.parse(JSON.stringify(once))
    );
  });

  test("remove on a config without our hooks is a no-op", () => {
    const config = { "other-hook": { Stop: [{ type: "command", command: "x" }] } };
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(adapter.stripHooks(config))),
      config
    );
  });
});

suite("antigravity merge shape", () => {
  const adapter = ANTIGRAVITY_ADAPTER;

  test("wires Stop + PreInvocation + PreToolUse under our hook name", () => {
    const merged = adapter.mergeHooks({}, HOOK_URL, SESSION, PORT_FILE_PATH) as Record<string, unknown>;
    assert.ok(HOOK_NAME in merged, "our named entry should exist");
    const entry = ourEntry(merged);
    assert.ok(Array.isArray(entry.Stop), "Stop should be wired");
    assert.ok(Array.isArray(entry.PreInvocation), "PreInvocation should be wired");
    assert.ok(Array.isArray(entry.PreToolUse), "PreToolUse should be wired");
  });

  test("Stop uses the flat handler shape (no matcher wrapper)", () => {
    const entry = ourEntry(adapter.mergeHooks({}, HOOK_URL, SESSION, PORT_FILE_PATH));
    const stop = entry.Stop as { type?: string; command?: string; matcher?: unknown }[];
    assert.ok(stop.length > 0);
    for (const handler of stop) {
      assert.strictEqual(handler.type, "command");
      assert.ok(typeof handler.command === "string" && handler.command.length > 0);
      assert.ok(!("matcher" in handler), "lifecycle events take flat handlers, not matcher entries");
    }
  });

  test("PreToolUse uses a matcher entry scoped to permission/question asks", () => {
    const entry = ourEntry(adapter.mergeHooks({}, HOOK_URL, SESSION, PORT_FILE_PATH));
    const preToolUse = entry.PreToolUse as { matcher?: string; hooks?: { command: string }[] }[];
    const ours = preToolUse.find((e) => e.hooks?.some((h) => h.command.includes(MARKER)));
    assert.ok(ours, "our matcher entry should exist");
    assert.strictEqual(
      ours.matcher,
      "ask_permission|ask_question",
      "matcher should scope to permission/question tools"
    );
  });

  test("Stop command derives status from the payload (error / not-idle / finished)", () => {
    const entry = ourEntry(adapter.mergeHooks({}, HOOK_URL, SESSION, PORT_FILE_PATH));
    const [cmd] = eventCommands(entry, "Stop");
    assert.ok(cmd.includes("terminationReason==='error'"), "error → failed");
    assert.ok(cmd.includes("fullyIdle===false"), "not idle → running");
    assert.ok(cmd.includes("'finished'"), "otherwise finished");
  });

  test("commands read the cwd from workspacePaths (camelCase payload)", () => {
    const entry = ourEntry(adapter.mergeHooks({}, HOOK_URL, SESSION, PORT_FILE_PATH));
    for (const event of ["Stop", "PreInvocation", "PreToolUse"]) {
      const cmds = eventCommands(entry, event);
      assert.ok(
        cmds.some((c) => c.includes("workspacePaths")),
        `${event} command should read workspacePaths`
      );
    }
  });

  test("PreToolUse command derives the waiting reason from the tool name", () => {
    const entry = ourEntry(adapter.mergeHooks({}, HOOK_URL, SESSION, PORT_FILE_PATH));
    const [cmd] = eventCommands(entry, "PreToolUse");
    assert.ok(cmd.includes("ask_permission") && cmd.includes("'permission'"), "permission ask");
    assert.ok(cmd.includes("ask_question") && cmd.includes("'question'"), "question ask");
  });

  test("merge preserves a user's enabled:false toggle", () => {
    const config = { [HOOK_NAME]: { enabled: false } };
    const merged = adapter.mergeHooks(config, HOOK_URL, SESSION, PORT_FILE_PATH);
    assert.strictEqual(ourEntry(merged).enabled, false, "toggle must survive an upgrade merge");
  });
});

suite("antigravity staleness + upgrades", () => {
  const adapter = ANTIGRAVITY_ADAPTER;

  test("hasCurrentHooks true after a fresh install", () => {
    const merged = adapter.mergeHooks({}, HOOK_URL, SESSION, PORT_FILE_PATH);
    assert.ok(adapter.hasCurrentHooks(merged));
    assert.ok(adapter.hasOurHooks(merged));
  });

  test("hasCurrentHooks false for a stale (older-schema) install", () => {
    const stale = {
      [HOOK_NAME]: {
        Stop: [{ type: "command", command: `node -e "/*${MARKER}:v1*/old"` }],
      },
    };
    assert.ok(adapter.hasOurHooks(stale), "marker-only check still sees it as ours");
    assert.ok(!adapter.hasCurrentHooks(stale), "version check should flag it as stale");
  });

  test("hasCurrentHooks ignores enabled:false (a disabled current hook isn't stale)", () => {
    const merged = adapter.mergeHooks({}, HOOK_URL, SESSION, PORT_FILE_PATH);
    const disabled = {
      ...(merged as Record<string, unknown>),
      [HOOK_NAME]: { ...ourEntry(merged), enabled: false },
    };
    assert.ok(adapter.hasCurrentHooks(disabled));
  });

  test("hasCurrentHooks false when only some wired events are present", () => {
    const merged = adapter.mergeHooks({}, HOOK_URL, SESSION, PORT_FILE_PATH);
    const partial = { ...(merged as Record<string, unknown>) };
    const entry = { ...ourEntry(partial) };
    delete entry.PreInvocation; // interrupted write / hand-deleted event
    partial[HOOK_NAME] = entry;
    assert.ok(!adapter.hasCurrentHooks(partial), "partial install must read stale");
  });

  test("re-merge replaces a stale generation instead of appending beside it", () => {
    const stale = {
      [HOOK_NAME]: {
        Stop: [
          { type: "command", command: `node -e "/*${MARKER}:v1*/old"` },
          { type: "command", command: "user-handler" },
        ],
      },
      "user-hook": { Stop: [{ type: "command", command: "untouched" }] },
    };
    const merged = adapter.mergeHooks(stale, HOOK_URL, SESSION, PORT_FILE_PATH);
    const entry = ourEntry(merged);
    const stopHandlers = entry.Stop as { command?: string }[];
    const cmds = stopHandlers.map((h) => h.command ?? "");
    assert.ok(cmds.includes("user-handler"), "user handler untouched");
    assert.strictEqual(
      cmds.filter((c) => c.includes(MARKER)).length,
      1,
      "exactly one generation of our hook"
    );
    assert.ok(!cmds.some((c) => c.includes(`${MARKER}:v1`)), "stale command dropped");
    assert.ok(
      cmds.some((c) => c.includes(`${MARKER}:v${HOOK_SCHEMA_VERSION}`)),
      "current command present"
    );
    // Other named hooks untouched.
    const other = (merged as Record<string, unknown>)["user-hook"] as { Stop: { command: string }[] };
    assert.strictEqual(other.Stop[0].command, "untouched");
  });

  test("re-merge fills a missing event without duplicating present ones", () => {
    const merged = adapter.mergeHooks({}, HOOK_URL, SESSION, PORT_FILE_PATH);
    const partial = { ...(merged as Record<string, unknown>) };
    const entry = { ...ourEntry(partial) };
    delete entry.PreInvocation;
    partial[HOOK_NAME] = entry;
    const healed = adapter.mergeHooks(partial, HOOK_URL, SESSION, PORT_FILE_PATH);
    const healedEntry = ourEntry(healed);
    assert.ok(adapter.hasCurrentHooks(healed));
    const preInvocation = healedEntry.PreInvocation as unknown[];
    assert.strictEqual(preInvocation.length, 1, "must not duplicate");
    const stop = healedEntry.Stop as unknown[];
    assert.strictEqual(stop.length, 1, "must not duplicate");
  });

  test("a stale matcher entry of ours is replaced, a user matcher entry survives", () => {
    const stale = {
      [HOOK_NAME]: {
        PreToolUse: [
          { matcher: "ask_permission|ask_question", hooks: [{ type: "command", command: `node -e "/*${MARKER}:v1*/old"` }] },
          { matcher: "run_command", hooks: [{ type: "command", command: "user-gate" }] },
        ],
      },
    };
    const merged = adapter.mergeHooks(stale, HOOK_URL, SESSION, PORT_FILE_PATH);
    const entry = ourEntry(merged);
    const preToolUse = entry.PreToolUse as { matcher?: string; hooks: { command: string }[] }[];
    assert.strictEqual(preToolUse.length, 2, "one user entry + one current ours");
    const userEntry = preToolUse.find((e) => e.matcher === "run_command");
    assert.ok(userEntry, "user matcher entry survives");
    assert.strictEqual(userEntry.hooks[0].command, "user-gate");
    const ourMatcher = preToolUse.find((e) => e.matcher === "ask_permission|ask_question");
    assert.ok(ourMatcher, "our matcher entry rebuilt");
    assert.ok(
      ourMatcher.hooks.some((h) => h.command.includes(`${MARKER}:v${HOOK_SCHEMA_VERSION}`)),
      "rebuilt with the current version"
    );
  });
});
