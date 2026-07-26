# Maintainers & local dev

## Build, test, package

```bash
npm install
npm run compile     # tsc
npm run watch       # tsc -w
npm test            # runs the unit suite in a headless VS Code (147 tests)
npm run package     # builds the .vsix
```

CI runs on every push across Ubuntu, macOS, and Windows — build, test, package, upload the vsix as an artifact.

## Source layout

- `src/extension.ts` — the extension: `BUILTIN_AGENTS`, `loadAgents`, `resolveIconPath`, `resolveColor`, `isCmdInstalled`, `isSafeBinaryName`, `frecencyScore`, `sortByFrecency`, `launchText`, plus the `LifecycleContext` class (session tracking, status-bar updates, notifications, hook install/remove).
- `src/lifecycle.ts` — lifecycle awareness shared core: types, the `LifecycleAdapter` interface, pure functions (JSON config helpers, command-hook merge/strip, status-bar rendering, notification logic), and the VS Code-coupled HTTP server + exit-status poller.
- `src/lifecycle-adapters.ts` — one adapter per lifecycle-aware agent: Claude Code, Droid (shared command-hook schema), and OpenCode (file-based ESM plugin). Registry + lookup helpers.
- `src/test/suite/extension.test.ts` — unit tests for the merge/icon/color/detection/frecency logic.
- `src/test/suite/lifecycle.test.ts` — unit tests for adapter symmetry, hook generation, status-bar rendering, and notification logic.
- `icons/*.svg` — one brand icon per agent. House style: 24×24 viewBox, `rx=6` rounded background, white glyph on brand fill.
- `package.json` — `contributes.configuration` (settings schema), `contributes.colors` (8 custom theme colors), command + keybinding.
- `.github/assets/` — README screenshots (real PNG captures).

## Adding a built-in agent

1. Drop an SVG in `icons/` (24×24, house style).
2. Add an entry to `BUILTIN_AGENTS` in `src/extension.ts`. Set `launcher` only if the agent is genuinely invoked through a package-fetching launcher (e.g. `uvx aider`, `npx <pkg>`); otherwise leave it unset so detection probes the binary on PATH directly. Do NOT set `launcher` just because a tool *can* be installed via a package manager — only when the launcher is the required invocation.
3. Only if you want a brand-new color id: add a matching `contributes.colors` entry in `package.json`. Otherwise reuse a `terminal.ansi*` key.

## Capturing screenshots

To refresh the PNGs in `.github/assets/`:

1. `code --extensionDevelopmentPath=.` with the GitHub Dark theme.
2. Screenshot the quick pick in (a) default view, (b) revealed view, (c) two terminals side-by-side.
3. For the demo GIF: record ⌘⇧A → pick Claude → ⌘⇧A → pick OpenCode → 6–10s, 15fps, ~600px wide.
4. Drop them in `.github/assets/` and update the image links in the README.

## Architecture notes

- **Detection** runs `command -v <binary>` (or `where` on Windows) per agent, in parallel. Results are cached for 5 minutes (TTL); the cache is also cleared whenever any `agentQuickpick.*` setting changes. When `launcher` is set (e.g. `uvx`), the launcher binary is probed instead of the first token of `cmd`. Binary names are validated against a safe-character allowlist before exec — a malicious or typo'd setting can't inject shell commands.
- **Frecency** scores each agent by `count × 2^(-ageDays/10)`; the quick-pick list is stable-sorted by that score so the most-used agents float to the top while never-launched agents keep curated order. Scores live in `globalState` (`frecency.v1`) so they persist across restarts and sync across machines via Settings Sync.
- **Icon resolution** falls back gracefully: codicon → existing file → `terminal` codicon. A broken icon path never breaks the quick pick.
- **Colors** are a closed set (8 built-ins + 16 ANSI) because VS Code registers theme colors at publish time only.
- **Lifecycle awareness** tracks per-session status (running / finished / waiting / failed) for Claude Code, OpenCode, and Droid. Each agent is abstracted behind a `LifecycleAdapter` — Claude and Droid share a command-hook schema (`hooks.<Event>` in settings JSON); OpenCode uses a file-based ESM plugin referenced from `opencode.json`'s `plugin[]` array. On `activate`, a localhost HTTP server (random port) receives POSTs from agent hooks; each lifecycle-aware terminal is injected with `AQP_HOOK_URL` + `AQP_SESSION` env vars via `createTerminal({ env })`. Install and removal are symmetric and idempotent — both are one-file-read → marker-based-transform → one-write. Hooks are identified by a unique marker (`agentQuickpick:<agent>`), so stripping ours never clobbers the user's own hooks. A 3-second exit-status poll is a universal fallback for agents whose hooks haven't fired. VS Code's stable API cannot badge a terminal tab after creation, so per-session status surfaces via notifications + the status bar instead.
