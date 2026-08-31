# Contributing

Thanks for helping out. Agent Quickpick is a VS Code extension written in
TypeScript, built to CommonJS with `tsc`.

## Getting started

```bash
npm install
npm run compile   # tsc -p ./ — also the only typecheck (strict mode)
npm run test:unit # fast tier: plain mocha, no VS Code window
npm test          # full gate: unit tier + host tier in a real editor window
```

Both test tiers run compiled JS under `out/`, so **compile before testing**.
There is no linter or formatter; `tsc --strict` is the only static gate.

## Making changes

- Bump the version in `package.json` for every change (patch for fixes, minor
  for features) and update `CHANGELOG.md` for user-visible changes.
- Follow the existing module split: `src/agents.ts` and the pure helpers in
  `src/lifecycle.ts` must stay free of runtime `vscode` imports so the unit
  tier can run them without a host. Only `src/extension.ts`,
  `src/lifecycle-adapters.ts` (and the server half of `src/lifecycle.ts`) may
  touch the VS Code API.
- Add tests for new behavior in `src/test/unit/` (no VS Code API) or
  `src/test/suite/` (requires the API). Both tiers use the mocha TDD UI
  (`suite`/`test`).

## Adding a built-in agent

1. Add a 24×24 SVG in `icons/` (rounded `rx=6` background, white glyph on a
   brand fill).
2. Add an entry to `BUILTIN_AGENTS` in `src/agents.ts`.
3. If you need a new tab color, add it to `contributes.colors` in
   `package.json` **and** to `BUILTIN_COLOR_IDS` in `agents.ts` — the two
   lists must stay in sync.

## Submitting changes

Open a pull request against `main`. CI runs on every PR across Ubuntu, macOS,
and Windows and must pass before merge.
