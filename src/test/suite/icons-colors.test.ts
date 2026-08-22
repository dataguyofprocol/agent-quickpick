/**
 * Icon + color resolution — the one piece of agent resolution that constructs
 * runtime vscode objects (ThemeIcon / ThemeColor / Uri), so it runs in the
 * VS Code host tier.
 */

import * as assert from "assert";
import * as vscode from "vscode";
import * as path from "path";

import { resolveIconPath, resolveColor } from "../../extension";
import { BUILTIN_AGENTS, ALLOWED_COLORS } from "../../agents";

const EXTENSION_URI = vscode.Uri.file(path.resolve(__dirname, "../../.."));

suite("resolveIconPath", () => {
  test("empty → ThemeIcon terminal", () => {
    const icon = resolveIconPath(undefined, EXTENSION_URI);
    assert.ok(icon instanceof vscode.ThemeIcon);
    assert.strictEqual((icon as vscode.ThemeIcon).id, "terminal");
  });

  test('"terminal" → ThemeIcon terminal', () => {
    const icon = resolveIconPath("terminal", EXTENSION_URI);
    assert.ok(icon instanceof vscode.ThemeIcon);
    assert.strictEqual((icon as vscode.ThemeIcon).id, "terminal");
  });

  test("absolute path that exists → Uri.file", () => {
    // Use a file we know exists: one of the bundled icons.
    const abs = path.join(EXTENSION_URI.fsPath, "icons", "claude.svg");
    const icon = resolveIconPath(abs, EXTENSION_URI);
    assert.ok(icon instanceof vscode.Uri);
  });

  test("absolute path that does NOT exist → ThemeIcon terminal (fallback)", () => {
    const abs = process.platform === "win32"
      ? "C:\\definitely\\does\\not\\exist.svg"
      : "/definitely/does/not/exist.svg";
    const icon = resolveIconPath(abs, EXTENSION_URI);
    assert.ok(icon instanceof vscode.ThemeIcon, "expected fallback to ThemeIcon");
    assert.strictEqual((icon as vscode.ThemeIcon).id, "terminal");
  });

  test("codicon id → ThemeIcon", () => {
    const icon = resolveIconPath("rocket", EXTENSION_URI);
    assert.ok(icon instanceof vscode.ThemeIcon);
    assert.strictEqual((icon as vscode.ThemeIcon).id, "rocket");
  });

  test("codicon id is lowercased", () => {
    const icon = resolveIconPath("Rocket", EXTENSION_URI);
    assert.ok(icon instanceof vscode.ThemeIcon);
    assert.strictEqual((icon as vscode.ThemeIcon).id, "rocket");
  });

  test("bundled filename that exists → Uri to icons folder", () => {
    const icon = resolveIconPath("claude.svg", EXTENSION_URI);
    assert.ok(icon instanceof vscode.Uri);
    assert.ok((icon as vscode.Uri).fsPath.includes("icons"));
    assert.ok((icon as vscode.Uri).fsPath.includes("claude.svg"));
  });

  test("bundled filename that does NOT exist → ThemeIcon terminal (fallback)", () => {
    const icon = resolveIconPath("definitely-not-a-real-icon.svg", EXTENSION_URI);
    assert.ok(icon instanceof vscode.ThemeIcon, "expected fallback to ThemeIcon");
    assert.strictEqual((icon as vscode.ThemeIcon).id, "terminal");
  });

  test("non-string falls back to ThemeIcon terminal", () => {
    const icon = resolveIconPath(123, EXTENSION_URI);
    assert.ok(icon instanceof vscode.ThemeIcon);
    assert.strictEqual((icon as vscode.ThemeIcon).id, "terminal");
  });

  test("path traversal out of the icons folder is refused (fallback)", () => {
    const icon = resolveIconPath("../package.json", EXTENSION_URI);
    assert.ok(icon instanceof vscode.ThemeIcon, "traversal must not resolve inside the extension");
    assert.strictEqual((icon as vscode.ThemeIcon).id, "terminal");
  });

  test("every built-in agent's icon resolves to a bundled Uri", () => {
    // The curated defaults must never render the fallback terminal glyph.
    for (const agent of BUILTIN_AGENTS) {
      const icon = resolveIconPath(agent.icon, EXTENSION_URI);
      assert.ok(
        icon instanceof vscode.Uri,
        `${agent.name}: icon "${agent.icon}" should resolve to a bundled file`
      );
    }
  });
});

suite("resolveColor", () => {
  test("undefined → undefined", () => {
    assert.strictEqual(resolveColor(undefined), undefined);
  });

  test("empty → undefined", () => {
    assert.strictEqual(resolveColor(""), undefined);
  });

  test("built-in color id → ThemeColor", () => {
    const c = resolveColor("agentQuickpick.claude");
    assert.ok(c instanceof vscode.ThemeColor);
    assert.strictEqual(c!.id, "agentQuickpick.claude");
  });

  test("declared-but-unused built-in color ids resolve (claudeProxy, claudeGlm)", () => {
    // These ids are declared in contributes.colors and referenced by the
    // README's custom-agent example, but no longer used by BUILTIN_AGENTS —
    // they must still resolve, not silently fall back to undefined.
    const proxy = resolveColor("agentQuickpick.claudeProxy");
    assert.ok(proxy instanceof vscode.ThemeColor);
    assert.strictEqual(proxy!.id, "agentQuickpick.claudeProxy");

    const glm = resolveColor("agentQuickpick.claudeGlm");
    assert.ok(glm instanceof vscode.ThemeColor);
    assert.strictEqual(glm!.id, "agentQuickpick.claudeGlm");
  });

  test("stock terminal.ansi* key → ThemeColor", () => {
    const c = resolveColor("terminal.ansiBlue");
    assert.ok(c instanceof vscode.ThemeColor);
    assert.strictEqual(c!.id, "terminal.ansiBlue");
  });

  test("bright ansi key → ThemeColor", () => {
    const c = resolveColor("terminal.ansiBrightMagenta");
    assert.ok(c instanceof vscode.ThemeColor);
    assert.strictEqual(c!.id, "terminal.ansiBrightMagenta");
  });

  test("garbage → undefined (does not throw)", () => {
    assert.strictEqual(resolveColor("not.a.real.color"), undefined);
    assert.strictEqual(resolveColor("#FF0000"), undefined);
    assert.strictEqual(resolveColor("red"), undefined);
  });

  test("every built-in agent's color resolves to a ThemeColor", () => {
    for (const agent of BUILTIN_AGENTS) {
      const c = resolveColor(agent.color);
      assert.ok(
        c instanceof vscode.ThemeColor,
        `${agent.name}: color "${agent.color}" should resolve`
      );
    }
  });
});
