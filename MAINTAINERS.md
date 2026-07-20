# Maintainers & local dev

## Build, test, package

```bash
npm install
npm run compile     # tsc
npm run watch       # tsc -w
npm test            # runs the unit suite in a headless VS Code (35 tests)
npm run package     # builds the .vsix
```

CI runs on every push across Ubuntu, macOS, and Windows — build, test, package, upload the vsix as an artifact.

## Source layout

- `src/extension.ts` — the extension: `BUILTIN_AGENTS`, `loadAgents`, `resolveIconPath`, `resolveColor`, `isCmdInstalled`, `isSafeBinaryName`.
- `src/test/suite/extension.test.ts` — unit tests for the merge/icon/color/detection logic.
- `icons/*.svg` — one brand icon per agent. House style: 24×24 viewBox, `rx=6` rounded background, white glyph on brand fill.
- `package.json` — `contributes.configuration` (settings schema), `contributes.colors` (8 custom theme colors), command + keybinding.
- `.github/assets/` — README mockups. **Replace with real PNGs/GIFs when you capture them** — see [Capturing screenshots](#capturing-screenshots) below.

## Adding a built-in agent

1. Drop an SVG in `icons/` (24×24, house style).
2. Add an entry to `BUILTIN_AGENTS` in `src/extension.ts`.
3. Only if you want a brand-new color id: add a matching `contributes.colors` entry in `package.json`. Otherwise reuse a `terminal.ansi*` key.

## Capturing screenshots

The mockups in `.github/assets/*.svg` are placeholders. To replace with real captures:

1. `code --extensionDevelopmentPath=.` with the GitHub Dark theme.
2. Screenshot the quick pick in (a) default view, (b) revealed view, (c) two terminals side-by-side.
3. For the demo GIF: record ⌘⇧A → pick Claude → ⌘⇧A → pick OpenCode → 6–10s, 15fps, ~600px wide.
4. Drop them in `.github/assets/` and update the image links in the README.

## Architecture notes

- **Detection** runs `command -v <binary>` (or `where` on Windows) per agent, in parallel, with results cached for the session. Binary names are validated against a safe-character allowlist before exec — a malicious or typo'd setting can't inject shell commands.
- **Icon resolution** falls back gracefully: codicon → existing file → `terminal` codicon. A broken icon path never breaks the quick pick.
- **Colors** are a closed set (8 built-ins + 16 ANSI) because VS Code registers theme colors at publish time only.
