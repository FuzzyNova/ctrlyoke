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
import {
  createWeigher,
  readTimings,
  selectShardFiles,
  shardCoordinate,
  testKey,
  timingsPath,
  writeShardTimings,
  type TestTimings,
} from "./sharding";

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

/**
 * Sums how long each test file's cases and hooks took, so the next run can
 * split the suite by measured work instead of by file size.
 *
 * Mocha loads every file before running any test, so module-require time is a
 * fixed per-shard cost rather than something to attribute to a file; what is
 * worth balancing is the time the cases themselves spend, which is what this
 * accumulates.
 */
function recordElapsedPerFile(
  runner: Mocha.Runner,
  testsRoot: string,
  elapsed: TestTimings
): void {
  const add = (file: string | undefined, duration: number | undefined) => {
    if (!file) return;
    const key = testKey(testsRoot, file);
    elapsed[key] = (elapsed[key] ?? 0) + (duration ?? 0);
  };
  runner.on("test end", (test) => add(test.file, test.duration));
  runner.on("hook end", (hook) => add(hook.file, hook.duration));
}

export function run(): Promise<void> {
  // Create the mocha test
  const mocha = new Mocha({
    ui: "tdd",
    color: true,
    // Extension-host tests routinely spawn Git and installed harness CLIs;
    // two seconds is too short for a cold Windows subprocess even when the
    // test itself is healthy, and 10s stopped being enough once the suite began
    // running as several shards beside the UI suite -- a healthy test waiting on
    // a subprocess on a fully loaded machine legitimately takes several times
    // what it does on an idle one. This is a budget for catching a genuine
    // hang, not an assertion about performance: a real hang still fails, just
    // later.
    timeout: 30_000,
    // Allow focused runs via `MOCHA_GREP="<pattern>"` for fast local iteration.
    ...(process.env.MOCHA_GREP ? { grep: process.env.MOCHA_GREP } : {}),
  });

  const testsRoot = path.resolve(__dirname, "..");
  // `out/test` -> repo root. Timings live outside `out/`, which is wiped on
  // every compile, so they have to be addressed from the repository layout.
  const repoRoot = path.resolve(testsRoot, "../..");
  const shardCount = Math.max(
    1,
    shardCoordinate(process.env.CTRLYOKE_TEST_SHARD_COUNT, 1)
  );
  const shardIndex = shardCoordinate(process.env.CTRLYOKE_TEST_SHARD_INDEX, 0);

  return new Promise((c, e) => {
    // Harness integration tests (src/test/harness/) run separately via
    // `npm run test:harness` — they invoke real AI CLIs and need long
    // timeouts that aren't compatible with the VS Code extension host.
    const testFiles = new glob.Glob("**/**.test.js", {
      cwd: testsRoot,
      ignore: ["harness/**"],
    });
    const testFileStream = testFiles.stream();
    const discovered: string[] = [];

    testFileStream.on("data", (file) => {
      discovered.push(path.resolve(testsRoot, file));
    });
    testFileStream.on("error", (err) => {
      e(err);
    });
    testFileStream.on("end", () => {
      void (async () => {
        // Sort before sharding: glob stream order is filesystem-dependent, and
        // a shard split has to be identical in every host or files get run
        // twice or not at all.
        discovered.sort();
        const mine = selectShardFiles(
          discovered,
          shardIndex,
          shardCount,
          createWeigher(
            discovered,
            readTimings(timingsPath(repoRoot)),
            (file) => testKey(testsRoot, file)
          )
        );
        if (shardCount > 1) {
          console.log(
            `[shard ${shardIndex + 1}/${shardCount}] running ${mine.length} of ${discovered.length} test files`
          );
        }
        for (const file of mine) {
          mocha.addFile(file);
        }
        await activateExtensionForTests();
        // Run the mocha test
        const elapsed: TestTimings = {};
        const runner = mocha.run((failures: number) => {
          writeShardTimings(repoRoot, shardIndex, elapsed);
          if (failures > 0) {
            e(new Error(`${failures} tests failed.`));
          } else {
            c();
          }
        });
        // Mocha defers the run itself to the next tick, so listeners attached
        // right after `run()` returns still see every event.
        recordElapsedPerFile(runner, testsRoot, elapsed);
      })().catch((err) => {
        console.error(err);
        e(err);
      });
    });
  });
}
