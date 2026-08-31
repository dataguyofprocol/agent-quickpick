# Maintainers & local dev

## Build, test, package

```bash
npm install
npm run compile     # tsc
npm run watch       # tsc -w
npm run test:unit   # fast tier: plain mocha, no editor window, ~3s (320+ tests)
npm test            # full gate: unit tier + host tier in a real editor window
npm run package     # builds the .vsix
```

CI runs on every push across Ubuntu, macOS, and Windows — build, test, package, upload the vsix as an artifact.

## Source layout

- `src/extension.ts` — the vscode-coupled half of the extension: `activate`, `resolveIconPath`, `resolveColor`, launch flow, and the `LifecycleContext` class (session tracking, status-bar updates, notifications, hook install/remove; exported for host-tier tests).
- `src/agents.ts` — the vscode-free half: `BUILTIN_AGENTS`, `loadAgents`, frecency, install detection + cache, `launchText`/`launchDelay`, terminal naming/session matching. Unit-testable without a host.
- `src/lifecycle.ts` — lifecycle awareness shared core: types, the `LifecycleAdapter` interface, pure functions (JSON config helpers, command-hook merge/strip, status-bar rendering, notification logic, notify/sound command builders), and the VS Code-coupled HTTP server + exit-status poller.
- `src/lifecycle-adapters.ts` — one adapter per lifecycle-aware agent: Claude Code, Droid, Codex (shared Claude-schema command hooks), Antigravity (named-registry command hooks in `~/.gemini/config/hooks.json`), and OpenCode (file-based ESM plugin). Registry + lookup helpers.
- `src/test/unit/*.test.ts` — unit tier (plain mocha, no host): merge/detection/frecency logic, adapter symmetry, status-bar/notification rendering, **behavioral** suites that execute the generated hook command and OpenCode plugin against a real localhost server, the exit-status poller, a seeded fuzz suite, and repo-consistency drift guards (colors ↔ package.json, icons ↔ BUILTIN_AGENTS).
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
- **Lifecycle awareness** tracks per-session status (running / finished / waiting / failed) for Claude Code, Codex, Antigravity, OpenCode, and Droid. Each agent is abstracted behind a `LifecycleAdapter` — Claude, Droid, and Codex share a command-hook schema (`hooks.<Event>` in settings JSON); Antigravity uses a *named-registry* `hooks.json` (one `"agent-quickpick"` entry; `PreToolUse` handlers are matcher-wrapped, lifecycle events flat; a user's `enabled:false` toggle survives merges, and its Stop payload is rich enough to distinguish error-crashes and not-yet-idle runs via status expressions in the generated command); OpenCode uses a self-contained ESM plugin dropped into its config dir's `plugin/` folder (auto-discovered, no JSON edit). On `activate`, a localhost HTTP server (random port) receives POSTs from agent hooks; each lifecycle-aware terminal is injected with `AQP_HOOK_URL` + `AQP_SESSION` env vars via `createTerminal({ env })`. Install and removal are symmetric and idempotent — both are one-file-read → marker-based-transform → one-write. Hooks are identified by a unique marker (`agentQuickpick:<agent>`), so stripping ours never clobbers the user's own hooks. A 3-second exit-status poll is a universal fallback for agents whose hooks haven't fired. VS Code's stable API cannot badge a terminal tab after creation, so per-session status surfaces via notifications + the status bar instead.

## Static-analysis triage (post-v0.9.2 Mimosa deep scan)

A sealed deep scan (scan ID `scan-2026-08-21T20-21-02.514Z-b094fc374ff4`, artifacts under `~/.mimosa/security-scans/`) reported 7 findings (4 high / 3 medium) against code that commit 8bdc728 had already hardened. Dispositions:

- **Icon path traversal (CWE-22)** — false positive: the bundled-icon branch of `resolveIconPath` has an explicit root-containment check (`fsPath === root || fsPath.startsWith(root + path.sep)`); the scanner's line anchor fell between branches.
- **`fireAndForget` command-injection taint** — remediated in v0.9.2, three layers: spawn takes an argv array with no shell (shell injection structurally impossible), notification text passes through `sanitizeArgvText`, osascript receives title/body as `on run argv` arguments, Windows toast text rides env vars read by PowerShell, and bundle ids are gated by `isSafeBundleId`.
- **OpenCode config-dir path-traversal taints** — remediated in v0.9.2 via a strict validator; v0.9.3 deleted the unused lenient resolver and moved the strict logic into pure, unit-tested `resolveValidatedOpenCodeConfigDir` (relative `OPENCODE_CONFIG_DIR` throws; result must be absolute for the target platform).
- **`$PATH` taint into `notifierCandidates`** — v0.9.3 removed the dead parameter entirely; `$PATH` is deliberately never probed.

A v0.9.3 rescan (`scan-2026-08-22T15-44-47.446Z-898d01845335`) confirmed the command-injection, icon-traversal, and `$PATH` findings no longer fire; 4 advisory findings remain, all anchored at the two `resolveValidatedOpenCodeConfigDir` call sites in `adapterFsPath`/`adapterDisplayPath`. These are **accepted by design**: the whole point of that resolver is that `OPENCODE_CONFIG_DIR`/`XDG_CONFIG_HOME`/`APPDATA` overrides (env-derived by definition) choose the OpenCode config dir, mirroring OpenCode's own xdg-basedir semantics. The resolver rejects relative overrides, normalizes away traversal segments, verifies the result is absolute, and only ever joins the compile-time-constant plugin filename — so the worst case is a user (who set the override themselves) writing our plugin into a directory of their own choosing. Static analyzers will keep flagging this chain; triage can stop re-litigating it.

**Accepted risk (unchanged):** the lifecycle HTTP server binds to localhost on a random port and performs no request authentication, so any local process can POST a spoofed `{session, status}` payload naming a tracked session and forge status-bar/notification output. Localhost-only, low severity; fixing it means threading a per-session token through every adapter's generated hook/plugin and is deliberately deferred.
