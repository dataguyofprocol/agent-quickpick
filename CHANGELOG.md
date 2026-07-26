# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Native OS notifications.** Lifecycle events previously ended at a VS Code toast, which is invisible precisely when it matters — window behind another app, minimized, or on another Space. Agent Quickpick now also raises a real OS notification (macOS Notification Center via `osascript`, Windows WinRT toast via PowerShell, Linux `notify-send`). New `agentQuickpick.systemNotifications`: `off` | `whenUnfocused` | `always`, default **`always`** — the OS notification is the only channel that reaches you outside the editor and the only one that persists in Notification Center, so it fires on every announced status (`whenUnfocused` is there if the doubled alert bothers you). On macOS the banner is raised through `terminal-notifier` when it's installed — `-sender` gives it the host editor's icon (bundle id read from `__CFBundleIdentifier`, so Insiders/VSCodium/Cursor work too) and `-open` hands the click to a new `<scheme>://<extension-id>/focus?session=…` URI handler that reveals **that agent's terminal** (falling back to the sessions picker if the terminal is gone). Its path is probed on disk (`/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin`, then `PATH`) because a Finder-launched editor inherits launchd's minimal `PATH` and a bare-name spawn would ENOENT. Without it we fall back to `osascript`, which macOS credits to **Script Editor** — grey icon, and a click that opens its folder in Finder. Re-attributing via AppleScript (`tell application id … to display notification`) is not usable: it sends an Apple event, so it hangs on a TCC automation-consent prompt. Deliberately *not* gated on the active-terminal suppression the toast uses: the agent's terminal can be focused while you're in a browser, and that's the case the OS notification exists for. All user-derived text (agent name, repo, session name) travels as argv or via env, never spliced into an AppleScript/PowerShell string.
- **Notification sound.** A single cue (`media/sounds/notif.wav`) for every announced status — done, blocked, crashed. The sound's only job is to get your attention; per-status variants would have asked you to learn a vocabulary for information the toast already spells out. Plays wherever the notification lands (toast or OS notification). Bundled as 16-bit PCM WAV (the only format playable by `afplay`, `paplay`/`aplay`, and Windows' WAV-only `Media.SoundPlayer`). Toggle with `agentQuickpick.notificationSound` (default on); override with your own file via `agentQuickpick.notificationSoundPath`. Playback and OS notifications are fire-and-forget — a missing player, a locked audio device, or a PowerShell execution policy can never surface an error or stall the lifecycle pipeline (Linux falls back `paplay` → `aplay`).
- **`⌘⇧L` / `Ctrl+Shift+L` lists running sessions.** `agentQuickpick.sessions` was reachable only by clicking the status-bar item or via the Command Palette. Note this shadows VS Code's built-in **Select All Occurrences**; rebind either from **Preferences: Open Keyboard Shortcuts**.

### Changed
- **Status bar is now scoped to the active repo.** Previously every agent terminal in the window — including ones pointed at a different folder — was aggregated into the count, and the bar would show "2●" for terminals you didn't launch from this workspace. Sessions now carry two workspace signals: a `launchedInFolder` captured at launch (immutable fallback), and a `cwd` refreshed by every hook that carries one (Claude Code's stdin payload already includes `cwd`; OpenCode reports `process.cwd()`). The status-bar count and the sessions picker filter to the active workspace folder (resolved from the active editor's folder, falling back to the first workspace folder), so the bar shows only *this* repo's agents. Re-adopted terminals with no folder on record are excluded from the filtered view. The tooltip now appends a folder basename so the same agent across repos stays distinguishable. The bar re-scopes live on editor-focus and workspace-folder changes.

### Fixed
- **Re-adopted terminals no longer lie as "working" after a host reload.** Each window's lifecycle server binds a random port and the URL is baked into each terminal's env once, at creation — so after any extension-host reload (settings change, update, "Reload Window"), surviving agent tabs were re-adopted and defaulted to `running` ("●"), but their hooks couldn't reach the new server (the old URL is dead, failures swallowed). The exit poller only fires on process death, so an idle agent at its prompt stayed stuck on ● forever. Re-adopted sessions now start as a new `unknown` state (rendered as "○ reconnecting", never notified, never claimed as working) and are promoted to a real state by the first hook or by the exit poller (which now also picks up `unknown` sessions, not just `running`).
- **Remove Lifecycle Hooks now always re-arms the install prompt.** The command reset each adapter's install-prompt flag only after successfully stripping hooks — so for an agent you had declined (clicking **Not now** installs nothing), the flag stayed `"declined"` and the one-time prompt could never come back. The flag is now reset unconditionally for every adapter, whether or not anything was stripped.
- **Lifecycle notifications now survive a window reload.** Previously, the in-memory session map started empty on every reload (extension update, "Reload Window", host restart), so `onHookEvent` dropped every incoming hook — silently disabling *all* "finished" and "needs input" toasts until you manually relaunched each agent. Agent terminals that survived a reload are now re-adopted into the session map on activate, so hooks keep landing. A new exported pure helper `matchSessionTerminals` backs the re-adoption.
- **Crashed agents are now visible.** A non-zero exit previously produced no toast at all (`shouldNotify` excluded `failed`, and `notificationMessage` returned `null`); the only signal was a status-bar `✗` count — invisible after a reload. `failed` now fires an **error-severity** toast (`✗ Claude crashed · my-app · exit 130`) with a **Show** button, and the captured exit code (previously read then discarded) is surfaced in both the toast and the session state.
- **Status is truthful mid-turn (Claude, Droid).** Only `Stop` + `Notification` were wired, so after the first `Stop` set "done" the bar stayed on ✓ for the entire next turn while the agent was actively working — it actively misled. A `UserPromptSubmit` hook is now wired (→ "running") so the bar flips back to ● the moment you send a new message. Install/remove symmetry remains marker-based and idempotent.
- **OpenCode lifecycle hooks now work on Windows and with `OPENCODE_CONFIG_DIR`.** The plugin was hardcoded to `~/.config/opencode/plugin/`, which OpenCode never scans on Windows (it uses `%APPDATA%` via xdg-basedir) and ignores any `OPENCODE_CONFIG_DIR`/`XDG_CONFIG_HOME` override — so install silently succeeded but the plugin never loaded, permanently, on a whole platform. The config dir is now resolved per-platform (`resolveOpenCodeConfigDir`): `OPENCODE_CONFIG_DIR` → `XDG_CONFIG_HOME` → `%APPDATA%`/`%LOCALAPPDATA%` on Windows → `~/.config/opencode` elsewhere.
- **OpenCode plugin no longer breaks under plain Node ESM.** The plugin used `require("http")`, which is undefined and throws `ReferenceError` at module-load under Node ESM (only working today because OpenCode runs on Bun). Switched to dynamic `import("node:http")` / `import("node:https")`, valid under both runtimes.
- **Dead localhost ports can no longer hang an agent's hook.** Both the Claude/Droid `node -e` hook command and the OpenCode plugin POST now arm a 2s socket timeout (was: none — a black-holed localhost socket could delay every `Stop` event up to the agent's own ~60s hook timeout) and drain the response. Failures stay swallowed (never break the agent's session).
- **Closed terminals no longer leak into the status-bar count.** An `onDidCloseTerminal` handler now evicts the session from the map; previously entries were never removed and the count drifted upward over a long session.
- **Monotonic failure: a terminal crash can't be overwritten by a late success.** If a non-zero exit set "failed" and a queued `Stop` hook then arrived claiming "finished", the status flipped to ✓. Both the hook path and the poll path now refuse to demote `failed` → `finished` (promotion `running` → `failed` still works).

### Tests
- 22 new tests covering the four reliability fixes: `matchSessionTerminals` (reload re-adoption pairs, counter stripping, case-insensitivity, unrelated-terminal rejection), `shouldNotify`/`notificationMessage` for `failed` (fires, error copy, exit-code suffix, repo-absent), mid-turn `UserPromptSubmit` wiring for Claude + Droid (with install⇄remove symmetry preserved), `resolveOpenCodeConfigDir` (all four platform branches + `OPENCODE_CONFIG_DIR` precedence), the OpenCode plugin's ESM `import()` + 2s socket timeout, and the Claude/Droid hook command's 2s socket timeout. Suite now at **167 tests**.
- 21 new tests for the notification channels: `shouldSystemNotify` across all three modes × every status × focus state (plus a regression guard that it does *not* inherit the toast's active-terminal suppression), `shouldPlaySound`, `isAnnouncedStatus`, and command-shape tests for `systemNotifyCommand` / `soundPlayCommand` on all platforms — asserting hostile text (`"$(id)"`, backticks, quotes) reaches the child as argv or env and never appears in a script string, that a bundle id produces the `terminal-notifier` spec with an `osascript` fallback, that a resolved notifier path replaces the bare name, that a focus URI routes the click through `-open`, and that an unsafe bundle id (`com.x" to do shell script "id`) is rejected by `isSafeBundleId` rather than spliced. Suite now at **214 tests**.

## [0.4.0] — 2026-07-21

### Added
- **Agent lifecycle awareness (Claude Code, OpenCode, Droid).** Get a VS Code notification when a supported agent finishes a task or needs your input — copy reads `✓ Claude finished · <repo>` (status glyph + agent + originating repo, so the same agent across repos is distinguishable), with a **Show** button to jump straight to its terminal. The status-bar button now shows live per-session counts (`2● 1✓ 1⏸`) and a tooltip listing each session's state. Lifecycle events come from each agent's own hook system (Claude/Droid command hooks; OpenCode ESM plugin), so statuses are accurate — not just exit-code guessing. A universal exit-status poll catches any agent whose hooks haven't fired. Toggle notifications with `agentQuickpick.lifecycleNotifications` (default on).
- **One-command global lifecycle hook install & removal.** The first time you launch a supported agent, a **one-time prompt** (per agent, ever — not per repo) offers to wire the lifecycle hook into your **user-level agent config** so it works in every repo: `~/.claude/settings.json` (Claude), `~/.factory/settings.json` (Droid), or a plugin file in `~/.config/opencode/plugin/` that OpenCode auto-loads (OpenCode). The hook only reports sessions launched from Agent Quickpick and **no-ops in agent terminals you open elsewhere**, so a global install stays inert outside VS Code. Remove all hooks in one action via the **Remove Lifecycle Hooks** command. Command-hook install/removal is symmetric, idempotent, and marker-based — it never clobbers your own hooks. An earlier testing build wrote hooks per-workspace; those are stripped automatically the first time each repo is opened.
- **Status bar button → running sessions.** An **Agent** button in the status bar (new `agentQuickpick.sessions` command) lists your currently-running agent terminals by tab name; pick one to focus it. When nothing is running it falls straight through to the launcher, and when sessions exist a **Launch new agent…** item re-enters the launcher. The `⌘/Ctrl+Shift+A` keybinding still opens the launcher directly. Sessions are matched by terminal name (base name minus any ` (N)` counter) against known agents, so they're re-adopted after a window reload with no in-memory tracking. Button shown by default; toggle with `agentQuickpick.showStatusBar`. Uses a bundled single-glyph icon font (the 2×2 agent-grid mark) registered via `contributes.icons` as `$(agent-quickpick)` — regenerate from `icons/statusbar-glyph.svg` with `npm run build:iconfont`.
- **Collision-free terminal tab names.** Launching a second tab for the same agent no longer produces two indistinguishable `Claude` tabs. Names follow VS Code's native convention — bare first, then `Claude (2)`, `Claude (3)` — and numbers are reclaimed when a tab closes (a freed bare name or a lower gap is reused first). New pure helper `uniqueTerminalName` exported for testing.

### Tests
- Tests covering the lifecycle adapter model — command-hook symmetry (install ⇄ remove round-trip, idempotency, user-hook preservation), the OpenCode plugin-file adapter (home-relative auto-load path, `AQP_SESSION`-guarded source), hook command generation, status-bar rendering, and the glyph+agent+repo notification copy. Suite at **145 tests**.
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
