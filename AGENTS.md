# AGENTS.md

Compact guide for OpenCode sessions working in this repo. Read this before editing.

## What this is

A VS Code extension (`engines.vscode: ^1.85.0`, `@types/vscode` pinned to 1.85). TypeScript → CommonJS → `out/`. Entry point `out/extension.js` (from `src/extension.ts`). Not a Node app or library; it runs inside VS Code's extension host.

## On every change

After making any code change, do both of these before handing back — don't leave them to the user:
1. **Bump the version** in `package.json` (patch for fixes/small changes, minor for new features).
2. **Run `npm run compile`** so `out/` is fresh and `npm test` won't run stale code.

## Commands

```bash
npm install
npm run compile        # tsc -p ./ (also the only typecheck; strict mode, no separate lint)
npm run watch          # tsc -w
npm test               # runs the suite in a downloaded headless VS Code via @vscode/test-electron
npm run package        # vsce package -> *.vsix
npm run build:iconfont # ONLY when icons/statusbar-glyph.svg changes (rebuilds the woff)
```

**`npm test` runs stale code unless you `npm run compile` first.** The test script is `node ./out/test/runTest.js` — it executes compiled JS, and there is no precompile hook. CI runs `compile` → `test`. Always compile after editing `.ts` before testing. There is no way to run a single test file; the runner globs `**/**.test.js` under `out/test/`.

Tests use **mocha TDD UI** (`suite`/`test`, not `describe`/`it`), 60s timeout each. They launch a real VS Code stable window — on macOS you'll see it flash; on Linux CI it's wrapped in `xvfb-run`.

No linter or formatter is configured. Don't invent one. `tsc --strict` is the only static gate.

## Source map

- `src/extension.ts` — `activate`, `BUILTIN_AGENTS`, `loadAgents`, `resolveIconPath`, `resolveColor`, `isCmdInstalled`, `isSafeBinaryName`, frecency, launch, terminal naming, the `LifecycleContext` class.
- `src/lifecycle.ts` — pure helpers (config read/write, hook merge/strip, status-bar text, notification logic) **plus** the VS Code-coupled localhost HTTP server and exit-status poller. Keep the pure helpers free of `vscode` imports — they're unit-tested without a host.
- `src/lifecycle-adapters.ts` — one `LifecycleAdapter` per lifecycle-aware agent, a `kind` union: `"command-hooks"` (Claude → `~/.claude/settings.json`, Droid → `~/.factory/settings.json`; same JSON schema) and `"plugin-file"` (OpenCode → a self-contained ESM plugin dropped in `~/.config/opencode/plugin/`, which OpenCode auto-loads — no JSON edit). Adapter paths are **home-relative**; the extension joins them with `os.homedir()`.
- `src/test/suite/*.test.ts` — unit tests. Pure helpers are exported from `extension.ts` / `lifecycle.ts` specifically so tests can import them without a VS Code host.
- `icons/*.svg` — one per agent. House style: 24×24 viewBox, `rx=6` rounded bg, white glyph on brand fill.
- `package.json` — `contributes.configuration` (settings schema), `contributes.colors` (closed set of custom theme colors), `contributes.icons` (status-bar glyph), commands, keybinding.

## Adding a built-in agent

1. Drop a 24×24 SVG in `icons/` (house style).
2. Add an entry to `BUILTIN_AGENTS` in `src/extension.ts`. Set `launcher` **only** when invocation genuinely requires a package-fetching prefix (`uvx aider`); leave it unset so detection probes the binary on PATH directly.
3. If you need a brand-new tab color, add a matching `contributes.colors` entry in `package.json` and to `BUILTIN_COLOR_IDS` in `extension.ts`. Otherwise reuse a `terminal.ansi*` key. Theme colors are a **closed set** — VS Code registers them at publish time, so this list must stay in sync with `package.json`.

## Generated / gitignored — do not edit, do not commit

Lifecycle hooks now install **globally** (into `~/.claude`, `~/.factory`, `~/.config/opencode`), not into the repo — so exercising them no longer litters the working tree. The following are still generated / gitignored:

- `.zcode/`, `.vscode-test/`, `out/`, `*.vsix` — build/test artifacts. Gitignored.
- `.env` — contains publish tokens (e.g. `OVSX_PAT`). Never commit.

If a session "fixes" or edits these, it's editing generated output. Source of truth is `src/`.

## Lifecycle hooks (when touching lifecycle code)

- Install is **global, once per agent** (prompt flag `hooks.<marker>.global`), into home-relative paths — never per-workspace. This works because the hook payload is driven by the `AQP_HOOK_URL` + `AQP_SESSION` env injected per-terminal via `createTerminal({ env })`; a global hook routes to whichever window launched the terminal and **no-ops when `AQP_SESSION` is absent** (a session we didn't launch). Preserve that guard — without it the global hook runs on every Stop/Notification system-wide.
- Command-hook install/remove must stay **symmetric and idempotent**, identified by the marker `agentQuickpick:<agent>`. Stripping ours must never remove a user's own hooks. Plugin-file install/remove is just write/delete of the plugin file.
- `migrateWorkspaceHooks()` (called on activate, once per workspace) strips the older workspace-local hooks a pre-global build left behind (`.claude/settings.local.json`, `.factory/settings.json`, `opencode.json` + `.opencode/*.mjs`).
- A 3-second exit-status poll is the universal fallback for agents whose hooks never fire.

## CI / release

`.github/workflows/ci.yml` runs on push to `main` and `feat/v1`, PRs to `main`. Matrix: Ubuntu, macOS, Windows; Node 20; `fail-fast: false`. **Packaging + vsix artifact upload happen only on Linux.** Publishing (when needed) is manual via `npm run publish:vscode` (vsce) and `npm run publish:openvsx` (ovsx). Default branch is `main`; active feature work happens on `feat/v1`.

## Other references

`MAINTAINERS.md` has the fuller architecture notes (detection, frecency scoring, icon/color resolution, lifecycle design) and screenshot-capture instructions. `CHANGELOG.md` tracks per-release changes — update it for user-visible changes.
