import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Writable } from "stream";
import { mergeShardTimings } from "./suite/sharding";

/**
 * How many VS Code instances to split the extension-host suite across.
 *
 * Mocha's own `--parallel` cannot help here: it farms test files out to plain
 * `node` worker processes, and every file in this tree loads production modules
 * that `require("vscode")` — a module that only exists inside the extension
 * host. So the only way to use more than one core is to run more than one
 * extension host, each given a disjoint slice of the discovered test files
 * (`src/test/suite/index.ts` does the splitting).
 *
 * Defaults to 1 so `npm run test:extension` on its own behaves exactly as it
 * always has; `scripts/run-test-suites.mjs` sets this when it fans the suites
 * out, because it is the one place that knows the whole core budget.
 */
const SHARD_COUNT = Math.max(
  1,
  Number.parseInt(process.env.CTRLYOKE_TEST_SHARD_COUNT ?? "1", 10) || 1
);

/** `out/test` -> repo root; timings live outside the wiped `out/` tree. */
const REPO_ROOT = path.resolve(__dirname, "../..");

interface ShardResult {
  readonly index: number;
  readonly failure?: unknown;
}

/**
 * Buffers a shard's output and replays it in one block once that shard is done.
 *
 * Six Mocha spec reporters writing to the same terminal at once produce
 * interleaved garbage — a tree whose indentation belongs to six different
 * runs. Nothing is dropped, it just arrives per shard instead of live. A
 * single-shard run streams straight through, so the usual local workflow keeps
 * its live output.
 */
function createShardSink(): { stream: Writable; text(): string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
}

async function runShard(
  vscodeExecutablePath: string,
  index: number
): Promise<ShardResult> {
  // Every shard needs its own state home *and* its own `--user-data-dir`:
  // VS Code treats a user-data dir as an exclusive single-instance lock, so
  // shards sharing the default one would hand off to the first instance and
  // exit without running anything.
  const stateHome = await fs.mkdtemp(
    path.join(os.tmpdir(), `ctrlyoke-extension-test-home-${index}-`)
  );
  const userDataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `ctrlyoke-extension-test-user-data-${index}-`)
  );
  const sharded = SHARD_COUNT > 1;
  const sink = sharded ? createShardSink() : undefined;

  try {
    const { runTests } = await import("@vscode/test-electron");
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: REPO_ROOT,
      extensionTestsPath: path.resolve(__dirname, "./suite/index"),
      launchArgs: ["--user-data-dir", userDataDir],
      extensionTestsEnv: {
        CTRLYOKE_HOME: stateHome,
        CTRLYOKE_TEST_SHARD_INDEX: String(index),
        CTRLYOKE_TEST_SHARD_COUNT: String(SHARD_COUNT),
      },
      stdout: sink?.stream,
      stderr: sink?.stream,
    });
    return { index };
  } catch (failure) {
    return { index, failure };
  } finally {
    if (sink) {
      const rule = "-".repeat(72);
      process.stdout.write(
        `\n${rule}\n shard ${index + 1}/${SHARD_COUNT}\n${rule}\n${sink.text()}`
      );
    }
    await Promise.all([discard(stateHome), discard(userDataDir)]);
  }
}

/**
 * Best-effort temp-dir removal.
 *
 * VS Code keeps writing its extension-host log as it shuts down, so on Windows
 * the user-data dir is still holding an open handle for a moment after the
 * process exits and an immediate delete fails with EBUSY. Retry past that, and
 * never let a leftover temp directory fail an otherwise green run -- this is
 * cleanup, not a test.
 */
async function discard(directory: string): Promise<void> {
  try {
    await fs.rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 250,
    });
  } catch (error) {
    console.warn(`Could not remove ${directory}: ${error}`);
  }
}

async function main() {
  // Extension-host child processes inherit this from VS Code. If it reaches
  // Code.exe, Electron runs as plain Node and rejects VS Code launch flags.
  delete process.env.ELECTRON_RUN_AS_NODE;

  const { downloadAndUnzipVSCode } = await import("@vscode/test-electron");
  // Resolve (and if needed download/unzip) the build once up front. Letting
  // every shard do this concurrently races them onto the same cache directory.
  const vscodeExecutablePath = await downloadAndUnzipVSCode();

  const results = await Promise.all(
    Array.from({ length: SHARD_COUNT }, (_unused, index) =>
      runShard(vscodeExecutablePath, index)
    )
  );

  // Every shard runs to completion before anything is reported, for the same
  // reason `scripts/run-test-suites.mjs` runs every suite: bailing on the first
  // failure hides the rest and costs another full run to find them.
  // Fold each shard's recorded per-file timings into the record the next run
  // splits on. Done even when a shard failed: the timings it did gather are
  // still the best information available for the next split.
  mergeShardTimings(REPO_ROOT, SHARD_COUNT);

  const failed = results.filter((result) => result.failure !== undefined);
  for (const result of failed) {
    console.error(
      `Shard ${result.index + 1}/${SHARD_COUNT} failed: ${result.failure}`
    );
  }
  // Set the code rather than calling `process.exit`, which on Windows pipes
  // truncates the shard blocks still queued on stdout.
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Failed to run tests", error);
  process.exitCode = 1;
});
