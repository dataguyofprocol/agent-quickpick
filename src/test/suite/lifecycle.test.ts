/**
 * Tests for the lifecycle awareness feature — adapter symmetry (install ⇄
 * remove), hook command generation, status-bar rendering, and notification
 * logic. Pure-function style, matching the existing extension.test.ts suite.
 */

import * as assert from "assert";
import * as path from "path";

import {
  type SessionState,
  type LifecycleStatus,
  type CommandHookAdapter,
  readConfigJson,
  writeConfigJson,
  countByStatus,
  statusBarText,
  statusBarTooltip,
  filterSessionsByFolder,
  folderOf,
  folderBasename,
  STATUS_LABEL,
  STATUS_GLYPH,
  shouldNotify,
  shouldSystemNotify,
  shouldPlaySound,
  systemNotifyCommand,
  notifierCandidates,
  VENDORED_NOTIFIER_REL,
  sessionFromFocusUri,
  FOCUS_URI_PATH,
  FOCUS_URI_SESSION_PARAM,
  isSafeBundleId,
  soundPlayCommand,
  isAnnouncedStatus,
  notificationMessage,
  buildNodeHookCommand,
  mergeCommandHooks,
  stripCommandHooks,
  hasCommandHooks,
  hasCurrentCommandHooks,
  HOOK_SCHEMA_VERSION,
} from "../../lifecycle";
import {
  CLAUDE_ADAPTER,
  DROID_ADAPTER,
  OPENCODE_ADAPTER,
  LIFECYCLE_ADAPTERS,
  getAdapter,
  isLifecycleAgent,
  buildOpenCodePluginSource,
  resolveOpenCodeConfigDir,
} from "../../lifecycle-adapters";

const HOOK_URL = "http://127.0.0.1:99999";
const SESSION = "Claude";
const PORT_FILE_PATH = "/home/user/.config/agent-quickpick/hook-server.json";

// ---------------------------------------------------------------------------
// JSON config helpers
// ---------------------------------------------------------------------------

suite("readConfigJson", () => {
  test("parses a valid object", () => {
    assert.deepStrictEqual(readConfigJson('{"a":1}'), { a: 1 });
  });

  test("empty string → {}", () => {
    assert.deepStrictEqual(readConfigJson(""), {});
  });

  test("whitespace-only → {}", () => {
    assert.deepStrictEqual(readConfigJson("   \n  "), {});
  });

  test("malformed JSON → {}", () => {
    assert.deepStrictEqual(readConfigJson("{not valid json"), {});
  });

  test("non-object top level (array) → {}", () => {
    assert.deepStrictEqual(readConfigJson("[1,2,3]"), {});
  });

  test("non-object top level (number) → {}", () => {
    assert.deepStrictEqual(readConfigJson("42"), {});
  });

  test("null → {}", () => {
    assert.deepStrictEqual(readConfigJson("null"), {});
  });
});

suite("writeConfigJson", () => {
  test("pretty-prints with 2-space indent + trailing newline", () => {
    assert.strictEqual(writeConfigJson({ a: 1 }), '{\n  "a": 1\n}\n');
  });

  test("round-trips through readConfigJson", () => {
    const obj = { hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] } };
    assert.deepStrictEqual(readConfigJson(writeConfigJson(obj)), obj);
  });
});

// ---------------------------------------------------------------------------
// Command-hook adapters (Claude & Droid share this schema)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// buildNodeHookCommand
// ---------------------------------------------------------------------------

suite("buildNodeHookCommand", () => {
  test("produces a non-empty string", () => {
    const cmd = buildNodeHookCommand(HOOK_URL, SESSION, "agentQuickpick:test", "finished", PORT_FILE_PATH);
    assert.ok(typeof cmd === "string" && cmd.length > 0);
  });

  test("starts with node -e", () => {
    const cmd = buildNodeHookCommand(HOOK_URL, SESSION, "agentQuickpick:test", "finished", PORT_FILE_PATH);
    assert.ok(cmd.startsWith("node -e"), `should start with "node -e", got: ${cmd.slice(0, 20)}`);
  });

  test("contains the hook URL", () => {
    const cmd = buildNodeHookCommand(HOOK_URL, SESSION, "agentQuickpick:test", "finished", PORT_FILE_PATH);
    assert.ok(cmd.includes("127.0.0.1"), "should contain the server host");
  });

  test("contains the marker", () => {
    const cmd = buildNodeHookCommand(HOOK_URL, SESSION, "agentQuickpick:test", "finished", PORT_FILE_PATH);
    assert.ok(cmd.includes("agentQuickpick:test"), "should contain the marker");
  });

  test("is embeddable as a JSON string value (parses without error)", () => {
    const cmd = buildNodeHookCommand(HOOK_URL, SESSION, "agentQuickpick:test", "finished", PORT_FILE_PATH);
    // Wrap it in a JSON object to simulate being inside settings.json.
    const wrapped = JSON.stringify({ command: cmd });
    assert.doesNotThrow(() => JSON.parse(wrapped));
  });

  test("forwards cwd from the parsed stdin JSON into the POST body", () => {
    // The hook reads stdin JSON (the agent's event payload, which for Claude
    // includes a `cwd` field) and must include it in the POST body so the
    // extension can attribute the session to a workspace folder. We verify
    // the source references j.cwd and a `cwd:` field in the stringified body.
    const cmd = buildNodeHookCommand(HOOK_URL, SESSION, "agentQuickpick:test", "finished", PORT_FILE_PATH);
    assert.ok(cmd.includes("j?.cwd"), "should read j.cwd defensively");
    assert.ok(cmd.includes("cwd:"), "should include a cwd field in the POST body");
  });

  test("cwd defaults to empty string when stdin has no cwd", () => {
    const cmd = buildNodeHookCommand(HOOK_URL, SESSION, "agentQuickpick:test", "finished", PORT_FILE_PATH);
    assert.ok(
      cmd.includes("j?.cwd||''"),
      "should default to '' when stdin JSON has no cwd"
    );
  });

  test("embeds the version tag alongside the marker", () => {
    const cmd = buildNodeHookCommand(HOOK_URL, SESSION, "agentQuickpick:test", "finished", PORT_FILE_PATH);
    assert.ok(
      cmd.includes(`agentQuickpick:test:v${HOOK_SCHEMA_VERSION}`),
      "should embed <marker>:v<schema version>"
    );
  });

  test("embeds the port file path and reads it before falling back", () => {
    const cmd = buildNodeHookCommand(HOOK_URL, SESSION, "agentQuickpick:test", "finished", PORT_FILE_PATH);
    assert.ok(cmd.includes(PORT_FILE_PATH), "should embed the port file path");
    assert.ok(
      cmd.includes("readFileSync"),
      "should read the port file at invocation time"
    );
    // Resolution order in the generated source: port file → AQP_HOOK_URL env → baked literal.
    const fileIdx = cmd.indexOf("fileUrl||process.env.AQP_HOOK_URL");
    assert.ok(fileIdx !== -1, "file-then-env fallback chain should be present");
  });

  test("a bad/missing port file never throws (wrapped in try/catch)", () => {
    const cmd = buildNodeHookCommand(HOOK_URL, SESSION, "agentQuickpick:test", "finished", PORT_FILE_PATH);
    assert.ok(
      /try\{fileUrl=JSON\.parse\(fs\.readFileSync\([^)]*\)\)\.url\}catch/.test(cmd),
      "port-file read must be wrapped so a missing/corrupt file falls through silently"
    );
  });
});

// ---------------------------------------------------------------------------
// Hook schema versioning (auto-upgrade detection)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Shared command-hook helpers (mergeCommandHooks / stripCommandHooks / hasCommandHooks)
// ---------------------------------------------------------------------------

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
});

// ---------------------------------------------------------------------------
// OpenCode adapter
// ---------------------------------------------------------------------------

suite("OpenCode adapter (plugin-file)", () => {
  const adapter = OPENCODE_ADAPTER;

  test("is a plugin-file adapter (no JSON config edit)", () => {
    assert.strictEqual(adapter.kind, "plugin-file");
  });

  test("plugin path is a config-dir-relative fragment", () => {
    assert.ok(adapter.kind === "plugin-file");
    // Path is relative to OpenCode's config dir (resolved per-platform), not to
    // home — so it's a bare "plugin/..." fragment. The extension joins it with
    // resolveOpenCodeConfigDir(...) at install time.
    assert.strictEqual(
      adapter.pluginPath,
      "plugin/agent-quickpick-lifecycle.js"
    );
    assert.ok(adapter.pluginPath.endsWith(".js"), "must be .js for OpenCode's discovery glob");
  });

  test("buildSource embeds URL + marker and guards on AQP_SESSION", () => {
    assert.ok(adapter.kind === "plugin-file");
    const src = adapter.buildSource(HOOK_URL, SESSION, PORT_FILE_PATH);
    assert.ok(src.includes("127.0.0.1"), "should embed the server URL");
    assert.ok(src.includes("agentQuickpick:opencode"), "should contain the marker");
    assert.ok(src.includes("AQP_SESSION"), "should guard on the injected session env");
  });
});

suite("buildOpenCodePluginSource", () => {
  test("produces ESM with the marker comment", () => {
    const src = buildOpenCodePluginSource(HOOK_URL, SESSION, PORT_FILE_PATH);
    assert.ok(src.includes("agentQuickpick:opencode"), "should contain marker");
  });

  test("exports the plugin factory", () => {
    const src = buildOpenCodePluginSource(HOOK_URL, SESSION, PORT_FILE_PATH);
    assert.ok(
      src.includes("AgentQuickpickLifecyclePlugin"),
      "should export the plugin name"
    );
  });

  test("maps lifecycle events to statuses", () => {
    const src = buildOpenCodePluginSource(HOOK_URL, SESSION, PORT_FILE_PATH);
    assert.ok(src.includes("session.idle"), "should handle session.idle");
    assert.ok(src.includes("permission.asked"), "should handle permission.asked");
    assert.ok(src.includes("question.asked"), "should handle question.asked");
    assert.ok(src.includes("session.error"), "should handle session.error");
  });

  test("embeds the hook URL", () => {
    const src = buildOpenCodePluginSource(HOOK_URL, SESSION, PORT_FILE_PATH);
    assert.ok(src.includes("127.0.0.1"), "should embed the server URL");
  });

  test("forwards process.cwd() in the POST body for repo attribution", () => {
    const src = buildOpenCodePluginSource(HOOK_URL, SESSION, PORT_FILE_PATH);
    assert.ok(
      src.includes("cwd: process.cwd()"),
      "should include process.cwd() in the POST body so sessions can be repo-scoped"
    );
  });
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

suite("adapter registry", () => {
  test("has all three adapters", () => {
    assert.ok(LIFECYCLE_ADAPTERS.Claude);
    assert.ok(LIFECYCLE_ADAPTERS.Droid);
    assert.ok(LIFECYCLE_ADAPTERS.OpenCode);
  });

  test("getAdapter returns by name", () => {
    assert.strictEqual(getAdapter("Claude"), CLAUDE_ADAPTER);
    assert.strictEqual(getAdapter("Droid"), DROID_ADAPTER);
    assert.strictEqual(getAdapter("OpenCode"), OPENCODE_ADAPTER);
  });

  test("getAdapter returns undefined for unsupported agent", () => {
    assert.strictEqual(getAdapter("Codex"), undefined);
  });

  test("isLifecycleAgent is correct", () => {
    assert.ok(isLifecycleAgent("Claude"));
    assert.ok(isLifecycleAgent("Droid"));
    assert.ok(isLifecycleAgent("OpenCode"));
    assert.ok(!isLifecycleAgent("Codex"));
    assert.ok(!isLifecycleAgent("Terminal"));
  });

  test("each adapter has a unique marker", () => {
    const markers = Object.values(LIFECYCLE_ADAPTERS).map((a) => a.marker);
    assert.strictEqual(new Set(markers).size, markers.length, "markers must be unique");
  });

  test("each adapter targets a unique, relative path", () => {
    const paths = Object.values(LIFECYCLE_ADAPTERS).map((a) =>
      a.kind === "command-hooks" ? a.configPath : a.pluginPath
    );
    assert.strictEqual(new Set(paths).size, paths.length, "target paths must be unique");
    // Command-hook paths are home-relative; OpenCode's plugin path is relative
    // to its config dir. Both are relative fragments (no leading slash, no ~).
    for (const p of paths) {
      assert.ok(!p.startsWith("/") && !p.startsWith("~"), `${p} should be a relative fragment`);
    }
  });
});

// ---------------------------------------------------------------------------
// Status-bar rendering
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Repo-scoping helpers (folderOf / folderBasename / filterSessionsByFolder)
// ---------------------------------------------------------------------------

suite("folderOf", () => {
  test("prefers cwd over launchedInFolder", () => {
    const got = folderOf(
      makeState("Claude", "Claude", "running", 100, {
        cwd: "/a/cwd",
        launchedInFolder: "/b/launch",
      })
    );
    assert.strictEqual(got, "/a/cwd");
  });

  test("falls back to launchedInFolder when cwd is absent", () => {
    const got = folderOf(
      makeState("Claude", "Claude", "running", 100, {
        launchedInFolder: "/b/launch",
      })
    );
    assert.strictEqual(got, "/b/launch");
  });

  test("returns undefined when neither is set (re-adopted, no hook yet)", () => {
    const got = folderOf(makeState("Claude", "Claude", "unknown", 100));
    assert.strictEqual(got, undefined);
  });
});

suite("folderBasename", () => {
  test("plain unix path", () => {
    assert.strictEqual(folderBasename("/Users/me/projects/my-app"), "my-app");
  });

  test("plain windows path", () => {
    assert.strictEqual(folderBasename("C:\\dev\\projects\\my-app"), "my-app");
  });

  test("strips trailing slash", () => {
    assert.strictEqual(folderBasename("/Users/me/projects/my-app/"), "my-app");
    assert.strictEqual(folderBasename("C:\\dev\\my-app\\"), "my-app");
  });

  test("bare name passthrough", () => {
    assert.strictEqual(folderBasename("my-app"), "my-app");
  });
});

suite("filterSessionsByFolder", () => {
  test("returns everything when activeFolder is undefined (no workspace)", () => {
    const states = [
      makeState("Claude", "Claude", "running", 100, { cwd: "/a" }),
      makeState("Codex", "Codex", "running", 100, { cwd: "/b" }),
      makeState("ReAdopted", "ReAdopted", "unknown", 100),
    ];
    assert.strictEqual(filterSessionsByFolder(states, undefined).length, 3);
  });

  test("filters to sessions whose cwd matches the active folder", () => {
    const states = [
      makeState("Claude", "Claude", "running", 100, { cwd: "/repo/alpha" }),
      makeState("Codex", "Codex", "running", 100, { cwd: "/repo/beta" }),
    ];
    const filtered = filterSessionsByFolder(states, "/repo/alpha");
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].name, "Claude");
  });

  test("falls back to launchedInFolder when cwd is absent", () => {
    const states = [
      makeState("Claude", "Claude", "running", 100, {
        launchedInFolder: "/repo/alpha",
      }),
      makeState("Codex", "Codex", "running", 100, {
        launchedInFolder: "/repo/beta",
      }),
    ];
    const filtered = filterSessionsByFolder(states, "/repo/alpha");
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].name, "Claude");
  });

  test("excludes re-adopted sessions (no cwd, no launchedInFolder) when a folder is set", () => {
    const states = [
      makeState("Claude", "Claude", "unknown", 100),
      makeState("Codex", "Codex", "running", 100, { cwd: "/repo/alpha" }),
    ];
    const filtered = filterSessionsByFolder(states, "/repo/alpha");
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].name, "Codex");
  });

  test("empty input → empty output", () => {
    assert.strictEqual(filterSessionsByFolder([], "/anywhere").length, 0);
  });
});

// ---------------------------------------------------------------------------
// Notification logic
// ---------------------------------------------------------------------------

suite("shouldNotify", () => {
  test("fires on finished when active + setting on", () => {
    assert.ok(shouldNotify("finished", false, true));
  });

  test("fires on waiting", () => {
    assert.ok(shouldNotify("waiting", false, true));
  });

  test("suppressed when terminal is active/focused", () => {
    assert.ok(!shouldNotify("finished", true, true));
    assert.ok(!shouldNotify("waiting", true, true));
  });

  test("suppressed when setting is off", () => {
    assert.ok(!shouldNotify("finished", false, false));
    assert.ok(!shouldNotify("waiting", false, false));
  });

  test("never fires on running", () => {
    assert.ok(!shouldNotify("running", false, true));
  });

  test("never fires on unknown (no confident state to announce)", () => {
    assert.ok(!shouldNotify("unknown", false, true));
    assert.ok(!shouldNotify("unknown", true, true));
    assert.ok(!shouldNotify("unknown", false, false));
  });

  test("fires on failed (crashes must be visible)", () => {
    assert.ok(shouldNotify("failed", false, true));
  });

  test("failed suppressed when terminal is active/focused", () => {
    assert.ok(!shouldNotify("failed", true, true));
  });

  test("failed suppressed when setting is off", () => {
    assert.ok(!shouldNotify("failed", false, false));
  });
});

suite("notificationMessage", () => {
  test("finished → glyph + agent + repo + Show action", () => {
    const msg = notificationMessage("Claude", "finished", "my-app");
    assert.ok(msg);
    assert.strictEqual(msg!.text, "✓ Claude finished · my-app");
    assert.strictEqual(msg!.action, "Show");
  });

  test("waiting → glyph + agent + repo + Show action", () => {
    const msg = notificationMessage("OpenCode", "waiting", "my-app");
    assert.ok(msg);
    assert.strictEqual(msg!.text, "⏸ OpenCode needs your input · my-app");
    assert.strictEqual(msg!.action, "Show");
  });

  test("omits the repo suffix when repo is absent/empty", () => {
    assert.strictEqual(notificationMessage("Claude", "finished")!.text, "✓ Claude finished");
    assert.strictEqual(notificationMessage("Claude", "finished", "")!.text, "✓ Claude finished");
    assert.strictEqual(notificationMessage("Claude", "finished", "  ")!.text, "✓ Claude finished");
  });

  test("running → null", () => {
    assert.strictEqual(notificationMessage("Claude", "running"), null);
  });

  test("failed → glyph + crashed + Show action", () => {
    const msg = notificationMessage("Claude", "failed", "my-app");
    assert.ok(msg);
    assert.strictEqual(msg!.text, "✗ Claude crashed · my-app");
    assert.strictEqual(msg!.action, "Show");
  });

  test("failed includes exit code when provided", () => {
    const msg = notificationMessage("Claude", "failed", "my-app", 130);
    assert.ok(msg);
    assert.strictEqual(msg!.text, "✗ Claude crashed · my-app · exit 130");
  });

  test("failed omits repo suffix when repo absent, still shows exit code", () => {
    const msg = notificationMessage("Claude", "failed", undefined, 1);
    assert.ok(msg);
    assert.strictEqual(msg!.text, "✗ Claude crashed · exit 1");
  });

  test("failed without exit code or repo", () => {
    const msg = notificationMessage("Claude", "failed");
    assert.ok(msg);
    assert.strictEqual(msg!.text, "✗ Claude crashed");
  });
});

// ---------------------------------------------------------------------------
// Mid-turn status wiring (UserPromptSubmit → running)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Hook command socket timeout (prevents a dead localhost port hanging the agent)
// ---------------------------------------------------------------------------

suite("buildNodeHookCommand socket timeout", () => {
  test("sets a 2s timeout so a dead port can't hang the agent's hook", () => {
    const cmd = buildNodeHookCommand(HOOK_URL, SESSION, "agentQuickpick:test", "finished", PORT_FILE_PATH);
    assert.ok(
      cmd.includes("setTimeout(2000"),
      "hook command should arm a 2s socket timeout"
    );
  });
});

// ---------------------------------------------------------------------------
// OpenCode config-dir resolution (per-platform, not hardcoded ~/.config)
// ---------------------------------------------------------------------------

suite("resolveOpenCodeConfigDir (Fix 4)", () => {
  const home = "/home/user";

  test("OPENCODE_CONFIG_DIR always wins", () => {
    assert.strictEqual(
      resolveOpenCodeConfigDir(
        { OPENCODE_CONFIG_DIR: "/custom/oc", XDG_CONFIG_HOME: "/xdg" },
        "linux",
        home
      ),
      "/custom/oc"
    );
  });

  test("XDG_CONFIG_HOME used when OPENCODE_CONFIG_DIR absent", () => {
    assert.strictEqual(
      resolveOpenCodeConfigDir({ XDG_CONFIG_HOME: "/xdg" }, "linux", home),
      path.join("/xdg", "opencode")
    );
  });

  test("Windows uses APPDATA (xdg-basedir's Windows fallback)", () => {
    assert.strictEqual(
      resolveOpenCodeConfigDir({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32", home),
      path.join("C:\\Users\\me\\AppData\\Roaming", "opencode")
    );
  });

  test("Windows falls back to LOCALAPPDATA then home", () => {
    assert.strictEqual(
      resolveOpenCodeConfigDir({ LOCALAPPDATA: "C:\\local" }, "win32", home),
      path.join("C:\\local", "opencode")
    );
    assert.strictEqual(
      resolveOpenCodeConfigDir({}, "win32", home),
      path.join(home, "opencode")
    );
  });

  test("macOS/Linux default → ~/.config/opencode", () => {
    assert.strictEqual(
      resolveOpenCodeConfigDir({}, "darwin", home),
      path.join(home, ".config", "opencode")
    );
    assert.strictEqual(
      resolveOpenCodeConfigDir({}, "linux", home),
      path.join(home, ".config", "opencode")
    );
  });

  test("OPENCODE_CONFIG_DIR wins even on Windows", () => {
    assert.strictEqual(
      resolveOpenCodeConfigDir(
        { OPENCODE_CONFIG_DIR: "D:\\oc", APPDATA: "C:\\AppData\\Roaming" },
        "win32",
        home
      ),
      "D:\\oc"
    );
  });
});

suite("OpenCode plugin source uses ESM dynamic import (Fix 4)", () => {
  test("uses dynamic import() not require() for http", () => {
    const src = buildOpenCodePluginSource(HOOK_URL, SESSION, PORT_FILE_PATH);
    assert.ok(
      src.includes('import("node:http")'),
      "plugin should use dynamic import('node:http') for Node-ESM compatibility"
    );
    assert.ok(
      !src.includes('require("http")'),
      "plugin should not use require() — bare require throws under Node ESM"
    );
  });

  test("arms a 2s socket timeout", () => {
    const src = buildOpenCodePluginSource(HOOK_URL, SESSION, PORT_FILE_PATH);
    assert.ok(src.includes("setTimeout(2000"), "plugin should arm a 2s socket timeout");
  });
});

// ---------------------------------------------------------------------------
// OS notifications + sound
// ---------------------------------------------------------------------------

const ANNOUNCED: LifecycleStatus[] = ["finished", "waiting", "failed"];
const SILENT: LifecycleStatus[] = ["running", "unknown"];

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
    assert.ok(!shouldNotify("finished", true, true));
    assert.ok(shouldSystemNotify("whenUnfocused", "finished", false, true));
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
    assert.ok(!shouldPlaySound(false, "finished", true));
    assert.ok(!shouldPlaySound(true, "finished", false));
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

suite("notifierCandidates", () => {
  const EXT = "/ext";

  test("returns no candidates off macOS (terminal-notifier is darwin-only)", () => {
    assert.deepStrictEqual(notifierCandidates(EXT, "linux", "/usr/bin"), []);
    assert.deepStrictEqual(notifierCandidates(EXT, "win32", "C:\\bin"), []);
  });

  test("prefers well-known installs before the bundled fallback", () => {
    const c = notifierCandidates(EXT, "darwin", undefined);
    // A user's own copy always wins, so power users keep their newer build...
    assert.strictEqual(c[0], "/opt/homebrew/bin/terminal-notifier");
    assert.strictEqual(c[1], "/usr/local/bin/terminal-notifier");
    assert.strictEqual(c[2], "/opt/local/bin/terminal-notifier");
    // ...and the bundled universal .app is the notifier of last resort.
    assert.strictEqual(
      c[c.length - 1],
      path.join(EXT, VENDORED_NOTIFIER_REL)
    );
  });

  test("expands $PATH entries between the well-known paths and the bundled fallback", () => {
    const dirs = ["/usr/local/other/bin", "/home/me/bin"];
    const c = notifierCandidates(EXT, "darwin", dirs.join(path.delimiter));
    const fromPath = dirs.map((d) => path.join(d, "terminal-notifier"));
    for (const p of fromPath) {
      assert.ok(c.includes(p), `$PATH entry ${p} should be a candidate`);
    }
    // Ordering: well-known first, then $PATH, then the bundled binary.
    const wellKnownEnd = c.indexOf("/opt/local/bin/terminal-notifier");
    const pathStart = c.indexOf(fromPath[0]);
    const vendored = c.indexOf(path.join(EXT, VENDORED_NOTIFIER_REL));
    assert.ok(wellKnownEnd < pathStart, "well-known paths come before $PATH");
    assert.ok(pathStart < vendored, "$PATH comes before the bundled fallback");
  });

  test("ignores empty $PATH segments", () => {
    const pathEnv = ["/opt/x", "", "/opt/y"].join(path.delimiter);
    const c = notifierCandidates(EXT, "darwin", pathEnv);
    // An empty segment must not yield a bare relative "terminal-notifier" entry.
    assert.ok(
      !c.some((p) => p === "terminal-notifier"),
      "empty $PATH segment must not produce a bare relative candidate"
    );
    assert.ok(c.includes(path.join("/opt/x", "terminal-notifier")));
    assert.ok(c.includes(path.join("/opt/y", "terminal-notifier")));
  });

  test("still offers the bundled fallback when nothing is on $PATH", () => {
    const c = notifierCandidates(EXT, "darwin", undefined);
    assert.ok(
      c.includes(path.join(EXT, VENDORED_NOTIFIER_REL)),
      "bundled notifier is the fresh-install default"
    );
  });

  test("the bundled candidate is the inner Mach-O of the vendored .app", () => {
    assert.strictEqual(
      VENDORED_NOTIFIER_REL,
      "resources/notifier/terminal-notifier.app/Contents/MacOS/terminal-notifier"
    );
  });
});

suite("sessionFromFocusUri", () => {
  test("returns the session for a focus URI", () => {
    const query = new URLSearchParams({
      [FOCUS_URI_SESSION_PARAM]: "Claude",
    }).toString();
    assert.strictEqual(sessionFromFocusUri(FOCUS_URI_PATH, query), "Claude");
  });

  test("round-trips a session name with spaces and parens (as focusUri emits)", () => {
    // focusUri builds the query with URLSearchParams; the click must recover the
    // exact tab name, e.g. "Codex (2)", so the right terminal is focused.
    const name = "Codex (2)";
    const query = new URLSearchParams({
      [FOCUS_URI_SESSION_PARAM]: name,
    }).toString();
    assert.strictEqual(sessionFromFocusUri(FOCUS_URI_PATH, query), name);
  });

  test("returns null for a non-focus path", () => {
    const query = new URLSearchParams({
      [FOCUS_URI_SESSION_PARAM]: "Claude",
    }).toString();
    assert.strictEqual(sessionFromFocusUri("/other", query), null);
    assert.strictEqual(sessionFromFocusUri("focus", query), null);
  });

  test("returns null when the session param is absent", () => {
    assert.strictEqual(
      sessionFromFocusUri(FOCUS_URI_PATH, "foo=bar&baz=qux"),
      null
    );
  });

  test("returns null for an empty session", () => {
    const query = new URLSearchParams({
      [FOCUS_URI_SESSION_PARAM]: "",
    }).toString();
    assert.strictEqual(sessionFromFocusUri(FOCUS_URI_PATH, query), null);
  });
});

suite("systemNotifyCommand", () => {
  const TITLE = "Agent Quickpick";
  // Hostile text: a session/repo name can legitimately contain these.
  const BODY = '✓ Claude finished · "$(id)" `whoami` \\ \'x\'';

  test("darwin without a bundle id passes body/title as argv, never spliced into AppleScript", () => {
    const spec = systemNotifyCommand("darwin", TITLE, BODY);
    assert.ok(spec);
    assert.strictEqual(spec!.file, "osascript");
    // The user-derived strings appear as standalone argv entries...
    assert.ok(spec!.args.includes(BODY), "body should be its own argv entry");
    assert.ok(spec!.args.includes(TITLE), "title should be its own argv entry");
    // ...and the script fragments reference argv, not the text itself.
    const script = spec!.args.filter((a) => a !== BODY && a !== TITLE).join(" ");
    assert.ok(script.includes("item 1 of argv"));
    assert.ok(script.includes("item 2 of argv"));
    assert.ok(!script.includes("$(id)"), "no user text inside the script");
  });

  test("darwin with a bundle id prefers terminal-notifier, falls back to osascript", () => {
    const spec = systemNotifyCommand("darwin", TITLE, BODY, {
      bundleId: "com.microsoft.VSCode",
    });
    assert.ok(spec);
    assert.strictEqual(spec!.file, "terminal-notifier");
    // -sender fixes the banner icon, -activate makes a click raise the editor.
    assert.deepStrictEqual(spec!.args, [
      "-title",
      TITLE,
      "-message",
      BODY,
      "-sender",
      "com.microsoft.VSCode",
      "-activate",
      "com.microsoft.VSCode",
    ]);
    // Not installed (ENOENT) must still produce a banner.
    assert.strictEqual(spec!.fallback?.file, "osascript");
  });

  test("darwin uses the resolved notifier path, not the bare name", () => {
    // A GUI-launched editor has launchd's PATH — Homebrew is not on it.
    const spec = systemNotifyCommand("darwin", TITLE, BODY, {
      bundleId: "com.microsoft.VSCode",
      notifierPath: "/opt/homebrew/bin/terminal-notifier",
    });
    assert.strictEqual(spec!.file, "/opt/homebrew/bin/terminal-notifier");
  });

  test("darwin routes a click through -open when given a focus URI", () => {
    const uri = "vscode://pub.agent-quickpick/focus?session=Claude%20(2)";
    const spec = systemNotifyCommand("darwin", TITLE, BODY, {
      bundleId: "com.microsoft.VSCode",
      openUrl: uri,
    });
    assert.ok(spec!.args.includes("-open"));
    assert.strictEqual(spec!.args[spec!.args.indexOf("-open") + 1], uri);
    // -open supersedes -activate: focusing the terminal beats raising the app.
    assert.ok(!spec!.args.includes("-activate"));
  });

  test("darwin rejects an unsafe bundle id rather than splicing it", () => {
    const evil = 'com.x" to do shell script "id';
    assert.strictEqual(isSafeBundleId(evil), false);
    assert.strictEqual(isSafeBundleId("com.microsoft.VSCode-insiders"), true);
    const spec = systemNotifyCommand("darwin", TITLE, BODY, { bundleId: evil });
    assert.strictEqual(spec!.file, "osascript");
    assert.ok(
      !spec!.args.join(" ").includes("do shell script"),
      "unsafe id must not reach the script or argv"
    );
  });

  test("linux uses notify-send with argv", () => {
    const spec = systemNotifyCommand("linux", TITLE, BODY);
    assert.deepStrictEqual(spec, { file: "notify-send", args: [TITLE, BODY] });
  });

  test("win32 passes text via env, not the command line", () => {
    const spec = systemNotifyCommand("win32", TITLE, BODY);
    assert.ok(spec);
    assert.strictEqual(spec!.file, "powershell");
    assert.strictEqual(spec!.env?.AQP_NOTIFY_TITLE, TITLE);
    assert.strictEqual(spec!.env?.AQP_NOTIFY_BODY, BODY);
    const cmd = spec!.args.join(" ");
    assert.ok(!cmd.includes(BODY), "body must not reach the command line");
    assert.ok(cmd.includes("$env:AQP_NOTIFY_BODY"));
    assert.ok(cmd.includes("-NoProfile"));
  });

  test("unknown platform → null (toast + sound still fire)", () => {
    assert.strictEqual(systemNotifyCommand("aix", TITLE, BODY), null);
  });
});

suite("soundPlayCommand", () => {
  const P = "/Users/me/Agent Quickpick/media/sounds/notif.wav";

  test("darwin uses afplay with the path as argv", () => {
    assert.deepStrictEqual(soundPlayCommand("darwin", P), {
      file: "afplay",
      args: [P],
    });
  });

  test("linux falls back from paplay to aplay", () => {
    const spec = soundPlayCommand("linux", P);
    assert.strictEqual(spec!.file, "paplay");
    assert.strictEqual(spec!.fallback?.file, "aplay");
    assert.ok(spec!.fallback?.args.includes(P));
  });

  test("win32 passes the path via env (spaces would break the command line)", () => {
    const spec = soundPlayCommand("win32", P);
    assert.strictEqual(spec!.env?.AQP_SOUND_PATH, P);
    assert.ok(!spec!.args.join(" ").includes(P));
  });

  test("unknown platform → null", () => {
    assert.strictEqual(soundPlayCommand("aix", P), null);
  });
});
