import * as assert from "assert";

import {
  OSC7501_MAX_RECORDS,
  ProgramStatusParser,
  detectHeuristicStatus,
  parseProgramStatusBody,
} from "../../lifecycle";

const osc = (body: string, term = "\u001b\\") => `\u001b]7501;${body}${term}`;
const b64 = (text: string) => Buffer.from(text).toString("base64");

suite("OSC 7501 status parsing", () => {
  test("accepts canonical statuses and bounded metadata", () => {
    assert.deepStrictEqual(parseProgramStatusBody("state=blocked:kind=permission"), {
      state: "blocked", kind: "permission",
    });
    assert.deepStrictEqual(parseProgramStatusBody(`state=done:msg=${b64("Ready")}`), {
      state: "done", msg: "Ready",
    });
    assert.strictEqual(parseProgramStatusBody("state=waiting"), undefined);
  });

  test("rejects invalid state, metadata and control-character text", () => {
    assert.strictEqual(parseProgramStatusBody("state=failed"), undefined);
    assert.strictEqual(parseProgramStatusBody("state=working:kind=auth"), undefined);
    assert.strictEqual(parseProgramStatusBody(`state=done:msg=${b64("bad\ntext")}`), undefined);
    assert.strictEqual(parseProgramStatusBody(`state=done:title=${"A".repeat(300)}`), undefined);
  });

  test("recognizes query but never treats it as a state update", () => {
    assert.strictEqual(parseProgramStatusBody("?"), "query");
    const parser = new ProgramStatusParser();
    assert.strictEqual(parser.push(osc("?")), undefined);
  });

  test("parses fragmented BEL and ST terminated sequences", () => {
    const parser = new ProgramStatusParser();
    const sequence = osc("state=working", "\u0007");
    assert.strictEqual(parser.push(sequence.slice(0, 5)), undefined);
    assert.strictEqual(parser.push(sequence.slice(5))?.status, "working");
    assert.strictEqual(parser.push(osc("state=blocked:kind=question"))?.kind, "question");
  });

  test("handles multiple records, priority, scoped clear and global clear", () => {
    const parser = new ProgramStatusParser();
    parser.push(osc("state=working:id=task"));
    assert.strictEqual(parser.push(osc("state=blocked:id=task/approval"))?.status, "blocked");
    assert.strictEqual(parser.push(osc("state=clear:id=task/approval"))?.status, "working");
    assert.strictEqual(parser.push(osc("state=clear"))?.status, "unknown");
  });

  test("caps records and oversized incomplete sequence memory", () => {
    const parser = new ProgramStatusParser();
    for (let i = 0; i < OSC7501_MAX_RECORDS + 8; i++) parser.push(osc(`state=working:id=task${i}`));
    assert.ok(parser.snapshot().records.size <= OSC7501_MAX_RECORDS);
    parser.push(`\u001b]7501;${"A".repeat(9000)}`);
    assert.ok(parser.push(osc("state=done"))?.status === "done");
  });
});

suite("conservative terminal heuristics", () => {
  test("detects known permission prompts but not generic prose", () => {
    assert.deepStrictEqual(detectHeuristicStatus("Claude", "Do you want to proceed?"), {
      status: "blocked", reason: "permission",
    });
    assert.strictEqual(detectHeuristicStatus("Claude", "The docs say do you want to proceed?"), undefined);
    assert.strictEqual(detectHeuristicStatus("Other", "Do you want to proceed?"), undefined);
  });

  test("recognizes active and prompt states by agent family", () => {
    assert.strictEqual(detectHeuristicStatus("Codex", "(12s • esc to interrupt)")?.status, "working");
    assert.strictEqual(detectHeuristicStatus("Claude", "❯\n")?.status, "idle");
    assert.strictEqual(detectHeuristicStatus("OpenCode", "Esc to interrupt")?.status, "working");
  });

  test("does not infer success or errors from ordinary text", () => {
    assert.strictEqual(detectHeuristicStatus("Codex", "Task completed successfully"), undefined);
    assert.strictEqual(detectHeuristicStatus("Claude", "error: could not find file"), undefined);
    assert.strictEqual(detectHeuristicStatus("OpenCode", "Press enter to continue"), undefined);
  });
});
