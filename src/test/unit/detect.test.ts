/**
 * Install detection (isCmdInstalled): PATH probing, safe-name gating, and the
 * 5-minute result cache. Unit tier — no VS Code host needed.
 */

import * as assert from "assert";

import {
  isCmdInstalled,
  isSafeBinaryName,
  _resetInstallCacheForTests,
  _poisonInstallCacheForTests,
} from "../../agents";

suite("isCmdInstalled", () => {
  setup(() => _resetInstallCacheForTests());
  teardown(() => _resetInstallCacheForTests());

  test("empty cmd → true (plain terminal)", async () => {
    assert.strictEqual(await isCmdInstalled(""), true);
    assert.strictEqual(await isCmdInstalled("   "), true);
  });

  test("a definitely-present binary → true", async () => {
    // `node` is running this test, so it must be on PATH.
    assert.strictEqual(await isCmdInstalled("node"), true);
  });

  test("a definitely-absent binary → false", async () => {
    assert.strictEqual(await isCmdInstalled("definitely-not-a-real-cli-xyz123"), false);
  });

  test("multi-word cmd checks only the first token", async () => {
    // `gh` itself may or may not be installed, but the check must not try to
    // resolve the literal string "gh copilot" as a binary name.
    const result = await isCmdInstalled("gh copilot");
    // Whatever the result, it should equal checking `gh` alone.
    assert.strictEqual(result, await isCmdInstalled("gh"));
  });

  test("unsafe binary names are rejected without hitting the shell", async () => {
    // Shell metacharacters → treat as not installed, never exec.
    assert.strictEqual(await isCmdInstalled('foo"; rm -rf /'), false);
    assert.strictEqual(await isCmdInstalled("foo && bar"), false);
    assert.strictEqual(await isCmdInstalled("foo$(evil)"), false);
    assert.strictEqual(await isCmdInstalled("foo | bar"), false);
  });

  test("caches results", async () => {
    // First call hits the shell.
    const first = await isCmdInstalled("node");
    // Second call should return from cache without re-running.
    const second = await isCmdInstalled("node");
    assert.strictEqual(first, second);
  });

  test("cached miss is honored within the TTL (no re-probe)", async () => {
    // Poison a fresh "not installed" entry and confirm the read path returns it.
    _poisonInstallCacheForTests("node", false, Date.now());
    assert.strictEqual(await isCmdInstalled("node"), false);
  });

  test("launcher probes the launcher binary, not the first token of cmd", async () => {
    // `node` is on PATH; the check should probe `node` regardless of `cmd`.
    const result = await isCmdInstalled("crush", "node");
    assert.strictEqual(result, true);
    // An absent launcher should report not installed even if `cmd` would be.
    const absent = await isCmdInstalled("crush", "definitely-not-a-real-cli-xyz123");
    assert.strictEqual(absent, false);
  });

  test("unsafe launcher names are rejected without hitting the shell", async () => {
    assert.strictEqual(await isCmdInstalled("crush", "uvx; rm -rf /"), false);
    assert.strictEqual(await isCmdInstalled("crush", "npx && evil"), false);
    assert.strictEqual(await isCmdInstalled("crush", "foo$(x)"), false);
  });

  test("cache entries expire after the TTL and get re-probed", async () => {
    // Poison with an old timestamp claiming `node` is NOT installed.
    _poisonInstallCacheForTests("node", false, Date.now() - 10 * 60 * 1000); // 10 min ago
    const stale = await isCmdInstalled("node");
    assert.strictEqual(stale, true, "expired cache entry should re-probe and find node");
    // Fresh entries are honored.
    _poisonInstallCacheForTests("node", true, Date.now());
    const fresh = await isCmdInstalled("node");
    assert.strictEqual(fresh, true);
  });
});

suite("isSafeBinaryName", () => {
  test("allows normal binary names", () => {
    assert.strictEqual(isSafeBinaryName("claude"), true);
    assert.strictEqual(isSafeBinaryName("claude-glm"), true);
    assert.strictEqual(isSafeBinaryName("my_tool"), true);
    assert.strictEqual(isSafeBinaryName("tool2"), true);
    assert.strictEqual(isSafeBinaryName("foo.bar"), true);
  });

  test("rejects shell metacharacters", () => {
    assert.strictEqual(isSafeBinaryName('foo"bar'), false);
    assert.strictEqual(isSafeBinaryName("foo;bar"), false);
    assert.strictEqual(isSafeBinaryName("foo && bar"), false);
    assert.strictEqual(isSafeBinaryName("foo$(x)"), false);
    assert.strictEqual(isSafeBinaryName("foo|bar"), false);
    assert.strictEqual(isSafeBinaryName("foo>bar"), false);
    assert.strictEqual(isSafeBinaryName("foo bar"), false); // space → multi-token
  });

  test("rejects empty", () => {
    assert.strictEqual(isSafeBinaryName(""), false);
  });

  test("rejects path separators (must be a bare binary name)", () => {
    assert.strictEqual(isSafeBinaryName("../evil"), false);
    assert.strictEqual(isSafeBinaryName("/bin/sh"), false);
    assert.strictEqual(isSafeBinaryName("a\\b"), false);
  });
});
