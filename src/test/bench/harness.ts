export interface BenchResult {
  name: string;
  iterations: number;
  medianNs: number;
  p95Ns: number;
  opsPerSec: number;
  heapBytesPerOp: number | null;
}

export interface BenchOptions {
  iterations?: number;
  warmup?: number;
}

export type BenchFn = (() => void) | (() => Promise<void>);

const maybeGc = (globalThis as { gc?: () => void }).gc;

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
