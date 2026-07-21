<p align="center">
  <img src="./icons/icon.png" width="96" alt="Agent Quickpick Icon">
</p>

<h1 align="center">Agent Quickpick</h1>

<p align="center">
  One quick pick for every terminal coding-agent CLI. Hit <b>⌘⇧A</b> / <b>Ctrl+Shift+A</b>, pick an agent, and launch it in an editor tab with its icon and color theme.
</p>

<p align="center">
  <a href="https://github.com/dataguyofprocol/agent-quickpick/actions"><img src="https://github.com/dataguyofprocol/agent-quickpick/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

---

<p align="center">
  <img src="./.github/assets/demo.gif" width="100%" alt="Agent Quickpick Demo">
</p>

---

Works in **VS Code**, **Cursor**, **Windsurf**, **Trae**, **Antigravity**, **Vodium**, or any VS Code fork.

## Features

- **Editor-area terminals**: Opens agents as editor tabs (instead of down in the bottom panel), making it easy to split editors and run agents side-by-side.
- **Icons & theme colors**: Each agent gets a dedicated icon and tab color (Claude orange, OpenCode blue, etc.) so you can tell them apart at a glance.
- **PATH detection & hidden state**: Uninstalled agents stay hidden by default. Click the eye icon in the quick pick bar to reveal them under a "Not installed" section.
- **Frecency sorting**: Agents you launch most often float to the top automatically. Order syncs across machines via Settings Sync.

## Built-in agents

Out of the box support for 19 CLI agents:

| Agent | Command | Agent | Command |
|---|---|---|---|
| Claude | `claude` | Goose | `goose` |
| Codex | `codex` | Crush | `crush` |
| Gemini | `gemini` | Amp | `amp` |
| Copilot | `gh copilot` | Droid | `droid` |
| OpenCode | `opencode` | Qwen | `qwen` |
| Command Code | `cmd` | Plandex | `plandex` |
| Aider | `aider` | Grok | `grok` |
| Cody | `cody` | Kilo | `kilo` |
| Qodo | `qodo` | oh-my-pi | `omp` |
| Terminal | *(plain shell)* | | |

## Installation

1. Grab the latest `.vsix` from [GitHub Actions artifacts](https://github.com/dataguyofprocol/agent-quickpick/actions).
2. In VS Code, open the Extensions panel (`⌘ShiftX` / `CtrlShiftX`).
3. Click `⋯` in the top right → **Install from VSIX…** and pick the downloaded file.

*(VS Code Marketplace listing coming soon.)*

## Customizing

No configuration is needed out of the box. To add custom agents or tweak built-ins, edit `agentQuickpick.agents` in `settings.json`:

```jsonc
"agentQuickpick.agents": [
  {
    "name": "Claude GLM",
    "cmd": "claude-glm",
    "icon": "claude-glm.svg",              // bundled SVG filename, absolute path, or codicon ID
    "color": "agentQuickpick.claudeGlm"     // built-in color ID or terminal.ansi* key
  },
  {
    "name": "Aider (uvx)",
    "cmd": "aider",
    "launcher": "uvx",                      // probes `uvx` on PATH, runs `uvx aider`
    "icon": "aider.svg"
  },
  { "name": "Droid", "hidden": true }       // hides a built-in agent
]
```

### Settings reference

| Field | Required | Notes |
|---|---|---|
| `name` | Yes | Display name in the quick pick and terminal tab. |
| `cmd` | No | Command to run. Empty opens a plain shell. Shell functions and aliases work. |
| `launcher` | No | Prefix binary (`uvx`, `npx`, `pipx`). Detection checks this on PATH and runs `${launcher} ${cmd}`. |
| `icon` | No | Codicon ID (`rocket`, `beaker`), absolute file path, or bundled SVG filename. Defaults to `terminal`. |
| `color` | No | Built-in color ID (`agentQuickpick.claude`) or `terminal.ansi*` key. |
| `hidden` | No | Set `true` to hide an agent. |

### Notes

- **Custom colors for user agents**: VS Code requires theme colors to be registered statically at publish time. Custom agents can choose from the 8 built-in agent color IDs + 16 `terminal.ansi*` keys (24 theme-aware colors total). Icons have no such limit.
- **Using shell aliases**: If your agent commands rely on shell functions or aliases that aren't binaries on `PATH`, turn off detection so they aren't hidden:
  ```jsonc
  "agentQuickpick.detectInstalled": false
  ```
- **Terminal auto-activation leaks**: If a virtualenv activation script (e.g. from the Python extension) bleeds into an agent's prompt on launch, adjust the startup delay to let activation finish first:
  ```jsonc
  "agentQuickpick.launchDelayMs": 500    // default 300ms; set 0 to disable
  ```

---

- Maintainers & local dev: [MAINTAINERS.md](./MAINTAINERS.md)
- Release notes: [CHANGELOG.md](./CHANGELOG.md)
- License: [MIT](./LICENSE)
