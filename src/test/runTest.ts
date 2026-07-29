import * as fs from "fs";
import * as path from "path";
import { runTests } from "@vscode/test-electron";

/**
 * Candidate Electron binaries for VS Code forks that may already be installed,
 * so a machine without stable VS Code can run the suite without downloading a
 * 300 MB copy. Checked in order; the first one present wins.
 */
const LOCAL_FORK_BINARIES = [
  "/Applications/Trae.app/Contents/MacOS/Electron",
  "/Applications/Cursor.app/Contents/MacOS/Electron",
  "/Applications/Windsurf.app/Contents/MacOS/Electron",
];

/**
 * Resolve the editor binary to test against:
 *  1. `AQP_TEST_VSCODE` — explicit override (any VS Code-compatible build).
 *  2. An installed fork from {@link LOCAL_FORK_BINARIES}.
 *  3. undefined → let test-electron download stable VS Code.
 */
function resolveExecutablePath(): string | undefined {
  const override = process.env.AQP_TEST_VSCODE;
  if (override) return override;
  return LOCAL_FORK_BINARIES.find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

async function main() {
  try {
    // Folder containing the extension manifest/package.json
    const extensionDevelopmentPath = path.resolve(__dirname, "../../");

    // Folder containing the mocha test runner
    const extensionTestsPath = path.resolve(__dirname, "./suite/index");

    const vscodeExecutablePath = resolveExecutablePath();
    if (vscodeExecutablePath) {
      console.log(`Testing against local editor: ${vscodeExecutablePath}`);
    }

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      // With an executable path set, `version` is ignored; without one,
      // test-electron downloads stable VS Code.
      ...(vscodeExecutablePath
        ? { vscodeExecutablePath }
        : { version: "stable" }),
    });
  } catch (err) {
    console.error("Failed to run tests:", err);
    process.exit(1);
  }
}

main();
