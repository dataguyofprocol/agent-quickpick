import type { OscProgress } from "./terminal-signals";

export type DetectState = "idle" | "working" | "blocked" | "unknown";

export type DetectRegion = "osc_title" | "osc_progress" | "text" | "text_bottom";

export interface DetectGate {
  contains?: string[];
  regex?: string[];
  lineRegex?: string[];
  all?: DetectGate[];
  any?: DetectGate[];
  not?: DetectGate[];
}

export interface DetectRule extends DetectGate {
  id: string;
  state?: DetectState;
  kind?: "permission" | "question" | "auth";
  priority: number;
  region: DetectRegion;
  lines?: number;
  visibleBlocker?: boolean;
  skipStateUpdate?: boolean;
}

export interface DetectManifest {
  id: string;
  aliases?: string[];
  rules: DetectRule[];
}

export interface DetectInput {
  title?: string;
  progress?: OscProgress;
  text: string;
  bottom(n: number): string;
}

export interface DetectResult {
  state: DetectState;
  kind?: "permission" | "question" | "auth";
  rule: DetectRule;
}

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

export function detect(manifest: DetectManifest, input: DetectInput): DetectResult | undefined {
  let best: DetectRule | undefined;
  for (const rule of manifest.rules) {
    if (rule.state === undefined && !rule.skipStateUpdate) continue;
    if (!hasPositiveMatcher(rule)) continue;

    const subject = regionText(rule, input);
    if (subject === undefined || subject === "") continue;
    if (!matches(rule, subject)) continue;

    if (best === undefined || rule.priority > best.priority) best = rule;
  }
  if (!best || best.skipStateUpdate) return undefined;
  return { state: best.state ?? "unknown", ...(best.kind ? { kind: best.kind } : {}), rule: best };
}

function normalize(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== "");
}

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
