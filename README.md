<p align="center">
  <img src="./icons/icon.png" width="96" alt="Agent Quickpick Icon">
</p>

# Agent Quickpick

> **Zero setup.** Hit `⌘ShiftA` (or `Ctrl+Shift+A`), pick an agent, and get a dedicated terminal tab with its own icon and color theme right in your editor workspace.

Built by a dev for devs who run CLI coding agents in VS Code (or Cursor, Windsurf, Trae, Antigravity, Vodium) and got tired of juggling generic bottom-panel terminals.

![Demo](./.github/assets/demo.gif)

---

## Why use it?

- **Zero configuration required**: Works instantly out of the box. It probes your `PATH` automatically and shows you only the agent CLIs you actually have installed.
- **Editor tabs, not bottom panel**: Terminals open as real editor tabs. Split them side-by-side or stacked to run Claude, Aider, and OpenCode simultaneously in the same window.
- **Icons & theme colors out of the box**: Every agent (Claude, Gemini, Codex, Goose, Aider, etc.) gets a distinct icon and tab color so you can identify active sessions at a glance.
- **Frecency sorting**: The agents you launch most float to the top automatically. Order syncs across machines via Settings Sync.
- **Clean & non-intrusive**: Agents not found on your system stay hidden by default so your picker stays clean—click the eye icon in the title bar anytime to reveal them.

---

## Supported agents (out of the box)

No configuration needed—if the tool is on your `PATH`, Agent Quickpick detects it automatically:

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

---

## Quick Install

1. Download the latest `.vsix` from [GitHub Actions Artifacts](https://github.com/dataguyofprocol/agent-quickpick/actions).
2. In VS Code, open Extensions (`⌘ShiftX` / `CtrlShiftX`).
3. Click `⋯` (top right) → **Install from VSIX…** and select the file.

*(Submitting to the VS Code Marketplace soon!)*

---

## Optional: Custom agents & tweaks

Most developers never need to touch settings. But if you have custom scripts, package-manager launchers, or want to hide specific built-in agents, configure `agentQuickpick.agents` in `settings.json`:

```jsonc
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
    "launcher": "uvx",       // probes `uvx` on PATH, launches `uvx aider`
    "icon": "aider.svg"
  },
  { "name": "Droid", "hidden": true }
]
```

### Handy settings

- **Using shell aliases / functions**: If your agents rely on shell aliases rather than binaries on `PATH`, turn off detection so they aren't hidden:
  ```jsonc
  "agentQuickpick.detectInstalled": false
  ```
- **Terminal activation scripts leaking into prompt**: If virtualenv/conda activation scripts bleed into an agent's stdin on open, adjust `launchDelayMs` (default 300ms):
  ```jsonc
  "agentQuickpick.launchDelayMs": 500
  ```

### Lifecycle notifications

The first time you launch Claude Code, OpenCode, or Droid, Agent Quickpick offers to install a one-time hook so it can notify you when that agent finishes or needs input — in every repo, not just this one. The hook is scoped to sessions launched from Agent Quickpick and does nothing in terminals you open elsewhere.

- **Where it lives**: your user-level agent config (e.g. `~/.claude/settings.json`), merged in alongside anything already there.
- **Remove it**: run **Remove Lifecycle Hooks** from the Command Palette, or turn off `agentQuickpick.lifecycleNotifications` in settings.

Notifications reach you through three channels:

| Channel | Setting | Default |
| --- | --- | --- |
| In-editor toast, with a **Show** button | `agentQuickpick.lifecycleNotifications` | on (master switch) |
| Native OS notification (macOS Notification Center, Windows toast, `notify-send`) | `agentQuickpick.systemNotifications` | `always` |
| Agent Quickpick's own sound cue | `agentQuickpick.notificationSound` | on |

The OS notification fires **every time** by default: it's the only channel that reaches you outside the editor and the only one that persists in Notification Center, while a VS Code toast is invisible when the window is behind another app or on another Space — exactly when "the agent needs you" matters. Set `whenUnfocused` if the doubled alert while you're looking at VS Code bothers you, or `off` for toasts only.

On macOS, install [`terminal-notifier`](https://github.com/julienXX/terminal-notifier) (`brew install terminal-notifier`) to get a properly attributed banner: your editor's icon, and a click that **jumps straight to that agent's terminal**. Without it macOS credits the notification to **Script Editor** — grey scroll icon, and clicking opens its folder in Finder — a limitation of `osascript`, the only notification channel every Mac has out of the box. Homebrew paths are probed directly, so it's found even though a Finder-launched editor doesn't inherit your shell's `PATH`.

One sound for every status — its job is to get your attention; the toast says which agent and what happened. It plays wherever the notification lands. Point `agentQuickpick.notificationSoundPath` at your own **16-bit PCM WAV** to replace it (WAV is the only format playable on all three platforms).

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘⇧A` / `Ctrl+Shift+A` | Open the agent launcher |
| `⌘⇧L` / `Ctrl+Shift+L` | List running agent sessions — pick one to focus it |

`⌘⇧L` shadows VS Code's built-in **Select All Occurrences**. Rebind either one from **Preferences: Open Keyboard Shortcuts**.

---

## License & Notes

- License: [MIT](./LICENSE) *(Icons are stylized original artwork)*
- Maintenance & local setup notes: [MAINTAINERS.md](./MAINTAINERS.md)
- Release history: [CHANGELOG.md](./CHANGELOG.md)
