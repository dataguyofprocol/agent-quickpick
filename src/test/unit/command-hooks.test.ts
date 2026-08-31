/**
 * Command-hook adapter symmetry (install ⇄ remove), idempotency, schema
 * versioning, and partial-install self-healing — the guarantees that keep a
 * user's `~/.claude/settings.json` / `~/.factory/settings.json` safe.
 * Unit tier — no VS Code host needed.
 */

import * as assert from "assert";

import {
  type CommandHookAdapter,
  mergeCommandHooks,
  stripCommandHooks,
  hasCommandHooks,
  hasCurrentCommandHooks,
} from "../../lifecycle";
import { CLAUDE_ADAPTER, DROID_ADAPTER, CODEX_ADAPTER } from "../../lifecycle-adapters";

const HOOK_URL = "http://127.0.0.1:99999";
const SESSION = "Claude";
const PORT_FILE_PATH = "/home/user/.config/agent-quickpick/hook-server.json";

/**
 * The core symmetry guarantee: install → remove === original, for every adapter
 * and every starting config shape.
 */
function assertInstallRemoveSymmetry(
  adapter: CommandHookAdapter,
  initial: unknown,
  label: string
): void {
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
  // After remove, the structure should match the initial (no leftover empty keys).
  const removedParsed = JSON.parse(JSON.stringify(removed));
  const initialParsed = JSON.parse(JSON.stringify(initial));
  assert.deepStrictEqual(
    removedParsed,
    initialParsed,
    `${label}: install → remove should equal original`
  );
}

suite("command-hook adapter symmetry (Claude)", () => {
  const adapter = CLAUDE_ADAPTER;

  test("install → remove on empty config", () => {
    assertInstallRemoveSymmetry(adapter, {}, "empty");
  });

  test("install → remove on config with unrelated keys", () => {
    assertInstallRemoveSymmetry(adapter, { model: "opus", permissions: { defaultMode: "auto" } }, "unrelated");
  });

  test("install → remove on config with pre-existing user hooks", () => {
    const userHooks = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "echo user-stop" }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo user-prompt" }] }],
      },
    };
    assertInstallRemoveSymmetry(adapter, userHooks, "user-hooks");
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

  test("remove on already-absent config is a no-op", () => {
    const config = { model: "opus" };
    const stripped = adapter.stripHooks(config);
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(stripped)),
      { model: "opus" }
    );
  });

  test("user hooks survive install + remove byte-identical", () => {
    const userCmd = "echo user-stop";
    const config = {
      hooks: { Stop: [{ hooks: [{ type: "command", command: userCmd }] }] },
    };
    const installed = adapter.mergeHooks(config, HOOK_URL, SESSION, PORT_FILE_PATH);
    const removed = adapter.stripHooks(installed);
    const removedHooks = (removed as Record<string, Record<string, unknown[]>>).hooks;
    // The user's Stop hook must still be there.
    const stopArr = removedHooks.Stop;
    assert.ok(stopArr, "user Stop hooks should survive");
    const cmds = stopArr.flatMap((e) => {
      const entry = e as { hooks: { command: string }[] };
      return entry.hooks.map((h) => h.command);
    });
    assert.ok(cmds.includes(userCmd), "user command must be intact");
  });

  test("hasOurHooks detects marker regardless of surrounding edits", () => {
    const installed = adapter.mergeHooks({}, HOOK_URL, SESSION, PORT_FILE_PATH) as Record<string, unknown>;
    // Simulate the user adding unrelated keys/reordering.
    const edited = { ...installed, customField: "added by user" };
    assert.ok(adapter.hasOurHooks(edited));
  });

  test("hasOurHooks is false for a config without our hooks", () => {
    assert.ok(!adapter.hasOurHooks({ model: "opus" }));
    assert.ok(!adapter.hasOurHooks({}));
  });
});

suite("command-hook adapter symmetry (Droid)", () => {
  const adapter = DROID_ADAPTER;

  test("install → remove on empty config", () => {
    assertInstallRemoveSymmetry(adapter, {}, "empty");
  });

  test("install → remove with pre-existing Droid settings", () => {
    const config = {
      enabledPlugins: { "core@factory-plugins": true },
      hooks: {
        SessionStart: [{ hooks: [{ command: "echo start", type: "command" }] }],
      },
    };
    assertInstallRemoveSymmetry(adapter, config, "droid-settings");
  });

  test("install is idempotent", () => {
    const once = adapter.mergeHooks({}, HOOK_URL, SESSION, PORT_FILE_PATH);
    const twice = adapter.mergeHooks(once, HOOK_URL, SESSION, PORT_FILE_PATH);
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(twice)),
      JSON.parse(JSON.stringify(once))
    );
  });
});

suite("command-hook adapter symmetry (Codex)", () => {
  const adapter = CODEX_ADAPTER;

  test("install → remove on empty config", () => {
    assertInstallRemoveSymmetry(adapter, {}, "empty");
  });

  test("install → remove on config with unrelated keys + user hooks", () => {
    const config = {
      model: "gpt-5.5",
      approval_policy: "on-request",
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "echo user-stop" }] }],
        PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: "echo user-tool" }] }],
      },
    };
    assertInstallRemoveSymmetry(adapter, config, "codex-user-hooks");
  });

  test("install is idempotent", () => {
    const once = adapter.mergeHooks({}, HOOK_URL, SESSION, PORT_FILE_PATH);
    const twice = adapter.mergeHooks(once, HOOK_URL, SESSION, PORT_FILE_PATH);
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(twice)),
      JSON.parse(JSON.stringify(once))
    );
  });

  test("Codex wires Stop + PermissionRequest + UserPromptSubmit", () => {
    const result = adapter.mergeHooks({}, HOOK_URL, SESSION, PORT_FILE_PATH) as Record<
      string,
      Record<string, unknown[]>
    >;
    assert.ok(result.hooks.Stop, "Stop event should exist");
    assert.ok(result.hooks.PermissionRequest, "PermissionRequest event should exist");
    assert.ok(result.hooks.UserPromptSubmit, "UserPromptSubmit event should exist");
  });

  test("PermissionRequest hook reports the typed waiting reason 'permission'", () => {
    const result = adapter.mergeHooks({}, HOOK_URL, SESSION, PORT_FILE_PATH) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    const cmd = result.hooks.PermissionRequest[0].hooks[0].command;
    // The reason is baked into the POSTed payload as a constant — no
    // free-text classification needed for Codex's typed permission event.
    assert.ok(
      cmd.includes("reason:'permission'"),
      `PermissionRequest command should embed reason:'permission', got: ${cmd}`
    );
    assert.ok(cmd.includes("status:'waiting'"), "PermissionRequest reports waiting");
  });

  test("Stop hook carries no baked reason (classification stays downstream)", () => {
    const result = adapter.mergeHooks({}, HOOK_URL, SESSION, PORT_FILE_PATH) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    const cmd = result.hooks.Stop[0].hooks[0].command;
    assert.ok(
      cmd.includes("reason:undefined"),
      "Stop command should leave the reason unset"
    );
  });
});

suite("command-hook merge produces correct schema", () => {
  test("Claude merge adds Stop + Notification + UserPromptSubmit hooks", () => {
    const result = CLAUDE_ADAPTER.mergeHooks({}, HOOK_URL, SESSION, PORT_FILE_PATH) as Record<
      string,
      Record<string, unknown[]>
    >;
    assert.ok(result.hooks, "hooks section should exist");
    assert.ok(result.hooks.Stop, "Stop event should exist");
    assert.ok(result.hooks.Notification, "Notification event should exist");
    // UserPromptSubmit keeps status truthful mid-turn (Stop alone would leave
    // the bar on "done" while the agent is working the next turn).
    assert.ok(result.hooks.UserPromptSubmit, "UserPromptSubmit event should exist");
    // Each event entry should have a hooks array with type:"command".
    const stopEntry = result.hooks.Stop[0] as { hooks: { type: string; command: string }[] };
    assert.strictEqual(stopEntry.hooks[0].type, "command");
    assert.ok(stopEntry.hooks[0].command.length > 0);
  });

  test("generated command references the marker", () => {
    const result = CLAUDE_ADAPTER.mergeHooks({}, HOOK_URL, SESSION, PORT_FILE_PATH);
    assert.ok(
      JSON.stringify(result).includes("agentQuickpick:claude"),
      "command should contain the marker"
    );
  });
});

suite("hasCurrentCommandHooks", () => {
  const marker = "agentQuickpick:test";

  test("false for a config with none of our hooks", () => {
    assert.ok(!hasCurrentCommandHooks({}, marker, ["Stop"]));
    assert.ok(!hasCurrentCommandHooks({ model: "opus" }, marker, ["Stop"]));
  });

  test("true for a config merged by the current schema version", () => {
    const installed = mergeCommandHooks(
      {},
      ["Stop"],
      HOOK_URL,
      SESSION,
      marker,
      PORT_FILE_PATH
    );
    assert.ok(hasCurrentCommandHooks(installed, marker, ["Stop"]));
    // hasOurHooks (marker-only) must also still see it as ours.
    assert.ok(hasCommandHooks(installed, marker));
  });

  test("false for a stale install written by an older schema version (marker present, no version tag)", () => {
    // Simulate a pre-versioning install: marker present, but no `:v<N>` tag —
    // e.g. an older extension's generated command.
    const stale = {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: `node -e "if(!process.env.AQP_SESSION){process.exit(0)}${marker}"`,
              },
            ],
          },
        ],
      },
    };
    assert.ok(hasCommandHooks(stale, marker), "marker-only check still sees it as ours");
    assert.ok(
      !hasCurrentCommandHooks(stale, marker, ["Stop"]),
      "version check should flag it as stale"
    );
  });

  test("false when only some wired events have a current hook", () => {
    // Partial install: Stop got written, Notification didn't (interrupted write,
    // or the user hand-deleted one). Must read as stale so install re-merges.
    const partial = mergeCommandHooks(
      {},
      ["Stop"],
      HOOK_URL,
      SESSION,
      marker,
      PORT_FILE_PATH
    );
    assert.ok(hasCurrentCommandHooks(partial, marker, ["Stop"]));
    assert.ok(
      !hasCurrentCommandHooks(partial, marker, ["Stop", "Notification"]),
      "a missing event must not pass as current"
    );
  });

  test("re-merge fills a missing event without duplicating the present one", () => {
    const events = ["Stop", "Notification"];
    const partial = mergeCommandHooks(
      {},
      ["Stop"],
      HOOK_URL,
      SESSION,
      marker,
      PORT_FILE_PATH
    );
    const healed = mergeCommandHooks(
      partial,
      events,
      HOOK_URL,
      SESSION,
      marker,
      PORT_FILE_PATH
    ) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    assert.ok(hasCurrentCommandHooks(healed, marker, events));
    assert.strictEqual(healed.hooks.Stop.length, 1, "Stop must not be duplicated");
    assert.strictEqual(healed.hooks.Notification.length, 1);
  });
});

suite("mergeCommandHooks / stripCommandHooks", () => {
  const events = ["Stop", "Notification"];
  const marker = "agentQuickpick:test";

  test("install → remove round-trip on empty", () => {
    const installed = mergeCommandHooks({}, events, HOOK_URL, SESSION, marker, PORT_FILE_PATH);
    assert.ok(hasCommandHooks(installed, marker));
    const removed = stripCommandHooks(installed, marker);
    assert.ok(!hasCommandHooks(removed, marker));
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(removed)),
      {}
    );
  });

  test("prunes empty hooks section after removal", () => {
    const installed = mergeCommandHooks({}, events, HOOK_URL, SESSION, marker, PORT_FILE_PATH);
    const removed = stripCommandHooks(installed, marker) as Record<string, unknown>;
    assert.ok(!("hooks" in removed), "empty hooks section should be pruned");
  });

  test("preserves user hooks when stripping ours", () => {
    const userHooks = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "user-cmd" }] }],
      },
    };
    const installed = mergeCommandHooks(userHooks, events, HOOK_URL, SESSION, marker, PORT_FILE_PATH);
    const removed = stripCommandHooks(installed, marker) as Record<
      string,
      Record<string, { hooks: { command: string }[] }[]>
    >;
    const stopCmds = removed.hooks.Stop.flatMap((e) => e.hooks.map((h) => h.command));
    assert.ok(stopCmds.includes("user-cmd"), "user command should survive");
  });

  test("strips a stale hook of ours that shares an entry with a user hook", () => {
    // Someone (a user, or another tool) put their command in the same entry as
    // ours. Filtering per-entry would delete their hook too.
    const shared = {
      hooks: {
        Stop: [
          {
            matcher: "*",
            hooks: [
              { type: "command", command: `node -e "/*${marker}:v1*/old"` },
              { type: "command", command: "user-cmd" },
            ],
          },
        ],
      },
    };
    const removed = stripCommandHooks(shared, marker) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
    };
    assert.strictEqual(removed.hooks.Stop.length, 1);
    assert.deepStrictEqual(
      removed.hooks.Stop[0].hooks.map((h) => h.command),
      ["user-cmd"]
    );
    assert.strictEqual(removed.hooks.Stop[0].matcher, "*", "entry keys preserved");
    assert.ok(!hasCommandHooks(removed, marker));
  });

  test("merge replaces a stale hook of ours instead of appending beside it", () => {
    const stale = {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: `node -e "/*${marker}:v1*/old"` }] },
          { hooks: [{ type: "command", command: "user-cmd" }] },
        ],
      },
    };
    const merged = mergeCommandHooks(
      stale,
      ["Stop"],
      HOOK_URL,
      SESSION,
      marker,
      PORT_FILE_PATH
    ) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    const cmds = merged.hooks.Stop.flatMap((e) => e.hooks.map((h) => h.command));
    assert.ok(cmds.includes("user-cmd"), "user hook untouched");
    assert.strictEqual(
      cmds.filter((c) => c.includes(marker)).length,
      1,
      "exactly one generation of our hook should remain"
    );
    assert.ok(!cmds.some((c) => c.includes(`${marker}:v1`)), "stale hook dropped");
  });

  test("merging twice is idempotent", () => {
    const once = mergeCommandHooks({}, events, HOOK_URL, SESSION, marker, PORT_FILE_PATH);
    const twice = mergeCommandHooks(once, events, HOOK_URL, SESSION, marker, PORT_FILE_PATH);
    assert.deepStrictEqual(twice, once);
  });

  test("a user's empty event array survives install + remove untouched", () => {
    // Found by the fuzz suite: an event with none of our hooks (here: an
    // empty array) must pass through byte-for-byte — not be pruned.
    const config = { hooks: { SessionStart: [] } };
    const installed = mergeCommandHooks(config, events, HOOK_URL, SESSION, marker, PORT_FILE_PATH);
    const removed = stripCommandHooks(installed, marker);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(removed)), config);
  });

  test("an event holding only junk entries (none of ours) is untouched", () => {
    const config = { hooks: { Custom: [null, "junk"] } };
    const installed = mergeCommandHooks(config, events, HOOK_URL, SESSION, marker, PORT_FILE_PATH);
    const removed = stripCommandHooks(installed, marker);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(removed)), config);
  });

  test("an empty WIRED event array is absorbed (pinned contract, not a bug)", () => {
    // Install appends into a wired event's empty array; remove then prunes
    // the emptied event per the documented pruning rule. Absent == empty for
    // the agent CLIs, so this is cosmetic — pinned so a change is deliberate.
    const installed = mergeCommandHooks(
      { hooks: { Stop: [] } },
      ["Stop"],
      HOOK_URL,
      SESSION,
      marker,
      PORT_FILE_PATH
    );
    const removed = stripCommandHooks(installed, marker);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(removed)), {});
  });
});

suite("mid-turn status wiring (Fix 3)", () => {
  test("Claude adapter wires UserPromptSubmit", () => {
    // The event list is private behind the factory; observe its effect by
    // merging into an empty config and checking the produced hook events.
    const result = CLAUDE_ADAPTER.mergeHooks({}, HOOK_URL, SESSION, PORT_FILE_PATH) as Record<
      string,
      Record<string, unknown[]>
    >;
    assert.ok(result.hooks.UserPromptSubmit, "Claude should wire UserPromptSubmit");
    // UserPromptSubmit maps to "running" — its generated command carries that status.
    const entry = result.hooks.UserPromptSubmit[0] as { hooks: { command: string }[] };
    assert.ok(
      entry.hooks[0].command.includes("'running'"),
      "UserPromptSubmit hook should report status 'running'"
    );
  });

  test("Droid adapter wires UserPromptSubmit", () => {
    const result = DROID_ADAPTER.mergeHooks({}, HOOK_URL, SESSION, PORT_FILE_PATH) as Record<
      string,
      Record<string, unknown[]>
    >;
    assert.ok(result.hooks.UserPromptSubmit, "Droid should wire UserPromptSubmit");
  });

  test("install → remove still symmetric with the extra UserPromptSubmit event", () => {
    // The symmetry guarantee must hold now that a third event is wired.
    assertInstallRemoveSymmetry(CLAUDE_ADAPTER, {}, "claude-with-prompt");
    assertInstallRemoveSymmetry(DROID_ADAPTER, {}, "droid-with-prompt");
  });
});
