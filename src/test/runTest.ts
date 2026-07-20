import * as path from "path";
import { runTests } from "@vscode/test-electron";

async function main() {
  try {
    // Folder containing the extension manifest/package.json
    const extensionDevelopmentPath = path.resolve(__dirname, "../../");

    // Folder containing the mocha test runner
    const extensionTestsPath = path.resolve(__dirname, "./suite/index");

    // Download VS Code (stable), unzip it, and run the tests
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      version: "stable",
    });
  } catch (err) {
    console.error("Failed to run tests:", err);
    process.exit(1);
  }
}

main();
