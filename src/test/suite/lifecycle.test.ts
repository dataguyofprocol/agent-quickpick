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
  STATUS_LABEL,
  shouldNotify,
  notificationMessage,
  buildNodeHookCommand,
  mergeCommandHooks,
  stripCommandHooks,
  hasCommandHooks,
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
  const installed = adapter.mergeHooks(initial, HOOK_URL, SESSION);
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
    const once = adapter.mergeHooks({}, HOOK_URL, SESSION);
    const twice = adapter.mergeHooks(once, HOOK_URL, SESSION);
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(twice)),
      JSON.parse(JSON.stringify(once))
    );
  });

  test("remove is idempotent (strip twice === strip once)", () => {
    const installed = adapter.mergeHooks({}, HOOK_URL, SESSION);
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
    const installed = adapter.mergeHooks(config, HOOK_URL, SESSION);
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
    const installed = adapter.mergeHooks({}, HOOK_URL, SESSION) as Record<string, unknown>;
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
    const once = adapter.mergeHooks({}, HOOK_URL, SESSION);
    const twice = adapter.mergeHooks(once, HOOK_URL, SESSION);
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(twice)),
      JSON.parse(JSON.stringify(once))
    );
  });
});

suite("command-hook merge produces correct schema", () => {
  test("Claude merge adds Stop + Notification + UserPromptSubmit hooks", () => {
    const result = CLAUDE_ADAPTER.mergeHooks({}, HOOK_URL, SESSION) as Record<
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
    const result = CLAUDE_ADAPTER.mergeHooks({}, HOOK_URL, SESSION);
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
    const cmd = buildNodeHookCommand(HOOK_URL, SESSION, "agentQuickpick:test", "finished");
    assert.ok(typeof cmd === "string" && cmd.length > 0);
  });

  test("starts with node -e", () => {
    const cmd = buildNodeHookCommand(HOOK_URL, SESSION, "agentQuickpick:test", "finished");
    assert.ok(cmd.startsWith("node -e"), `should start with "node -e", got: ${cmd.slice(0, 20)}`);
  });

  test("contains the hook URL", () => {
    const cmd = buildNodeHookCommand(HOOK_URL, SESSION, "agentQuickpick:test", "finished");
    assert.ok(cmd.includes("127.0.0.1"), "should contain the server host");
  });

  test("contains the marker", () => {
    const cmd = buildNodeHookCommand(HOOK_URL, SESSION, "agentQuickpick:test", "finished");
    assert.ok(cmd.includes("agentQuickpick:test"), "should contain the marker");
  });

  test("is embeddable as a JSON string value (parses without error)", () => {
    const cmd = buildNodeHookCommand(HOOK_URL, SESSION, "agentQuickpick:test", "finished");
    // Wrap it in a JSON object to simulate being inside settings.json.
    const wrapped = JSON.stringify({ command: cmd });
    assert.doesNotThrow(() => JSON.parse(wrapped));
  });
});

// ---------------------------------------------------------------------------
// Shared command-hook helpers (mergeCommandHooks / stripCommandHooks / hasCommandHooks)
// ---------------------------------------------------------------------------

suite("mergeCommandHooks / stripCommandHooks", () => {
  const events = ["Stop", "Notification"];
  const marker = "agentQuickpick:test";

  test("install → remove round-trip on empty", () => {
    const installed = mergeCommandHooks({}, events, HOOK_URL, SESSION, marker);
    assert.ok(hasCommandHooks(installed, marker));
    const removed = stripCommandHooks(installed, marker);
    assert.ok(!hasCommandHooks(removed, marker));
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(removed)),
      {}
    );
  });

  test("prunes empty hooks section after removal", () => {
    const installed = mergeCommandHooks({}, events, HOOK_URL, SESSION, marker);
    const removed = stripCommandHooks(installed, marker) as Record<string, unknown>;
    assert.ok(!("hooks" in removed), "empty hooks section should be pruned");
  });

  test("preserves user hooks when stripping ours", () => {
    const userHooks = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "user-cmd" }] }],
      },
    };
    const installed = mergeCommandHooks(userHooks, events, HOOK_URL, SESSION, marker);
    const removed = stripCommandHooks(installed, marker) as Record<
      string,
      Record<string, { hooks: { command: string }[] }[]>
    >;
    const stopCmds = removed.hooks.Stop.flatMap((e) => e.hooks.map((h) => h.command));
    assert.ok(stopCmds.includes("user-cmd"), "user command should survive");
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
    const src = adapter.buildSource(HOOK_URL, SESSION);
    assert.ok(src.includes("127.0.0.1"), "should embed the server URL");
    assert.ok(src.includes("agentQuickpick:opencode"), "should contain the marker");
    assert.ok(src.includes("AQP_SESSION"), "should guard on the injected session env");
  });
});

suite("buildOpenCodePluginSource", () => {
  test("produces ESM with the marker comment", () => {
    const src = buildOpenCodePluginSource(HOOK_URL, SESSION);
    assert.ok(src.includes("agentQuickpick:opencode"), "should contain marker");
  });

  test("exports the plugin factory", () => {
    const src = buildOpenCodePluginSource(HOOK_URL, SESSION);
    assert.ok(
      src.includes("AgentQuickpickLifecyclePlugin"),
      "should export the plugin name"
    );
  });

  test("maps lifecycle events to statuses", () => {
    const src = buildOpenCodePluginSource(HOOK_URL, SESSION);
    assert.ok(src.includes("session.idle"), "should handle session.idle");
    assert.ok(src.includes("permission.asked"), "should handle permission.asked");
    assert.ok(src.includes("question.asked"), "should handle question.asked");
    assert.ok(src.includes("session.error"), "should handle session.error");
  });

  test("embeds the hook URL", () => {
    const src = buildOpenCodePluginSource(HOOK_URL, SESSION);
    assert.ok(src.includes("127.0.0.1"), "should embed the server URL");
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
  changedAt = Date.now()
): SessionState {
  return { name, agentName, status, changedAt };
}

suite("countByStatus", () => {
  test("empty → all zero", () => {
    const counts = countByStatus([]);
    assert.strictEqual(counts.running, 0);
    assert.strictEqual(counts.finished, 0);
    assert.strictEqual(counts.waiting, 0);
    assert.strictEqual(counts.failed, 0);
  });

  test("mixed statuses tallied correctly", () => {
    const counts = countByStatus([
      makeState("Claude", "Claude", "running"),
      makeState("Codex", "Codex", "running"),
      makeState("Aider", "Aider", "finished"),
      makeState("Gemini", "Gemini", "waiting"),
      makeState("Droid", "Droid", "failed"),
    ]);
    assert.strictEqual(counts.running, 2);
    assert.strictEqual(counts.finished, 1);
    assert.strictEqual(counts.waiting, 1);
    assert.strictEqual(counts.failed, 1);
  });
});

suite("statusBarText", () => {
  test("all-zero → static default", () => {
    assert.strictEqual(
      statusBarText({ running: 0, finished: 0, waiting: 0, failed: 0 }),
      "$(agent-quickpick) Agent"
    );
  });

  test("running only → count with ●", () => {
    assert.strictEqual(
      statusBarText({ running: 2, finished: 0, waiting: 0, failed: 0 }),
      "$(agent-quickpick) 2●"
    );
  });

  test("mixed → all non-zero groups", () => {
    assert.strictEqual(
      statusBarText({ running: 1, finished: 1, waiting: 1, failed: 1 }),
      "$(agent-quickpick) 1● 1✓ 1⏸ 1✗"
    );
  });

  test("finished only → ✓", () => {
    assert.strictEqual(
      statusBarText({ running: 0, finished: 3, waiting: 0, failed: 0 }),
      "$(agent-quickpick) 3✓"
    );
  });

  test("waiting only → ⏸", () => {
    assert.strictEqual(
      statusBarText({ running: 0, finished: 0, waiting: 1, failed: 0 }),
      "$(agent-quickpick) 1⏸"
    );
  });
});

suite("STATUS_LABEL", () => {
  test("maps each status to Herdr vocabulary", () => {
    assert.strictEqual(STATUS_LABEL.running, "working");
    assert.strictEqual(STATUS_LABEL.finished, "done");
    assert.strictEqual(STATUS_LABEL.waiting, "blocked");
    assert.strictEqual(STATUS_LABEL.failed, "failed");
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
    const result = CLAUDE_ADAPTER.mergeHooks({}, HOOK_URL, SESSION) as Record<
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
    const result = DROID_ADAPTER.mergeHooks({}, HOOK_URL, SESSION) as Record<
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
    const cmd = buildNodeHookCommand(HOOK_URL, SESSION, "agentQuickpick:test", "finished");
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
    const src = buildOpenCodePluginSource(HOOK_URL, SESSION);
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
    const src = buildOpenCodePluginSource(HOOK_URL, SESSION);
    assert.ok(src.includes("setTimeout(2000"), "plugin should arm a 2s socket timeout");
  });
});
