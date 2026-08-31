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
- **Icons & theme colors out of the box**: Every agent (Claude, Codex, Antigravity, Goose, Aider, etc.) gets a distinct icon and tab color so you can identify active sessions at a glance.
- **Frecency sorting**: The agents you launch most float to the top automatically. Order syncs across machines via Settings Sync.
- **Clean & non-intrusive**: Agents not found on your system stay hidden by default so your picker stays clean—click the eye icon in the title bar anytime to reveal them.
- **Know when an agent needs you**: Lifecycle hooks (installed once per agent) fire native OS notifications, in-editor toasts with a **Show** button, and a sound cue when an agent finishes a task or is waiting for input — even when VS Code is behind another app or on another Space. Works in **every repo**, not just this one.
- **Live session status at a glance**: The running-sessions picker shows a real-time status badge per agent — `●` working, `⏸` blocked (waiting on you), `✓` done, `✗` failed — so you instantly see which agents are blocked waiting on your input. Double-tap `⌘⇧A` to jump to any of them.

---

## Supported agents (out of the box)

No configuration needed—if the tool is on your `PATH`, Agent Quickpick detects it automatically:

| Agent | Command | Agent | Command |
|---|---|---|---|
| Claude | `claude` | Goose | `goose` |
| Codex | `codex` | Crush | `crush` |
| Antigravity | `agy` | Amp | `amp` |
| Copilot | `gh copilot` | Droid | `droid` |
| OpenCode | `opencode` | Qwen | `qwen` |
| Command Code | `cmd` | Plandex | `plandex` |
| Aider | `aider` | Grok | `grok` |
| Cody | `cody` | Kilo | `kilo` |
| Qodo | `qodo` | oh-my-pi | `omp` |
| Terminal | *(plain shell)* | | |

---

## Quick Install

### Option A — Install from Open VSX (recommended)

The extension is published on the [Open VSX Registry](https://open-vsx.org/extension/dataguyofprocol/agent-quickpick) — the open-source marketplace used by VSCodium, Cursor, Windsurf, Trae, Antigravity, and other VS Code-based editors. From those editors you can install it directly from the Extensions panel.

Vanilla **VS Code** doesn't browse Open VSX natively (it uses Microsoft's Marketplace), but you can install the extension from Open VSX in two ways:

1. **Download the `.vsix`** from the [Open VSX page](https://open-vsx.org/extension/dataguyofprocol/agent-quickpick) (click **Download**).
2. In VS Code, open Extensions (`⌘⇧X` / `Ctrl+⇧+X`).
3. Click `⋯` (top right) → **Install from VSIX…** and select the file.

Or, from the command line:

```bash
code --install-extension <path-to-downloaded-.vsix>
```

You get automatic update checks by pinning to the [Open VSX listing](https://open-vsx.org/extension/dataguyofprocol/agent-quickpick) in editors that natively use Open VSX (Cursor, Windsurf, VSCodium). Vanilla VS Code will **not** auto-update from Open VSX — you'll need to re-download newer `.vsix` releases as they're published.

### Option B — Grab a build from CI

1. Download the latest `.vsix` from [GitHub Actions Artifacts](https://github.com/dataguyofprocol/agent-quickpick/actions).
2. Install via **Install from VSIX…** as above.

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

The first time you launch Claude Code, Codex, Antigravity, OpenCode, or Droid, Agent Quickpick offers to install a one-time hook so it can notify you when that agent finishes or needs input — in every repo, not just this one. The hook is scoped to sessions launched from Agent Quickpick and does nothing in terminals you open elsewhere.

- **Where it lives**: your user-level agent config (e.g. `~/.claude/settings.json`), merged in alongside anything already there.
- **Remove it**: run **Remove Lifecycle Hooks** from the Command Palette, or turn off `agentQuickpick.lifecycleNotifications` in settings.

Notifications reach you through three channels:

| Channel | Setting | Default |
| --- | --- | --- |
| In-editor toast, with a **Show** button | `agentQuickpick.lifecycleNotifications` | on (master switch) |
| Native OS notification (macOS Notification Center, Windows toast, `notify-send`) | `agentQuickpick.systemNotifications` | `always` |
| Agent Quickpick's own sound cue | `agentQuickpick.notificationSound` | on |

The OS notification fires **every time** by default: it's the only channel that reaches you outside the editor and the only one that persists in Notification Center, while a VS Code toast is invisible when the window is behind another app or on another Space — exactly when "the agent needs you" matters. Set `whenUnfocused` if the doubled alert while you're looking at VS Code bothers you, or `off` for toasts only.

On macOS, notifications are attributed to **your running editor** out of the box — its icon on the banner, and a click that **jumps straight to that agent's terminal** — because Agent Quickpick ships a bundled universal [`terminal-notifier`](https://github.com/julienXX/terminal-notifier) (x86_64 + arm64). If you have your own copy (`brew install terminal-notifier`), its Homebrew/MacPorts paths are probed first so you keep running your newer build; those locations are checked directly because a Finder-launched editor doesn't inherit your shell's `PATH`. Only if neither is reachable does macOS fall back to `osascript`, which credits the notification to **Script Editor** — grey scroll icon, clicking opens its folder in Finder. macOS Notification Center always shows the icon of the *sending app's bundle* and offers no runtime override, so a bundled `.app` is the only way to get a correctly attributed banner without asking you to install anything.

One sound for every status — its job is to get your attention; the toast says which agent and what happened. It plays wherever the notification lands. Point `agentQuickpick.notificationSoundPath` at your own **16-bit PCM WAV** to replace it (WAV is the only format playable on all three platforms).

### Keyboard shortcuts

One binding does both jobs — no second shortcut to remember, and nothing of VS Code's own is shadowed. The default is `⌘⇧A` / `Ctrl+Shift+A`.

| Default shortcut | Action |
| --- | --- |
| `⌘⇧A` / `Ctrl+Shift+A` | Open the agent launcher |
| `⌘⇧A` twice (within 250ms) | Open running agent sessions — pick one to focus it |
| `⌘⇧A` again while the launcher is open | Switch to running agent sessions |

Double-tap with nothing running just re-opens the launcher, so the gesture is never a dead end. `Agent Quickpick: Running Sessions` is also on the status-bar item and in the Command Palette.

**Change the shortcut.** Run **Agent Quickpick: Change Agent Quickpick Shortcut** to jump straight into VS Code's Keyboard Shortcuts editor on this binding (or open it with `⌘K ⌘S` / `Ctrl+K Ctrl+S` and search `agentQuickpick.open`), then assign any key or chord. The double-tap and launcher-swap gestures are tied to the command, not the key, so they work with whatever you bind.

### Status bar

The **Agent** item shows a live count of running agents **for the active repo only** — terminals launched from another folder in the same window don't inflate it. Click it to jump to a session. Hide it with `agentQuickpick.showStatusBar: false`.

---

## License & Notes

- License: [MIT](./LICENSE) *(Icons are stylized original artwork)*
- Contributing: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Security policy & vulnerability reporting: [SECURITY.md](./SECURITY.md)
- Maintenance & local setup notes: [MAINTAINERS.md](./MAINTAINERS.md)
- Release history: [CHANGELOG.md](./CHANGELOG.md)
