/**
 * Shared harness for the unit tier. Plain Node only — the lifecycle types below
 * are import-types, so this module stays free of runtime vscode usage like the
 * rest of the unit-tier imports. Not a *.test.ts file, so mocha's
 * out/test/unit/*.test.js glob never collects it.
 */

import type { LifecycleStatus, SessionState } from "../../lifecycle";

/** Build a SessionState with defaults, for status-bar / folder-scope tests. */
export function makeState(
  name: string,
  agentName: string,
  status: LifecycleStatus,
  changedAt = Date.now(),
  extra: Partial<
    Pick<SessionState, "cwd" | "launchedInFolder" | "progress" | "blockedKind" | "message">
  > = {}
): SessionState {
  return { name, agentName, status, changedAt, source: "none", ...extra };
}
