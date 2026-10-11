import * as fs from "fs";
import * as path from "path";
import { runTests } from "@vscode/test-electron";

const LOCAL_FORK_BINARIES = [
  "/Applications/Trae.app/Contents/MacOS/Electron",
  "/Applications/Cursor.app/Contents/MacOS/Electron",
  "/Applications/Windsurf.app/Contents/MacOS/Electron",
];

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
    const extensionDevelopmentPath = path.resolve(__dirname, "../../");

    const extensionTestsPath = path.resolve(__dirname, "./suite/index");

    const vscodeExecutablePath = resolveExecutablePath();
    if (vscodeExecutablePath) {
      console.log(`Testing against local editor: ${vscodeExecutablePath}`);
    }

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
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
