/**
 * Agent lifecycle awareness — presentation, and the pieces that need VS Code.
 *
 * Where a status *comes from* lives elsewhere:
 *  - `./program-status`  — the OSC 7501 Program Status Protocol (parsing + records)
 *  - `./terminal-signals` — reading title/progress/text out of terminal output
 *  - `./detect` + `./detect-manifests` — fallback rules for agents without OSC 7501
 *  - `./session-tracker` — the per-terminal state machine that picks between them
 *  - `./legacy-hooks`   — removal of hooks that older versions installed
 *
 * What is left here is either pure presentation (status-bar text/tooltip, session
 * filtering, notification copy, notify/sound command builders) or genuinely
 * VS Code-coupled (the exit-status poller). Keep the pure helpers free of
 * *runtime* `vscode` usage so the unit tier can import them without a host —
 * type-only imports are fine, tsc elides them.
 */

import * as path from "path";
import * as vscode from "vscode";

import type { LifecycleStatus, WaitingReason } from "./program-status";
import type { SessionState } from "./session-tracker";

export type { LifecycleStatus, WaitingReason };
export type { SessionState } from "./session-tracker";

/**
 * Human labels for each lifecycle status, using Herdr's vocabulary. Shared by
 * the status-bar tooltip and the session quickpick so the two never drift.
 * `unknown` is the honest label for a re-adopted terminal after a host reload:
 * we know an agent tab exists, but until a protocol report, a rule match, or an
 * exit status confirms its state, we don't claim it's working.
 */
export const STATUS_LABEL: Record<LifecycleStatus, string> = {
  idle: "idle", working: "working", done: "done", blocked: "blocked", error: "error", unknown: "unknown",
};

/** Compact glyph per status, matching {@link statusBarText}. */
export const STATUS_GLYPH: Record<LifecycleStatus, string> = {
  idle: "○", working: "●", done: "✓", blocked: "⏸", error: "✗", unknown: "?",
};

// ---------------------------------------------------------------------------
// Status-bar + notification rendering (pure, tested)
// ---------------------------------------------------------------------------

/** Tally an array of session states into a count-per-status map. */
export function countByStatus(states: SessionState[]): Record<LifecycleStatus, number> {
  const counts: Record<LifecycleStatus, number> = {
    idle: 0, working: 0, done: 0, blocked: 0, error: 0, unknown: 0,
  };
  for (const s of states) {
    counts[s.status]++;
  }
  return counts;
}

/**
 * Render the status-bar item text. All-zero → the static default. Otherwise a
 * compact live count, most attention-worthy first:
 * `$(agent-quickpick) 1⏸ 1✗ 2✓ 1●` (only non-zero groups are shown). `unknown`
 * renders as `?` so re-adopted terminals after a host reload are visually
 * distinct from agents whose state we actually know.
 */
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

/**
 * Render the status-bar tooltip: a per-session list, most-recently-changed
 * first. Empty → a generic description. When a session's `workspaceFolder` is
 * known (either via a shell-integration `cwd` or its launch folder), the
 * folder's basename is appended so the same agent across multiple repos is
 * disambiguated in the tooltip.
 *
 * A session that reported `progress` shows its percentage, so a long build or
 * deploy conveys more than "working".
 */
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

/**
 * The workspace folder to attribute a session to. Prefers the agent's reported
 * `cwd` from shell integration (the source of truth, since it accounts for a
 * `cd` inside the agent) and falls back to the launch folder. Returns undefined
 * for re-adopted terminals that have neither (after a host reload, before the
 * agent has reported anything).
 */
export function folderOf(state: SessionState): string | undefined {
  return state.cwd ?? state.launchedInFolder;
}

/** Return the basename of a folder path, tolerating trailing slashes. */
export function folderBasename(folder: string): string {
  const trimmed = folder.replace(/[\\/]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/**
 * Filter a list of session states to those that belong to the active workspace
 * folder. Pure + host-free so it's unit-testable. A session belongs iff its
 * {@link folderOf} matches `activeFolder`. When `activeFolder` is undefined
 * (no workspace open), all sessions are returned (preserves the pre-filter
 * aggregate-everything behavior).
 *
 * Re-adopted sessions with neither `cwd` nor `launchedInFolder` are excluded
 * when an `activeFolder` is set — we can't honestly claim them for any repo.
 */
export function filterSessionsByFolder(
  states: SessionState[],
  activeFolder: string | undefined
): SessionState[] {
  if (activeFolder === undefined) {
    return states;
  }
  return states.filter((s) => folderOf(s) === activeFolder);
}

/**
 * The statuses worth announcing to the user. `running` is too noisy and
 * `unknown` isn't a state we can honestly announce. Shared by the toast, the
 * OS notification, and the sound so the three never drift apart.
 */
const ANNOUNCED_STATUSES: readonly LifecycleStatus[] = ["done", "blocked", "error"];

/** True if this status is one we announce (toast / OS notification / sound). */
export function isAnnouncedStatus(status: LifecycleStatus): boolean {
  return ANNOUNCED_STATUSES.includes(status);
}

/**
 * Whether a notification toast should fire for this status. Suppressed when the
 * terminal is already focused (the user is looking at it) or the setting is off.
 * Fires on `finished`, `waiting`, and `failed` — not on `running` (too noisy)
 * and never on `unknown` (we don't have a confident state to announce).
 * `failed` is rendered as an error-severity toast by the caller (see
 * {@link LifecycleContext.maybeNotify}), so it is included here; a crashed agent
 * must not be silent.
 */
export function shouldNotify(
  status: LifecycleStatus,
  isActiveTerminal: boolean,
  settingOn: boolean
): boolean {
  if (!settingOn) return false;
  if (isActiveTerminal) return false;
  return isAnnouncedStatus(status);
}

// ---------------------------------------------------------------------------
// OS notifications + notification sound
// ---------------------------------------------------------------------------

/**
 * When to raise a *native* OS notification (Notification Center / toast /
 * libnotify) in addition to the in-editor toast.
 *
 * `always` is the default: the OS notification is the only channel that reaches
 * you outside the editor *and* the only one that persists in Notification
 * Center, so it fires on every announced status. A VS Code toast is invisible
 * when the window is behind another app, minimized, or on another Space — which
 * is exactly when "the agent needs you" matters. `whenUnfocused` is available
 * for people who find the doubled alert while looking at VS Code redundant.
 */
export type SystemNotifyMode = "off" | "whenUnfocused" | "always";

/**
 * A process to spawn, described as file + argv so the caller can use `spawn`
 * without a shell. Never build these strings by interpolating agent names, repo
 * paths, or session names into a shell/AppleScript/PowerShell command — those
 * are attacker-adjacent free text (a session name can contain quotes, `$(...)`,
 * backticks). Everything user-derived travels as argv or via `env`.
 */
export interface SpawnSpec {
  file: string;
  args: string[];
  /** Extra env vars for the child (merged over `process.env` by the caller). */
  env?: Record<string, string>;
  /** Tried once if `file` fails to spawn (e.g. ENOENT on Linux audio tools). */
  fallback?: SpawnSpec;
}

/**
 * Whether to raise an OS notification for this status change.
 *
 * Deliberately does NOT consider `isActiveTerminal` the way {@link shouldNotify}
 * does. That suppression assumes "terminal focused ⇒ user is watching", which is
 * false when the VS Code window itself isn't focused: the agent's terminal can
 * be the active terminal while the user is in a browser. Window focus is the
 * only signal that matters here.
 *
 * `settingOn` is the master `lifecycleNotifications` switch — off means silent
 * operation across every channel.
 */
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

/**
 * Whether to play the notification sound. Independent of *where* the
 * notification is rendered: Agent Quickpick's sound is its signature, so it
 * fires for an in-editor toast and an OS notification alike (one sound per
 * event — the caller announces a status change once).
 */
export function shouldPlaySound(
  soundOn: boolean,
  status: LifecycleStatus,
  settingOn: boolean
): boolean {
  if (!settingOn) return false;
  if (!soundOn) return false;
  return isAnnouncedStatus(status);
}

/**
 * A macOS bundle identifier is safe to splice into AppleScript source only if it
 * looks like one. Bundle ids are reverse-DNS: letters, digits, dots, hyphens.
 * Anything else (a quote, `"` + arbitrary AppleScript) is rejected so the caller
 * falls back to the unattributed form rather than building an injectable script.
 */
export function isSafeBundleId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/.test(id);
}

/**
 * Everything platform-specific the caller knows about the host editor. All
 * optional: with none of it we still raise a banner, just an unattributed one.
 */
export interface NotifyTarget {
  /** macOS bundle id of the host editor — sets the banner's icon and owner. */
  bundleId?: string;
  /**
   * Absolute path to `terminal-notifier`. A GUI-launched editor inherits
   * launchd's minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so Homebrew's
   * `terminal-notifier` is invisible to a bare-name spawn — the caller resolves
   * it on disk instead.
   */
  notifierPath?: string;
  /** URI opened when the banner is clicked (our `…://…/focus?session=` link). */
  openUrl?: string;
}

/**
 * Path to the `terminal-notifier` Mach-O bundled with the extension, relative to
 * the extension root. macOS requires a bundled `.app` (with a bundle id) to post
 * an attributed notification — a bare `osascript` is forever Script Editor — so
 * a universal `terminal-notifier.app` ships under `resources/notifier/` and this
 * inner binary is the notifier of last resort. Exported so the resolver in
 * `extension.ts` can recognise a resolved vendored path (to fix its exec bit).
 */
export const VENDORED_NOTIFIER_REL =
  "resources/notifier/terminal-notifier.app/Contents/MacOS/terminal-notifier";

/**
 * Ordered candidate paths for `terminal-notifier` on macOS. A user's own install
 * wins first (Homebrew Apple-silicon, Homebrew Intel, MacPorts) so power users
 * keep running their newer build; the extension's bundled universal `.app` is
 * the final candidate, so a fresh install still gets a banner that wears the
 * running editor's icon (via `-sender`) instead of Script Editor's. Returns
 * `[]` off macOS — `terminal-notifier` is darwin-only. `$PATH` is deliberately
 * not probed: a GUI-launched editor inherits launchd's minimal PATH anyway,
 * so scanning `process.env.PATH` would add env-derived taint for candidates
 * that can't exist in practice.
 *
 * Pure (no `vscode` import) so it can be unit-tested without a host, matching the
 * convention for the notification-resolution helpers.
 */
export function notifierCandidates(
  extensionPath: string,
  platform: NodeJS.Platform
): string[] {
  if (platform !== "darwin") {
    return [];
  }
  return [
    "/opt/homebrew/bin/terminal-notifier", // Homebrew, Apple silicon
    "/usr/local/bin/terminal-notifier", // Homebrew, Intel
    "/opt/local/bin/terminal-notifier", // MacPorts
    path.join(extensionPath, VENDORED_NOTIFIER_REL), // bundled universal fallback
  ];
}

/**
 * Path component of the focus URI handled by `registerUriHandler` in
 * `extension.ts`. Kept here alongside the parser so the URI contract between the
 * producer (`focusUri`) and the consumer (the URI handler) lives in one place.
 */
export const FOCUS_URI_PATH = "/focus";

/** Query parameter carrying the terminal (session) name a focus URI targets. */
export const FOCUS_URI_SESSION_PARAM = "session";

/**
 * Parse a focus URI's path + query into the session (terminal tab name) to
 * focus, or `null` if it isn't a focus URI or carries no session. Pure (no
 * `vscode` import) so the click-through contract is unit-tested directly: a
 * notification carries `focusUri(...)`, and a click must round-trip back to the
 * exact session that fired it.
 */
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

/**
 * Strip control characters and shell metacharacters from user-derived text before
 * it reaches a subprocess argv. The subprocesses we spawn (terminal-notifier,
 * notify-send, afplay, etc.) already receive argv rather than shell source, but
 * this sanitizer kills static taint so the analyzer can see the text is not
 * being spliced into a command line.
 */
export function sanitizeArgvText(value: string): string {
  // Allow letters, digits, whitespace, common punctuation, quotes, parentheses,
  // and unicode symbols. Remove C0/C1 controls and characters that would be
  // special in shell context (command substitution, pipes, redirects, etc.).
  return value.replace(
    /[\x00-\x1f\x7f;|`$&\\<>!*?#~%@+=\[\]{}^]/g,
    ""
  );
}

/**
 * Build the OS-notification command for a platform, or `null` where we have no
 * native channel (then the toast + sound still fire).
 *
 * - **macOS**: `terminal-notifier`, using the resolver's user-installed copy or
 *   the universal `.app` bundled with the extension — never `osascript`. A bare
 *   `display notification` is attributed to whatever app *ran* the script,
 *   Script Editor, whose grey scroll icon lands on the banner and whose click
 *   opens Finder on a script URL instead of the editor. That is exactly the
 *   "Script Editor notification / weird script address" failure users hit on
 *   desktop editor builds whose bundle id we cannot read, so the AppleScript
 *   path is gone entirely. `-open <focusUri>` routes the click to our URI
 *   handler, which focuses that agent's specific terminal, and it needs no
 *   bundle id at all: opening the `<scheme>://` URL hands it to LaunchServices,
 *   which raises whichever editor registered the scheme. `-sender` (the editor's
 *   icon) is used only for the bundle-id case with no focus URI, because macOS
 *   commonly swallows `-open` when the banner is attributed to another app. When
 *   neither applies, or the notifier cannot launch, the OS banner is skipped and
 *   the in-editor toast still fires — better than a misleading Script Editor one.
 * - **Linux**: `notify-send` (argv, nothing to escape).
 * - **Windows**: PowerShell raising a real WinRT toast, reading title/body from
 *   env vars. The AUMID is PowerShell's own registered id — an unregistered
 *   AppId makes `Show()` a silent no-op.
 */
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
      // A click follows -open when we have a focus URI (focuses the exact
      // terminal, and works without any bundle id — the fix for desktop editor
      // forks that report no readable bundle), otherwise -sender -activate to at
      // least raise the editor. We deliberately do NOT combine -sender with
      // -open: when macOS attributes a notification to another app via -sender,
      // it commonly ignores -open/-execute and the click becomes a no-op. When
      // neither is available the banner is skipped rather than handed to
      // osascript, which macOS credits to Script Editor (clicking it opens Finder
      // on a script URL). The toast + sound still fire.
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

/**
 * Build the sound-playback command for a platform, or `null` where we have no
 * player. The bundled asset is 16-bit PCM WAV because that's the lowest common
 * denominator: `Media.SoundPlayer` (Windows) plays *only* WAV, and `paplay`
 * won't take MP3.
 *
 * Linux has no single guaranteed player, so `paplay` (PulseAudio/PipeWire)
 * falls back to `aplay` (ALSA).
 */
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

/**
 * The single bundled cue, relative to the extension root. One sound for every
 * announced status: the sound's only job is "look at me", and per-status
 * variants asked the user to learn a vocabulary for information the toast
 * already spells out.
 */
export const SOUND_FILE_DEFAULT = "media/sounds/notif.wav";

/**
 * The notification message + button label for a status change. Returns `null`
 * for any status we do not announce (`idle`, `working`, `unknown`), so a caller
 * can treat `null` as "nothing happened worth interrupting the user for".
 *
 * Copy: `<glyph> <agent> <verb> · <what it said> · <repo>`, e.g.
 * "✓ Claude done · Upgraded 12 packages · my-app". The status glyph leads (VS
 * Code toasts cannot carry a per-agent icon, only the fixed severity icon), the
 * protocol's `msg` follows when the agent supplied one, and the repo name
 * disambiguates the same agent running across several repos. For `error`, the
 * exit code is appended when known: "✗ Claude error · my-app · exit 130".
 */
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

/**
 * Classify Claude's free-text Notification `message` into a
 * {@link WaitingReason}. Claude's notification copy is a small stable set of
 * English strings ("…needs your permission to use Bash", "…is waiting for
 * your input"), so a conservative keyword match is enough: anything mentioning
 * permission is a permission ask; everything else — including a missing or
 * non-string message — is a generic wait.
 */
export function classifyWaitingMessage(message: unknown): WaitingReason | undefined {
  if (typeof message !== "string" || message === "") {
    return undefined;
  }
  return message.toLowerCase().includes("permission") ? "permission" : undefined;
}

/**
 * Sentence-form headline for a waiting toast. "wants to run a command —
 * approve?" instead of "needs your input" when we know the agent is blocked on
 * a permission ask, "asked a question — needs your answer" when it's waiting
 * on a reply. Kept separate from the compact picker/tooltip label
 * ({@link waitingLabel}) so the two surfaces can read naturally without
 * drifting on the *reason* mapping.
 */
export function waitingHeadline(agentName: string, reason?: WaitingReason): string {
  switch (reason) {
    case "permission": return `${agentName} is blocked on permission`;
    case "question": return `${agentName} is blocked on a question`;
    case "auth": return `${agentName} is blocked on authentication`;
    default: return `${agentName} is blocked`;
  }
}

/**
 * Compact status label (no agent name, no glyph) for the sessions picker and
 * the status-bar tooltip — reason-aware for waits.
 */
export function waitingLabel(reason?: WaitingReason): string {
  switch (reason) {
    case "permission": return "blocked · permission";
    case "question": return "blocked · question";
    case "auth": return "blocked · auth";
    default: return STATUS_LABEL.blocked;
  }
}

// ---------------------------------------------------------------------------
// HTTP lifecycle server (VS Code-coupled)
// ---------------------------------------------------------------------------


/** A terminal whose process has exited, reported by {@link pollExitStatuses}. */
export interface PolledExit {
  status: "done" | "error";
  /** The raw exit code from `vscode.Terminal.exitStatus`, when available. */
  exitCode?: number;
}

/**
 * The name a terminal was created with, which does not change when the user
 * renames the tab. `vscode.Terminal.creationOptions` is frozen at creation
 * time; `vscode.Terminal.name` is the mutable display name. We match sessions
 * by the creation name so a renamed agent tab still counts as its original
 * agent.
 */
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
    if (!exit || exit.code === undefined) continue; // still running
    // Already-final sessions are filtered by the tracker's `execEnd`, which
    // keeps a protocol-reported done/error over a later exit.
    result.set(t.name, {
      status: exit.code === 0 ? "done" : "error",
      exitCode: exit.code,
    });
  }
  return result;
}
