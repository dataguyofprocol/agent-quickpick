import * as assert from "assert";

import {
  detect,
  invalidRules,
  manifestFor,
  type DetectInput,
  type DetectManifest,
} from "../../detect";
import { DETECT_MANIFESTS } from "../../detect-manifests";
import { OscProgress } from "../../terminal-signals";

const b64 = (text: string) => Buffer.from(text).toString("base64");

function input(over: {
  title?: string;
  progress?: string;
  text?: string;
}): DetectInput {
  const text = over.text ?? "";
  return {
    ...(over.title !== undefined ? { title: over.title } : {}),
    ...(over.progress !== undefined
      ? { progress: { state: 3, raw: over.progress, at: 0 } as OscProgress }
      : {}),
    text,
    bottom: (n: number) => text.split("\n").slice(-n).join("\n"),
  };
}

const fire = (agent: string, over: Parameters<typeof input>[0]) => {
  const manifest = manifestFor(agent, DETECT_MANIFESTS);
  assert.ok(manifest, `no manifest for ${agent}`);
  return detect(manifest!, input(over));
};

suite("manifestFor", () => {
  test("resolves the agents we ship", () => {
    assert.strictEqual(manifestFor("Claude", DETECT_MANIFESTS)?.id, "claude");
    assert.strictEqual(manifestFor("Claude Proxy", DETECT_MANIFESTS)?.id, "claude");
    assert.strictEqual(manifestFor("Codex", DETECT_MANIFESTS)?.id, "codex");
    assert.strictEqual(manifestFor("OpenCode", DETECT_MANIFESTS)?.id, "opencode");
    assert.strictEqual(manifestFor("Droid", DETECT_MANIFESTS)?.id, "droid");
    assert.strictEqual(manifestFor("pi", DETECT_MANIFESTS)?.id, "pi");
  });

  test("does not let a two-letter alias claim an unrelated agent", () => {
    assert.strictEqual(manifestFor("oh-my-pi", DETECT_MANIFESTS), undefined);
    assert.strictEqual(manifestFor("Custom 3", DETECT_MANIFESTS), undefined);
    assert.strictEqual(manifestFor("Terminal", DETECT_MANIFESTS), undefined);
    assert.strictEqual(manifestFor("Antigravity", DETECT_MANIFESTS), undefined);
  });
});

suite("rule table integrity", () => {
  test("every rule and gate has a positive matcher", () => {
    assert.deepStrictEqual(invalidRules(DETECT_MANIFESTS), []);
  });

  test("every blocked rule opts in to notifying", () => {
    for (const manifest of DETECT_MANIFESTS) {
      for (const rule of manifest.rules) {
        if (rule.state === "blocked") {
          assert.strictEqual(
            rule.visibleBlocker,
            true,
            `${manifest.id}/${rule.id} is blocked but not visibleBlocker`
          );
        }
      }
    }
  });

  test("no heuristic claims done or error", () => {
    for (const manifest of DETECT_MANIFESTS) {
      for (const rule of manifest.rules) {
        assert.ok(
          rule.state === undefined ||
            ["idle", "working", "blocked", "unknown"].includes(rule.state),
          `${manifest.id}/${rule.id} claims ${rule.state}`
        );
      }
    }
  });
});

suite("detect: title and progress rules", () => {
  test("Claude's braille/half-circle spinner in the title means working", () => {
    assert.strictEqual(fire("Claude", { title: "⠹ claude" })?.state, "working");
    assert.strictEqual(fire("Claude", { title: "◐ refactoring" })?.state, "working");
    assert.strictEqual(fire("Claude", { title: "New task" }), undefined);
  });

  test("Claude's idle gear glyph means idle", () => {
    assert.strictEqual(fire("Claude", { title: "\u2733 claude" })?.state, "idle");
  });

  test("Codex 'Action Required' is blocked and notify-eligible", () => {
    const result = fire("Codex", { title: "claude — Action Required" });
    assert.strictEqual(result?.state, "blocked");
    assert.strictEqual(result?.rule.visibleBlocker, true);
  });

  test("Codex's spinner means working, and a plain title means idle", () => {
    assert.strictEqual(fire("Codex", { title: "codex ⠋" })?.state, "working");
    assert.strictEqual(fire("Codex", { title: "codex" })?.state, "idle");
  });

  test("Grok's indeterminate progress and Qwen's glyphs", () => {
    assert.strictEqual(fire("Grok", { progress: "4;1;-1" })?.state, "working");
    assert.strictEqual(fire("Qwen", { progress: "4;3;" })?.state, "working");
    assert.strictEqual(fire("Qwen", { title: "\u2733\uFE0E waiting" })?.state, "blocked");
  });
});

suite("detect: text rules that survive a stream", () => {
  test("OpenCode's explicit permission marker is blocked", () => {
    assert.strictEqual(fire("OpenCode", { text: "△ Permission required" })?.state, "blocked");
  });

  test("Codex's long literal blocker phrases are matched", () => {
    assert.strictEqual(
      fire("Codex", { text: "Allow command?\nPress enter to confirm" })?.state,
      "blocked"
    );
    assert.strictEqual(fire("Codex", { text: "plain output" }), undefined);
  });

  test("Claude's permission prompt needs the question, a footer and an option line", () => {
    const prompt = [
      "Bash command",
      "  rm -rf build",
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. Yes, and don't ask again",
      "  3. No",
      "esc to cancel · tab to amend",
    ].join("\n");
    assert.strictEqual(fire("Claude", { text: prompt })?.state, "blocked");
    assert.strictEqual(
      fire("Claude", { text: "Do you want to proceed?\nesc to cancel" }),
      undefined
    );
  });

  test("Claude's working hints come from explicit interrupt text", () => {
    assert.strictEqual(fire("Claude", { text: "esc to interrupt" })?.state, "working");
  });
});

suite("detect: rules deliberately NOT ported", () => {
  test("a dismissed Claude permission blurb does not re-arm", () => {
    assert.strictEqual(fire("Claude", { text: "waiting for permission\ntab to amend" }), undefined);
    assert.strictEqual(fire("Claude", { text: "review your answers" }), undefined);
  });

  test("Codex's weak blocker needles are not used", () => {
    assert.strictEqual(fire("Codex", { text: "[y/n] yes (y)" }), undefined);
    assert.strictEqual(fire("Codex", { text: "Do you trust the contents of this directory?" }), undefined);
  });

  test("a Gemini transcript mentioning yes/allow is not a live prompt", () => {
    assert.strictEqual(fire("Gemini", { text: "❯ allow this for me please" }), undefined);
    assert.strictEqual(fire("Gemini", { text: "│ Apply this change" })?.state, "blocked");
  });

  test("OpenCode's generic interrupt/progress needles are not blockers", () => {
    assert.strictEqual(fire("OpenCode", { text: "esc dismiss" }), undefined);
  });
});

suite("detect: priority and tie-breaking", () => {
  test("the highest priority match wins", () => {
    const result = fire("Codex", {
      title: "codex — Action Required",
      text: "esc to interrupt",
    });
    assert.strictEqual(result?.state, "blocked");
    assert.strictEqual(result?.rule.id, "osc_title_blocked");
  });

  test("a tie keeps the first-declared rule", () => {
    const manifest: DetectManifest = {
      id: "test",
      rules: [
        { id: "first", state: "working", priority: 10, region: "text", contains: ["x"] },
        { id: "second", state: "idle", priority: 10, region: "text", contains: ["x"] },
      ],
    };
    assert.strictEqual(detect(manifest, input({ text: "x" }))?.rule.id, "first");
  });

  test("skipStateUpdate publishes nothing", () => {
    const manifest: DetectManifest = {
      id: "test",
      rules: [
        { id: "viewer", state: "unknown", priority: 100, region: "text", skipStateUpdate: true, contains: ["viewer"] },
        { id: "fallback", state: "working", priority: 1, region: "text", contains: ["viewer"] },
      ],
    };
    assert.strictEqual(detect(manifest, input({ text: "viewer" })), undefined);
  });

  test("a rule whose region has no content cannot match", () => {
    assert.strictEqual(fire("Claude", { text: "esc to interrupt" })?.rule.region, "text_bottom");
    assert.strictEqual(fire("Claude", { title: undefined, text: "" }), undefined);
  });

  test("a malformed regex never matches (and never throws)", () => {
    const manifest: DetectManifest = {
      id: "test",
      rules: [{ id: "bad", state: "working", priority: 1, region: "text", regex: ["[unterminated"] }],
    };
    assert.strictEqual(detect(manifest, input({ text: "anything" })), undefined);
  });
});

suite("detect: text_bottom only trusts the bottom", () => {
  test("a needle above the window is not matched by a bottom-region rule", () => {
    const manifest: DetectManifest = {
      id: "test",
      rules: [
        { id: "bottom", state: "blocked", priority: 1, region: "text_bottom", lines: 2, contains: ["prompt"] },
      ],
    };
    const text = ["prompt", ...Array.from({ length: 10 }, (_, i) => `line ${i}`)].join("\n");
    assert.strictEqual(detect(manifest, input({ text })), undefined);
  });
});
