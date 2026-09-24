/**
 * Minimal benchmark harness for the data-plane hot paths — dependency-free on
 * purpose (the extension ships zero runtime deps; the bench shouldn't quietly
 * become the first). Not a `*.test.ts` file, so neither test tier's glob
 * (out/test/unit/*.test.js, host suite) ever collects it. Reached via
 * `npm run bench` → out/test/bench/run.js.
 *
 * Methodology, such as it is:
 *  - Fixed warmup, then per-iteration `hrtime.bigint()` around each call. The
 *    timing overhead itself is sub-µs and — crucially — identical across runs,
 *    which is what matters for the before/after A/B this exists for.
 *  - median + p95 instead of mean: one-off outliers (GC pause, scheduler)
 *    land in p95, not in the number you compare.
 *  - Heap delta per op via forced GC before/after the timed loop. Rough by
 *    construction (a mid-loop GC undercounts churn), but consistent enough to
 *    catch a refactor that starts cloning a large config per call. Needs
 *    `--expose-gc` (the npm script passes it); reports null without it.
 *
 * These numbers are for comparing runs on the same machine — never absolutes.
 */

export interface BenchResult {
  name: string;
  iterations: number;
  medianNs: number;
  p95Ns: number;
  opsPerSec: number;
  heapBytesPerOp: number | null;
}

export interface BenchOptions {
  /** Timed iterations (after warmup). Default 2000. */
  iterations?: number;
  /** Untimed warmup calls. Default max(50, iterations / 10). */
  warmup?: number;
}

/** The per-iteration function under test; sync for tight-loop measurement, async for I/O scenarios. */
export type BenchFn = (() => void) | (() => Promise<void>);

/** `--expose-gc`'s global; absent when run without the flag. */
const maybeGc = (globalThis as { gc?: () => void }).gc;

/** Force a GC and read heapUsed, or null when --expose-gc wasn't passed. */
function heapAfterGc(): number | null {
  if (!maybeGc) return null;
  maybeGc();
  return process.memoryUsage().heapUsed;
}

function summarize(
  name: string,
  durationsNs: number[],
  heapBefore: number | null,
  heapAfter: number | null,
  iterations: number
): BenchResult {
  durationsNs.sort((a, b) => a - b);
  const medianNs = durationsNs[Math.floor((durationsNs.length - 1) / 2)];
  const p95Ns = durationsNs[Math.floor((durationsNs.length - 1) * 0.95)];
  const heapBytesPerOp =
    heapBefore !== null && heapAfter !== null
      ? Math.max(0, heapAfter - heapBefore) / iterations
      : null;
  return {
    name,
    iterations,
    medianNs,
    p95Ns,
    opsPerSec: 1e9 / medianNs,
    heapBytesPerOp,
  };
}

function warmupCount(iterations: number, warmup?: number): number {
  return warmup ?? Math.max(50, Math.floor(iterations / 10));
}

/**
 * Run one scenario. The first (probe) call decides sync vs async handling —
 * async fns pay ~1µs/iteration of await overhead, which only matters for the
 * sub-µs pure functions that are benchmarked sync anyway. Always resolves, so
 * the runner can `await` uniformly.
 */
export function bench(name: string, fn: BenchFn, opts: BenchOptions = {}): Promise<BenchResult> {
  const iterations = opts.iterations ?? 2000;
  const warmup = warmupCount(iterations, opts.warmup);

  const probe = fn();
  if (probe && typeof (probe as Promise<void>).then === "function") {
    return (probe as Promise<void>).then(() => runAsync(name, fn as () => Promise<void>, iterations, warmup));
  }
  return Promise.resolve(runSync(name, fn as () => void, iterations, warmup));
}

function runSync(name: string, fn: () => void, iterations: number, warmup: number): BenchResult {
  for (let i = 1; i < warmup; i++) fn();
  const durations: number[] = new Array(iterations);
  const heapBefore = heapAfterGc();
  for (let i = 0; i < iterations; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    durations[i] = Number(process.hrtime.bigint() - t0);
  }
  return summarize(name, durations, heapBefore, heapAfterGc(), iterations);
}

async function runAsync(name: string, fn: () => Promise<void>, iterations: number, warmup: number): Promise<BenchResult> {
  for (let i = 1; i < warmup; i++) await fn();
  const durations: number[] = new Array(iterations);
  const heapBefore = heapAfterGc();
  for (let i = 0; i < iterations; i++) {
    const t0 = process.hrtime.bigint();
    await fn();
    durations[i] = Number(process.hrtime.bigint() - t0);
  }
  return summarize(name, durations, heapBefore, heapAfterGc(), iterations);
}
