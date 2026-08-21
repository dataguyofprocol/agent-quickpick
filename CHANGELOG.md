# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.2] — 2026-08-20

### Fixed
- **macOS notification clicks are now reliably actionable.** When a notification carried `-sender <bundleId>`, macOS consistently attributed the banner to the editor and ignored the `-open`/`-execute` click action, so the banner was visible but non-clickable. Clickable lifecycle notifications now use `-open <focusUri>` without `-sender`, letting terminal-notifier own the banner so the click reliably reaches our URI handler. The notification icon reverts to terminal-notifier's own icon for clickable banners; the editor's icon is still used for the rare non-URI fallback (`-sender -activate`).

## [0.9.1] — 2026-08-20

### Fixed
- **macOS notification clicks are now reliably actionable.** The v0.8.0 `-sender <bundleId> -open <focusUri>` click action was often swallowed by macOS when the banner was attributed to the editor (the most visible symptom: the banner appeared but clicking it did nothing). The banner now uses `-execute '/usr/bin/open "<focusUri>"'` instead, which keeps the editor's icon via `-sender` while making the click run `open` and deliver the URI to our handler. This fixes dead clicks in VS Code forks such as Trae/TraeCode as well as stable VS Code.

## [0.9.0] — 2026-08-18

### Added
- **Waiting toasts now say *why* the agent needs you.** Instead of a generic "Claude needs your input", a permission ask reads "⏸ Claude wants to run a command — approve?" and an OpenCode question reads "⏸ OpenCode asked a question — needs your answer". The same reason-aware wording shows in the sessions picker and the status-bar tooltip ("wants a command approved" / "asked a question"). Sources: OpenCode's typed `permission.asked` / `question.asked` events (previously collapsed into one generic "blocked"), and Claude's Notification-hook `message` (previously discarded by the hook command — now forwarded and classified by a conservative keyword match). Droid shares Claude's hook schema but its stdin carries no message, so its waits stay generic. New pure, unit-tested helpers: `classifyWaitingMessage`, `waitingHeadline`, `waitingLabel`.

### Fixed
- **macOS notifications now wear the running editor's icon out of the box.** Previously a fresh install without `terminal-notifier` on `$PATH` fell back to `osascript`, which macOS credits to **Script Editor** (grey scroll icon, click opens its folder in Finder). Agent Quickpick now bundles a universal `terminal-notifier.app` (x86_64 + arm64; macOS 10.10 / 11.0+) under `resources/notifier/`, so a properly attributed banner is the default on every Mac. A user-installed copy (Homebrew/MacPorts/`$PATH`) still wins when present. macOS Notification Center shows the icon of the sending app's bundle with no runtime override, so a bundled `.app` is the only way to fix this without asking the user to install anything. Resolution is driven by a new pure, unit-tested helper `notifierCandidates`.
- **Clicking a notification now reliably raises the editor window and focuses that agent's terminal.** The banner is posted with `-sender <editor bundleId> -open <focusUri>`; opening the `<scheme>://` URL activates the editor (LaunchServices raises the window that registered the scheme), and the URI handler reveals the specific session's terminal. The focus-URI contract (path + `session` query param) is centralized in a pure, unit-tested helper `sessionFromFocusUri` so the producer (`focusUri`) and the click consumer can't drift. The handler is now async and wrapped so a malformed URI or a closed terminal falls through to the sessions picker instead of no-op'ing or throwing.
- **A fork no longer wears VS Code's icon when its bundle id can't be read.** `hostBundleId` fell back to `com.microsoft.VSCode` whenever `__CFBundleIdentifier` was unset, so a fork (Cursor/Trae/Windsurf) with a sanitized env would show VS Code's icon. It now only assumes VS Code when `vscode.env.uriScheme` agrees (`vscode` / `vscode-insiders`); otherwise it declines to guess and the banner is left to the notifier fallback rather than mis-attributed.

## [0.7.2] — 2026-07-30

### Fixed
- **A partly-installed hook config now self-heals.** `hasCurrentCommandHooks` checked only whether the version tag appeared *somewhere* in the file, so a config that had lost one event's hook (hand-deleted, or a write interrupted mid-merge) read as current forever while that event stayed dead. The check is now per-event: every wired event must carry a current hook, otherwise the config is treated as stale and re-merged.
- **Upgrades no longer leave two generations of our hook firing side by side.** `mergeCommandHooks` now drops hooks of ours written by an older schema version before appending the current form, instead of appending beside them. Still idempotent, and a re-merge fills a missing event without duplicating one that's already present.
- **A user hook sharing an entry with ours is no longer deleted with it.** Install and remove both filter per *hook* rather than per entry, so other commands in the same entry survive, along with the entry's other keys (`matcher`). Entries left holding nothing of ours are dropped rather than left as `{ hooks: [] }` litter.
- **Hook config writes are atomic.** Settings are written to a unique sibling temp file and renamed over the target, so a crash or a concurrent reader never sees a half-written `~/.claude/settings.json` / `~/.factory/settings.json` — a truncated write there breaks every agent session, not just ours. Falls back to a plain write if the rename fails.

### Tests
- Coverage for per-event staleness, stale-hook replacement, shared-entry preservation, and partial-install healing.
- `runTest.ts` now tests against an installed VS Code fork (Trae/Cursor/Windsurf) when present, or `AQP_TEST_VSCODE`, instead of always downloading a 300 MB stable build.

## [0.7.1] — 2026-07-28

### Fixed
- **Lifecycle notifications silently self-heal after an update, no relaunch needed.** Two compounding bugs fixed: (1) hook installs were only ever checked by marker presence, so a schema change in a later release never reached existing users — hooks now carry a version tag and are silently re-installed on activation when stale. (2) the hook server's port was baked into a frozen per-terminal env var, so any extension restart permanently orphaned already-open terminals — the current port is now also written to a stable file under global storage and checked first, so live terminals recover on their next hook event even after a restart.

## [0.7.0] — 2026-07-27

### Added
- **Double-tap `⌘⇧A` / `Ctrl+Shift+A` to open running sessions.** A single press opens the launcher; a second press within 250ms opens the running-sessions picker (falls back to the launcher when nothing is running). The launcher also opens instantly with a busy indicator while install detection resolves.
- **Native OS notifications.** Lifecycle events now raise a real OS notification (macOS Notification Center, Windows toast, Linux `notify-send`) in addition to the VS Code toast, so they reach you when the editor is in the background or on another Space. New `agentQuickpick.systemNotifications`: `off` | `whenUnfocused` | `always` (default `always`). On macOS, `terminal-notifier` is used when installed and is attributed to the host editor with a click that focuses the agent's terminal; otherwise `osascript`.
- **Notification sound.** A single cue (`media/sounds/notif.wav`) plays for every announced status. Toggle with `agentQuickpick.notificationSound` (default on); override the file with `agentQuickpick.notificationSoundPath`.

### Changed
- **Status bar is scoped to the active repo.** The count and sessions picker now filter to the active workspace folder (captured at launch, refreshed from each hook's `cwd`), so the bar shows only this repo's agents. The tooltip appends a folder basename so the same agent across repos stays distinguishable.

### Fixed
- **Re-adopted terminals no longer show as "working" after a host reload.** Surviving tabs now start in a new `unknown` ("○ reconnecting") state, never notified or claimed as working, and are promoted by the first hook or the exit poller.
- **Lifecycle notifications now survive a window reload.** Surviving agent terminals are re-adopted into the session map on activate, so hooks keep landing. Backed by a new exported helper `matchSessionTerminals`.
- **Crashed agents are now visible.** A non-zero exit now fires an error-severity toast (`✗ Claude crashed · my-app · exit 130`) with a **Show** button; previously it was silent.
- **Status is truthful mid-turn (Claude, Droid).** A `UserPromptSubmit` hook now flips the bar back to "running" the moment you send a new message, instead of staying on ✓ through the next turn.
- **OpenCode lifecycle hooks now work on Windows and honor `OPENCODE_CONFIG_DIR`.** The plugin dir is resolved per-platform via `resolveOpenCodeConfigDir` (env override → XDG → `%APPDATA%` on Windows → `~/.config/opencode`).
- **OpenCode plugin no longer breaks under plain Node ESM.** Switched from `require("http")` to dynamic `import("node:http")` / `import("node:https")`, valid under both Bun and Node.
- **Dead localhost ports can no longer hang an agent's hook.** Both the Claude/Droid hook command and the OpenCode plugin POST now arm a 2s socket timeout.
- **Closed terminals no longer leak into the status-bar count.** An `onDidCloseTerminal` handler evicts sessions from the map.
- **A terminal crash can no longer be overwritten by a late success.** Both the hook and poll paths refuse to demote `failed` → `finished`.
- **Remove Lifecycle Hooks now always re-arms the install prompt.** The flag is reset for every adapter, whether or not anything was stripped (previously stuck on `declined` for dismissed agents).

### Tests
- 22 new tests covering the reliability fixes: `matchSessionTerminals`, `failed`-status notifications, mid-turn `UserPromptSubmit` wiring, `resolveOpenCodeConfigDir`, and the OpenCode/Claude/Droid socket timeouts. Suite now at **167 tests**.
- 21 new tests for the notification channels: `shouldSystemNotify` across modes/statuses/focus, `shouldPlaySound`, `isAnnouncedStatus`, and command-shape tests on all platforms (hostile-text argv/env safety, `terminal-notifier` + `osascript` fallback, focus-URI routing, `isSafeBundleId`). Suite now at **214 tests**.

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
