/**
 * Repo-scoping helpers (folderOf / folderBasename / filterSessionsByFolder).
 * Unit tier — no VS Code host needed.
 */

import * as assert from "assert";

import {
  type SessionState,
  folderOf,
  folderBasename,
  filterSessionsByFolder,
} from "../../lifecycle";

function makeState(
  name: string,
  agentName: string,
  status: SessionState["status"],
  changedAt = Date.now(),
  extra: Partial<Pick<SessionState, "cwd" | "launchedInFolder">> = {}
): SessionState {
  return { name, agentName, status, changedAt, ...extra };
}

suite("folderOf", () => {
  test("prefers cwd over launchedInFolder", () => {
    const got = folderOf(
      makeState("Claude", "Claude", "running", 100, {
        cwd: "/a/cwd",
        launchedInFolder: "/b/launch",
      })
    );
    assert.strictEqual(got, "/a/cwd");
  });

  test("falls back to launchedInFolder when cwd is absent", () => {
    const got = folderOf(
      makeState("Claude", "Claude", "running", 100, {
        launchedInFolder: "/b/launch",
      })
    );
    assert.strictEqual(got, "/b/launch");
  });

  test("returns undefined when neither is set (re-adopted, no hook yet)", () => {
    const got = folderOf(makeState("Claude", "Claude", "unknown", 100));
    assert.strictEqual(got, undefined);
  });
});

suite("folderBasename", () => {
  test("plain unix path", () => {
    assert.strictEqual(folderBasename("/Users/me/projects/my-app"), "my-app");
  });

  test("plain windows path", () => {
    assert.strictEqual(folderBasename("C:\\dev\\projects\\my-app"), "my-app");
  });

  test("strips trailing slash", () => {
    assert.strictEqual(folderBasename("/Users/me/projects/my-app/"), "my-app");
    assert.strictEqual(folderBasename("C:\\dev\\my-app\\"), "my-app");
  });

  test("strips repeated trailing slashes", () => {
    assert.strictEqual(folderBasename("/Users/me/projects/my-app//"), "my-app");
  });

  test("bare name passthrough", () => {
    assert.strictEqual(folderBasename("my-app"), "my-app");
  });
});

suite("filterSessionsByFolder", () => {
  test("returns everything when activeFolder is undefined (no workspace)", () => {
    const states = [
      makeState("Claude", "Claude", "running", 100, { cwd: "/a" }),
      makeState("Codex", "Codex", "running", 100, { cwd: "/b" }),
      makeState("ReAdopted", "ReAdopted", "unknown", 100),
    ];
    assert.strictEqual(filterSessionsByFolder(states, undefined).length, 3);
  });

  test("filters to sessions whose cwd matches the active folder", () => {
    const states = [
      makeState("Claude", "Claude", "running", 100, { cwd: "/repo/alpha" }),
      makeState("Codex", "Codex", "running", 100, { cwd: "/repo/beta" }),
    ];
    const filtered = filterSessionsByFolder(states, "/repo/alpha");
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].name, "Claude");
  });

  test("falls back to launchedInFolder when cwd is absent", () => {
    const states = [
      makeState("Claude", "Claude", "running", 100, {
        launchedInFolder: "/repo/alpha",
      }),
      makeState("Codex", "Codex", "running", 100, {
        launchedInFolder: "/repo/beta",
      }),
    ];
    const filtered = filterSessionsByFolder(states, "/repo/alpha");
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].name, "Claude");
  });

  test("excludes re-adopted sessions (no cwd, no launchedInFolder) when a folder is set", () => {
    const states = [
      makeState("Claude", "Claude", "unknown", 100),
      makeState("Codex", "Codex", "running", 100, { cwd: "/repo/alpha" }),
    ];
    const filtered = filterSessionsByFolder(states, "/repo/alpha");
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].name, "Codex");
  });

  test("empty input → empty output", () => {
    assert.strictEqual(filterSessionsByFolder([], "/anywhere").length, 0);
  });
});
