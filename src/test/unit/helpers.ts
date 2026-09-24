/**
 * Shared harness for the unit tier — the helpers that several behavioral
 * suites each carried a copy of (with drift): waitFor, the hook-command
 * executor, and makeState. Plain Node only (assert + child_process); the
 * lifecycle types below are import-types, so this module stays free of
 * runtime vscode usage like the rest of the unit-tier imports. Not a
 * *.test.ts file, so mocha's out/test/unit/*.test.js glob never collects it.
 */

import * as assert from "assert";
import { execFile } from "child_process";

import type { LifecycleStatus, SessionState } from "../../lifecycle";

/**
 * The command is always `node -e "<script>"`. Peel off the wrapper so we can
 * exec the script directly, without a shell, on every platform.
 */
export function extractScript(cmd: string): string {
  const prefix = 'node -e "';
  assert.ok(cmd.startsWith(prefix), `command should start with ${prefix}`);
  assert.ok(cmd.endsWith('"'), "command should end with a double quote");
  return cmd.slice(prefix.length, -1);
}

export interface RunResult {
  code: number | null;
  stderr: string;
}

/** Execute a generated hook command with the given env + stdin JSON. */
export function runHook(
  cmd: string,
  opts: { env?: Record<string, string>; stdin?: string } = {}
): Promise<RunResult> {
  // Hermetic: strip any ambient AQP_* env this test process inherited (e.g.
  // the tests running inside a terminal agent-quickpick itself launched —
  // AQP_SESSION/AQP_HOOK_URL there belong to the editor session, not us).
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  delete env.AQP_SESSION;
  delete env.AQP_HOOK_URL;
  Object.assign(env, opts.env);
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath, // the same node running the tests
      ["-e", extractScript(cmd)],
      { env },
      (_error, _stdout, stderr) => {
        // The callback fires on exit whatever the code; exitCode is the truth.
        resolve({ code: child.exitCode, stderr: String(stderr) });
      }
    );
    child.on("error", reject);
    if (opts.stdin !== undefined) {
      child.stdin?.end(opts.stdin);
    } else {
      child.stdin?.end();
    }
  });
}

/** Wait until predicate() is truthy, polling every 25ms up to `ms`. */
export function waitFor(predicate: () => boolean, ms = 3000, what = "condition"): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > ms) {
        return reject(new Error(`timed out after ${ms}ms waiting for ${what}`));
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

/** Build a SessionState with defaults, for status-bar / folder-scope tests. */
export function makeState(
  name: string,
  agentName: string,
  status: LifecycleStatus,
  changedAt = Date.now(),
  extra: Partial<Pick<SessionState, "cwd" | "launchedInFolder">> = {}
): SessionState {
  return { name, agentName, status, changedAt, ...extra };
}
