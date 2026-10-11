import * as path from "path";
import Mocha from "mocha";
import { glob } from "glob";

class ConsoleReporter extends Mocha.reporters.Base {
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

  const testsRoot = path.resolve(__dirname, "..");

  const files = await glob("suite/**/*.test.js", { cwd: testsRoot });
  files.sort();

  files.forEach((f) => mocha.addFile(path.resolve(testsRoot, f)));

  return new Promise<void>((resolve, reject) => {
    mocha.run((failures: number, stats?: Mocha.Stats) => {
      if (failures > 0) {
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
