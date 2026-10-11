/**
 * Fallback status inference for agents that don't emit `OSC 7501`.
 *
 * The rule model is ported from [Herdr](https://github.com/herdrdev/herdr)'s
 * detection manifests, because Herdr has done the hard work of describing what
 * a dozen-plus agent TUIs actually look like on screen. Two things differ, and
 * both are deliberate:
 *
 * - **Regions.** Herdr matches against a *rendered screen grid*
 *   (`prompt_box_body`, `after_last_horizontal_rule`, `bottom_non_empty_lines(N)`,
 *   ...). We never have a grid — only a byte stream. Only `osc_title`,
 *   `osc_progress`, and a line-oriented text tail are reproducible, so
 *   screen-geometry rules are not implemented at all rather than approximated
 *   into false positives. See `./detect-manifests` for the exclusion list.
 * - **Priority ties.** Herdr keeps the incumbent unless a newcomer is strictly
 *   higher priority, so ties go to the first-declared rule. The same here.
 *
 * Free of runtime `vscode` usage so the unit tier can drive it directly.
 */

import type { OscProgress } from "./terminal-signals";

/** The states a heuristic may infer. `done`/`error` are never inferred: only the
 *  protocol or a real process exit code can know a program is finished. */
export type DetectState = "idle" | "working" | "blocked" | "unknown";

/** Where a rule looks. Text regions are line-oriented approximations of a screen. */
export type DetectRegion = "osc_title" | "osc_progress" | "text" | "text_bottom";

/**
 * A match expression. Every field listed on one gate must be satisfied (AND),
 * `all` requires every child, `any` at least one, `not` none — matching Herdr's
 * semantics, where alternatives are always expressed by wrapping them in `any`.
 */
export interface DetectGate {
  /** Case-insensitive substrings that must all appear in the region. */
  contains?: string[];
  /** Patterns that must all match somewhere in the region. */
  regex?: string[];
  /** Patterns that must each match at least one whole line of the region. */
  lineRegex?: string[];
  all?: DetectGate[];
  any?: DetectGate[];
  not?: DetectGate[];
}

export interface DetectRule extends DetectGate {
  id: string;
  state?: DetectState;
  /** Waiting reason for a `blocked` rule; `permission` when omitted. */
  kind?: "permission" | "question" | "auth";
  priority: number;
  region: DetectRegion;
  /** Line count for `text_bottom`; defaults to 12. */
  lines?: number;
  /**
   * This rule may report `blocked` **and is the only kind of heuristic allowed
   * to raise a notification**. A wrong "needs you" alert is worse than a
   * missing one, so text-derived blocks are opt-in per rule.
   */
  visibleBlocker?: boolean;
  /** A match means "publish nothing this tick" — the previous state stands. */
  skipStateUpdate?: boolean;
}

export interface DetectManifest {
  /** Stable id, matched against the agent's name. */
  id: string;
  /** Extra names that resolve to this manifest (Herdr's `aliases`). */
  aliases?: string[];
  rules: DetectRule[];
}

/** The signals a rule can see for one terminal. */
export interface DetectInput {
  title?: string;
  progress?: OscProgress;
  text: string;
  /** The last `n` lines of `text`. */
  bottom(n: number): string;
}

export interface DetectResult {
  state: DetectState;
  kind?: "permission" | "question" | "auth";
  rule: DetectRule;
}

/**
 * Compile a pattern from the ported rule tables.
 *
 * The upstream patterns are Rust `regex` crate syntax, where flags are written
 * inline as `(?i)` / `(?m)` / `(?s)`. JavaScript has no inline flags — passing
 * one straight to `new RegExp` throws, which would silently disable the rule —
 * so a leading flag group is lifted into the `RegExp` flags instead. Rust and JS
 * agree on everything else these patterns use.
 *
 * @returns the compiled expression, or `undefined` for a pattern we cannot
 *          compile (which must never match rather than match everything).
 */
function compile(pattern: string): RegExp | undefined {
  let flags = "u";
  let source = pattern;
  const inline = /^\(\?([ims]+)\)/.exec(source);
  if (inline) {
    for (const letter of inline[1]) {
      if (!flags.includes(letter)) flags += letter;
    }
    source = source.slice(inline[0].length);
  }
  try {
    return new RegExp(source, flags);
  } catch {
    return undefined;
  }
}

function testRegex(patterns: string[], subject: string): boolean {
  return patterns.every((pattern) => compile(pattern)?.test(subject) ?? false);
}

function testLineRegex(patterns: string[], subject: string): boolean {
  const lines = subject.split("\n");
  return patterns.every((pattern) => {
    const re = compile(pattern);
    if (!re) return false;
    return lines.some((line) => re.test(line));
  });
}

/** True when the gate has at least one positive (non-`not`) condition. */
function hasPositiveMatcher(gate: DetectGate): boolean {
  if (gate.contains?.length || gate.regex?.length || gate.lineRegex?.length) return true;
  if (gate.all?.some(hasPositiveMatcher) || gate.any?.some(hasPositiveMatcher)) return true;
  return false;
}

function matches(gate: DetectGate, subject: string): boolean {
  if (gate.contains?.length) {
    const haystack = subject.toLowerCase();
    for (const needle of gate.contains) {
      if (!haystack.includes(needle.toLowerCase())) return false;
    }
  }
  if (gate.regex?.length && !testRegex(gate.regex, subject)) return false;
  if (gate.lineRegex?.length && !testLineRegex(gate.lineRegex, subject)) return false;
  if (gate.all?.length && !gate.all.every((child) => matches(child, subject))) return false;
  if (gate.any?.length && !gate.any.some((child) => matches(child, subject))) return false;
  if (gate.not?.length && gate.not.some((child) => matches(child, subject))) return false;
  return true;
}

/** The region text a rule should be evaluated against, or `undefined`. */
function regionText(rule: DetectRule, input: DetectInput): string | undefined {
  switch (rule.region) {
    case "osc_title":
      return input.title;
    case "osc_progress":
      return input.progress?.raw;
    case "text":
      return input.text;
    case "text_bottom":
      return input.bottom(rule.lines ?? 12);
  }
}

/**
 * Evaluate a manifest against the current signals.
 *
 * @returns the winning rule and the state it implies, or `undefined` when no
 *          rule matched (the caller then falls back to activity/idle defaults).
 */
export function detect(manifest: DetectManifest, input: DetectInput): DetectResult | undefined {
  let best: DetectRule | undefined;
  for (const rule of manifest.rules) {
    if (rule.state === undefined && !rule.skipStateUpdate) continue;
    if (!hasPositiveMatcher(rule)) continue;

    const subject = regionText(rule, input);
    if (subject === undefined || subject === "") continue;
    if (!matches(rule, subject)) continue;

    // Highest priority wins; a tie keeps the earlier rule (Herdr's behaviour).
    if (best === undefined || rule.priority > best.priority) best = rule;
  }
  if (!best || best.skipStateUpdate) return undefined;
  return { state: best.state ?? "unknown", ...(best.kind ? { kind: best.kind } : {}), rule: best };
}

/** Normalize an agent name for manifest lookup. */
function normalize(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== "");
}

/**
 * Find the manifest for an agent name.
 *
 * Names come from the user's own configuration, so matching is deliberately
 * conservative: the whole normalized name or its **first** token must equal an
 * id/alias, or a longer id must appear as one of the tokens. That stops short
 * aliases like `pi` from claiming an unrelated name such as `oh-my-pi`, whose
 * first token is `oh`.
 */
export function manifestFor(
  name: string,
  manifests: readonly DetectManifest[]
): DetectManifest | undefined {
  const tokens = normalize(name);
  if (tokens.length === 0) return undefined;
  const whole = tokens.join("");

  for (const manifest of manifests) {
    const keys = [manifest.id, ...(manifest.aliases ?? [])].map((key) => key.toLowerCase());
    if (keys.includes(whole) || keys.includes(tokens[0])) return manifest;
  }
  for (const manifest of manifests) {
    const keys = [manifest.id, ...(manifest.aliases ?? [])]
      .map((key) => key.toLowerCase())
      .filter((key) => key.length >= 4);
    if (keys.some((key) => tokens.includes(key))) return manifest;
  }
  return undefined;
}

/** Rules that fail the "must have a positive matcher" invariant, for tests. */
export function invalidRules(manifests: readonly DetectManifest[]): string[] {
  const offenders: string[] = [];
  const walk = (manifestId: string, ruleId: string, gate: DetectGate) => {
    if (!hasPositiveMatcher(gate)) offenders.push(`${manifestId}/${ruleId}`);
    for (const child of [...(gate.all ?? []), ...(gate.any ?? [])]) walk(manifestId, ruleId, child);
    for (const child of gate.not ?? []) walk(manifestId, ruleId, child);
  };
  for (const manifest of manifests) {
    for (const rule of manifest.rules) walk(manifest.id, rule.id, rule);
  }
  return offenders;
}
