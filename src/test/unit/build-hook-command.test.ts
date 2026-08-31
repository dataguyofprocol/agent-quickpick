/**
 * String-level contract for the generated `node -e` hook command.
 * (Behavioral execution tests live in hook-command.test.ts.)
 * Unit tier — no VS Code host needed.
 */

import * as assert from "assert";

import {
  buildNodeHookCommand,
  HOOK_SCHEMA_VERSION,
} from "../../lifecycle";

const HOOK_URL = "http://127.0.0.1:99999";
const SESSION = "Claude";
const PORT_FILE_PATH = "/home/user/.config/agent-quickpick/hook-server.json";

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

  test("escapes single quotes and backslashes in URL, port file path, and session", () => {
    const cmd = buildNodeHookCommand(
      "http://127.0.0.1:9999/path?x='\\",
      "Claude's (\\2)",
      "agentQuickpick:test",
      "finished",
      "/tmp/aqp'\\port.json"
    );
    // The payload is inside node -e "<script>"; verify dangerous characters are
    // escaped so the generated script remains structurally intact.
    assert.ok(cmd.includes("\\'"), "single quote in inputs should be escaped");
    assert.ok(cmd.includes("\\\\"), "backslash in inputs should be escaped");
  });

  test("arms a 2s timeout so a dead port can't hang the agent's hook", () => {
    const cmd = buildNodeHookCommand(HOOK_URL, SESSION, "agentQuickpick:test", "finished", PORT_FILE_PATH);
    assert.ok(
      cmd.includes("setTimeout(2000"),
      "hook command should arm a 2s socket timeout"
    );
  });

  test("forwards the stdin message (waiting-reason classification source)", () => {
    const cmd = buildNodeHookCommand(HOOK_URL, SESSION, "agentQuickpick:claude", "waiting", PORT_FILE_PATH);
    assert.ok(cmd.includes("message:j?.message||''"), "hook POST body should carry the stdin message");
  });
});

suite("buildNodeHookCommand report specs", () => {
  test("constant reason is baked into the POST body", () => {
    const cmd = buildNodeHookCommand(
      HOOK_URL, SESSION, "agentQuickpick:codex", "waiting", PORT_FILE_PATH,
      { reason: "permission" }
    );
    assert.ok(
      cmd.includes("reason:'permission'"),
      "constant reason should be embedded verbatim"
    );
  });

  test("no reason → reason:undefined (dropped by JSON.stringify)", () => {
    const cmd = buildNodeHookCommand(HOOK_URL, SESSION, "agentQuickpick:test", "finished", PORT_FILE_PATH);
    assert.ok(
      cmd.includes("reason:undefined"),
      "unset reason should serialize as undefined so the field is omitted"
    );
  });

  test("statusExpr overrides the positional status and is parenthesized", () => {
    const cmd = buildNodeHookCommand(
      HOOK_URL, SESSION, "agentQuickpick:antigravity", "finished", PORT_FILE_PATH,
      { statusExpr: "j?.x==='error'?'failed':'finished'" }
    );
    assert.ok(
      cmd.includes("status:(j?.x==='error'?'failed':'finished')"),
      "expression should be spliced in parenthesized"
    );
    assert.ok(
      !cmd.includes("status:'finished'"),
      "the constant must not also appear as the status"
    );
  });

  test("reasonExpr and constant reason are mutually exclusive (expr wins)", () => {
    const cmd = buildNodeHookCommand(
      HOOK_URL, SESSION, "agentQuickpick:test", "waiting", PORT_FILE_PATH,
      { reason: "question", reasonExpr: "j?.a?'permission':undefined" }
    );
    assert.ok(cmd.includes("reason:(j?.a?'permission':undefined)"));
    assert.ok(!cmd.includes("reason:'question'"));
  });

  test("cwdExpr replaces the default j?.cwd read and guards emptiness", () => {
    const cmd = buildNodeHookCommand(
      HOOK_URL, SESSION, "agentQuickpick:test", "running", PORT_FILE_PATH,
      { cwdExpr: "j?.workspacePaths?.[0]" }
    );
    assert.ok(
      cmd.includes("cwd:(j?.workspacePaths?.[0])||''"),
      "cwd expression should be parenthesized with an ||'' guard"
    );
    assert.ok(!cmd.includes("cwd:j?.cwd"), "the default cwd read must be replaced");
  });

  test("hostile expressions stay out of the escaping path (spec is our code, not user input)", () => {
    // The spec contract: expressions are compile-time constants from adapter
    // code. We can't defend against ourselves, but we pin that the builder
    // never *needs* to escape them — i.e. existing escapes (url/session/port)
    // still apply unchanged when a spec is present.
    const cmd = buildNodeHookCommand(
      "http://127.0.0.1:9999/path?x='\\",
      "Claude's (\\2)",
      "agentQuickpick:test",
      "waiting",
      "/tmp/aqp'\\port.json",
      { reason: "permission", statusExpr: "j?.x?'failed':'waiting'" }
    );
    assert.ok(cmd.includes("\\'"), "single quote escaping still applies");
    assert.ok(cmd.includes("\\\\"), "backslash escaping still applies");
    assert.doesNotThrow(() => JSON.parse(JSON.stringify({ command: cmd })));
  });
});
