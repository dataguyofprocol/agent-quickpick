import * as path from "path";
import * as vscode from "vscode";

import type { LifecycleStatus, WaitingReason } from "./program-status";
import type { SessionState } from "./session-tracker";

export type { LifecycleStatus, WaitingReason };
export type { SessionState } from "./session-tracker";

export const STATUS_LABEL: Record<LifecycleStatus, string> = {
  idle: "idle", working: "working", done: "done", blocked: "blocked", error: "error", unknown: "unknown",
};

export const STATUS_GLYPH: Record<LifecycleStatus, string> = {
  idle: "○", working: "●", done: "✓", blocked: "⏸", error: "✗", unknown: "?",
};

export function countByStatus(states: SessionState[]): Record<LifecycleStatus, number> {
  const counts: Record<LifecycleStatus, number> = {
    idle: 0, working: 0, done: 0, blocked: 0, error: 0, unknown: 0,
  };
  for (const s of states) {
    counts[s.status]++;
  }
  return counts;
}

export function statusBarText(counts: Record<LifecycleStatus, number>): string {
  const glyph = "$(agent-quickpick)";
  const parts: string[] = [];
  if (counts.blocked > 0) parts.push(`${counts.blocked}⏸`);
  if (counts.error > 0) parts.push(`${counts.error}✗`);
  if (counts.done > 0) parts.push(`${counts.done}✓`);
  if (counts.working > 0) parts.push(`${counts.working}●`);
  if (counts.idle > 0) parts.push(`${counts.idle}○`);
  if (counts.unknown > 0) parts.push(`${counts.unknown}?`);

  if (parts.length === 0) {
    return `${glyph} Agent`;
  }
  return `${glyph} ${parts.join(" ")}`;
}

export function statusBarTooltip(states: SessionState[]): string {
  if (states.length === 0) {
    return "Agent Quickpick — running agents";
  }
  const sorted = [...states].sort((a, b) => b.changedAt - a.changedAt);
  return sorted
    .map((s) => {
      const folder = folderOf(s);
      const suffix = folder ? ` · ${folderBasename(folder)}` : "";
      const pct = typeof s.progress === "number" ? ` ${s.progress}%` : "";
      const label =
        s.status === "blocked" ? waitingLabel(s.blockedKind) : STATUS_LABEL[s.status];
      return `${s.name} — ${label}${pct}${suffix}`;
    })
    .join("\n");
}

export function folderOf(state: SessionState): string | undefined {
  return state.cwd ?? state.launchedInFolder;
}

export function folderBasename(folder: string): string {
  const trimmed = folder.replace(/[\\/]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

export function filterSessionsByFolder(
  states: SessionState[],
  activeFolder: string | undefined
): SessionState[] {
  if (activeFolder === undefined) {
    return states;
  }
  return states.filter((s) => folderOf(s) === activeFolder);
}

const ANNOUNCED_STATUSES: readonly LifecycleStatus[] = ["done", "blocked", "error"];

export function isAnnouncedStatus(status: LifecycleStatus): boolean {
  return ANNOUNCED_STATUSES.includes(status);
}

export function shouldNotify(
  status: LifecycleStatus,
  isActiveTerminal: boolean,
  settingOn: boolean
): boolean {
  if (!settingOn) return false;
  if (isActiveTerminal) return false;
  return isAnnouncedStatus(status);
}

export type SystemNotifyMode = "off" | "whenUnfocused" | "always";

export interface SpawnSpec {
  file: string;
  args: string[];
  env?: Record<string, string>;
  fallback?: SpawnSpec;
}

export function shouldSystemNotify(
  mode: SystemNotifyMode,
  status: LifecycleStatus,
  windowFocused: boolean,
  settingOn: boolean
): boolean {
  if (!settingOn) return false;
  if (mode === "off") return false;
  if (!isAnnouncedStatus(status)) return false;
  return mode === "always" ? true : !windowFocused;
}

export function shouldPlaySound(
  soundOn: boolean,
  status: LifecycleStatus,
  settingOn: boolean
): boolean {
  if (!settingOn) return false;
  if (!soundOn) return false;
  return isAnnouncedStatus(status);
}

export function isSafeBundleId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/.test(id);
}

export interface NotifyTarget {
  bundleId?: string;
  notifierPath?: string;
  openUrl?: string;
}

export const VENDORED_NOTIFIER_REL =
  "resources/notifier/terminal-notifier.app/Contents/MacOS/terminal-notifier";

export function notifierCandidates(
  extensionPath: string,
  platform: NodeJS.Platform
): string[] {
  if (platform !== "darwin") {
    return [];
  }
  return [
    "/opt/homebrew/bin/terminal-notifier",
    "/usr/local/bin/terminal-notifier",
    "/opt/local/bin/terminal-notifier",
    path.join(extensionPath, VENDORED_NOTIFIER_REL),
  ];
}

export const FOCUS_URI_PATH = "/focus";

export const FOCUS_URI_SESSION_PARAM = "session";

export function sessionFromFocusUri(
  uriPath: string,
  query: string
): string | null {
  if (uriPath !== FOCUS_URI_PATH) {
    return null;
  }
  const session = new URLSearchParams(query).get(FOCUS_URI_SESSION_PARAM);
  return session && session.length > 0 ? session : null;
}

export function sanitizeArgvText(value: string): string {
  return value.replace(
    /[\x00-\x1f\x7f;|`$&\\<>!*?#~%@+=\[\]{}^]/g,
    ""
  );
}

export function systemNotifyCommand(
  platform: NodeJS.Platform,
  title: string,
  body: string,
  target: NotifyTarget = {}
): SpawnSpec | null {
  const safeTitle = sanitizeArgvText(title);
  const safeBody = sanitizeArgvText(body);
  switch (platform) {
    case "darwin": {
      const { bundleId, notifierPath, openUrl } = target;
      const args = ["-title", safeTitle, "-message", safeBody];
      if (openUrl) {
        args.push("-open", openUrl);
      } else if (bundleId && isSafeBundleId(bundleId)) {
        args.push("-sender", bundleId, "-activate", bundleId);
      } else {
        return null;
      }
      return {
        file: notifierPath ?? "terminal-notifier",
        args,
      };
    }
    case "linux":
      return { file: "notify-send", args: [safeTitle, safeBody] };
    case "win32": {
      const aumid =
        "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";
      const script = [
        "$null=[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]",
        "$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
        "$n=$t.GetElementsByTagName('text')",
        "$null=$n.Item(0).AppendChild($t.CreateTextNode($env:AQP_NOTIFY_TITLE))",
        "$null=$n.Item(1).AppendChild($t.CreateTextNode($env:AQP_NOTIFY_BODY))",
        `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${aumid}').Show([Windows.UI.Notifications.ToastNotification]::new($t))`,
      ].join(";");
      return {
        file: "powershell",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-Command",
          script,
        ],
        env: { AQP_NOTIFY_TITLE: safeTitle, AQP_NOTIFY_BODY: safeBody },
      };
    }
    default:
      return null;
  }
}

export function soundPlayCommand(
  platform: NodeJS.Platform,
  soundPath: string
): SpawnSpec | null {
  switch (platform) {
    case "darwin":
      return { file: "afplay", args: [soundPath] };
    case "linux":
      return {
        file: "paplay",
        args: [soundPath],
        fallback: { file: "aplay", args: ["-q", soundPath] },
      };
    case "win32":
      return {
        file: "powershell",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-Command",
          "(New-Object Media.SoundPlayer $env:AQP_SOUND_PATH).PlaySync()",
        ],
        env: { AQP_SOUND_PATH: soundPath },
      };
    default:
      return null;
  }
}

export const SOUND_FILE_DEFAULT = "media/sounds/notif.wav";

export function notificationMessage(
  agentName: string,
  status: LifecycleStatus,
  repo?: string,
  exitCode?: number,
  reason?: WaitingReason,
  detail?: string
): { text: string; action: string } | null {
  const suffix = repo && repo.trim() !== "" ? ` · ${repo.trim()}` : "";
  const cleanDetail = detail?.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 160);
  const extra = cleanDetail ? ` · ${cleanDetail}` : "";
  switch (status) {
    case "done":
      return { text: `${STATUS_GLYPH.done} ${agentName} done${extra}${suffix}`, action: "Show" };
    case "blocked":
      return { text: `${STATUS_GLYPH.blocked} ${waitingHeadline(agentName, reason)}${extra}${suffix}`, action: "Show" };
    case "error": {
      const codeSuffix = typeof exitCode === "number" ? `${suffix} · exit ${exitCode}` : suffix;
      return { text: `${STATUS_GLYPH.error} ${agentName} error${extra}${codeSuffix}`, action: "Show" };
    }
    default:
      return null;
  }
}

export function classifyWaitingMessage(message: unknown): WaitingReason | undefined {
  if (typeof message !== "string" || message === "") {
    return undefined;
  }
  return message.toLowerCase().includes("permission") ? "permission" : undefined;
}

export function waitingHeadline(agentName: string, reason?: WaitingReason): string {
  switch (reason) {
    case "permission": return `${agentName} is blocked on permission`;
    case "question": return `${agentName} is blocked on a question`;
    case "auth": return `${agentName} is blocked on authentication`;
    default: return `${agentName} is blocked`;
  }
}

export function waitingLabel(reason?: WaitingReason): string {
  switch (reason) {
    case "permission": return "blocked · permission";
    case "question": return "blocked · question";
    case "auth": return "blocked · auth";
    default: return STATUS_LABEL.blocked;
  }
}

export interface PolledExit {
  status: "done" | "error";
  exitCode?: number;
}

export function terminalCreationName(t: vscode.Terminal): string {
  const options = t.creationOptions as { name?: unknown } | undefined;
  return typeof options?.name === "string" && options.name.trim() !== ""
    ? options.name
    : t.name;
}

export function pollExitStatuses(
  terminals: readonly vscode.Terminal[],
  agentNames: Set<string>
): Map<string, PolledExit> {
  const result = new Map<string, PolledExit>();
  for (const t of terminals) {
    const creationName = terminalCreationName(t);
    const base = creationName.replace(/ \(\d+\)$/, "");
    if (!agentNames.has(base.toLowerCase())) continue;
    const exit = t.exitStatus;
    if (!exit || exit.code === undefined) continue;
    result.set(t.name, {
      status: exit.code === 0 ? "done" : "error",
      exitCode: exit.code,
    });
  }
  return result;
}
