/**
 * Fallback detection rules, ported from Herdr.
 *
 * Rule patterns and thresholds are derived from Herdr
 * (https://github.com/herdrdev/herdr), Apache-2.0, copyright the Herdr
 * contributors. Modified for Agent Quickpick: the rules are expressed against
 * `osc_title`, `osc_progress`, and a line-oriented text tail instead of Herdr's
 * rendered screen grid, so every region that requires a real screen
 * (`prompt_box_body`, `after_last_horizontal_rule`, `last_non_empty_above_prompt_box`,
 * `bottom_non_empty_lines(N)`, `top_non_empty_lines(N)`, `*_prompt_marker`) has
 * been dropped or, where the needles are strong enough to survive a stream,
 * re-expressed with *more* conditions than Herdr requires. See
 * `THIRD_PARTY_NOTICES.md`.
 *
 * ## Why rules are dropped rather than approximated
 *
 * Herdr matches an idempotent screen: text that was dismissed is gone. We match
 * a monotonic byte stream: dismissed text is still in the history, so any needle
 * that a *past* screen could have left behind becomes a sticky false positive —
 * a spurious "needs your attention" that never clears. The following Herdr rules
 * are therefore deliberately absent, because each can be satisfied by transcript
 * or diff text rather than a live prompt:
 *
 * - claude `legacy_no_prompt_blocker` ("waiting for permission", "tab to amend"),
 *   `generic_permission_prompt` / `live_blocked_form` / `bash_permission_prompt`
 *   as written (we keep a single strict merge of the latter two instead: both the
 *   "do you want to proceed?" needle *and* an option line *and* a footer hint),
 *   `live_prompt_box`, `background_agents_working`,
 *   `background_mcp_task_working`, `transcript_viewer`, `model_picker_menu`
 * - codex `weak_blocker` ("[y/n]", "yes (y)"), `trust_directory`, `startup_update`,
 *   `screen_working_fallback`, `transcript_viewer`
 * - opencode `progress_bar_working` (`(■|⬝){4,}`), `permission_required`'s
 *   second branch
 * - amp `approval_footer` ("invoke tool", "waiting for approval")
 * - gemini `apply_or_allow_change`'s `❯.*(yes|allow)` branch
 *
 * Only a rule flagged `visibleBlocker` is allowed to raise a notification; every
 * other heuristic outcome is confined to the status bar and the session picker.
 */

import type { DetectManifest } from "./detect";

export const DETECT_MANIFESTS: readonly DetectManifest[] = [
  {
    id: "claude",
    aliases: ["claude-code", "claudeproxy", "claudeglm"],
    rules: [
      // Herdr osc_title_working: braille covers <= 2.1.227, half-circles 2.1.228+.
      {
        id: "osc_title_working",
        state: "working",
        priority: 1100,
        region: "osc_title",
        regex: ["^[\\u2800-\\u28FF\\u25D0-\\u25D3] "],
      },
      // Stricter than Herdr: their bash_permission_prompt and
      // generic_permission_prompt each need one needle plus options; we require
      // the question, a footer hint, and an option line, because a stream tail
      // also contains the *answered* copy of a prompt.
      {
        id: "permission_prompt",
        state: "blocked",
        kind: "permission",
        priority: 850,
        region: "text_bottom",
        lines: 14,
        visibleBlocker: true,
        contains: ["do you want to proceed?"],
        any: [
          { contains: ["esc to cancel"] },
          { contains: ["tab to amend"] },
          { contains: ["ctrl+e to explain"] },
        ],
        all: [
          {
            any: [
              { lineRegex: ["(?i)(?:^|\\s)1\\.\\s*yes\\b"] },
              { lineRegex: ["(?i)(?:^|\\s)2\\.\\s*yes\\b"] },
              { lineRegex: ["(?i)(?:^|\\s)3\\.\\s*no\\b"] },
              { lineRegex: ["(?i)^\\s*[❯>]?\\s*yes\\b"] },
            ],
          },
        ],
      },
      {
        id: "live_turn_working",
        state: "working",
        priority: 970,
        region: "text_bottom",
        lines: 12,
        any: [
          { lineRegex: ["^\\s*[⏸⏵].*esc to interrupt(?:\\s|·|$)"] },
          { contains: ["esc to interrupt"] },
        ],
      },
      {
        id: "dynamic_workflow_prompt",
        state: "blocked",
        kind: "question",
        priority: 980,
        region: "text",
        visibleBlocker: true,
        contains: ["run a dynamic workflow?", "esc to cancel"],
      },
      {
        id: "mcp_elicitation_prompt",
        state: "blocked",
        kind: "question",
        priority: 980,
        region: "text",
        visibleBlocker: true,
        contains: ["esc to cancel"],
        lineRegex: ['(?i)^\\s*MCP server ["\u201c].+["\u201d] requests your input\\s*$'],
        any: [{ lineRegex: ["^\\s*❯?\\s*Accept\\b"] }, { lineRegex: ["^\\s*❯?\\s*Decline\\b"] }],
      },
      {
        id: "osc_title_idle",
        state: "idle",
        priority: 250,
        region: "osc_title",
        regex: ["^\\u2733 "],
      },
      {
        id: "osc_progress_idle",
        state: "idle",
        priority: 250,
        region: "osc_progress",
        regex: ["^4;0"],
      },
    ],
  },
  {
    id: "codex",
    rules: [
      {
        id: "osc_title_blocked",
        state: "blocked",
        kind: "permission",
        priority: 1100,
        region: "osc_title",
        visibleBlocker: true,
        contains: ["action required"],
      },
      {
        id: "osc_title_working",
        state: "working",
        priority: 1050,
        region: "osc_title",
        regex: ["(?:^| )[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?: |$)"],
      },
      // Herdr live_strong_blocker: long literals only, which is what makes it
      // safe without a screen.
      {
        id: "live_strong_blocker",
        state: "blocked",
        kind: "permission",
        priority: 900,
        region: "text",
        visibleBlocker: true,
        any: [
          { contains: ["press enter to confirm or esc to cancel"] },
          { contains: ["enter to submit answer"] },
          { contains: ["enter to submit all"] },
          { contains: ["allow command?"] },
        ],
      },
      {
        id: "osc_title_idle",
        state: "idle",
        priority: 100,
        region: "osc_title",
        regex: ["\\S"],
        not: [
          { regex: ["(?:^| )[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?: |$)"] },
          { contains: ["action required"] },
        ],
      },
    ],
  },
  {
    id: "amp",
    rules: [
      {
        id: "osc_title_working",
        state: "working",
        priority: 1050,
        region: "osc_title",
        regex: ["^[\\u2800-\\u28FF] "],
      },
      {
        id: "osc_title_idle",
        state: "idle",
        priority: 50,
        region: "osc_title",
        contains: [" - amp - "],
        not: [{ regex: ["^[\\u2800-\\u28FF] "] }],
      },
    ],
  },
  {
    id: "grok",
    rules: [
      {
        id: "osc_title_blocked",
        state: "blocked",
        kind: "permission",
        priority: 1300,
        region: "osc_title",
        visibleBlocker: true,
        contains: ["action required"],
      },
      {
        id: "osc_progress_working",
        state: "working",
        priority: 1150,
        region: "osc_progress",
        regex: ["^4;1;-1$"],
      },
      {
        id: "osc_title_idle",
        state: "idle",
        priority: 1100,
        region: "osc_title",
        regex: ["(?:^| - )grok$"],
      },
      {
        id: "osc_title_working",
        state: "working",
        priority: 1000,
        region: "osc_title",
        regex: ["(?:^|\\s)[\\u2801-\\u28FF](?:\\s|$)"],
      },
      {
        id: "osc_progress_idle",
        state: "idle",
        priority: 950,
        region: "osc_progress",
        regex: ["^4;0;0$"],
      },
    ],
  },
  {
    id: "hermes",
    rules: [
      {
        id: "osc_title_blocked",
        state: "blocked",
        kind: "question",
        priority: 1100,
        region: "osc_title",
        visibleBlocker: true,
        regex: ["^⚠[\\uFE0E\\uFE0F]?(?:\\s|$)"],
      },
      {
        id: "osc_title_working",
        state: "working",
        priority: 1050,
        region: "osc_title",
        regex: ["^⏳"],
      },
      { id: "osc_title_idle", state: "idle", priority: 100, region: "osc_title", regex: ["^✓"] },
    ],
  },
  {
    id: "kiro",
    rules: [
      {
        id: "osc_title_working",
        state: "working",
        priority: 900,
        region: "osc_title",
        regex: ["(?i)^[◐◓◑◒/|\\-]\\s+kiro:"],
      },
      {
        id: "osc_progress_working",
        state: "working",
        priority: 890,
        region: "osc_progress",
        regex: ["^4;3;?$"],
      },
    ],
  },
  {
    id: "qwen",
    rules: [
      {
        id: "osc_title_blocked",
        state: "blocked",
        kind: "question",
        priority: 1200,
        region: "osc_title",
        visibleBlocker: true,
        regex: ["^\\u2733\\uFE0E? "],
      },
      {
        id: "osc_title_working",
        state: "working",
        priority: 1100,
        region: "osc_title",
        regex: ["^\\u25D0\\uFE0E? "],
      },
      {
        id: "osc_progress_working",
        state: "working",
        priority: 850,
        region: "osc_progress",
        regex: ["^4;3(?:;|$)"],
      },
    ],
  },
  {
    id: "opencode",
    rules: [
      {
        id: "permission_required",
        state: "blocked",
        kind: "permission",
        priority: 300,
        region: "text",
        visibleBlocker: true,
        contains: ["△ permission required"],
      },
      {
        id: "interrupt_hint_working",
        state: "working",
        priority: 110,
        region: "text",
        any: [{ contains: ["esc to interrupt"] }, { contains: ["ctrl+c to interrupt"] }],
      },
    ],
  },
  {
    id: "pi",
    rules: [
      {
        id: "working_literal",
        state: "working",
        priority: 100,
        region: "text",
        any: [
          { contains: ["working..."] },
          { lineRegex: ["^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Working$"] },
        ],
      },
      {
        id: "working_border",
        state: "working",
        priority: 100,
        region: "text_bottom",
        lines: 12,
        any: [
          { lineRegex: ["^── [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Working ─+$"] },
          { lineRegex: ["^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Working$"] },
        ],
      },
    ],
  },
  {
    id: "droid",
    aliases: ["factory", "factorydroid"],
    rules: [
      {
        id: "execute_selection_blocker",
        state: "blocked",
        kind: "permission",
        priority: 300,
        region: "text",
        visibleBlocker: true,
        contains: ["enter to select", "esc to cancel", "to navigate"],
        any: [{ contains: ["> yes, allow"] }, { contains: ["> no, cancel"] }],
      },
      {
        id: "selection_menu_blocker",
        state: "blocked",
        kind: "permission",
        priority: 290,
        region: "text_bottom",
        lines: 8,
        visibleBlocker: true,
        contains: ["enter select", "esc cancel"],
        regex: ["[↑↓]"],
      },
      {
        id: "spinner_stop_working",
        state: "working",
        priority: 110,
        region: "text",
        contains: ["esc to stop"],
        regex: ["(?m)^\\s*[\\u2800-\\u28FF]"],
      },
      {
        id: "stop_hint_working",
        state: "working",
        priority: 100,
        region: "text",
        contains: ["esc to stop"],
      },
    ],
  },
  {
    id: "gemini",
    aliases: ["agy"],
    rules: [
      {
        id: "apply_or_allow_change",
        state: "blocked",
        kind: "permission",
        priority: 300,
        region: "text",
        visibleBlocker: true,
        any: [
          { contains: ["│ apply this change"] },
          { contains: ["│ allow execution"] },
        ],
      },
      {
        id: "esc_cancel_working",
        state: "working",
        priority: 100,
        region: "text",
        contains: ["esc to cancel"],
      },
    ],
  },

];
