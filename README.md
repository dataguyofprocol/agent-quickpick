# Agent Quickpick

A minimal VS Code extension that opens your favorite "agent" CLIs (e.g. `claude`, `opencode`, `omp`, `droid`) as terminals **inside the editor area**, each with its own **icon** and **theme color**.

Press the keybinding, pick an agent from the quick-pick, and a new editor-tab terminal opens and runs the agent for you.

## Features

- One keybinding → quick-pick list of agents.
- Opens the chosen agent **in the editor area** (not the panel).
- Each agent gets a hand-made SVG icon + a distinct tab color.
- Adding a new agent = one line of config + one SVG. No keybind edits.

## Default agents

| Agent    | Command  | Color  | Icon            |
|----------|----------|--------|-----------------|
| claude   | `claude` | orange | asterisk/sparkle |
| opencode | `opencode` | blue | terminal glyph  |
| omp      | `omp`    | pink   | prompt `❯`      |
| droid    | `droid`  | yellow | robot head      |

## Install / Run from source

```bash
npm install
npm run compile   # or: npx tsc
code --extensionDevelopmentPath=.
```

Then press **Cmd+Shift+A** (macOS) / **Ctrl+Shift+A** (Linux/Windows) and pick an agent.

To build a packaged `.vsix`:

```bash
npx @vscode/vsce package
```

## Configure

Open `src/extension.ts` and edit the `AGENTS` array:

```ts
const AGENTS: Agent[] = [
  { name: "claude",   cmd: "claude",   icon: "claude.svg",   colorId: "agentQuickpick.claude" },
  { name: "opencode", cmd: "opencode", icon: "opencode.svg", colorId: "agentQuickpick.opencode" },
  { name: "omp",      cmd: "omp",      icon: "omp.svg",      colorId: "agentQuickpick.omp" },
  { name: "droid",    cmd: "droid",    icon: "droid.svg",    colorId: "agentQuickpick.droid" },
];
```

- `cmd` — the command run inside the terminal.
- `icon` — SVG file in `icons/`.
- `colorId` — a custom color registered in `package.json` under `contributes.colors`.

Adding an agent: add an entry here, drop an SVG in `icons/`, and register a matching color in `package.json`.

## Notes / limitations

- VS Code cannot theme a single terminal's **body**; `color` tints the **tab label and icon** only.
- The keybinding is bound under `when: !terminalFocus` so it doesn't steal input while a terminal is active.
- Icons are stylized, original artwork (licensing-safe), not official brand marks.

## License

MIT — see [LICENSE](./LICENSE).
