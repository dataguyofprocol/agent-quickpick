/**
 * Frecency scoring, sorting, and persistence via a fake memento.
 * Unit tier — imports from ../../agents, no VS Code host needed.
 */

import * as assert from "assert";

import {
  frecencyScore,
  sortByFrecency,
  recordLaunch,
  readFrecency,
  type MementoLike,
} from "../../agents";

/** Map-backed vscode.Memento stand-in. */
function fakeMemento(initial?: Record<string, unknown>): MementoLike & {
  store: Map<string, unknown>;
} {
  const store = new Map<string, unknown>(Object.entries(initial ?? {}));
  return {
    store,
    get<T>(key: string): T | undefined {
      return store.get(key) as T | undefined;
    },
    update(key: string, value: unknown): void {
      store.set(key, value);
    },
  };
}

suite("frecencyScore", () => {
  const NOW = 1_700_000_000_000;
  const DAY = 86_400_000;

  test("zero count → score 0", () => {
    assert.strictEqual(frecencyScore(0, NOW, NOW), 0);
    assert.strictEqual(frecencyScore(0, 0, NOW), 0);
  });

  test("negative count → score 0", () => {
    assert.strictEqual(frecencyScore(-3, NOW, NOW), 0);
  });

  test("freshly launched: score == count", () => {
    // age = 0 → decay factor = 1.
    assert.strictEqual(frecencyScore(5, NOW, NOW), 5);
    assert.strictEqual(frecencyScore(42, NOW, NOW), 42);
  });

  test("older launches score lower than newer ones at equal count", () => {
    const fresh = frecencyScore(10, NOW - 1 * DAY, NOW);
    const stale = frecencyScore(10, NOW - 30 * DAY, NOW);
    assert.ok(fresh > stale, `fresh (${fresh}) should beat stale (${stale})`);
  });

  test("future last-used dates don't inflate the score (age clamped at 0)", () => {
    assert.strictEqual(frecencyScore(5, NOW + 30 * DAY, NOW), 5);
  });

  test("decay is roughly halved per 10-day half-life", () => {
    const now = frecencyScore(10, NOW - 10 * DAY, NOW);
    // 2^(-1) ≈ 0.5 → ~5.0, allow small float slack.
    assert.ok(Math.abs(now - 5) < 0.01, `expected ~5, got ${now}`);
  });

  test("higher count can overcome recency advantage", () => {
    // A 100-launch agent 30 days ago still beats a 1-launch agent from today.
    const heavyOld = frecencyScore(100, NOW - 30 * DAY, NOW);
    const lightNew = frecencyScore(1, NOW, NOW);
    assert.ok(heavyOld > lightNew, "frequent old should beat rare new");
  });
});

suite("sortByFrecency", () => {
  const NOW = 1_700_000_000_000;
  const DAY = 86_400_000;

  test("stable when all scores equal: preserves input order", () => {
    const items = ["a", "b", "c", "d"];
    const sorted = sortByFrecency(items, () => 0);
    assert.deepStrictEqual(sorted, ["a", "b", "c", "d"]);
  });

  test("higher scores sort first", () => {
    const items = [
      { name: "low", score: 1 },
      { name: "high", score: 100 },
      { name: "mid", score: 10 },
    ];
    const sorted = sortByFrecency(items, (x) => x.score).map((x) => x.name);
    assert.deepStrictEqual(sorted, ["high", "mid", "low"]);
  });

  test("ties keep original relative order (stability)", () => {
    const items = [
      { name: "first", score: 5 },
      { name: "second", score: 5 },
      { name: "third", score: 5 },
    ];
    const sorted = sortByFrecency(items, (x) => x.score).map((x) => x.name);
    assert.deepStrictEqual(sorted, ["first", "second", "third"]);
  });

  test("mixed zero and non-zero scores: zeros keep input order at the tail", () => {
    const items = [
      { name: "B", score: 0 },
      { name: "A", score: 3 },
      { name: "C", score: 0 },
      { name: "D", score: 0 },
    ];
    const sorted = sortByFrecency(items, (x) => x.score).map((x) => x.name);
    // A (score 3) first, then B/C/D in original order.
    assert.deepStrictEqual(sorted, ["A", "B", "C", "D"]);
  });

  test("simulated frecency sort matches expected decay behavior", () => {
    // Claude: launched 20×, last 1 day ago.
    // Codex: launched 5×, last 0 days ago.
    // Gemini: never launched (score 0).
    // Terminal: launched 1×, 20 days ago.
    const agents = [
      { name: "Terminal", c: 1, t: NOW - 20 * DAY },
      { name: "Claude", c: 20, t: NOW - 1 * DAY },
      { name: "Codex", c: 5, t: NOW },
      { name: "Gemini", c: 0, t: 0 },
    ];
    const sorted = sortByFrecency(agents, (a) => frecencyScore(a.c, a.t, NOW)).map((a) => a.name);
    // Claude's high count dominates despite Codex being fresher.
    assert.strictEqual(sorted[0], "Claude");
    assert.strictEqual(sorted[sorted.length - 1], "Gemini"); // never launched → last
  });

  test("does not mutate the input array", () => {
    const items = [{ name: "B", score: 2 }, { name: "A", score: 1 }];
    const snapshot = items.map((x) => x.name);
    sortByFrecency(items, (x) => x.score);
    assert.deepStrictEqual(items.map((x) => x.name), snapshot);
  });
});

suite("recordLaunch (persistence via memento)", () => {
  test("first launch writes {c:1, t:now} keyed by lowercase name", () => {
    const m = fakeMemento();
    recordLaunch(m, "Claude", 1000);
    assert.deepStrictEqual(m.store.get("frecency.v1"), { claude: { c: 1, t: 1000 } });
  });

  test("subsequent launches increment count and update timestamp", () => {
    const m = fakeMemento({
      "frecency.v1": { claude: { c: 4, t: 1000 } },
    });
    recordLaunch(m, "Claude", 2000);
    assert.deepStrictEqual(m.store.get("frecency.v1"), { claude: { c: 5, t: 2000 } });
  });

  test("mixed-case launches hit the same key", () => {
    const m = fakeMemento();
    recordLaunch(m, "Claude", 1000);
    recordLaunch(m, "CLAUDE", 2000);
    assert.deepStrictEqual(m.store.get("frecency.v1"), { claude: { c: 2, t: 2000 } });
  });

  test("multiple agents coexist in the map", () => {
    const m = fakeMemento();
    recordLaunch(m, "Claude", 1000);
    recordLaunch(m, "Codex", 1100);
    recordLaunch(m, "Claude", 1200);
    assert.deepStrictEqual(m.store.get("frecency.v1"), {
      claude: { c: 2, t: 1200 },
      codex: { c: 1, t: 1100 },
    });
  });

  test("readFrecency is defensive against a garbage persisted shape", () => {
    assert.deepStrictEqual(readFrecency(fakeMemento()), {});
    assert.deepStrictEqual(readFrecency(fakeMemento({ "frecency.v1": null })), {});
    assert.deepStrictEqual(readFrecency(fakeMemento({ "frecency.v1": 42 })), {});
    assert.deepStrictEqual(readFrecency(fakeMemento({ "frecency.v1": [1, 2] })), {});
  });

  test("recordLaunch overwrites a garbage persisted shape without throwing", () => {
    const m = fakeMemento({ "frecency.v1": "not-an-object" });
    recordLaunch(m, "Claude", 1000);
    assert.deepStrictEqual(m.store.get("frecency.v1"), { claude: { c: 1, t: 1000 } });
  });
});
