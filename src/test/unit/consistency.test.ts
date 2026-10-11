/**
 * Repo consistency invariants — the drift AGENTS.md warns about:
 * contributes.colors is a closed set registered at publish time, every
 * built-in agent needs its icon on disk, and lifecycle adapters must match
 * built-in names for launch wiring. Reads package.json + icons/ from the repo.
 * Unit tier — no VS Code host needed.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

import { BUILTIN_AGENTS, ALLOWED_COLORS } from "../../agents";
import { LEGACY_TARGETS, isAbsoluteForPlatform } from "../../legacy-hooks";

// out/test/unit/consistency.test.js → repo root is three levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const pkg = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")
) as {
  contributes: {
    colors: { id: string }[];
    commands: { command: string }[];
    keybindings: { command: string; key: string; when?: string }[];
  };
};

suite("consistency: theme colors (closed set)", () => {
  test("every agentQuickpick.* id in ALLOWED_COLORS is declared in contributes.colors", () => {
    const declared = new Set(pkg.contributes.colors.map((c) => c.id));
    for (const id of ALLOWED_COLORS) {
      if (id.startsWith("agentQuickpick.")) {
        assert.ok(
          declared.has(id),
          `${id} is used by resolveColor but not declared in package.json — VS Code registers colors at publish time, so this id would never theme`
        );
      }
    }
  });

  test("every agentQuickpick.* id declared in contributes.colors is known to ALLOWED_COLORS", () => {
    for (const c of pkg.contributes.colors) {
      assert.ok(
        ALLOWED_COLORS.has(c.id),
        `${c.id} is declared in package.json but missing from ALLOWED_COLORS — resolveColor would silently drop it`
      );
    }
  });

  test("both sets are exactly the same size (no drift in either direction)", () => {
    const declared = pkg.contributes.colors.filter((c) =>
      c.id.startsWith("agentQuickpick.")
    );
    const known = [...ALLOWED_COLORS].filter((id) => id.startsWith("agentQuickpick."));
    assert.strictEqual(
      declared.length,
      known.length,
      "contributes.colors and ALLOWED_COLORS agentQuickpick.* sets differ"
    );
  });

  test("declared color ids are unique", () => {
    const ids = pkg.contributes.colors.map((c) => c.id);
    assert.strictEqual(new Set(ids).size, ids.length);
  });
});

suite("consistency: built-in agents ↔ icons on disk", () => {
  test("every built-in agent's icon file exists in icons/", () => {
    for (const agent of BUILTIN_AGENTS) {
      const iconPath = path.join(REPO_ROOT, "icons", agent.icon!);
      assert.ok(
        fs.existsSync(iconPath),
        `${agent.name}: icons/${agent.icon} is missing — the quick pick would fall back to the terminal glyph`
      );
    }
  });

  test("every built-in agent has name + icon + color set", () => {
    for (const agent of BUILTIN_AGENTS) {
      assert.ok(typeof agent.name === "string" && agent.name !== "", "name required");
      assert.ok(agent.icon, `${agent.name}: icon required`);
      assert.ok(agent.color, `${agent.name}: color required`);
    }
  });

  test("Terminal is first in the curated order", () => {
    assert.strictEqual(BUILTIN_AGENTS[0].name, "Terminal");
  });
});

suite("consistency: legacy hook targets", () => {
  const HOME = { darwin: "/Users/me", linux: "/home/me", win32: "C:\\Users\\me" } as const;

  test("legacy targets are well-formed, including for retired agents", () => {
    // Deliberately NOT restricted to built-in agents: Antigravity is retired,
    // but a hook an older version wrote must still be strippable, so its target
    // stays. What matters is that every target can still be resolved.
    assert.ok(LEGACY_TARGETS.length > 0);
    for (const target of LEGACY_TARGETS) {
      assert.ok(target.agentName.trim() !== "", "a legacy target needs an agent name");
      assert.ok(target.marker.trim() !== "", `${target.agentName}: a marker is required`);
      assert.ok(
        target.marker.startsWith("agentQuickpick:"),
        `${target.agentName}: markers are namespaced agentQuickpick:<agent>`
      );
    }
  });

  test("legacy markers are unique per agent", () => {
    // One agent may have been installed at several paths over time (OpenCode's
    // V1 `plugin/` and V2 `plugins/`), but always with its own single marker.
    const byAgent = new Map<string, string>();
    for (const target of LEGACY_TARGETS) {
      const seen = byAgent.get(target.agentName);
      assert.ok(seen === undefined || seen === target.marker, `${target.agentName}: one marker`);
      byAgent.set(target.agentName, target.marker);
    }
    const markers = [...byAgent.values()];
    assert.strictEqual(new Set(markers).size, markers.length);
  });

  test("command-hook config paths are home-relative POSIX fragments", () => {
    for (const target of LEGACY_TARGETS) {
      if (target.kind !== "command-hooks") continue;
      assert.ok(
        !path.isAbsolute(target.configPath) && !target.configPath.includes("\\"),
        `${target.agentName}: configPath must be home-relative, got "${target.configPath}"`
      );
    }
  });

  test("named-schema targets declare a registry key", () => {
    for (const target of LEGACY_TARGETS) {
      if (target.kind !== "command-hooks" || target.schema !== "named") continue;
      assert.ok(target.hookName, `${target.agentName}: named schema needs hookName`);
    }
  });

  test("plugin base dirs resolve absolute on every platform with a bare env", () => {
    // The cleanup sink joins pluginPath onto this; a relative result would look
    // for our file somewhere relative to the extension host's cwd.
    for (const target of LEGACY_TARGETS) {
      if (target.kind !== "plugin-file") continue;
      for (const platform of ["darwin", "linux", "win32"] as const) {
        const dir = target.resolveBaseDir({}, platform, HOME[platform]);
        assert.ok(
          isAbsoluteForPlatform(dir, platform),
          `${target.agentName} on ${platform}: "${dir}" is not absolute`
        );
      }
    }
  });

  test("plugin paths are relative fragments, unique across targets", () => {
    const paths: string[] = [];
    for (const target of LEGACY_TARGETS) {
      if (target.kind !== "plugin-file") continue;
      assert.ok(
        !path.isAbsolute(target.pluginPath) && !target.pluginPath.startsWith("~"),
        `${target.agentName}: pluginPath must be base-dir-relative`
      );
      paths.push(target.pluginPath);
    }
    assert.strictEqual(new Set(paths).size, paths.length, "plugin paths must not collide");
  });
});

suite("consistency: contributed commands + keybinding", () => {
  const COMMANDS = [
    "agentQuickpick.open",
    "agentQuickpick.sessions",
    "agentQuickpick.removeHooks",
    "agentQuickpick.openKeybindings",
    "agentQuickpick.renameSession",
  ];

  test("all five commands are contributed", () => {
    const contributed = new Set(pkg.contributes.commands.map((c) => c.command));
    for (const cmd of COMMANDS) {
      assert.ok(contributed.has(cmd), `${cmd} must be in contributes.commands`);
    }
    assert.strictEqual(contributed.size, COMMANDS.length, "no stray commands");
  });

  test("default keybindings target launcher and sessions rename", () => {
    assert.strictEqual(pkg.contributes.keybindings.length, 2);
    const byCommand = new Map(
      pkg.contributes.keybindings.map((k) => [k.command, k])
    );
    assert.strictEqual(byCommand.get("agentQuickpick.open")?.key, "ctrl+shift+a");
    assert.strictEqual(
      byCommand.get("agentQuickpick.renameSession")?.key,
      "r"
    );
    assert.strictEqual(
      byCommand.get("agentQuickpick.renameSession")?.when,
      "agentQuickpick.sessionsOpen && agentQuickpick.sessionsInputEmpty && agentQuickpick.sessionsRenameAvailable"
    );
  });
});
