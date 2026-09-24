/**
 * Bench entry point. Two modes:
 *
 *   npm run bench                               # run all scenarios, print table, save snapshot
 *   npm run bench -- --compare a.json b.json    # diff two saved snapshots (no run)
 *
 * The refactor A/B workflow: bench on the old code (snapshot A), apply the
 * refactor, bench again (snapshot B), then --compare A B. Same machine,
 * ideally same background load; expect a few % of jitter run-to-run — which is
 * why the compare table flags |Δmedian| >= 10% instead of presenting raw
 * deltas as truth. This is a measuring tool, not a gate: it always exits 0
 * unless invoked wrong.
 */

import * as fs from "fs";
import * as path from "path";

import { bench, type BenchResult } from "./harness";
import { SCENARIOS } from "./scenarios";

interface Snapshot {
  meta: {
    node: string;
    platform: string;
    date: string;
    exposeGc: boolean;
  };
  results: BenchResult[];
}

const RESULTS_DIR = "bench-results";
const FLAG_THRESHOLD = 0.1; // |Δmedian| ≥ 10% gets a ▲/▼ marker

function fmtDuration(ns: number): string {
  if (ns < 1e3) return `${Math.round(ns)} ns`;
  if (ns < 1e6) return `${(ns / 1e3).toFixed(1)} µs`;
  if (ns < 1e9) return `${(ns / 1e6).toFixed(2)} ms`;
  return `${(ns / 1e9).toFixed(2)} s`;
}

function fmtOps(opsPerSec: number): string {
  if (opsPerSec >= 1e6) return `${(opsPerSec / 1e6).toFixed(2)}M/s`;
  if (opsPerSec >= 1e3) return `${(opsPerSec / 1e3).toFixed(1)}k/s`;
  return `${Math.round(opsPerSec)}/s`;
}

function fmtBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function row(cells: string[], widths: number[]): string {
  return cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
}

function compareTable(oldResults: BenchResult[], newResults: BenchResult[]): string {
  const header = ["scenario", "old median", "new median", "Δ median", "heap/op old→new", ""];
  const oldByName = new Map(oldResults.map((r) => [r.name, r]));
  const rows: string[][] = [];
  for (const nu of newResults) {
    const old = oldByName.get(nu.name);
    if (!old) {
      rows.push([nu.name, "—", fmtDuration(nu.medianNs), "new", "—", ""]);
      continue;
    }
    const delta = (nu.medianNs - old.medianNs) / old.medianNs;
    const marker = delta >= FLAG_THRESHOLD ? "▲ slower" : delta <= -FLAG_THRESHOLD ? "▼ faster" : "·";
    rows.push([
      nu.name,
      fmtDuration(old.medianNs),
      fmtDuration(nu.medianNs),
      `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}%`,
      `${fmtBytes(old.heapBytesPerOp)} → ${fmtBytes(nu.heapBytesPerOp)}`,
      marker,
    ]);
  }
  const newNames = new Set(newResults.map((r) => r.name));
  for (const old of oldResults) {
    if (!newNames.has(old.name)) {
      rows.push([old.name, fmtDuration(old.medianNs), "—", "removed", "—", ""]);
    }
  }
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  return [row(header, widths), ...rows.map((r) => row(r, widths))].join("\n");
}

function readSnapshot(file: string): Snapshot {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Snapshot;
  if (!parsed || !Array.isArray(parsed.results)) {
    throw new Error(`${file} is not a bench snapshot`);
  }
  return parsed;
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function runMode(): Promise<void> {
  const exposeGc = typeof (globalThis as { gc?: () => void }).gc === "function";
  console.log(`agent-quickpick bench — node ${process.version}, ${process.platform} ${process.arch}${exposeGc ? "" : " (no --expose-gc: heap column disabled)"}`);
  console.log("");

  const results: BenchResult[] = [];
  // Scenario names are static, so column widths can come from them up front —
  // rows print progressively below and must align with this header.
  const header = ["scenario", "iter", "median", "p95", "ops/s", "heap/op"];
  const widths = header.map((h, i) =>
    i === 0 ? Math.max(h.length, ...SCENARIOS.map((s) => s.name.length)) : h.length
  );
  console.log(row(header, widths));
  for (const scenario of SCENARIOS) {
    const fn = scenario.setup();
    const result = await bench(scenario.name, fn, scenario);
    await scenario.teardown?.();
    results.push(result);
    // Progressive output — the suite takes seconds, not ms.
    console.log(row(
      [result.name, String(result.iterations), fmtDuration(result.medianNs), fmtDuration(result.p95Ns), fmtOps(result.opsPerSec), fmtBytes(result.heapBytesPerOp)],
      widths
    ));
  }

  const snapshot: Snapshot = {
    meta: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      date: new Date().toISOString(),
      exposeGc,
    },
    results,
  };
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const file = path.join(RESULTS_DIR, `bench-${timestamp()}.json`);
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2) + "\n");
  console.log("");
  console.log(`full table saved: ${file}`);
  console.log(`A/B a refactor:  npm run bench -- --compare <old-snapshot> ${file}`);
}

function compareMode(oldFile: string, newFile: string): void {
  const oldSnap = readSnapshot(oldFile);
  const newSnap = readSnapshot(newFile);
  console.log(`old: ${oldFile} — ${oldSnap.meta.date}, node ${oldSnap.meta.node}`);
  console.log(`new: ${newFile} — ${newSnap.meta.date}, node ${newSnap.meta.node}`);
  if (oldSnap.meta.platform !== newSnap.meta.platform) {
    console.log("⚠ snapshots come from different platforms — numbers are not comparable");
  }
  console.log("");
  console.log(compareTable(oldSnap.results, newSnap.results));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--compare") {
    if (argv.length !== 3) {
      throw new Error("usage: npm run bench -- --compare <old.json> <new.json>");
    }
    compareMode(argv[1], argv[2]);
    return;
  }
  if (argv.length > 0) {
    throw new Error(`unknown arguments: ${argv.join(" ")} (only --compare is supported)`);
  }
  await runMode();
}

main().catch((err: unknown) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
