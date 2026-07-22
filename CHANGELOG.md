# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Status bar button → running sessions.** An **Agent** button in the status bar (new `agentQuickpick.sessions` command) lists your currently-running agent terminals by tab name; pick one to focus it. When nothing is running it falls straight through to the launcher, and when sessions exist a **Launch new agent…** item re-enters the launcher. The `⌘/Ctrl+Shift+A` keybinding still opens the launcher directly. Sessions are matched by terminal name (base name minus any ` (N)` counter) against known agents, so they're re-adopted after a window reload with no in-memory tracking. Button shown by default; toggle with `agentQuickpick.showStatusBar`. Uses a bundled single-glyph icon font (the 2×2 agent-grid mark) registered via `contributes.icons` as `$(agent-quickpick)` — regenerate from `icons/statusbar-glyph.svg` with `npm run build:iconfont`.
- **Collision-free terminal tab names.** Launching a second tab for the same agent no longer produces two indistinguishable `Claude` tabs. Names follow VS Code's native convention — bare first, then `Claude (2)`, `Claude (3)` — and numbers are reclaimed when a tab closes (a freed bare name or a lower gap is reused first). New pure helper `uniqueTerminalName` exported for testing.

### Tests
- 14 new tests: `uniqueTerminalName` (bare-first, increment, bare/gap reclaim, base isolation, Set input), plus `baseTerminalName` / `isSessionTerminal` (counter stripping, case-insensitive match, numbered-session re-adoption, rejection of unrelated terminals). Suite now at **78 tests**.

## [0.3.0] — 2026-07-21

### Added
- **Frecency sorting.** The quick-pick list now surfaces your most-used agents first, scored by launch count × recency (≈10-day half-life). It's global, persists across restarts, and syncs across machines via Settings Sync. Never-launched agents keep the curated order, so the list still feels curated for new users.
- **`launcher` field for agents.** Optional prefix binary (e.g. `uvx`, `npx`, `pipx`) on built-in and custom agents. When set, install detection probes the launcher on PATH and the terminal runs `${launcher} ${cmd}` — so package-manager-only agents work without configuring shell aliases.
- **Install-cache TTL + config-change invalidation.** Detection results are cached for 5 minutes (was: session) and the cache is cleared whenever any `agentQuickpick.*` setting changes — so installing a CLI or toggling a setting is picked up without a window reload.
- **User-added agents always show.** Entries from `agentQuickpick.agents` now skip install detection — they're added on purpose and are often shell aliases (`claude-proxy`, `claude-glm`) that a non-interactive `command -v` probe can't see. Detection still gates the built-in list. Overriding a built-in by name also opts it out of detection.
- Pure helpers `frecencyScore`, `sortByFrecency`, `launchText` exported for testing.

### Changed
- Built-in **Crush** now launches via `uvx crush` (canonical install). Its install detection now correctly probes `uvx` instead of `crush`.

### Tests
- 26 new tests covering frecency math, stable-sort behavior, launcher detection (including unsafe-launcher rejection), cache TTL expiry, `launchText` composition, and user-defined detection skipping. Suite now at **60 tests**.

## [0.2.2] — 2026-07-21

### Added
- Shell-injection guard on CLI detection — binary names are validated against a safe-character allowlist before being passed to `command -v` / `where`.
- Parallelized install detection across agents for a faster quick-pick open.
- `isSafeBinaryName()` exported helper + tests for the new validation.
- Continuous-integration workflow (`.github/workflows/ci.yml`) — builds, runs the test suite, and packages the vsix on Ubuntu/macOS/Windows, uploading each as a build artifact.

### Changed
- README rewritten: concise hero, scannable sections, inline visuals, separate maintainer/fork section.
- Settings schema docs now cover the icon/color fallback behavior.

## [0.2.0] — 2026-07-20

### Added
- **Settings-driven agents.** Add, override, or hide any agent via `agentQuickpick.agents` in `settings.json` — no recompiling required.
- **Install detection.** Agents whose `cmd` isn't on `PATH` are hidden from the quick pick by default; click the **eye** button in the title bar to reveal them under a "Not installed" divider. Set `agentQuickpick.detectInstalled: false` to show everything (useful for shell-alias agents like `claude-proxy` / `claude-glm`).
- **Robust icon resolution with fallback.** Icons resolve in this order: codicon id → existing absolute path → existing bundled filename → `terminal` codicon. A missing file no longer produces a broken icon.
- **Mocha + `@vscode/test-electron` test suite** covering the agent-merge, icon-resolution, color-validation, and install-detection logic. 35 tests, run via `npm test`.
- **`.vscode/launch.json`** with "Run Extension" and "Extension Tests" configurations.
- Expanded built-in agent list to cover the standard coding-agent CLIs (Claude, Codex, Gemini, Copilot, OpenCode, Aider, Goose, Crush, Amp, Droid, Qwen, Plandex, Grok, Cody, Kilo, Qodo, oh-my-pi, Command Code) + a plain Terminal.

### Changed
- Two-word commands like `gh copilot` are now supported — only the first token is checked against `PATH`, but the full string is sent to the terminal.
- README overhauled, `bugs`/`homepage`/`keywords` added to the manifest.

### Removed
- `claude-proxy`, `claude-glm`, and `Command Code` were demoted out of the default agent list — but kept in the icon set so they can be re-added via user settings. (`Command Code` was subsequently re-added as a default in 0.2.x.)

## [0.1.x] — 2026-07-20

### Added
- Initial release: hardcoded list of 8 agents, single `Open Agent Terminal` command, `Cmd/Ctrl+Shift+A` keybinding, terminals open in the editor area with their own icon and tab color.
