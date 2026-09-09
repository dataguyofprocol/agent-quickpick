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
import { HOOK_SCHEMA_VERSION, mergeCommandHooks } from "../../lifecycle";
import { LIFECYCLE_ADAPTERS, isAbsoluteForPlatform } from "../../lifecycle-adapters";

// out/test/unit/consistency.test.js → repo root is three levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const pkg = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")
) as {
  contributes: {
    colors: { id: string }[];
    commands: { command: string }[];
    keybindings: { command: string; key: string }[];
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

suite("consistency: lifecycle adapters ↔ built-ins", () => {
  test("every lifecycle adapter name matches a built-in agent (launch wiring)", () => {
    // launchAgent looks up the adapter by agent.name; a mismatch silently
    // skips hook env injection for that agent.
    const names = new Set(BUILTIN_AGENTS.map((a) => a.name.toLowerCase()));
    for (const name of Object.keys(LIFECYCLE_ADAPTERS)) {
      assert.ok(
        names.has(name.toLowerCase()),
        `adapter "${name}" has no built-in agent — hook env would never be injected`
      );
    }
  });

  test("adapter markers are unique across adapters", () => {
    const markers = Object.values(LIFECYCLE_ADAPTERS).map((a) => a.marker);
    assert.strictEqual(new Set(markers).size, markers.length);
  });

  test("fresh merge embeds the current HOOK_SCHEMA_VERSION tag (upgrade contract)", () => {
    for (const adapter of Object.values(LIFECYCLE_ADAPTERS)) {
      if (adapter.kind !== "command-hooks") continue;
      const merged = adapter.mergeHooks(
        {},
        "http://127.0.0.1:49999",
        "Claude",
        "/tmp/hook-server.json"
      );
      assert.ok(
        JSON.stringify(merged).includes(`${adapter.marker}:v${HOOK_SCHEMA_VERSION}`),
        `${adapter.agentName}: merged hooks must embed the current version tag`
      );
    }
  });
});

suite("consistency: plugin-file adapters", () => {
  const HOME = { darwin: "/Users/me", linux: "/home/me", win32: "C:\\Users\\me" } as const;

  test("resolveBaseDir yields an absolute dir on every platform with a bare env", () => {
    // The install sink joins pluginPath onto this; a relative result would
    // write the extension somewhere relative to the extension host's cwd.
    for (const adapter of Object.values(LIFECYCLE_ADAPTERS)) {
      if (adapter.kind !== "plugin-file") continue;
      for (const platform of ["darwin", "linux", "win32"] as const) {
        const dir = adapter.resolveBaseDir({}, platform, HOME[platform]);
        assert.ok(
          isAbsoluteForPlatform(dir, platform),
          `${adapter.agentName} on ${platform}: "${dir}" is not absolute`
        );
      }
    }
  });

  test("plugin paths are relative fragments, unique across adapters", () => {
    const paths: string[] = [];
    for (const adapter of Object.values(LIFECYCLE_ADAPTERS)) {
      if (adapter.kind !== "plugin-file") continue;
      assert.ok(
        !adapter.pluginPath.startsWith("/") && !adapter.pluginPath.startsWith("~"),
        `${adapter.agentName}: pluginPath must be base-dir-relative`
      );
      paths.push(adapter.pluginPath);
    }
    assert.strictEqual(new Set(paths).size, paths.length, "plugin paths must not collide");
  });

  test("generated source embeds the adapter's own marker (guard recognizes it)", () => {
    // shouldWritePluginFile/shouldRemovePluginFile key off the marker; a source
    // without it would make install refuse to upgrade its own previous output.
    for (const adapter of Object.values(LIFECYCLE_ADAPTERS)) {
      if (adapter.kind !== "plugin-file") continue;
      const src = adapter.buildSource("http://127.0.0.1:49999", "", "/tmp/hook-server.json");
      assert.ok(
        src.includes(adapter.marker),
        `${adapter.agentName}: generated source must contain its marker`
      );
    }
  });
});

suite("consistency: contributed commands + keybinding", () => {
  const COMMANDS = [
    "agentQuickpick.open",
    "agentQuickpick.sessions",
    "agentQuickpick.removeHooks",
    "agentQuickpick.openKeybindings",
  ];

  test("all four commands are contributed", () => {
    const contributed = new Set(pkg.contributes.commands.map((c) => c.command));
    for (const cmd of COMMANDS) {
      assert.ok(contributed.has(cmd), `${cmd} must be in contributes.commands`);
    }
    assert.strictEqual(contributed.size, COMMANDS.length, "no stray commands");
  });

  test("the default keybinding targets agentQuickpick.open", () => {
    assert.strictEqual(pkg.contributes.keybindings.length, 1);
    assert.strictEqual(pkg.contributes.keybindings[0].command, "agentQuickpick.open");
    assert.ok(pkg.contributes.keybindings[0].key, "default keybinding must exist");
  });
});
