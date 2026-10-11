// agent-quickpick status reporter (opencode)
// Launch-time status reporter for OpenCode V2, loaded by Agent Quickpick through
// OPENCODE_CLI_CONFIG_CONTENT for the terminals it launches. Nothing is written
// to OpenCode's configuration; outside those terminals this file is never loaded.
//
// OpenCode does not speak the Program Status Protocol (OSC 7501) yet, so this
// translates its own session events into OSC 7501 reports, written to the
// terminal this TUI runs in. Agent Quickpick already parses those reports, so
// the reporter needs no channel of its own. Delete it once OpenCode ships 7501
// natively (anomalyco/opencode#54402).
//
// The event handling follows Herdr's OpenCode V2 TUI plugin (Apache-2.0,
// https://github.com/herdrdev/herdr), reduced to state reporting.

import fs from "node:fs";

/** Write one OSC 7501 report to this TUI's terminal. Never throws. */
function report(state, kind) {
  const fields = [`state=${state}`, ...(kind ? [`kind=${kind}`] : []), "app=opencode"];
  try {
    // AQP_REPORTER_TTY exists for the extension's unit tests only.
    const tty = process.env.AQP_REPORTER_TTY || "/dev/tty";
    fs.appendFileSync(tty, `\u001b]7501;${fields.join(":")}\u001b\\`);
  } catch {
    // No controlling terminal (piped / headless run): nothing to report to.
  }
}

function setup(api) {
  let disposed = false;
  let selected;
  let state = "idle";
  let last;
  // Pending permission requests / forms in the selected session's tree,
  // keyed `permission:<id>` / `form:<id>` → kind.
  const blockers = new Map();
  const parents = new Map();

  function root(id) {
    const seen = new Set();
    while (typeof id === "string" && !seen.has(id)) {
      seen.add(id);
      const parent = api.data.session.get(id)?.parentID ?? parents.get(id);
      if (!parent) return id;
      id = parent;
    }
  }

  function routed() {
    const route = api.ui.router.current();
    return route?.type === "session" ? root(route.sessionID) : undefined;
  }

  function publish() {
    if (disposed || !selected) return;
    const blocker = blockers.size ? [...blockers.values()][0] : undefined;
    const next = blocker ? `blocked:${blocker}` : state;
    if (next === last) return;
    last = next;
    if (blocker) report("blocked", blocker);
    else report(state);
  }

  // Follow the session this terminal is showing. Switching sessions reports the
  // new one's state; a fresh TUI on the home screen reports nothing.
  function sync() {
    if (disposed) return;
    const id = routed();
    if (id === selected) return;
    selected = id;
    blockers.clear();
    if (id) {
      state = api.data.session.status(id) === "running" ? "working" : "idle";
      publish();
    }
  }

  function receive({ details: event }) {
    if (disposed) return;
    const data = event?.data;
    if (data == null) return;
    if (event.type === "session.created" && data.parentID) {
      parents.set(data.sessionID, data.parentID);
    }
    sync();
    const id = event.type === "form.created" ? data.form?.sessionID : data.sessionID;
    if (!selected || root(id) !== selected) return;
    switch (event.type) {
      case "permission.asked":
        blockers.set(`permission:${data.id}`, "permission");
        break;
      case "permission.replied":
        blockers.delete(`permission:${data.requestID}`);
        break;
      case "form.created":
        blockers.set(`form:${data.form?.id}`, "question");
        break;
      case "form.replied":
      case "form.cancelled":
        blockers.delete(`form:${data.id}`);
        break;
      // Only the selected root's own execution drives working/done; a subagent
      // finishing is not the turn finishing.
      case "session.execution.started":
        if (id !== selected) return;
        state = "working";
        break;
      case "session.execution.succeeded":
        if (id !== selected) return;
        state = "done";
        blockers.clear();
        break;
      case "session.execution.interrupted":
        if (id !== selected) return;
        state = "idle";
        blockers.clear();
        break;
      case "session.execution.failed":
        if (id !== selected) return;
        state = "error";
        blockers.clear();
        break;
      default:
        return;
    }
    publish();
  }

  const unsubscribe = api.data.listen(receive);
  sync();
  // Route changes are not events; poll for them cheaply.
  const poll = setInterval(sync, 250);
  poll.unref?.();
  return () => {
    disposed = true;
    clearInterval(poll);
    unsubscribe();
  };
}

export default { id: "agent-quickpick.status-reporter", setup };
