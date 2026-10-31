#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const EVENTS = [
  { event: "UserPromptSubmit", payload: "state=working:app=claude" },
  { event: "PostToolUse", payload: "state=working:app=claude" },
  { event: "PostToolUseFailure", payload: "state=working:app=claude" },
  { event: "ElicitationResult", payload: "state=working:app=claude" },
  { event: "PermissionRequest", payload: "state=blocked:kind=permission:app=claude" },
  { event: "PreToolUse", matcher: "AskUserQuestion", payload: "state=blocked:kind=question:app=claude" },
  { event: "Elicitation", payload: "state=blocked:kind=question:app=claude" },
  { event: "Notification", matcher: "idle_prompt", payload: "state=idle:app=claude" },
  { event: "Stop", payload: "state=done:app=claude" },
  { event: "StopFailure", payload: "state=error:app=claude" },
];

function hookCommand(payload) {
  return `t=$(ps -o tty= -p $PPID 2>/dev/null | tr -d " "); case "$t" in ""|"?"|"??") exit 0;; esac; printf "\\033]7501;${payload}\\033\\\\\\\\" > "/dev/$t" 2>/dev/null; exit 0`;
}

function buildClaudeSettings() {
  const hooks = {};
  for (const { event, matcher, payload } of EVENTS) {
    const hook = { type: "command", command: hookCommand(payload) };
    hooks[event] = [matcher === undefined ? { hooks: [hook] } : { matcher, hooks: [hook] }];
  }
  return JSON.stringify({ hooks }, null, 2) + "\n";
}

module.exports = { buildClaudeSettings };

if (require.main === module) {
  fs.writeFileSync(
    path.join(__dirname, "..", "reporters", "claude-settings.json"),
    buildClaudeSettings()
  );
}
