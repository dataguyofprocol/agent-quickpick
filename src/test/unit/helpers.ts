import type { LifecycleStatus, SessionState } from "../../lifecycle";

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
