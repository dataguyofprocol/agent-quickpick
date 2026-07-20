# Agent Quickpick

Minimal VS Code extension. Press a key, pick an agent CLI (`claude`, `opencode`, `omp`, `droid`), and it opens in a terminal **in the editor area** with its own icon and tab color.

## Default agents

| Agent    | Command    | Color  |
|----------|------------|--------|
| claude   | `claude`   | orange |
| opencode | `opencode` | blue   |
| omp      | `omp`      | pink   |
| droid    | `droid`    | yellow |

## Use

Press **Cmd+Shift+A** (macOS) / **Ctrl+Shift+A** (Win/Linux), or run **Open Agent Terminal** from the command palette, then pick an agent.

## Build & install

```bash
npm install
npm run compile        # build to out/
npm run package        # produce agent-quickpick-<version>.vsix
```

Install the `.vsix`:

```bash
code --install-extension agent-quickpick-0.1.0.vsix
```

Run from source (no packaging):

```bash
code --extensionDevelopmentPath=.
```

## Add an agent

Edit the `AGENTS` array in `src/extension.ts`:

```ts
{ name: "mytool", cmd: "mytool", icon: "mytool.svg", colorId: "agentQuickpick.mytool" }
```

Then drop `icons/mytool.svg` (use `fill="currentColor"` so the tab color drives it) and register a matching color in `package.json` under `contributes.colors`. Recompile.

## Notes

- `color` tints the terminal **tab label and icon** only — VS Code can't theme a terminal's body.
- Icons are original stylized artwork, not official brand marks.

## License

MIT — see [LICENSE](./LICENSE).
