import * as assert from "assert";

import { OSC_PROGRESS_TTL_MS, TerminalSignals, TEXT_TAIL_LINES } from "../../terminal-signals";

const BEL = "\u0007";
const ST = "\u001b\\";
const b64 = (text: string) => Buffer.from(text).toString("base64");

suite("TerminalSignals: OSC 7501", () => {
  test("delegates reports to the protocol parser", () => {
    const signals = new TerminalSignals();
    signals.push(`\u001b]7501;state=blocked:kind=permission:msg=${b64("Approve?")}${ST}`, 1000);
    const snapshot = signals.snapshot();
    assert.strictEqual(snapshot?.status, "blocked");
    assert.strictEqual(snapshot?.kind, "permission");
    assert.strictEqual(snapshot?.msg, "Approve?");
    assert.strictEqual(signals.reportVersion(), 1);
  });

  test("a report split across chunks still lands", () => {
    const signals = new TerminalSignals();
    const sequence = `\u001b]7501;state=working${BEL}`;
    signals.push(sequence.slice(0, 6), 1000);
    assert.strictEqual(signals.snapshot(), undefined);
    signals.push(sequence.slice(6), 1000);
    assert.strictEqual(signals.snapshot()?.status, "working");
  });

  test("the report version only advances on a real report", () => {
    const signals = new TerminalSignals();
    signals.push("\u001b]2;title only\u0007", 1000);
    assert.strictEqual(signals.reportVersion(), 0);
    signals.push(`\u001b]7501;?${ST}`, 1000);
    assert.strictEqual(signals.reportVersion(), 0, "a query is not a report");
  });
});

suite("TerminalSignals: window title", () => {
  test("OSC 2 sets the title and OSC 0 also sets it", () => {
    const signals = new TerminalSignals();
    signals.push(`\u001b]2;⠹ claude${BEL}`, 1000);
    assert.strictEqual(signals.title(), "⠹ claude");
    signals.push(`\u001b]0; claude${ST}`, 1000);
    assert.strictEqual(signals.title(), " claude");
  });

  test("an empty payload clears the title", () => {
    const signals = new TerminalSignals();
    signals.push(`\u001b]2;busy${BEL}`, 1000);
    signals.push(`\u001b]2;${BEL}`, 1001);
    assert.strictEqual(signals.title(), undefined);
  });

  test("control characters are stripped and the title is capped", () => {
    const signals = new TerminalSignals();
    signals.push(`\u001b]2;a\u0001b\u0002c${BEL}`, 1000);
    assert.strictEqual(signals.title(), "abc");
    signals.push(`\u001b]2;${"x".repeat(400)}${BEL}`, 1001);
    assert.strictEqual(signals.title()?.length, 256);
  });

  test("a title split across chunks is reassembled, not dropped", () => {
    const signals = new TerminalSignals();
    signals.push("\u001b]2;⠹ cla", 1000);
    signals.push("ude\u0007", 1000);
    assert.strictEqual(signals.title(), "⠹ claude");
  });
});

suite("TerminalSignals: OSC 9 progress", () => {
  test("parses state and percentage, keeping the raw payload for rules", () => {
    const signals = new TerminalSignals();
    signals.push(`\u001b]9;4;1;40${BEL}`, 1000);
    const progress = signals.progress(1000);
    assert.strictEqual(progress?.state, 1);
    assert.strictEqual(progress?.percent, 40);
    assert.strictEqual(progress?.raw, "4;1;40");
  });

  test("an empty payload does not clear it (matching Herdr's capture)", () => {
    const signals = new TerminalSignals();
    signals.push(`\u001b]9;4;3;${BEL}`, 1000);
    signals.push(`\u001b]9;${BEL}`, 1100);
    assert.strictEqual(signals.progress(1100)?.raw, "4;3;");
  });

  test("progress expires, so a never-cleared report cannot pin a state", () => {
    const signals = new TerminalSignals();
    signals.push(`\u001b]9;4;3;${BEL}`, 1000);
    assert.ok(signals.progress(1000 + OSC_PROGRESS_TTL_MS - 1));
    assert.strictEqual(signals.progress(1000 + OSC_PROGRESS_TTL_MS + 1), undefined);
  });
});

suite("TerminalSignals: text tail", () => {
  test("keeps printable text and drops escape sequences", () => {
    const signals = new TerminalSignals();
    signals.push("\u001b[38;5;246mhello\u001b[0m world", 1000);
    assert.strictEqual(signals.text(), "hello world");
  });

  test("carriage return rewrites the current line (spinner repaints)", () => {
    const signals = new TerminalSignals();
    signals.push("⠹ Running...\r⠸ Running...", 1000);
    assert.strictEqual(signals.text(), "⠸ Running...");
  });

  test("ESC[K erases the current line; ESC[2J clears the view", () => {
    const signals = new TerminalSignals();
    signals.push("junk\u001b[Kkept", 1000);
    assert.strictEqual(signals.text(), "kept");
    signals.push("\nsecond\n\u001b[2J", 1001);
    assert.strictEqual(signals.text(), "");
  });

  test("newlines accumulate lines and the tail is bounded", () => {
    const signals = new TerminalSignals();
    signals.push(Array.from({ length: TEXT_TAIL_LINES + 10 }, (_, i) => `line ${i}`).join("\n"), 1000);
    const lines = signals.text().split("\n");
    assert.strictEqual(lines.length, TEXT_TAIL_LINES);
    assert.strictEqual(lines[lines.length - 1], `line ${TEXT_TAIL_LINES + 9}`);
    assert.ok(!signals.text().includes("line 0\n"));
  });

  test("bottom(n) only returns the last n lines", () => {
    const signals = new TerminalSignals();
    signals.push("one\ntwo\nthree", 1000);
    assert.strictEqual(signals.bottom(2), "two\nthree");
  });

  test("backspace deletes a character", () => {
    const signals = new TerminalSignals();
    signals.push("abc\u0008d", 1000);
    assert.strictEqual(signals.text(), "abd");
  });

  test("an escape split across chunks is not mistaken for text", () => {
    const signals = new TerminalSignals();
    signals.push("before\u001b[3", 1000);
    assert.strictEqual(signals.text(), "before");
    signals.push("8;5;9mafter\u001b[0m", 1001);
    assert.strictEqual(signals.text(), "beforeafter");
  });
});

suite("TerminalSignals: execution boundary", () => {
  test("a new command clears title, progress and text but keeps done/error records", () => {
    const signals = new TerminalSignals();
    signals.push(`\u001b]2;⠹ claude${BEL}`, 1000);
    signals.push(`\u001b]9;4;3;${BEL}`, 1000);
    signals.push("some output", 1000);
    signals.push(`\u001b]7501;state=done${ST}`, 1000);

    signals.startExecution();

    assert.strictEqual(signals.title(), undefined);
    assert.strictEqual(signals.progress(1000), undefined);
    assert.strictEqual(signals.text(), "");
    assert.strictEqual(signals.snapshot()?.status, "done", "done survives the next prompt");
  });

  test("a working record is dropped at the next command boundary", () => {
    const signals = new TerminalSignals();
    signals.push(`\u001b]7501;state=working${ST}`, 1000);
    signals.startExecution();
    assert.strictEqual(signals.snapshot()?.status, "unknown");
  });

  test("reset clears the protocol state too", () => {
    const signals = new TerminalSignals();
    signals.push(`\u001b]7501;state=done${ST}`, 1000);
    signals.reset();
    assert.strictEqual(signals.snapshot(), undefined);
  });
});
