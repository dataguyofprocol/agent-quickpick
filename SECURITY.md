# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately rather than opening a public
issue. Use GitHub's private vulnerability reporting on the repository's
**Security** tab, or DM the maintainer on X/Twitter at `@batra99` with a
short description, affected version, and steps to reproduce.

You can expect:

- An acknowledgment within a few days.
- A fix released as a patch version (or a coordinated disclosure path if a
  fix is not immediately possible).

## Scope

This repository is a VS Code extension. The main areas worth scrutiny:

- **Lifecycle hook installation** — the extension writes hooks into your
  user-level agent configs (`~/.claude/settings.json`, `~/.factory/settings.json`,
  `~/.codex/hooks.json`, `~/.gemini/config/hooks.json`, and the OpenCode plugin
  directory). It must never remove or alter hooks it did not install.
- **The localhost hook server** — the extension listens on localhost to
  receive lifecycle events from agent hooks. It should only accept requests
  from processes carrying the per-terminal `AQP_SESSION` token, and never bind
  to anything but loopback.
- **Command construction** — terminal launch commands and notification
  commands are built from configuration and process data; these must be passed
  as separate argv entries, never interpolated into a single shell string.

If you find a way around any of these, that is in scope.

## Supported versions

Only the latest released version receives security fixes. Fixes land on
`main`, are published as a patch release, and older releases are not
backported.
