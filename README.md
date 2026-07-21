# Agent Quickpick

Quick-pick launcher extension for terminal coding-agent CLIs in VS Code and compatible editor forks.

Agent Quickpick opens CLI agent terminals directly in the editor workspace area—rather than the bottom panel—assigning each session a dedicated tab icon and color theme.

<p align="center">
  <img src="./.github/assets/demo.gif" width="100%" alt="Agent Quickpick extension demonstration">
</p>

## Compatibility

- **VS Code**: `^1.85.0`
- **Supported Editors**: VS Code, Cursor, Windsurf, Trae, Antigravity, Vodium, and other VS Code derivatives.

## Key Behaviors

- **Editor-Area Placement**: Terminal sessions instantiate as editor tab documents, enabling side-by-side split layouts and multi-agent workflows.
- **Visual Distinction**: Dedicated SVG icon and theme color per agent CLI for instant visual identification across active editor tabs.
- **PATH Detection & Filtering**: Uninstalled agents are hidden by default. The quick-pick title bar includes a toggle (eye icon) to inspect uninstalled CLIs under a "Not installed" section.
- **Frecency Ranking**: Agent ordering uses a frecency algorithm (frequency + recency). Usage metadata synchronizes across devices via VS Code Settings Sync.

## Default Agent Registry

Agent Quickpick includes preconfigured definitions for 19 CLI tools:

| Agent Name | Command | Agent Name | Command |
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

### VSIX Installation

1. Download the `.vsix` package from the [GitHub Actions Artifacts](https://github.com/dataguyofprocol/agent-quickpick/actions) of the latest build.
2. In VS Code, navigate to **Extensions** (`Ctrl+Shift+X` / `Cmd+Shift+X`).
3. Open the overflow menu (`⋯`) and select **Install from VSIX…**.
4. Select the downloaded `.vsix` file.

*(VS Code Marketplace release pending.)*

## Configuration

Custom agent definitions and overrides are configured via `agentQuickpick.agents` in `settings.json`.

```jsonc
{
  "agentQuickpick.agents": [
    {
      "name": "Claude GLM",
      "cmd": "claude-glm",
      "icon": "claude-glm.svg",
      "color": "agentQuickpick.claudeGlm"
    },
    {
      "name": "Aider (uvx)",
      "cmd": "aider",
      "launcher": "uvx",
      "icon": "aider.svg"
    },
    {
      "name": "Droid",
      "hidden": true
    }
  ]
}
```

### Agent Configuration Schema

| Setting | Type | Required | Default | Description |
|---|---|:---:|---|---|
| `name` | `string` | Yes | — | Display label in quick-pick menu and terminal tab header. |
| `cmd` | `string` | No | `""` | Shell command executed upon terminal creation. Empty string launches default interactive shell. |
| `launcher` | `string` | No | — | Binary prefix (e.g., `uvx`, `npx`, `pipx`). PATH detection checks `launcher`; terminal executes `${launcher} ${cmd}`. |
| `icon` | `string` | No | `"terminal"` | Codicon identifier (`rocket`, `beaker`), path to custom SVG/PNG file, or bundled icon filename. |
| `color` | `string` | No | — | Registered theme color ID (`agentQuickpick.claude`) or standard ANSI key (`terminal.ansiBlue`). |
| `hidden` | `boolean` | No | `false` | When `true`, suppresses the agent from the quick-pick list. Used to hide built-in agents. |

### Global Extension Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `agentQuickpick.detectInstalled` | `boolean` | `true` | Probes system `PATH` for executable binaries and categorizes missing tools under uninstalled state. Set `false` when using shell aliases or functions. |
| `agentQuickpick.launchDelayMs` | `number` | `300` | Delay in milliseconds before dispatching `cmd` to the terminal. Prevents terminal auto-activation scripts (e.g., Python venv / Conda) from bleeding into agent stdin. |

## Technical Notes

### Theme Color Scoping
VS Code requires theme color contributions to be declared statically in `package.json` at publish time. Custom agents can assign any of the 8 extension-provided color IDs or 16 standard `terminal.ansi*` keys. SVG and PNG icons do not have restricted color palettes.

### Shell Alias Resolution
When `agentQuickpick.detectInstalled` is `true`, PATH detection resolves binary executables. Shell functions or aliases defined in `.zshrc` / `.bashrc` will fail binary resolution. Set `"agentQuickpick.detectInstalled": false` to disable binary validation.

## Development & License

- **Maintainer & Local Setup Guide**: [MAINTAINERS.md](./MAINTAINERS.md)
- **Release History**: [CHANGELOG.md](./CHANGELOG.md)
- **License**: [MIT](./LICENSE)
