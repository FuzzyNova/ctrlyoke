import * as path from "path";

async function main() {
  try {
    // Extension-host child processes inherit this from VS Code. If it reaches
    // Code.exe, Electron runs as plain Node and rejects VS Code launch flags.
    delete process.env.ELECTRON_RUN_AS_NODE;
    const { runTests } = await import("@vscode/test-electron");

    // The folder containing the Extension Manifest package.json
    // Passed to `--extensionDevelopmentPath`
    const extensionDevelopmentPath = path.resolve(__dirname, "../../");

    // The path to test runner
    // Passed to --extensionTestsPath
    const extensionTestsPath = path.resolve(__dirname, "./suite/index");

    // Download VS Code, unzip it and run the integration test
    await runTests({ extensionDevelopmentPath, extensionTestsPath });
  } catch (err) {
    console.error("Failed to run tests");
    process.exit(1);
  }
}

main();
