# Agent Quickpick

![CI](https://github.com/dataguyofprocol/agent-quickpick/actions/workflows/ci.yml/badge.svg)

One quick pick for every terminal coding-agent CLI. Hit **⌘⇧A** / **Ctrl+Shift+A**, pick an agent, get a terminal in the editor area with its own icon and tab color.

Works in VS Code, Cursor, Windsurf, Trae, Antigravity, Vodium — any VS Code fork.

---

<p align="center">
  <em>Default view — only installed agents</em><br>
  <img src="./.github/assets/quickpick-default.png" width="540" alt="Quick pick showing only installed agents">
</p>

## How it works

Out of the box the quick pick lists the standard coding-agent CLIs, each with its own icon and a themed tab color. Agents whose command isn't on your `PATH` are **hidden by default** — click the eye button in the title bar to reveal them under a "Not installed" divider.

<p align="center">
  <img src="./.github/assets/quickpick-revealed.png" width="540" alt="Quick pick with uninstalled agents revealed"><br>
  <em>Revealed view — click the eye to toggle</em>
</p>

Picking an agent opens it in the **editor area** (not the bottom panel), so multiple agents sit side-by-side as editor tabs, each color-coded:

<p align="center">
  <img src="./.github/assets/terminals-side-by-side.png" width="640" alt="Two agent terminals side by side in the editor area">
</p>

### Built-in agents

| | Agent | Command | | Agent | Command |
|---|---|---|---|---|---|
| 🟧 | Claude | `claude` | 🟨 | Goose | `goose` |
| 🟩 | Codex | `codex` | 🟪 | Crush | `crush` |
| 🟦 | Gemini | `gemini` | 🟪 | Amp | `amp` |
| 🟦 | Copilot | `gh copilot` | 🟨 | Droid | `droid` |
| 🟦 | OpenCode | `opencode` | 🟦 | Qwen | `qwen` |
| 🟪 | Command Code | `cmd` | 🟦 | Plandex | `plandex` |
| 🟥 | Aider | `aider` | ⬜ | Grok | `grok` |
| 🟪 | Cody | `cody` | 🟦 | Kilo | `kilo` |
| 🟩 | Qodo | `qodo` | 🟪 | oh-my-pi | `omp` |
| ⬜ | Terminal | *(plain shell)* | | | |

## Add your own agent

In `settings.json`:

```jsonc
"agentQuickpick.agents": [
  {
    "name": "Claude GLM",
    "cmd": "claude-glm",
    "icon": "claude-glm.svg",              // bundled filename, absolute path, or codicon id
    "color": "agentQuickpick.claudeGlm"     // built-in id or terminal.ansi*
  },
  { "name": "Droid", "hidden": true }       // hides a built-in
]
```

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Display name. |
| `cmd` | no | Shell command. Empty = plain terminal. Aliases/functions work (VS Code terminals are interactive). |
| `icon` | no | Codicon id (`rocket`, `beaker`, `hubot`), absolute SVG/PNG path, or bundled filename. Missing file → `terminal` codicon fallback. |
| `color` | no | Built-in id (`agentQuickpick.claude`, …) or stock `terminal.ansi*` key. Invalid → no tab color. |
| `hidden` | no | `true` hides a built-in. |

> **Why can't my custom agent get a brand-new color?** VS Code only registers theme colors at publish time, so user-added agents pick from the 8 built-in ids + 16 `terminal.ansi*` keys (24 theme-aware options). Icons have no such limit.

If all your agents rely on shell aliases (`claude-proxy`, etc.), turn detection off so they all show:

```jsonc
"agentQuickpick.detectInstalled": false
```

## Install

**From a built `.vsix`** (latest build is in [GitHub Actions artifacts](https://github.com/dataguyofprocol/agent-quickpick/actions)):

```bash
code     --install-extension agent-quickpick-0.2.2.vsix
cursor   --install-extension agent-quickpick-0.2.2.vsix
windsurf --install-extension agent-quickpick-0.2.2.vsix
trae     --install-extension agent-quickpick-0.2.2.vsix
```

Or via any editor's UI: **Extensions** panel → **⋯** → **Install from VSIX…**

**From source** (dev mode, no packaging):

```bash
code --extensionDevelopmentPath=.
```

---

## For maintainers & forks

```bash
npm install
npm run compile     # tsc
npm run watch       # tsc -w
npm test            # runs the unit suite in a headless VS Code (35 tests)
npm run package     # builds the .vsix
```

CI runs on every push across Ubuntu, macOS, and Windows — build, test, package, upload the vsix as an artifact.

### Source layout

- `src/extension.ts` — the extension: `BUILTIN_AGENTS`, `loadAgents`, `resolveIconPath`, `resolveColor`, `isCmdInstalled`, `isSafeBinaryName`.
- `src/test/suite/extension.test.ts` — unit tests for the merge/icon/color/detection logic.
- `icons/*.svg` — one brand icon per agent. House style: 24×24 viewBox, `rx=6` rounded background, white glyph on brand fill.
- `package.json` — `contributes.configuration` (settings schema), `contributes.colors` (8 custom theme colors), command + keybinding.
- `.github/assets/` — README mockups. **Replace with real PNGs/GIFs when you capture them** — see [CONTRIBUTING](#capturing-screenshots) below.

### Adding a built-in agent

1. Drop an SVG in `icons/` (24×24, house style).
2. Add an entry to `BUILTIN_AGENTS` in `src/extension.ts`.
3. Only if you want a brand-new color id: add a matching `contributes.colors` entry in `package.json`. Otherwise reuse a `terminal.ansi*` key.

### Capturing screenshots

The mockups in `.github/assets/*.svg` are placeholders. To replace with real captures:

1. `code --extensionDevelopmentPath=.` with the GitHub Dark theme.
2. Screenshot the quick pick in (a) default view, (b) revealed view, (c) two terminals side-by-side.
3. For the demo GIF: record ⌘⇧A → pick Claude → ⌘⇧A → pick OpenCode → 6–10s, 15fps, ~600px wide.
4. Drop them in `.github/assets/` and update the image links in this README.

### Architecture notes

- **Detection** runs `command -v <binary>` (or `where` on Windows) per agent, in parallel, with results cached for the session. Binary names are validated against a safe-character allowlist before exec — a malicious or typo'd setting can't inject shell commands.
- **Icon resolution** falls back gracefully: codicon → existing file → `terminal` codicon. A broken icon path never breaks the quick pick.
- **Colors** are a closed set (8 built-ins + 16 ANSI) because VS Code registers theme colors at publish time only.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md). Notable: 0.2.0 added settings-driven agents, install detection with the eye toggle, and the test suite; 0.2.2 added the injection guard, parallelized detection, and CI.

## License

MIT — see [LICENSE](./LICENSE). Icons are original stylized artwork, not official brand marks.
