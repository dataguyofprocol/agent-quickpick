# Maintainers & local dev

## Build, test, package

```bash
npm install
npm run compile     # tsc
npm run watch       # tsc -w
npm run test:unit   # fast tier: plain mocha, no editor window, ~3s (320+ tests)
npm test            # full gate: unit tier + host tier in a real editor window
npm run bench       # micro-benchmarks over the pure modules (see "Benchmarking")
npm run package     # builds the .vsix
```

CI runs on every push across Ubuntu, macOS, and Windows — build, test, package, upload the vsix as an artifact.

## Benchmarking

`npm run bench` runs the micro-benchmark suite over the vscode-free data plane (OSC 7501 parse+snapshot over a realistic burst of agent output, signal capture, rule classification with and without a match, legacy-hook strip/cleanup on realistic ~8 KB and stressed ~500 KB configs, frecency sort/write at 320–10k entries, the exit-status poller at 500 terminals, `loadAgents`, status-bar render). It prints median/p95 per op and a rough heap-per-op (via `--expose-gc`), and saves a JSON snapshot under `bench-results/` (gitignored). A recorded baseline table lives in README.md ("Performance baseline") — refresh it there when a deliberate perf change lands.

The A/B workflow for a refactor:

```bash
npm run bench                                                # on the old code → snapshot A
# ...apply the refactor...
npm run bench                                                # → snapshot B
npm run bench -- --compare bench-results/<A>.json bench-results/<B>.json
```

Reading the output honestly:

- **Same machine, same background load.** Run-to-run jitter on identical code is a few percent (up to ~10% for the I/O-bound server scenario), which is why `--compare` only flags |Δmedian| ≥ 10% — deltas below that are noise, not signal.
- **It's a measuring tool, not a gate.** There are deliberately no perf-budget assertions and no CI wiring. The bench answers "did refactor X move the number"; it does not find problems. Every perf/memory win in the v0.12.x overhaul came from code reading, not measurement — that stays the primary lens.
- **Only bench what has a reason to get slower.** Scenarios exist for per-keystroke / per-hook-event / per-poll-tick paths and user-controlled file sizes. A scenario without a refactor in mind is a scoreboard entry, not a signal.

What the bench **cannot** cover, and how to measure it manually when it matters:

- **First-command activation** (probe prewarm, port file write, poller start): Command Palette → "Developer: Startup Timings" → Extension Activation Timings, in a window where the extension activates on first command.
- **PATH-probe burst** (~20 `command -v` spawns on first open): time `resolveAgents` ad hoc, or profile the extension host (Developer: Take Extension Host Profile) while opening the quick pick cold.
- **Real memory leaks** (timers/terminals retained past dispose): these live in the vscode-coupled half and show up as retention across a long-lived window, not as heap-per-op. The extension host profile's heap snapshot diff is the tool; the last real leaks (launch-delay timer, unpruned frecency) were found by reading, and that pattern held across the whole audit.

## Source layout

- `src/extension.ts` — the vscode-coupled half of the extension: `activate`, `resolveIconPath`, `resolveColor`, launch flow, and the `LifecycleContext` class (a thin adapter over `SessionTracker`: terminal events in, status transitions out; exported for host-tier tests).
- `src/agents.ts` — the vscode-free half: `BUILTIN_AGENTS`, `loadAgents`, frecency, install detection + cache, `launchText`/`launchDelay`, terminal naming/session matching. Unit-testable without a host.
- `src/program-status.ts` / `src/terminal-signals.ts` / `src/detect.ts` / `src/detect-manifests.ts` / `src/session-tracker.ts` / `src/legacy-hooks.ts` — the status pipeline: protocol parsing, terminal signal capture, fallback rules, the state machine, and removal of hooks older versions installed. All pure (no runtime `vscode`).
- `src/lifecycle.ts` — presentation and VS Code-coupled bits: status-bar rendering, notification copy + notify/sound command builders, and the exit-status poller. Pure helpers stay free of runtime `vscode`.
- `src/test/unit/*.test.ts` — unit tier (plain mocha, no host): the OSC 7501 parser and record selection, terminal signal capture, the fallback rule table (including a suite asserting the rules *not* ported from Herdr stay silent on transcript-like text), the session state machine, legacy-hook removal, status-bar/notification rendering, the exit-status poller, a seeded fuzz suite, and repo-consistency drift guards (colors ↔ package.json, icons ↔ BUILTIN_AGENTS, legacy targets ↔ built-ins).
- `src/test/bench/*.ts` — manually-run micro-benchmarks over the same vscode-free modules (see "Benchmarking"). Not collected by either test tier.
- `src/test/suite/*.test.ts` — host tier (@vscode/test-electron): icon/color resolution, `LifecycleContext` orchestration, activation smoke tests.
- `icons/*.svg` — one brand icon per agent. House style: 24×24 viewBox, `rx=6` rounded background, white glyph on brand fill.
- `package.json` — `contributes.configuration` (settings schema), `contributes.colors` (8 custom theme colors), command + keybinding.
- `.github/assets/` — README screenshots (real PNG captures).

## Adding a built-in agent

1. Drop an SVG in `icons/` (24×24, house style).
2. Add an entry to `BUILTIN_AGENTS` in `src/agents.ts`. Set `launcher` only if the agent is genuinely invoked through a package-fetching launcher (e.g. `uvx aider`, `npx <pkg>`); otherwise leave it unset so detection probes the binary on PATH directly. Do NOT set `launcher` just because a tool *can* be installed via a package manager — only when the launcher is the required invocation.
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
- **Status detection** answers one question per agent terminal — is it working, blocked on you, finished, or failed — and reports it through notifications, the status bar, and the sessions picker. It has four sources, in strict priority order. **(1) OSC 7501, the Program Status Protocol** (`src/program-status.ts`) is authoritative: an agent that reports its own state is believed, and its records can be numerous and hierarchical (a `blocked` sub-task is surfaced even while the root record says `working`; a missing optional key is treated as absent, a malformed `state`/`id` or a bad `msg`/`title` discards the report). **(2) Heuristics** (`src/detect.ts`, `src/detect-manifests.ts`) cover agents that don't speak the protocol, matching window-title spinners/glyphs, `OSC 9;4` progress and a line-oriented text tail against per-agent rule tables derived from Herdr's detection manifests (Apache-2.0 — see `THIRD_PARTY_NOTICES.md`; the rule model is Herdr's, but only its `osc_title`/`osc_progress`/text regions are portable without a rendered screen buffer, so every screen-geometry rule was dropped rather than approximated, and only a rule flagged `visibleBlocker` may raise a notification). **(3) The process exit code** is the only non-protocol source allowed to claim `done`/`error`. **(4) Otherwise the session settles**: output means `working`, quiet means `idle`, and `unknown` until evidence arrives. `done`/`error` latch — they survive the process, while `working`/`blocked` are dropped at the next command — so a crash is reported even after a `done` report, and stale text cannot revive a finished session. Output reaches `src/session-tracker.ts` (the pure state machine) from `src/terminal-signals.ts`, fed by VS Code's shell integration over `execution.read()`; that API is 1.93+, which is where `engines.vscode` sits, and a 3-second exit-status poll backstops terminals whose shell integration never comes up. User-driven tab renames alias the current display name back to the terminal's creation-time key, so status, notifications, exit polling and click-to-focus all follow; launch naming reserves those keys so a new launch cannot collide with a running renamed tab. VS Code's stable API cannot badge a terminal tab after creation, so per-session status surfaces via notifications + the status bar instead. **Launch-time reporters** (`src/agent-reporters.ts`, `reporters/`) make Claude Code (`--settings` hooks) and OpenCode V2 (a TUI plugin via `OPENCODE_CLI_CONFIG_CONTENT`) emit OSC 7501 for the terminals we launch, since neither can report natively in VS Code; they are per-launch shims, not installs. **Nothing is installed.** Earlier releases wrote hooks into agent configs; `src/legacy-hooks.ts` now only *removes* them (marker-scoped, plus a one-time automatic cleanup after upgrade) and the "Remove Legacy Lifecycle Hooks" command remains for a manual sweep.

## Static-analysis triage (post-v0.9.2 Mimosa deep scan)

A sealed deep scan (scan ID `scan-2026-08-21T20-21-02.514Z-b094fc374ff4`, artifacts under `~/.mimosa/security-scans/`) reported 7 findings (4 high / 3 medium) against code that commit 8bdc728 had already hardened. Dispositions:

- **Icon path traversal (CWE-22)** — false positive: the bundled-icon branch of `resolveIconPath` has an explicit root-containment check (`fsPath === root || fsPath.startsWith(root + path.sep)`); the scanner's line anchor fell between branches.
- **`fireAndForget` command-injection taint** — remediated in v0.9.2, three layers: spawn takes an argv array with no shell (shell injection structurally impossible), notification text passes through `sanitizeArgvText`, osascript receives title/body as `on run argv` arguments, Windows toast text rides env vars read by PowerShell, and bundle ids are gated by `isSafeBundleId`.
- **OpenCode config-dir path-traversal taints** — remediated in v0.9.2 via a strict validator; v0.9.3 deleted the unused lenient resolver and moved the strict logic into pure, unit-tested `resolveValidatedOpenCodeConfigDir` (relative `OPENCODE_CONFIG_DIR` throws; result must be absolute for the target platform).
- **`$PATH` taint into `notifierCandidates`** — v0.9.3 removed the dead parameter entirely; `$PATH` is deliberately never probed.

A v0.9.3 rescan (`scan-2026-08-22T15-44-47.446Z-898d01845335`) confirmed the command-injection, icon-traversal, and `$PATH` findings no longer fire; 4 advisory findings remain, all anchored at the two `resolveValidatedOpenCodeConfigDir` call sites in `adapterFsPath`/`adapterDisplayPath`. These are **accepted by design**: the whole point of that resolver is that `OPENCODE_CONFIG_DIR`/`XDG_CONFIG_HOME`/`APPDATA` overrides (env-derived by definition) choose the OpenCode config dir, mirroring OpenCode's own xdg-basedir semantics. The resolver rejects relative overrides, normalizes away traversal segments, verifies the result is absolute, and only ever joins the compile-time-constant plugin filename — so the worst case is a user (who set the override themselves) writing our plugin into a directory of their own choosing. Static analyzers will keep flagging this chain; triage can stop re-litigating it.

**Resolved risk:** the lifecycle HTTP server — which bound to a localhost port and accepted unauthenticated POSTs, letting any local process forge status for a tracked session — is gone. v0.13.0 removed hook installation (and the server with it) in favour of the protocol and terminal heuristics; the attack surface no longer exists, so there is nothing left to authenticate.
