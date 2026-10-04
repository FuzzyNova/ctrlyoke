import * as fs from "fs";
import * as path from "path";
import { Worker } from "worker_threads";
import { SCRIPT_OPERATORS } from "../types/DashboardConstants";
import {
  compareScriptOutputInline,
  readComparisonSource,
  resolveScriptComparison,
  MAX_REGEX_INPUT_LENGTH,
  type ScriptComparisonConfig,
  type ScriptComparisonInput,
  type ScriptComparisonResult,
} from "./ScriptComparison";

/** Maximum time a long-output regex may occupy a worker thread. */
export const REGEX_WORKER_TIMEOUT_MS = 2_000;

function resolveRegexWorkerPath(): string {
  const bundledPath = path.resolve(__dirname, "scriptRegexWorker.js");
  return fs.existsSync(bundledPath)
    ? bundledPath
    : path.resolve(__dirname, "../scriptRegexWorker.js");
}

function compareRegexInWorker(
  actual: string,
  pattern: string
): Promise<{ passed: boolean; timedOut: boolean }> {
  return new Promise((resolve) => {
    const worker = new Worker(
      resolveRegexWorkerPath(),
      { workerData: { actual, pattern } }
    );
    let settled = false;
    const finish = (result: { passed: boolean; timedOut: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void worker.terminate();
      resolve(result);
    };
    const timeout = setTimeout(
      () => finish({ passed: false, timedOut: true }),
      REGEX_WORKER_TIMEOUT_MS
    );
    worker.once("message", (passed: unknown) =>
      finish({ passed: passed === true, timedOut: false })
    );
    worker.once("error", () => finish({ passed: false, timedOut: false }));
    worker.once("exit", () => finish({ passed: false, timedOut: false }));
  });
}

/** Compare output asynchronously, isolating long regex work from the host. */
export async function compareScriptOutputAsync(
  config: ScriptComparisonConfig,
  input: ScriptComparisonInput
): Promise<ScriptComparisonResult> {
  const { compareSource, operator, expected } = resolveScriptComparison(config);
  const actual = readComparisonSource(compareSource, input);
  if (
    operator !== SCRIPT_OPERATORS.MATCHES ||
    expected === undefined ||
    actual.length <= MAX_REGEX_INPUT_LENGTH
  ) {
    return compareScriptOutputInline(config, input);
  }

  const result = await compareRegexInWorker(actual, expected);
  if (!result.timedOut) return { passed: result.passed, actual };
  return {
    passed: false,
    actual,
    reason: `regex timed out after ${REGEX_WORKER_TIMEOUT_MS / 1000}s on ${actual.length} chars`,
  };
}
