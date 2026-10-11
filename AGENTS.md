# AGENTS.md

Compact guide for OpenCode sessions working in this repo. Read this before editing.

## What this is

A VS Code extension (`engines.vscode: ^1.93.0`, `@types/vscode` pinned to 1.85). TypeScript → CommonJS → `out/`. Entry point `out/extension.js` (from `src/extension.ts`). Not a Node app or library; it runs inside VS Code's extension host.

The 1.93 floor exists because status detection reads each agent's terminal output through shell integration (`onDidStartTerminalShellExecution` + `execution.read()`); that API landed in 1.93. Don't lower it without a replacement path.

## No comments or docstrings

- Do not add code comments, JSDoc, docstrings, section banners, or commented-out code in source, tests, scripts, configuration, or SVGs.
- Use clear names, types, and tests to explain behavior. Put prose documentation in Markdown files.
- Keep only required license attribution and operative tooling directives, such as shebangs and editor synchronization markers. Do not use this exception for explanatory comments or type-check suppressions.
- Preserve comment-shaped text inside runtime strings, regexes, and test fixtures. It is data, not a code comment.

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

- **Unit tier** (`src/test/unit/*.test.ts`, run by `npm run test:unit`): plain mocha over `out/test/unit/` — no VS Code window, seconds. Anything that imports only `agents.ts`, the status modules (`program-status.ts` / `terminal-signals.ts` / `detect.ts` / `detect-manifests.ts` / `session-tracker.ts`), `lifecycle.ts` or `legacy-hooks.ts` belongs here (those modules must stay free of *runtime* `vscode` usage; type-only imports are fine — tsc elides them). The status machine is driven with synthetic output and a fake clock, so protocol/regex/lifetime behavior is all testable here; the tier also includes the seeded fuzz and repo-consistency suites.
- **Host tier** (`src/test/suite/*.test.ts`, run inside `@vscode/test-electron`): only what genuinely needs the VS Code API — `resolveIconPath`/`resolveColor` (construct runtime vscode objects), `LifecycleContext`, activation. Uses **mocha TDD UI**, 60s timeout. It launches a real editor window (a local fork binary if found, else downloaded stable VS Code — on macOS you'll see it flash; Linux CI wraps it in `xvfb-run`).

  **If you run the host tier from inside an Electron-based editor's terminal** (this repo's own dev loop), unset `ELECTRON_RUN_AS_NODE` or the launched editor will run as plain Node and die with `bad option: --no-sandbox`: `env -u ELECTRON_RUN_AS_NODE npm test`. `AQP_TEST_VSCODE=/path/to/Electron` pins the editor binary to test against.

Single-file runs: `npx mocha --ui tdd --exit out/test/unit/<file>.test.js` (compile first). The host tier has no per-file filter — but its rejection message always names failing tests, because some forks (Trae) drop all extension-host console output.

Both tiers use the **mocha TDD UI** (`suite`/`test`, not `describe`/`it`).

No linter or formatter is configured. Don't invent one. `tsc --strict` is the only static gate.

## Source map

- `src/extension.ts` — `activate`, icon/color resolution (`resolveIconPath`/`resolveColor`), launch, the `LifecycleContext` class (exported for host-tier tests), URI handler, commands.
- `src/agents.ts` — the vscode-free half: `BUILTIN_AGENTS`, `loadAgents`, frecency, install detection (`isCmdInstalled` + cache), `launchText`/`launchDelay`, `programStatusEnv` (the OSC 7501 opt-in some agents need), terminal naming/session matching. Must stay free of *runtime* `vscode` usage so the unit tier can import it.
- `src/program-status.ts` — the OSC 7501 Program Status Protocol: report parsing, record lifetime, and the attention/root record-selection policy. Pure.
- `src/terminal-signals.ts` — raw terminal output → usable signals: OSC 0/2 window title, OSC 9 progress, and a `\r`/`ESC[K`-aware line-oriented text tail (the closest thing to a screen we can get without a screen buffer). Pure.
- `src/detect.ts` + `src/detect-manifests.ts` — the fallback rule engine and its per-agent rule tables, derived from [Herdr](https://github.com/herdrdev/herdr)'s detection manifests (Apache-2.0; see `THIRD_PARTY_NOTICES.md`). Rules match `osc_title` / `osc_progress` / the text tail; screen-geometry rules are deliberately not ported. Pure.
- `src/session-tracker.ts` — the per-terminal state machine: source precedence (protocol → heuristics → exit code), the fallback ladder, `done`/`error` latching, notification policy and rate limiting. Pure, and where most status bugs will live.
- `src/agent-reporters.ts` + `reporters/` — launch-time OSC 7501 reporters for Claude Code (`claude-settings.json`) and OpenCode V2 (`opencode/tui.js`). vscode-free; unit-tested, including a fake-API run of the OpenCode plugin.
- `src/legacy-hooks.ts` — **removal only** of hooks/plugins older versions installed (marker-scoped strip + the paths and markers to find them). Nothing here writes NEW agent configuration.
- `src/lifecycle.ts` — presentation and VS Code-coupled bits: status-bar text/tooltip, session filtering, notification copy, notify/sound command builders, and the exit-status poller. Keep the pure helpers free of runtime `vscode` usage — they're unit-tested without a host.
- `src/test/unit/*.test.ts` — unit tier (see above). `src/test/suite/*.test.ts` — host tier.
- `icons/*.svg` — one per agent. House style: 24×24 viewBox, `rx=6` rounded bg, white glyph on brand fill.
- `package.json` — `contributes.configuration` (settings schema), `contributes.colors` (closed set of custom theme colors), `contributes.icons` (status-bar glyph), commands, keybinding.

## Adding a built-in agent

1. Drop a 24×24 SVG in `icons/` (house style).
2. Add an entry to `BUILTIN_AGENTS` in `src/agents.ts`. Set `launcher` **only** when invocation genuinely requires a package-fetching prefix (`uvx aider`); leave it unset so detection probes the binary on PATH directly.
3. If you need a brand-new tab color, add a matching `contributes.colors` entry in `package.json` and to `BUILTIN_COLOR_IDS` in `agents.ts`. Otherwise reuse a `terminal.ansi*` key. Theme colors are a **closed set** — VS Code registers them at publish time, so this list must stay in sync with `package.json` (the unit-tier consistency suite enforces both directions, including the icon file existing).

## Generated / gitignored — do not edit, do not commit

Nothing writes into the repo at runtime, and status detection installs nothing at all. The following are generated / gitignored:

- `.zcode/`, `.vscode-test/`, `out/`, `*.vsix` — build/test artifacts. Gitignored.
- `.env` — contains publish tokens (e.g. `OVSX_PAT`). Never commit.

If a session "fixes" or edits these, it's editing generated output. Source of truth is `src/`.

## Status detection (when touching lifecycle code)

Four tiers, in priority order, and the order is the whole design:

1. **`OSC 7501`** (the Program Status Protocol, `src/program-status.ts`). An agent that reports its own state is believed, full stop. The parser follows the spec's error handling exactly: a malformed *optional* key (`kind`, `progress`, `app`) is treated as **absent**, while a malformed `state`/`id` or an undecodable or control-character-bearing `msg`/`title` **discards the report**. Don't "simplify" either direction.
2. **Heuristics** (`src/detect.ts` + `src/detect-manifests.ts`) for agents that don't speak it: window title, `OSC 9;4` progress, text tail. Ported from Herdr, but only the regions we can actually compute — **never** approximate a screen-geometry region, and never add a rule whose needles a transcript or diff could satisfy. A spurious "needs your attention" is worse than a missing one.
3. **The exit code**, the only non-protocol source allowed to claim `done`/`error`.
4. Everything else settles: output → `working`, quiet → `idle`, `unknown` until evidence arrives.

**The protocol is mostly gated behind a handshake, and VS Code cannot answer it.** Claude Code, pi and Droid send `OSC 7501 ; ?` and only report if the reply arrives *before* the terminal's own `CSI c` (DA1) reply — VS Code implements neither, and an extension's only write channel (`sendText`) lands after DA1, which the agents ignore by design. So in VS Code the protocol path fires only for agents that emit unconditionally (Codex), ship their own override (pi, via `PI_PROGRAM_STATUS=1` in `programStatusEnv`, `agents.ts`), or get a **launch-time reporter** from us (`src/agent-reporters.ts`): Claude Code is launched with `--settings reporters/claude-settings.json` (hooks that print OSC 7501 to the parent process's tty — Claude runs hooks detached, so `/dev/tty` fails), and OpenCode V2 with `OPENCODE_CLI_CONFIG_CONTENT` naming the `reporters/opencode` TUI plugin. That variable's `plugins` list *replaces* the user's `cli.json` list, so the user's plugins are copied in first, and an unreadable `cli.json` means no reporter rather than dropped plugins. Reporters are shims: delete each one when its agent reports natively in VS Code. **Never treat the heuristic tier as removable legacy on the strength of the protocol's existence** — it is what tracks Claude Code and most others today. Re-check this note before changing `fallbackDetection`'s default or deleting a rule table.

Rules that must not regress:

- **`done`/`error` latch.** Once a session reaches a terminal state it stays there until a new protocol report or a new command. A stale text tail must not drag it back to `working`, and a crash after a `done` report becomes `error`.
- **Only a `visibleBlocker` heuristic, the protocol, or an exit may notify.** A unit test enforces the flag on every `blocked` rule.
- **Alert rate limiting** (one per session per 2s) is in `SessionTracker.commit`, per the protocol's recommendation.
- **Herdr's patterns are Rust regex**, where flags are inline (`(?i)`, `(?m)`). JS has no inline flags, so `detect.ts` translates a leading flag group into `RegExp` flags. A pattern that fails to compile must never match — the old behavior of throwing was silently disabling rules.
- **`read()` must be called synchronously** inside `onDidStartTerminalShellExecution`, or output written before the first call is lost. Shell integration exists on VS Code 1.93+ only, so every use is guarded and the 3-second exit poll stays as the backstop.
- **Nothing installs anything.** Reporters are passed per launch (a flag, an env var) and never written to an agent's config. `src/legacy-hooks.ts` is removal-only: marker-scoped strip of what older versions wrote, a one-time automatic cleanup after upgrade, and the `Remove Legacy Lifecycle Hooks` command. A config or plugin file that isn't ours is never modified or deleted.

## CI / release

`.github/workflows/ci.yml` runs on push to `main` and `feat/v1`, PRs to `main`. Matrix: Ubuntu, macOS, Windows; Node 20; `fail-fast: false`. **Packaging + vsix artifact upload happen only on Linux.** Publishing (when needed) is manual via `npm run publish:vscode` (vsce) and `npm run publish:openvsx` (ovsx). Default branch is `main`; active feature work happens on `feat/v1`.

## Other references

`MAINTAINERS.md` has the fuller architecture notes (detection, frecency scoring, icon/color resolution, lifecycle design) and screenshot-capture instructions. `CHANGELOG.md` tracks per-release changes — update it for user-visible changes.
