/**
 * OSC 7501 — the Program Status Protocol. Parser conformance (including the
 * spec's "malformed optional key = absent, malformed state/id = discard" rule)
 * and the record-selection policy. Unit tier — no VS Code host needed.
 */

import * as assert from "assert";

import {
  OSC7501_MAX_RECORDS,
  ProgramStatusParser,
  parseProgramStatusBody,
} from "../../program-status";

const osc = (body: string, term = "\u001b\\") => `\u001b]7501;${body}${term}`;

/** Parse and assert the result is a record (not a query or a rejection). */
function record(body: string) {
  const parsed = parseProgramStatusBody(body);
  assert.ok(parsed !== undefined && parsed !== "query", `expected a record for "${body}"`);
  return parsed;
}
const b64 = (text: string) => Buffer.from(text).toString("base64");

suite("parseProgramStatusBody", () => {
  test("accepts each state and the documented optional keys", () => {
    assert.deepStrictEqual(parseProgramStatusBody("state=blocked:kind=permission"), {
      state: "blocked",
      kind: "permission",
    });
    assert.deepStrictEqual(
      parseProgramStatusBody(`state=done:app=claude-code:msg=${b64("Upgraded 12 packages")}`),
      { state: "done", app: "claude-code", msg: "Upgraded 12 packages" }
    );
    assert.deepStrictEqual(
      parseProgramStatusBody(`state=working:progress=40:title=${b64("US East")}`),
      { state: "working", progress: 40, title: "US East" }
    );
    for (const state of ["idle", "working", "done", "blocked", "error", "clear"]) {
      assert.strictEqual(record(`state=${state}`).state, state);
    }
  });

  test("a malformed optional key is absent, never fatal (spec §Syntax)", () => {
    // `kind` is only meaningful with `blocked`, and an unknown kind is ignored
    // rather than discarding the report — otherwise a later revision adding a
    // kind would silently break every agent that used it.
    assert.deepStrictEqual(parseProgramStatusBody("state=working:kind=auth"), { state: "working" });
    assert.deepStrictEqual(parseProgramStatusBody("state=blocked:kind=telepathy"), {
      state: "blocked",
    });
    assert.deepStrictEqual(parseProgramStatusBody("state=working:progress=101"), { state: "working" });
    assert.deepStrictEqual(parseProgramStatusBody("state=working:progress=-1"), { state: "working" });
    assert.deepStrictEqual(parseProgramStatusBody("state=done:progress=40"), { state: "done" });
    assert.deepStrictEqual(parseProgramStatusBody("state=done:app=has spaces"), { state: "done" });
  });

  test("skips a malformed pair and still processes the rest", () => {
    assert.deepStrictEqual(parseProgramStatusBody("nonsense:state=done:oops"), { state: "done" });
    assert.deepStrictEqual(parseProgramStatusBody("=x:state=done"), { state: "done" });
    assert.deepStrictEqual(parseProgramStatusBody("state=done:9bad=1"), { state: "done" });
  });

  test("a repeated key keeps the last value", () => {
    assert.deepStrictEqual(parseProgramStatusBody("state=working:state=done"), { state: "done" });
  });

  test("whitespace around keys and values is removed", () => {
    assert.deepStrictEqual(parseProgramStatusBody(" state = done "), { state: "done" });
  });

  test("discards the whole report on an unknown or absent state", () => {
    assert.strictEqual(parseProgramStatusBody("state=waiting"), undefined);
    assert.strictEqual(parseProgramStatusBody("state=failed"), undefined);
    assert.strictEqual(parseProgramStatusBody("app=brew"), undefined);
    assert.strictEqual(parseProgramStatusBody(""), undefined);
  });

  test("discards a report whose id breaks the grammar", () => {
    // A value outside the pair charset makes the *pair* malformed, so it is
    // skipped and the report is still valid — only an id that parses as a pair
    // but breaks the id grammar may discard the report.
    assert.deepStrictEqual(parseProgramStatusBody("state=done:id=has space"), { state: "done" });
    assert.strictEqual(parseProgramStatusBody("state=done:id=a//b"), undefined);
    assert.strictEqual(parseProgramStatusBody("state=done:id=nine/deep/levels/x/y/z/8/9/10"), undefined);
    assert.strictEqual(parseProgramStatusBody(`state=done:id=${"a".repeat(33)}`), undefined);
    assert.strictEqual(parseProgramStatusBody("state=done:id="), undefined);
    // A legal id round-trips.
    assert.strictEqual(record("state=done:id=build/test").id, "build/test");
  });

  test("discards a report with undecodable or control-character text", () => {
    assert.strictEqual(parseProgramStatusBody(`state=done:msg=${b64("two\nlines")}`), undefined);
    assert.strictEqual(parseProgramStatusBody(`state=done:msg=${b64("bell\u0007")}`), undefined);
    // `////` is in the value charset but is not valid UTF-8.
    assert.strictEqual(parseProgramStatusBody("state=done:msg=////"), undefined);
    assert.strictEqual(parseProgramStatusBody("state=done:title=//"), undefined);
  });

  test("enforces the size caps", () => {
    assert.strictEqual(parseProgramStatusBody(`state=done:title=${"A".repeat(257)}`), undefined);
    assert.ok(parseProgramStatusBody(`state=done:msg=${b64("x".repeat(2048))}`));
    assert.strictEqual(parseProgramStatusBody(`state=done:msg=${b64("x".repeat(2049))}`), undefined);
    assert.strictEqual(parseProgramStatusBody(`state=done:${"a".repeat(5000)}`), undefined);
  });

  test("recognizes feature detection but never as a state update", () => {
    assert.strictEqual(parseProgramStatusBody("?"), "query");
    assert.strictEqual(parseProgramStatusBody("?:states=idle"), undefined);
  });
});

suite("ProgramStatusParser", () => {
  test("parses fragmented BEL- and ST-terminated sequences", () => {
    const parser = new ProgramStatusParser();
    const sequence = osc("state=working", "\u0007");
    assert.strictEqual(parser.push(sequence.slice(0, 5)), undefined);
    assert.strictEqual(parser.push(sequence.slice(5))?.status, "working");
    assert.strictEqual(parser.push(osc("state=blocked:kind=question"))?.kind, "question");
  });

  test("returns a snapshot only when a record changes", () => {
    const parser = new ProgramStatusParser();
    assert.ok(parser.push(osc("state=working")), "a report yields a snapshot");
    assert.strictEqual(parser.push("plain output with no protocol traffic"), undefined);
    assert.strictEqual(parser.push(osc("?")), undefined);
  });

  test("a query never updates state", () => {
    const parser = new ProgramStatusParser();
    assert.strictEqual(parser.push(osc("?")), undefined);
    assert.strictEqual(parser.snapshot().reported, false);
  });

  test("carries app down from an ancestor record", () => {
    const parser = new ProgramStatusParser();
    parser.push(osc("state=working:app=deploy"));
    const snapshot = parser.push(osc("state=blocked:kind=permission:id=eu-west"));
    assert.strictEqual(snapshot?.status, "blocked");
    assert.strictEqual(snapshot?.app, "deploy");
  });

  test("clear removes the addressed record and its descendants", () => {
    const parser = new ProgramStatusParser();
    parser.push(osc("state=working:id=task"));
    assert.strictEqual(parser.push(osc("state=blocked:id=task/approval"))?.status, "blocked");
    assert.strictEqual(parser.push(osc("state=clear:id=task/approval"))?.status, "working");
    assert.strictEqual(parser.push(osc("state=clear:id=task"))?.status, "unknown");
  });

  test("clear with no id removes every record", () => {
    const parser = new ProgramStatusParser();
    parser.push(osc("state=working:id=a"));
    parser.push(osc("state=blocked:id=b"));
    const snapshot = parser.push(osc("state=clear"));
    assert.strictEqual(snapshot?.status, "unknown");
    assert.strictEqual(snapshot?.records.size, 0);
  });

  suite("record selection", () => {
    test("attention wins over the root, and the root wins ties", () => {
      const parser = new ProgramStatusParser();
      parser.push(osc("state=working"));
      assert.strictEqual(
        parser.push(osc("state=blocked:kind=permission:id=eu-west"))?.status,
        "blocked",
        "a blocked sub-task is what the user must act on"
      );
      parser.push(osc("state=error:id=us-east"));
      assert.strictEqual(parser.snapshot().status, "blocked", "blocked outranks error");
    });

    test("a done root is not masked by a stale working child", () => {
      const parser = new ProgramStatusParser();
      parser.push(osc("state=done"));
      assert.strictEqual(parser.push(osc("state=working:id=sub"))?.status, "done");
    });

    test("with no root, the most informative child is shown", () => {
      const parser = new ProgramStatusParser();
      parser.push(osc("state=idle:id=a"));
      assert.strictEqual(parser.push(osc("state=working:id=b"))?.status, "working");
      assert.strictEqual(parser.push(osc("state=done:id=b"))?.status, "done");
    });
  });

  test("caps the record set, evicting the least recently updated", () => {
    const parser = new ProgramStatusParser();
    for (let i = 0; i < OSC7501_MAX_RECORDS + 8; i++) {
      parser.push(osc(`state=working:id=task${i}`));
    }
    const records = parser.snapshot().records;
    assert.ok(records.size <= OSC7501_MAX_RECORDS, `kept ${records.size}`);
    // The newest survive; the oldest are gone.
    assert.ok(records.has(`task${OSC7501_MAX_RECORDS + 7}`));
    assert.ok(!records.has("task0"));
  });

  test("an oversized unterminated sequence cannot wedge the parser", () => {
    const parser = new ProgramStatusParser();
    parser.push(`\u001b]7501;${"A".repeat(9000)}`);
    assert.strictEqual(parser.push(osc("state=done"))?.status, "done");
  });

  test("surfaces the protocol's progress in the snapshot", () => {
    const parser = new ProgramStatusParser();
    assert.strictEqual(parser.push(osc("state=working:progress=42"))?.progress, 42);
  });
});
