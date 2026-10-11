/**
 * Launch-time status reporters: which launches get one, how the user's OpenCode
 * plugins survive the env override, and that every report the shipped reporters
 * emit is one our own OSC 7501 parser accepts.
 * Unit tier — no VS Code host needed.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  parseJsonc,
  reporterLaunch,
  shellQuote,
  type ReporterContext,
} from "../../agent-reporters";
import { parseProgramStatusBody } from "../../program-status";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const EXT = "/ext/agent-quickpick";
const HOME = "/home/me";
const CLAUDE_SETTINGS = `${EXT}/reporters/claude-settings.json`;
const OPENCODE_PLUGIN = `${EXT}/reporters/opencode`;
const CLI_JSON = `${HOME}/.config/opencode/cli.json`;

function ctx(files: Record<string, string> = {}, env: NodeJS.ProcessEnv = {}): ReporterContext {
  const all: Record<string, string> = {
    [CLAUDE_SETTINGS]: "{}",
    [`${OPENCODE_PLUGIN}/tui.js`]: "export default {}",
    ...files,
  };
  return {
    extensionPath: EXT,
    platform: "linux",
    env,
    homedir: HOME,
    readFile: (file) => all[file],
  };
}

function openCodePlugins(launch: ReturnType<typeof reporterLaunch>): unknown[] {
  const content = launch?.env?.OPENCODE_CLI_CONFIG_CONTENT;
  assert.ok(content, "expected OPENCODE_CLI_CONFIG_CONTENT");
  return (JSON.parse(content) as { plugins: unknown[] }).plugins;
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
  });
});

suite("reporterLaunch: OpenCode", () => {
  test("adds only our plugin when the user has no cli.json", () => {
    assert.deepStrictEqual(openCodePlugins(reporterLaunch("opencode", undefined, ctx())), [
      OPENCODE_PLUGIN,
    ]);
  });

  test("keeps the user's plugins, made absolute, ahead of ours", () => {
    const cli = `{
      // OpenCode's cli.json is JSONC
      "theme": { "name": "system" },
      "plugins": ["./herdr-opencode", ["../shared/p", { "x": 1 }], "npm-plugin@1", "/abs/p",],
    }`;
    assert.deepStrictEqual(
      openCodePlugins(reporterLaunch("opencode", undefined, ctx({ [CLI_JSON]: cli }))),
      [
        `${HOME}/.config/opencode/herdr-opencode`,
        [`${HOME}/.config/shared/p`, { x: 1 }],
        "npm-plugin@1",
        "/abs/p",
        OPENCODE_PLUGIN,
      ]
    );
  });

  test("honors OPENCODE_CONFIG_DIR when locating cli.json", () => {
    const env = { OPENCODE_CONFIG_DIR: "/cfg" };
    const launch = reporterLaunch(
      "opencode",
      undefined,
      ctx({ "/cfg/cli.json": '{"plugins":["./mine"]}' }, env)
    );
    assert.deepStrictEqual(openCodePlugins(launch), ["/cfg/mine", OPENCODE_PLUGIN]);
  });

  test("skips the reporter rather than drop plugins it can't read", () => {
    for (const cli of ["{ not json", '{"plugins": "oops"}', '{"plugins": [42]}', "[]"]) {
      assert.strictEqual(
        reporterLaunch("opencode", undefined, ctx({ [CLI_JSON]: cli })),
        undefined,
        cli
      );
    }
  });

  test("never overrides a user's own OPENCODE_CLI_CONFIG_CONTENT", () => {
    const env = { OPENCODE_CLI_CONFIG_CONTENT: '{"plugins":[]}' };
    assert.strictEqual(reporterLaunch("opencode", undefined, ctx({}, env)), undefined);
  });
});

suite("agent-reporters helpers", () => {
  test("parseJsonc strips comments and trailing commas, not string contents", () => {
    assert.deepStrictEqual(parseJsonc('{"a": "http://x//y", /* c */ "b": [1,],}'), {
      a: "http://x//y",
      b: [1],
    });
    assert.strictEqual(parseJsonc("[1]"), undefined);
    assert.strictEqual(parseJsonc(""), undefined);
  });

  test("shellQuote leaves plain paths bare and escapes quotes", () => {
    assert.strictEqual(shellQuote("/a/b.json"), "/a/b.json");
    assert.strictEqual(shellQuote("it's"), `'it'\\''s'`);
  });
});

suite("shipped Claude reporter settings", () => {
  const settings = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "reporters", "claude-settings.json"), "utf8")
  ) as { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };

  /** The OSC 7501 body a hook command prints, as `printf` would render it. */
  function reportBody(command: string): string {
    const match = /\\033\]7501;(.*?)\\033/.exec(command);
    assert.ok(match, `no OSC 7501 report in: ${command}`);
    return match[1];
  }

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

// ---------------------------------------------------------------------------
// The OpenCode TUI plugin, driven through a fake V2 plugin API
// ---------------------------------------------------------------------------

interface FakeSession {
  parentID?: string;
  running?: boolean;
}

/** Load the ESM plugin from CommonJS (tsc would rewrite a literal `import()`). */
const importEsm = new Function("p", "return import(p)") as (
  p: string
) => Promise<{ default: { setup(api: unknown): () => void } }>;

suite("shipped OpenCode reporter plugin", () => {
  let tty: string;
  let dispose: (() => void) | undefined;
  const previous = process.env.AQP_REPORTER_TTY;

  setup(() => {
    tty = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aqp-reporter-")), "tty");
    fs.writeFileSync(tty, "");
    process.env.AQP_REPORTER_TTY = tty;
  });

  teardown(() => {
    dispose?.();
    dispose = undefined;
    if (previous === undefined) delete process.env.AQP_REPORTER_TTY;
    else process.env.AQP_REPORTER_TTY = previous;
  });

  async function start(route: string | undefined, sessions: Record<string, FakeSession>) {
    const plugin = await importEsm(
      "file://" + path.join(REPO_ROOT, "reporters", "opencode", "tui.js")
    );
    let listener: ((e: { details: unknown }) => void) | undefined;
    const api = {
      data: {
        listen(cb: (e: { details: unknown }) => void) {
          listener = cb;
          return () => (listener = undefined);
        },
        session: {
          get: (id: string) => (sessions[id] ? { id, ...sessions[id] } : undefined),
          status: (id: string) => (sessions[id]?.running ? "running" : "idle"),
        },
      },
      ui: { router: { current: () => (route ? { type: "session", sessionID: route } : { type: "home" }) } },
    };
    dispose = plugin.default.setup(api);
    return (type: string, data: Record<string, unknown>) => listener?.({ details: { type, data } });
  }

  /** The reports written so far, as OSC 7501 bodies. */
  function reports(): string[] {
    const ESC = String.fromCharCode(0x1b);
    return fs
      .readFileSync(tty, "utf8")
      .split(`${ESC}\\`)
      .filter(Boolean)
      .map((seq) => seq.replace(`${ESC}]7501;`, ""));
  }

  test("reports a turn: working → blocked → working → done", async () => {
    const emit = await start("s1", { s1: {} });
    emit("session.execution.started", { sessionID: "s1" });
    emit("permission.asked", { sessionID: "s1", id: "p1" });
    emit("permission.replied", { sessionID: "s1", requestID: "p1" });
    emit("session.execution.succeeded", { sessionID: "s1" });
    assert.deepStrictEqual(reports(), [
      "state=idle:app=opencode",
      "state=working:app=opencode",
      "state=blocked:kind=permission:app=opencode",
      "state=working:app=opencode",
      "state=done:app=opencode",
    ]);
    for (const body of reports()) assert.ok(parseProgramStatusBody(body), body);
  });

  test("a subagent's question blocks the turn, but its finish doesn't end it", async () => {
    const emit = await start("root", { root: { running: true }, child: { parentID: "root" } });
    emit("form.created", { form: { sessionID: "child", id: "f1" } });
    emit("form.replied", { sessionID: "child", id: "f1" });
    emit("session.execution.succeeded", { sessionID: "child" });
    assert.deepStrictEqual(reports(), [
      "state=working:app=opencode",
      "state=blocked:kind=question:app=opencode",
      "state=working:app=opencode",
    ]);
  });

  test("ignores other sessions and the home screen", async () => {
    const emit = await start(undefined, { other: {} });
    emit("session.execution.started", { sessionID: "other" });
    emit("permission.asked", { sessionID: "other", id: "p" });
    assert.deepStrictEqual(reports(), []);
  });

  test("failure and interruption report error and idle", async () => {
    const emit = await start("s", { s: { running: true } });
    emit("session.execution.failed", { sessionID: "s" });
    emit("session.execution.started", { sessionID: "s" });
    emit("session.execution.interrupted", { sessionID: "s" });
    assert.deepStrictEqual(reports(), [
      "state=working:app=opencode",
      "state=error:app=opencode",
      "state=working:app=opencode",
      "state=idle:app=opencode",
    ]);
  });
});
