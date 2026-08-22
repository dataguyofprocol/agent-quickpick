/**
 * JSON config helpers shared by all adapters that write JSON config files.
 * Unit tier — no VS Code host needed.
 */

import * as assert from "assert";

import { readConfigJson, writeConfigJson } from "../../lifecycle";

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
