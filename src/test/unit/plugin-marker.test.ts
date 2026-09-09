/**
 * The plugin-file marker guard: we write and delete files in dirs shared with
 * the user and with other tools (pi's `extensions/` in particular is where
 * herdr, cmux, and orca all install their own integrations), so a file at our
 * path that isn't ours must never be clobbered or removed.
 * Unit tier — no VS Code host needed.
 */

import * as assert from "assert";

import { shouldWritePluginFile, shouldRemovePluginFile } from "../../lifecycle";
import { LIFECYCLE_ADAPTERS } from "../../lifecycle-adapters";

const MARKER = "agentQuickpick:pi";
const OURS = `// @ts-nocheck\n// ${MARKER}\nexport default function () {}\n`;
const THEIRS = "// installed by herdr\nexport default function () {}\n";

suite("plugin-file marker guard", () => {
  test("absent file → fresh install", () => {
    assert.strictEqual(shouldWritePluginFile(undefined, MARKER), true);
    assert.strictEqual(shouldRemovePluginFile(undefined, MARKER), false);
  });

  test("our own file → regenerate, and remove on request", () => {
    assert.strictEqual(shouldWritePluginFile(OURS, MARKER), true);
    assert.strictEqual(shouldRemovePluginFile(OURS, MARKER), true);
  });

  test("someone else's file → never written, never deleted", () => {
    assert.strictEqual(shouldWritePluginFile(THEIRS, MARKER), false);
    assert.strictEqual(shouldRemovePluginFile(THEIRS, MARKER), false);
  });

  test("an empty file is foreign, not ours", () => {
    // A truncated write of ours is indistinguishable from a user's stub, and
    // refusing is the safe direction: the toast tells them to delete it.
    assert.strictEqual(shouldWritePluginFile("", MARKER), false);
    assert.strictEqual(shouldRemovePluginFile("", MARKER), false);
  });

  test("another adapter's marker doesn't authorize ours", () => {
    const opencode = `// agentQuickpick:opencode\n`;
    assert.strictEqual(shouldWritePluginFile(opencode, MARKER), false);
    assert.strictEqual(shouldRemovePluginFile(opencode, MARKER), false);
  });

  test("every plugin-file adapter's generated source is self-recognizing", () => {
    // Without this, install would refuse to upgrade its own previous output.
    for (const adapter of Object.values(LIFECYCLE_ADAPTERS)) {
      if (adapter.kind !== "plugin-file") continue;
      const src = adapter.buildSource("http://127.0.0.1:1/hook", "", "/tmp/port.json");
      assert.ok(
        shouldWritePluginFile(src, adapter.marker),
        `${adapter.agentName} would refuse to overwrite its own file`
      );
      assert.ok(
        shouldRemovePluginFile(src, adapter.marker),
        `${adapter.agentName} would refuse to remove its own file`
      );
    }
  });
});
