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
npm run test:unit      # FAST tier: plain mocha, no VS Code window, ~3s
npm test               # full gate: test:unit, then the host tier in a real editor window
npm run package        # vsce package -> *.vsix
npm run build:iconfont # ONLY when icons/statusbar-glyph.svg changes (rebuilds the woff)
```

**Both tiers run stale code unless you `npm run compile` first.** The scripts execute compiled JS under `out/`, and there is no precompile hook. CI runs `compile` → `test`. Always compile after editing `.ts` before testing.

### Two test tiers

- **Unit tier** (`src/test/unit/*.test.ts`, run by `npm run test:unit`): plain mocha over `out/test/unit/` — no VS Code window, seconds. Anything that imports only `agents.ts` / `lifecycle.ts` / `lifecycle-adapters.ts` belongs here (those modules must stay free of *runtime* `vscode` usage; type-only imports are fine — tsc elides them). This tier also executes the generated hook command and OpenCode plugin for real against a localhost server, and includes the seeded fuzz + repo-consistency suites.
- **Host tier** (`src/test/suite/*.test.ts`, run inside `@vscode/test-electron`): only what genuinely needs the VS Code API — `resolveIconPath`/`resolveColor` (construct runtime vscode objects), `LifecycleContext`, activation. Uses **mocha TDD UI**, 60s timeout. It launches a real editor window (a local fork binary if found, else downloaded stable VS Code — on macOS you'll see it flash; Linux CI wraps it in `xvfb-run`).

Single-file runs: `npx mocha --ui tdd --exit out/test/unit/<file>.test.js` (compile first). The host tier has no per-file filter — but its rejection message always names failing tests, because some forks (Trae) drop all extension-host console output.

Both tiers use the **mocha TDD UI** (`suite`/`test`, not `describe`/`it`).

No linter or formatter is configured. Don't invent one. `tsc --strict` is the only static gate.

## Source map

- `src/extension.ts` — `activate`, icon/color resolution (`resolveIconPath`/`resolveColor`), launch, the `LifecycleContext` class (exported for host-tier tests), URI handler, commands.
- `src/agents.ts` — the vscode-free half: `BUILTIN_AGENTS`, `loadAgents`, frecency, install detection (`isCmdInstalled` + cache), `launchText`/`launchDelay`, terminal naming/session matching. Must stay free of *runtime* `vscode` usage so the unit tier can import it.
- `src/lifecycle.ts` — pure helpers (config read/write, hook merge/strip, status-bar text, notification logic, notify/sound command builders) **plus** the VS Code-coupled localhost HTTP server and exit-status poller. Keep the pure helpers free of runtime `vscode` usage — they're unit-tested without a host.
- `src/lifecycle-adapters.ts` — one `LifecycleAdapter` per lifecycle-aware agent, a `kind` union: `"command-hooks"` (Claude → `~/.claude/settings.json`, Droid → `~/.factory/settings.json`; same JSON schema) and `"plugin-file"` (OpenCode → a self-contained ESM plugin dropped in `~/.config/opencode/plugin/`, which OpenCode auto-loads — no JSON edit). Adapter paths are **home-relative**; the extension joins them with `os.homedir()`.
- `src/test/unit/*.test.ts` — unit tier (see above). `src/test/suite/*.test.ts` — host tier.
- `icons/*.svg` — one per agent. House style: 24×24 viewBox, `rx=6` rounded bg, white glyph on brand fill.
- `package.json` — `contributes.configuration` (settings schema), `contributes.colors` (closed set of custom theme colors), `contributes.icons` (status-bar glyph), commands, keybinding.

## Adding a built-in agent

1. Drop a 24×24 SVG in `icons/` (house style).
2. Add an entry to `BUILTIN_AGENTS` in `src/agents.ts`. Set `launcher` **only** when invocation genuinely requires a package-fetching prefix (`uvx aider`); leave it unset so detection probes the binary on PATH directly.
3. If you need a brand-new tab color, add a matching `contributes.colors` entry in `package.json` and to `BUILTIN_COLOR_IDS` in `agents.ts`. Otherwise reuse a `terminal.ansi*` key. Theme colors are a **closed set** — VS Code registers them at publish time, so this list must stay in sync with `package.json` (the unit-tier consistency suite enforces both directions, including the icon file existing).

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
