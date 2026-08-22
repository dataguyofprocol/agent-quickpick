import * as path from "path";
import Mocha from "mocha";
import { glob } from "glob";

/**
 * Minimal reporter that writes through console.log instead of process.stdout.
 *
 * Some editor forks (Trae) pipe the extension host's console to the launcher's
 * stdout but silently drop process.stdout writes — which is where every stock
 * mocha reporter writes — so failures were invisible ("N tests failed" with no
 * names). This reporter keeps the output coarse (suite names, failures with
 * stacks, final tally) since it's a diagnostics channel, not interactive UX.
 */
class ConsoleReporter extends Mocha.reporters.Base {
  /** Full titles of failed tests from the most recent run — read by run(). */
  static lastFailures: string[] | undefined;

  private passed = 0;
  private failedTests: string[] = [];

  constructor(runner: Mocha.Runner, options: Mocha.MochaOptions) {
    super(runner, options);
    ConsoleReporter.lastFailures = undefined;
    runner.on(Mocha.Runner.constants.EVENT_TEST_PASS, (test) => {
      this.passed++;
      console.log(`    ✔ ${test.fullTitle()}`);
    });
    runner.on(Mocha.Runner.constants.EVENT_TEST_FAIL, (test, err) => {
      const msg = err?.message ?? String(err);
      const title = /timed out/.test(msg)
        ? `${test.fullTitle()} — TIMED OUT`
        : test.fullTitle();
      this.failedTests.push(
        msg ? `${title}\n      ${msg.split("\n")[0].slice(0, 300)}` : title
      );
      console.log(`    ✗ ${title}`);
      console.log(`      ${err?.stack ?? msg}`);
    });
    runner.once(Mocha.Runner.constants.EVENT_RUN_END, () => {
      ConsoleReporter.lastFailures = this.failedTests;
      if (this.failedTests.length > 0) {
        console.log(`\n  ${this.failedTests.length} failing:\n`);
        for (const f of this.failedTests) {
          console.log(`  1) ${f}\n`);
        }
      }
      console.log(
        `  ${this.passed} passing, ${this.failedTests.length} failing\n`
      );
    });
  }
}

export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: "tdd",
    timeout: 60000,
    reporter: ConsoleReporter,
  });

  // Host-tier tests only — unit tests (out/test/unit) run via plain mocha in
  // `npm run test:unit`, without launching a VS Code window.
  const testsRoot = path.resolve(__dirname, "..");

  const files = await glob("suite/**/*.test.js", { cwd: testsRoot });
  files.sort();

  // Add files to the test suite
  files.forEach((f) => mocha.addFile(path.resolve(testsRoot, f)));

  return new Promise<void>((resolve, reject) => {
    mocha.run((failures: number, stats?: Mocha.Stats) => {
      if (failures > 0) {
        // Some editor forks (Trae) drop ALL extension-host console/stdout
        // output; the rejection message is the one channel that reaches the
        // launcher. Include the failure names (from the shared reporter
        // state) so `npm test` always says WHAT failed, not just how many.
        const names = (ConsoleReporter.lastFailures ?? [])
          .map((f) => `  ✗ ${f}`)
          .join("\n");
        reject(
          new Error(`${failures} tests failed.\n${names}\n(stats: ${JSON.stringify(stats ?? {})}...)
`.trim())
        );
      } else {
        resolve();
      }
    });
  });
}
