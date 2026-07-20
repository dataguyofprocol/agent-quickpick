# Agent Quickpick

Minimal extension for VS Code and its forks (**Trae, Cursor, Windsurf, Antigravity, …**). Press a key, pick an agent CLI (`claude`, `claude-proxy`, `claude-glm`, `opencode`, `omp`, `droid`, `cmd`), and it opens in a terminal **in the editor area** with its own icon and tab color.

## Default agents

| Agent         | Command         | Color   |
|---------------|-----------------|---------|
| claude        | `claude`        | orange  |
| claude-proxy  | `claude-proxy`  | orange  |
| claude-glm    | `claude-glm`    | grey    |
| opencode      | `opencode`      | blue    |
| omp           | `omp`           | pink    |
| droid         | `droid`         | yellow  |
| commandcode   | `cmd`           | purple  |

> `claude-proxy` and `claude-glm` rely on zsh aliases/functions you define in your `~/.zshrc` (VS Code terminals run an interactive shell, so they resolve automatically).

## Use

Press **Cmd+Shift+A** (macOS) / **Ctrl+Shift+A** (Win/Linux), or run **Open Agent Terminal** from the command palette, then pick an agent.

## Build the `.vsix`

```bash
npm install
npm run package    # creates agent-quickpick-0.1.0.vsix in this folder
```

The `.vsix` appears in the repo root. It's gitignored, so it stays on your machine — never committed.

## Install — editor CLI

Same file works on every fork:

```bash
trae     --install-extension agent-quickpick-0.1.0.vsix   # Trae
cursor   --install-extension agent-quickpick-0.1.0.vsix   # Cursor
windsurf --install-extension agent-quickpick-0.1.0.vsix   # Windsurf
code     --install-extension agent-quickpick-0.1.0.vsix   # VS Code
```

## Install — editor UI

For any editor, including ones with no CLI (e.g. Antigravity):

1. Open the **Extensions** panel.
2. Click the **⋯** menu (top-right of the panel).
3. Choose **Install from VSIX…** and pick `agent-quickpick-0.1.0.vsix`.

## Run from source (no packaging)

```bash
npm install
code --extensionDevelopmentPath=.   # or: trae / cursor / windsurf --extensionDevelopmentPath=.
```

## Add an agent

Edit the `AGENTS` array in `src/extension.ts`:

```ts
{ name: "pi", cmd: "pi", icon: "pi.svg", colorId: "agentQuickpick.pi" }
```

Then drop `icons/mytool.svg` (use `fill="currentColor"` so the tab color drives it) and register a matching color in `package.json` under `contributes.colors`. Rebuild.

## Notes

- `color` tints the terminal **tab label and icon** only — VS Code can't theme a terminal's body.
- Icons are original stylized artwork, not official brand marks.

## License

MIT — see [LICENSE](./LICENSE).
