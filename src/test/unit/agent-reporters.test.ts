import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

import {
  reporterLaunch,
  shellQuote,
  type ReporterContext,
} from "../../agent-reporters";
import { parseProgramStatusBody } from "../../program-status";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const EXT = "/ext/agent-quickpick";
const CLAUDE_SETTINGS = `${EXT}/reporters/claude-settings.json`;

function ctx(files: Record<string, string> = {}): ReporterContext {
  const all: Record<string, string> = {
    [CLAUDE_SETTINGS]: "{}",
    ...files,
  };
  return {
    extensionPath: EXT,
    platform: "linux",
    readFile: (file) => all[file],
  };
}

suite("reporterLaunch: Claude Code", () => {
  test("appends --settings pointing at the shipped reporter", () => {
    assert.deepStrictEqual(reporterLaunch("claude", undefined, ctx()), {
      args: ` --settings ${CLAUDE_SETTINGS}`,
    });
    assert.ok(reporterLaunch("claude --model opus", undefined, ctx())?.args);
    assert.ok(reporterLaunch("/usr/local/bin/claude", undefined, ctx())?.args);
  });

  test("quotes an install path with spaces", () => {
    const spaced = { ...ctx(), extensionPath: "/Users/me/Library/Application Support/x" };
    spaced.readFile = () => "{}";
    assert.strictEqual(
      reporterLaunch("claude", undefined, spaced)?.args,
      " --settings '/Users/me/Library/Application Support/x/reporters/claude-settings.json'"
    );
  });

  test("leaves launches it can't safely change alone", () => {
    assert.strictEqual(reporterLaunch("claude --settings mine.json", undefined, ctx()), undefined);
    assert.strictEqual(reporterLaunch("claude --settings=mine.json", undefined, ctx()), undefined);
    assert.strictEqual(reporterLaunch("claudeproxy", undefined, ctx()), undefined);
    assert.strictEqual(reporterLaunch("claude", "npx", ctx()), undefined);
    assert.strictEqual(reporterLaunch("claude", undefined, { ...ctx(), platform: "win32" }), undefined);
    assert.strictEqual(
      reporterLaunch("claude", undefined, { ...ctx(), readFile: () => undefined }),
      undefined
    );
    assert.strictEqual(reporterLaunch("codex", undefined, ctx()), undefined);
    assert.strictEqual(reporterLaunch("opencode", undefined, ctx()), undefined);
  });
});

suite("agent-reporters helpers", () => {
  test("shellQuote leaves plain paths bare and escapes quotes", () => {
    assert.strictEqual(shellQuote("/a/b.json"), "/a/b.json");
    assert.strictEqual(shellQuote("it's"), `'it'\\''s'`);
  });
});

suite("shipped Claude reporter settings", () => {
  const settings = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "reporters", "claude-settings.json"), "utf8")
  ) as { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };

  function reportBody(command: string): string {
    const match = /\\033\]7501;(.*?)\\033/.exec(command);
    assert.ok(match, `no OSC 7501 report in: ${command}`);
    return match[1];
  }

  test("the checked-in file is byte-identical to what the build script generates", () => {
    const { buildClaudeSettings } = require(path.join(
      REPO_ROOT,
      "scripts",
      "build-claude-reporter-settings.js"
    )) as { buildClaudeSettings: () => string };
    assert.strictEqual(
      fs.readFileSync(path.join(REPO_ROOT, "reporters", "claude-settings.json"), "utf8"),
      buildClaudeSettings()
    );
  });

  test("every hook emits a report our parser accepts", () => {
    for (const [event, entries] of Object.entries(settings.hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          const parsed = parseProgramStatusBody(reportBody(hook.command));
          assert.ok(parsed && parsed !== "query", `${event}: unparseable report`);
          assert.strictEqual(parsed.app, "claude", `${event}: app`);
        }
      }
    }
  });

  test("the turn-level events map to the states notifications depend on", () => {
    const state = (event: string) =>
      parseProgramStatusBody(reportBody(settings.hooks[event][0].hooks[0].command));
    assert.deepStrictEqual(state("UserPromptSubmit"), { state: "working", app: "claude" });
    assert.deepStrictEqual(state("PermissionRequest"), {
      state: "blocked",
      kind: "permission",
      app: "claude",
    });
    assert.deepStrictEqual(state("Stop"), { state: "done", app: "claude" });
    assert.deepStrictEqual(state("StopFailure"), { state: "error", app: "claude" });
  });

  test("hooks never fail the agent's turn", () => {
    for (const entries of Object.values(settings.hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) assert.match(hook.command, /exit 0$/);
      }
    }
  });
});
