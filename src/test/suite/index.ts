import * as path from "path";
import * as vscode from "vscode";
import Mocha from "mocha";
import { glob } from "glob";
import {
  EXTENSION_IDENTIFIERS,
  RUN_HISTORY_LOCATIONS,
} from "../../types/DashboardConstants";
import {
  initializeRunHistoryLocation,
  isRunHistoryLocationInitialized,
} from "../../utils/RunHistoryStoragePolicy";

async function activateExtensionForTests(): Promise<void> {
  const extension = vscode.extensions.all.find(
    (candidate) =>
      candidate.id === EXTENSION_IDENTIFIERS.ID ||
      candidate.packageJSON.name === EXTENSION_IDENTIFIERS.PACKAGE_NAME
  );
  if (!extension) {
    throw new Error("ctrlyoke extension must be loaded for extension tests");
  }
  if (!extension.isActive) {
    await extension.activate();
  }
  // The extension bundle has its own copy of this vscode-free policy module;
  // initialize the test module copy for directly imported production modules.
  if (!isRunHistoryLocationInitialized()) {
    initializeRunHistoryLocation(RUN_HISTORY_LOCATIONS.USER);
  }
}

export function run(): Promise<void> {
  // Create the mocha test
  const mocha = new Mocha({
    ui: "tdd",
    color: true,
    // Extension-host tests routinely spawn Git and installed harness CLIs;
    // two seconds is too short for a cold Windows subprocess even when the
    // test itself is healthy.
    timeout: 10_000,
    // Allow focused runs via `MOCHA_GREP="<pattern>"` for fast local iteration.
    ...(process.env.MOCHA_GREP ? { grep: process.env.MOCHA_GREP } : {}),
  });

  const testsRoot = path.resolve(__dirname, "..");

  return new Promise((c, e) => {
    // Harness integration tests (src/test/harness/) run separately via
    // `npm run test:harness` — they invoke real AI CLIs and need long
    // timeouts that aren't compatible with the VS Code extension host.
    const testFiles = new glob.Glob("**/**.test.js", {
      cwd: testsRoot,
      ignore: ["harness/**"],
    });
    const testFileStream = testFiles.stream();

    testFileStream.on("data", (file) => {
      mocha.addFile(path.resolve(testsRoot, file));
    });
    testFileStream.on("error", (err) => {
      e(err);
    });
    testFileStream.on("end", () => {
      void (async () => {
        await activateExtensionForTests();
        // Run the mocha test
        mocha.run((failures: number) => {
          if (failures > 0) {
            e(new Error(`${failures} tests failed.`));
          } else {
            c();
          }
        });
      })().catch((err) => {
        console.error(err);
        e(err);
      });
    });
  });
}
