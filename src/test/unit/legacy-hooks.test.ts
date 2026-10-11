import * as assert from "assert";

import {
  LEGACY_TARGETS,
  cleanupLegacyHooks,
  hasCommandHooks,
  hasNamedHooks,
  hasOldOpencodePlugin,
  shouldRemovePluginFile,
  stripCommandHooks,
  stripNamedHooks,
  stripOldOpencodePlugin,
  stripTarget,
  stripWorkspaceLegacyHooks,
  targetPath,
  writeConfigJson,
  type LegacyIo,
  type LegacyTarget,
} from "../../legacy-hooks";

const CLAUDE = "agentQuickpick:claude";
const OPENCODE = "agentQuickpick:opencode";
const ENV = { PI_CODING_AGENT_DIR: "/home/me/.pi/agent" } as NodeJS.ProcessEnv;
const HOME = "/home/me";

function memIo(initial: Record<string, string> = {}): {
  io: LegacyIo;
  files: Map<string, string>;
} {
  const files = new Map(Object.entries(initial));
  return {
    files,
    io: {
      read: async (file) => files.get(file),
      write: async (file, text) => {
        files.set(file, text);
      },
      remove: async (file) => {
        if (!files.delete(file)) throw new Error("ENOENT");
      },
    },
  };
}

const target = (agentName: string): LegacyTarget => {
  const found = LEGACY_TARGETS.find((t) => t.agentName === agentName);
  assert.ok(found, `no legacy target for ${agentName}`);
  return found!;
};

const ours = (marker: string) => ({ type: "command", command: `node -e "/*${marker}:v4*/post()"` });
const user = { type: "command", command: "node -e '/* mine */'" };

suite("stripCommandHooks", () => {
  test("removes ours and keeps the user's hook sharing the entry", () => {
    const config = {
      hooks: { Stop: [{ matcher: "*", hooks: [user, ours(CLAUDE)] }] },
      model: "sonnet",
    };
    const stripped = stripCommandHooks(config, CLAUDE) as typeof config;
    assert.deepStrictEqual(stripped.hooks.Stop[0].hooks, [user]);
    assert.strictEqual(stripped.model, "sonnet", "unrelated keys survive");
  });

  test("prunes the event and the hooks section once they empty", () => {
    const stripped = stripCommandHooks(
      { hooks: { Stop: [{ hooks: [ours(CLAUDE)] }] } },
      CLAUDE
    ) as { hooks?: unknown };
    assert.strictEqual(stripped.hooks, undefined);
  });

  test("leaves a config with none of ours byte-identical", () => {
    const config = { hooks: { Stop: [], UserPromptSubmit: [{ hooks: [user] }] } };
    assert.deepStrictEqual(stripCommandHooks(config, CLAUDE), config);
  });

  test("is idempotent", () => {
    const config = { hooks: { Stop: [{ hooks: [user, ours(CLAUDE)] }] } };
    const once = stripCommandHooks(config, CLAUDE);
    assert.deepStrictEqual(stripCommandHooks(once, CLAUDE), once);
  });

  test("recognizes any schema version by marker", () => {
    assert.strictEqual(hasCommandHooks({ hooks: { Stop: [{ hooks: [ours(CLAUDE)] }] } }, CLAUDE), true);
    assert.strictEqual(hasCommandHooks({ hooks: { Stop: [{ hooks: [user] }] } }, CLAUDE), false);
    assert.strictEqual(hasCommandHooks({}, CLAUDE), false);
    assert.strictEqual(hasCommandHooks(null, CLAUDE), false);
  });
});

suite("stripNamedHooks", () => {
  test("removes our named entry's commands and keeps user handlers", () => {
    const config = {
      "agent-quickpick": { Stop: [ours("agentQuickpick:antigravity") as never, user as never] },
      "user-hook": { Stop: [user] },
    };
    const stripped = stripNamedHooks(
      config,
      "agent-quickpick",
      "agentQuickpick:antigravity"
    ) as Record<string, { Stop?: unknown[] }>;
    assert.deepStrictEqual(stripped["agent-quickpick"].Stop, [user]);
    assert.deepStrictEqual(stripped["user-hook"], config["user-hook"]);
  });

  test("hasNamedHooks finds ours in both the flat and matcher shapes", () => {
    const flat = { "agent-quickpick": { Stop: [ours("agentQuickpick:antigravity")] } };
    const wrapped = {
      "agent-quickpick": {
        PreToolUse: [{ matcher: "run", hooks: [user, ours("agentQuickpick:antigravity")] }],
      },
    };
    assert.strictEqual(hasNamedHooks(flat, "agent-quickpick", "agentQuickpick:antigravity"), true);
    assert.strictEqual(hasNamedHooks(wrapped, "agent-quickpick", "agentQuickpick:antigravity"), true);
    assert.strictEqual(hasNamedHooks({ "agent-quickpick": { Stop: [user] } }, "agent-quickpick", "agentQuickpick:antigravity"), false);
    assert.strictEqual(hasNamedHooks({}, "agent-quickpick", "agentQuickpick:antigravity"), false);
  });

  test("drops our entry entirely once no events remain", () => {
    const stripped = stripNamedHooks(
      { "agent-quickpick": { enabled: false, Stop: [ours("agentQuickpick:antigravity") as never] } },
      "agent-quickpick",
      "agentQuickpick:antigravity"
    ) as Record<string, unknown>;
    assert.strictEqual(stripped["agent-quickpick"], undefined);
  });

  test("never touches a same-named entry that is not ours", () => {
    const config = { "agent-quickpick": { Stop: [user] } };
    assert.deepStrictEqual(
      stripNamedHooks(config, "agent-quickpick", "agentQuickpick:antigravity"),
      config
    );
  });
});

suite("stripTarget", () => {
  test("a command-hook config is rewritten in place", async () => {
    const { io, files } = memIo({
      [`${HOME}/.claude/settings.json`]: writeConfigJson({
        hooks: { Stop: [{ hooks: [user, ours(CLAUDE)] }] },
      }),
    });
    assert.strictEqual(await stripTarget(target("Claude"), io, ENV, "linux", HOME), true);
    const written = JSON.parse(files.get(`${HOME}/.claude/settings.json`)!) as {
      hooks: { Stop: { hooks: unknown[] }[] };
    };
    assert.deepStrictEqual(written.hooks.Stop[0].hooks, [user]);
  });

  test("a missing config is not created", async () => {
    const { io, files } = memIo();
    assert.strictEqual(await stripTarget(target("Claude"), io, ENV, "linux", HOME), false);
    assert.strictEqual(files.size, 0);
    assert.strictEqual(files.has(`${HOME}/.claude/settings.json`), false);
  });

  test("deletes a plugin file we wrote, and only that one", async () => {
    const path = targetPath(target("pi"), ENV, "linux", HOME);
    const mine = memIo({ [path]: `/* ${target("pi").marker} */` });
    assert.strictEqual(await stripTarget(target("pi"), mine.io, ENV, "linux", HOME), true);
    assert.strictEqual(mine.files.has(path), false);

    const theirs = memIo({ [path]: "// someone else's extension\n" });
    assert.strictEqual(await stripTarget(target("pi"), theirs.io, ENV, "linux", HOME), false);
    assert.strictEqual(
      theirs.files.has(path),
      true,
      "a file at our path that is not ours must never be deleted"
    );
    assert.strictEqual(shouldRemovePluginFile(undefined, target("pi").marker), false);
  });

  test("resolves the documented paths", () => {
    assert.strictEqual(
      targetPath(target("Claude"), ENV, "linux", HOME),
      `${HOME}/.claude/settings.json`
    );
    assert.strictEqual(
      targetPath(target("OpenCode"), ENV, "linux", HOME),
      `${HOME}/.config/opencode/plugin/agent-quickpick-lifecycle.js`
    );
    assert.strictEqual(
      targetPath(target("pi"), ENV, "linux", HOME),
      `${HOME}/.pi/agent/extensions/agent-quickpick-lifecycle.js`
    );
  });
});

suite("cleanupLegacyHooks", () => {
  test("removes every install we find and reports only what changed", async () => {
    const claude = writeConfigJson({ hooks: { Stop: [{ hooks: [user, ours(CLAUDE)] }] } });
    const installed = writeConfigJson({
      hooks: { Stop: [{ hooks: [ours("agentQuickpick:codex")] }] },
    });
    const { io } = memIo({
      [`${HOME}/.claude/settings.json`]: claude,
      [`${HOME}/.codex/hooks.json`]: installed,
      [`${HOME}/.gemini/config/hooks.json`]: writeConfigJson({
        "agent-quickpick": { Stop: [ours("agentQuickpick:antigravity")] },
      }),
      [`${HOME}/.config/opencode/plugin/agent-quickpick-lifecycle.js`]: `/* ${OPENCODE} */`,
      [`${HOME}/.config/opencode/plugins/agent-quickpick-lifecycle.js`]: `/* ${OPENCODE} */`,
      [`${HOME}/.pi/agent/extensions/agent-quickpick-lifecycle.js`]: "// not ours\n",
    });

    const touched = await cleanupLegacyHooks(io, ENV, "linux", HOME);
    assert.deepStrictEqual(touched.sort(), [
      "/home/me/.config/opencode/plugin/agent-quickpick-lifecycle.js",
      "/home/me/.config/opencode/plugins/agent-quickpick-lifecycle.js",
      "~/.claude/settings.json",
      "~/.codex/hooks.json",
      "~/.gemini/config/hooks.json",
    ].sort());
  });

  test("is idempotent and quiet on a second run", async () => {
    const { io, files } = memIo({
      [`${HOME}/.claude/settings.json`]: writeConfigJson({
        hooks: { Stop: [{ hooks: [ours(CLAUDE)] }] },
      }),
    });
    assert.strictEqual((await cleanupLegacyHooks(io, ENV, "linux", HOME)).length, 1);
    assert.deepStrictEqual(await cleanupLegacyHooks(io, ENV, "linux", HOME), []);
    assert.ok(files.has(`${HOME}/.claude/settings.json`));
  });

  test("one unreadable target does not stop the others", async () => {
    const broken: LegacyIo = {
      read: async (file) => {
        if (file.includes(".codex")) throw new Error("EACCES");
        return undefined;
      },
      write: async () => {},
      remove: async () => {},
    };
    assert.deepStrictEqual(await cleanupLegacyHooks(broken, ENV, "linux", HOME), []);
  });
});

suite("workspace-local migration", () => {
  test("strips the old workspace hooks and the old OpenCode plugin", async () => {
    const base = "/repo";
    const { io, files } = memIo({
      [`${base}/.claude/settings.local.json`]: writeConfigJson({
        hooks: { Stop: [{ hooks: [user, ours(CLAUDE)] }] },
      }),
      [`${base}/.factory/settings.json`]: writeConfigJson({
        hooks: { Stop: [{ hooks: [ours("agentQuickpick:droid")] }] },
      }),
      [`${base}/opencode.json`]: writeConfigJson({
        plugin: ["file:///old/agent-quickpick-lifecycle.mjs", "file:///keep.mjs"],
      }),
      [`${base}/.opencode/agent-quickpick-lifecycle.mjs`]: "// old plugin\n",
    });

    await stripWorkspaceLegacyHooks(io, base);

    const claude = JSON.parse(files.get(`${base}/.claude/settings.local.json`)!) as {
      hooks: { Stop: { hooks: unknown[] }[] };
    };
    assert.deepStrictEqual(claude.hooks.Stop[0].hooks, [user]);
    assert.strictEqual(files.get(`${base}/.factory/settings.json`), writeConfigJson({}));
    const opencode = JSON.parse(files.get(`${base}/opencode.json`)!) as { plugin: string[] };
    assert.deepStrictEqual(opencode.plugin, ["file:///keep.mjs"]);
    assert.strictEqual(files.has(`${base}/.opencode/agent-quickpick-lifecycle.mjs`), false);
  });

  test("a missing workspace file is skipped, and absent files are never created", async () => {
    const { io, files } = memIo();
    await stripWorkspaceLegacyHooks(io, "/repo");
    assert.strictEqual(files.size, 0);
  });

  test("opencode.json helpers are marker-scoped", () => {
    const config = { plugin: ["file:///a/agent-quickpick-lifecycle.mjs", "file:///b.mjs"] };
    assert.strictEqual(hasOldOpencodePlugin(config), true);
    assert.deepStrictEqual(
      (stripOldOpencodePlugin(config) as { plugin: string[] }).plugin,
      ["file:///b.mjs"]
    );
    assert.strictEqual(hasOldOpencodePlugin({ plugin: ["file:///b.mjs"] }), false);
    const kept = stripOldOpencodePlugin({ plugin: ["file:///b.mjs"] }) as { plugin?: unknown };
    assert.deepStrictEqual(kept.plugin, ["file:///b.mjs"]);
    const emptied = stripOldOpencodePlugin({ plugin: ["file:///a/agent-quickpick-lifecycle.mjs"] }) as {
      plugin?: unknown;
    };
    assert.strictEqual(emptied.plugin, undefined);
  });
});
