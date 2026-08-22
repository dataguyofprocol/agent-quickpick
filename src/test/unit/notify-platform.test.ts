/**
 * Platform notification/sound command builders + the focus-URI click contract
 * + argv sanitizers. Everything here is argv-based; these tests pin that no
 * user-derived text is ever spliced into a shell/AppleScript/PowerShell
 * command line. Unit tier — no VS Code host needed.
 */

import * as assert from "assert";
import * as path from "path";

import {
  systemNotifyCommand,
  soundPlayCommand,
  notifierCandidates,
  VENDORED_NOTIFIER_REL,
  sessionFromFocusUri,
  FOCUS_URI_PATH,
  FOCUS_URI_SESSION_PARAM,
  isSafeBundleId,
  sanitizeArgvText,
  HOOK_ENV,
} from "../../lifecycle";

suite("sanitizeArgvText", () => {
  test("keeps plain readable text", () => {
    assert.strictEqual(sanitizeArgvText("✓ Claude finished · my-app"), "✓ Claude finished · my-app");
    assert.strictEqual(sanitizeArgvText("hello world"), "hello world");
  });

  test("keeps quotes and parentheses (safe as standalone argv entries)", () => {
    assert.strictEqual(sanitizeArgvText('"quoted" (parens)'), '"quoted" (parens)');
    assert.strictEqual(sanitizeArgvText("it's"), "it's");
  });

  test("keeps unicode symbols and em-dashes", () => {
    assert.strictEqual(sanitizeArgvText("⏸ ● — ✓"), "⏸ ● — ✓");
  });

  test("strips C0 control characters", () => {
    assert.strictEqual(sanitizeArgvText("a\x00\x01b"), "ab");
    assert.strictEqual(sanitizeArgvText("line\x0abreak"), "linebreak");
  });

  test("strips DEL (0x7f)", () => {
    assert.strictEqual(sanitizeArgvText("a\x7fb"), "ab");
  });

  test("strips shell metacharacters", () => {
    for (const ch of ";|`$&\\<>!*?#~%@+=[]{}^") {
      assert.strictEqual(sanitizeArgvText(`a${ch}b`), "ab", `metachar ${ch} should be stripped`);
    }
  });

  test("neutralizes command substitution markers", () => {
    // Parens are kept (legit in session names like "Codex (2)"), but $ and
    // backticks are stripped, so no $(...) or `...` substitution can survive.
    assert.strictEqual(sanitizeArgvText("$(id)"), "(id)");
    const out = sanitizeArgvText('"; rm -rf ~ #$(id)`touch /tmp/pwned`');
    assert.ok(!out.includes("$"), "no substitution markers survive");
    assert.ok(!out.includes("`"), "no backticks survive");
    assert.ok(!out.includes(";"), "no statement separators survive");
  });

  test("empty string passthrough", () => {
    assert.strictEqual(sanitizeArgvText(""), "");
  });
});

suite("isSafeBundleId", () => {
  test("accepts reverse-DNS ids", () => {
    assert.ok(isSafeBundleId("com.microsoft.VSCode"));
    assert.ok(isSafeBundleId("com.microsoft.VSCode-insiders"));
    assert.ok(isSafeBundleId("a"));
    assert.ok(isSafeBundleId("dev.trae.app-1"));
  });

  test("rejects quotes and injection payloads", () => {
    assert.strictEqual(isSafeBundleId('com.x" to do shell script "id'), false);
    assert.strictEqual(isSafeBundleId("com.x'; id"), false);
    assert.strictEqual(isSafeBundleId("$(id)"), false);
    assert.strictEqual(isSafeBundleId("com.x\ninjected"), false);
  });

  test("rejects empty and leading-dot ids", () => {
    assert.strictEqual(isSafeBundleId(""), false);
    assert.strictEqual(isSafeBundleId(".leading.dot"), false);
  });

  test("rejects over-long ids (more than 128 chars)", () => {
    // 1 leading char + up to 127 more = 128 max.
    assert.strictEqual(isSafeBundleId("a".repeat(128)), true);
    assert.strictEqual(isSafeBundleId("a".repeat(129)), false);
  });
});

suite("HOOK_ENV", () => {
  test("carries exactly the two injected env vars", () => {
    assert.deepStrictEqual(HOOK_ENV("http://127.0.0.1:4242", "Claude (2)"), {
      AQP_HOOK_URL: "http://127.0.0.1:4242",
      AQP_SESSION: "Claude (2)",
    });
  });
});

suite("notifierCandidates", () => {
  const EXT = "/ext";

  test("returns no candidates off macOS (terminal-notifier is darwin-only)", () => {
    assert.deepStrictEqual(notifierCandidates(EXT, "linux"), []);
    assert.deepStrictEqual(notifierCandidates(EXT, "win32"), []);
  });

  test("prefers well-known installs before the bundled fallback; $PATH not probed", () => {
    const c = notifierCandidates(EXT, "darwin");
    // A user's own copy always wins, so power users keep their newer build...
    assert.strictEqual(c[0], "/opt/homebrew/bin/terminal-notifier");
    assert.strictEqual(c[1], "/usr/local/bin/terminal-notifier");
    assert.strictEqual(c[2], "/opt/local/bin/terminal-notifier");
    // ...and the bundled universal .app is the notifier of last resort. The
    // list is closed: no $PATH probing (a GUI-launched editor inherits
    // launchd's minimal PATH anyway, so such candidates can't exist).
    assert.strictEqual(c.length, 4);
    assert.strictEqual(
      c[c.length - 1],
      path.join(EXT, VENDORED_NOTIFIER_REL)
    );
  });

  test("the bundled candidate is the inner Mach-O of the vendored .app", () => {
    assert.strictEqual(
      VENDORED_NOTIFIER_REL,
      "resources/notifier/terminal-notifier.app/Contents/MacOS/terminal-notifier"
    );
  });
});

suite("sessionFromFocusUri", () => {
  test("returns the session for a focus URI", () => {
    const query = new URLSearchParams({
      [FOCUS_URI_SESSION_PARAM]: "Claude",
    }).toString();
    assert.strictEqual(sessionFromFocusUri(FOCUS_URI_PATH, query), "Claude");
  });

  test("round-trips a session name with spaces and parens (as focusUri emits)", () => {
    // focusUri builds the query with URLSearchParams; the click must recover the
    // exact tab name, e.g. "Codex (2)", so the right terminal is focused.
    const name = "Codex (2)";
    const query = new URLSearchParams({
      [FOCUS_URI_SESSION_PARAM]: name,
    }).toString();
    assert.strictEqual(sessionFromFocusUri(FOCUS_URI_PATH, query), name);
  });

  test("returns null for a non-focus path", () => {
    const query = new URLSearchParams({
      [FOCUS_URI_SESSION_PARAM]: "Claude",
    }).toString();
    assert.strictEqual(sessionFromFocusUri("/other", query), null);
    assert.strictEqual(sessionFromFocusUri("focus", query), null);
  });

  test("returns null when the session param is absent", () => {
    assert.strictEqual(
      sessionFromFocusUri(FOCUS_URI_PATH, "foo=bar&baz=qux"),
      null
    );
  });

  test("returns null for an empty session", () => {
    const query = new URLSearchParams({
      [FOCUS_URI_SESSION_PARAM]: "",
    }).toString();
    assert.strictEqual(sessionFromFocusUri(FOCUS_URI_PATH, query), null);
  });
});

suite("systemNotifyCommand", () => {
  const TITLE = "Agent Quickpick";
  // Hostile text: a session/repo name can legitimately contain these.
  // sanitizeArgvText strips shell metacharacters while keeping readable text.
  const BODY = '✓ Claude finished · "(id)" whoami  \'x\'';

  test("darwin without a bundle id passes body/title as argv, never spliced into AppleScript", () => {
    const spec = systemNotifyCommand("darwin", TITLE, BODY);
    assert.ok(spec);
    assert.strictEqual(spec!.file, "osascript");
    // The user-derived strings appear as standalone argv entries...
    assert.ok(spec!.args.includes(BODY), "body should be its own argv entry");
    assert.ok(spec!.args.includes(TITLE), "title should be its own argv entry");
    // ...and the script fragments reference argv, not the text itself.
    const script = spec!.args.filter((a) => a !== BODY && a !== TITLE).join(" ");
    assert.ok(script.includes("item 1 of argv"));
    assert.ok(script.includes("item 2 of argv"));
    assert.ok(!script.includes("$(id)"), "no user text inside the script");
  });

  test("darwin with a bundle id prefers terminal-notifier, falls back to osascript", () => {
    const spec = systemNotifyCommand("darwin", TITLE, BODY, {
      bundleId: "com.microsoft.VSCode",
    });
    assert.ok(spec);
    assert.strictEqual(spec!.file, "terminal-notifier");
    // -sender fixes the banner icon, -activate makes a click raise the editor.
    assert.deepStrictEqual(spec!.args, [
      "-title",
      TITLE,
      "-message",
      BODY,
      "-sender",
      "com.microsoft.VSCode",
      "-activate",
      "com.microsoft.VSCode",
    ]);
    // Not installed (ENOENT) must still produce a banner.
    assert.strictEqual(spec!.fallback?.file, "osascript");
  });

  test("darwin uses the resolved notifier path, not the bare name", () => {
    // A GUI-launched editor has launchd's PATH — Homebrew is not on it.
    const spec = systemNotifyCommand("darwin", TITLE, BODY, {
      bundleId: "com.microsoft.VSCode",
      notifierPath: "/opt/homebrew/bin/terminal-notifier",
    });
    assert.strictEqual(spec!.file, "/opt/homebrew/bin/terminal-notifier");
  });

  test("darwin routes a click through -open when given a focus URI", () => {
    const uri = "vscode://pub.agent-quickpick/focus?session=Claude%20(2)";
    const spec = systemNotifyCommand("darwin", TITLE, BODY, {
      bundleId: "com.microsoft.VSCode",
      openUrl: uri,
    });
    assert.ok(spec!.args.includes("-open"));
    assert.strictEqual(spec!.args[spec!.args.indexOf("-open") + 1], uri);
    // -sender must not be combined with -open; macOS swallows the click when the
    // notification is attributed to another app.
    assert.ok(!spec!.args.includes("-sender"));
    assert.ok(!spec!.args.includes("-activate"));
  });

  test("darwin rejects an unsafe bundle id rather than splicing it", () => {
    const evil = 'com.x" to do shell script "id';
    assert.strictEqual(isSafeBundleId(evil), false);
    assert.strictEqual(isSafeBundleId("com.microsoft.VSCode-insiders"), true);
    const spec = systemNotifyCommand("darwin", TITLE, BODY, { bundleId: evil });
    assert.strictEqual(spec!.file, "osascript");
    assert.ok(
      !spec!.args.join(" ").includes("do shell script"),
      "unsafe id must not reach the script or argv"
    );
  });

  test("linux uses notify-send with argv", () => {
    const spec = systemNotifyCommand("linux", TITLE, BODY);
    assert.deepStrictEqual(spec, { file: "notify-send", args: [TITLE, BODY] });
  });

  test("win32 passes text via env, not the command line", () => {
    const spec = systemNotifyCommand("win32", TITLE, BODY);
    assert.ok(spec);
    assert.strictEqual(spec!.file, "powershell");
    assert.strictEqual(spec!.env?.AQP_NOTIFY_TITLE, TITLE);
    assert.strictEqual(spec!.env?.AQP_NOTIFY_BODY, BODY);
    const cmd = spec!.args.join(" ");
    assert.ok(!cmd.includes(BODY), "body must not reach the command line");
    assert.ok(cmd.includes("$env:AQP_NOTIFY_BODY"));
    assert.ok(cmd.includes("-NoProfile"));
  });

  test("unknown platform → null (toast + sound still fire)", () => {
    assert.strictEqual(systemNotifyCommand("aix", TITLE, BODY), null);
  });
});

suite("soundPlayCommand", () => {
  const P = "/Users/me/Agent Quickpick/media/sounds/notif.wav";

  test("darwin uses afplay with the path as argv", () => {
    assert.deepStrictEqual(soundPlayCommand("darwin", P), {
      file: "afplay",
      args: [P],
    });
  });

  test("linux falls back from paplay to aplay", () => {
    const spec = soundPlayCommand("linux", P);
    assert.strictEqual(spec!.file, "paplay");
    assert.strictEqual(spec!.fallback?.file, "aplay");
    assert.ok(spec!.fallback?.args.includes(P));
  });

  test("win32 passes the path via env (spaces would break the command line)", () => {
    const spec = soundPlayCommand("win32", P);
    assert.strictEqual(spec!.env?.AQP_SOUND_PATH, P);
    assert.ok(!spec!.args.join(" ").includes(P));
  });

  test("unknown platform → null", () => {
    assert.strictEqual(soundPlayCommand("aix", P), null);
  });
});
