import * as path from "path";
import { Worker } from "worker_threads";
import { SCRIPT_OPERATORS } from "../types/DashboardConstants";
import { ConfigurationUtils } from "./ConfigurationUtils";
import {
  compareScriptOutputInline,
  readComparisonSource,
  resolveScriptComparison,
  type ScriptComparisonConfig,
  type ScriptComparisonInput,
  type ScriptComparisonResult,
} from "./ScriptComparison";
import { findExistingWorkerPath } from "./WorkerPath";

interface RegexWorkerResult {
  passed: boolean;
  timedOut: boolean;
  failure?: string;
}
interface PendingComparison {
  id: number;
  actual: string;
  pattern: string;
  timeoutMs: number;
  resolve: (result: RegexWorkerResult) => void;
}

function resolveRegexWorkerPath(): string {
  const candidates = [
    path.resolve(__dirname, "scriptRegexWorker.js"),
    path.resolve(__dirname, "../scriptRegexWorker.js"),
  ];
  return findExistingWorkerPath(candidates) ?? candidates[1];
}

let worker: Worker | undefined;
let workerOnline = false;
let active: PendingComparison | undefined;
let activeTimeout: ReturnType<typeof setTimeout> | undefined;
let nextRequestId = 0;
const pending: PendingComparison[] = [];

function clearActiveTimer(): void {
  if (activeTimeout) clearTimeout(activeTimeout);
  activeTimeout = undefined;
}

/**
 * Settle the active comparison and move on. With `discardWorker`, the worker
 * is terminated first so a pattern still backtracking cannot block the next
 * one; messages it already queued are ignored because it is no longer
 * `worker`.
 */
function settleActive(result: RegexWorkerResult, discardWorker: boolean): void {
  const completed = active;
  clearActiveTimer();
  active = undefined;
  if (discardWorker) {
    const discarded = worker;
    worker = undefined;
    workerOnline = false;
    if (discarded) void discarded.terminate();
  } else {
    worker?.unref();
  }
  completed?.resolve(result);
  runNext();
}

/**
 * Start the deadline only once the worker can run the pattern, so a cold
 * start (first use, or the replacement after a timeout) is not billed to it.
 */
function armDeadline(current: PendingComparison): void {
  if (active !== current || activeTimeout) return;
  activeTimeout = setTimeout(() => {
    if (active === current)
      settleActive({ passed: false, timedOut: true }, true);
  }, current.timeoutMs);
}

function getWorker(): Worker {
  if (worker) return worker;
  const created = new Worker(resolveRegexWorkerPath());
  created.unref();
  worker = created;
  workerOnline = false;
  created.once("online", () => {
    if (worker !== created) return;
    workerOnline = true;
    if (active) armDeadline(active);
  });
  created.on("message", (message: { id: unknown; passed: unknown }) => {
    if (worker !== created || !active || message.id !== active.id) return;
    settleActive({ passed: message.passed === true, timedOut: false }, false);
  });
  created.on("error", (error: Error) => {
    if (worker !== created) return;
    settleActive(
      { passed: false, timedOut: false, failure: error.message },
      true
    );
  });
  created.on("exit", (code: number) => {
    if (worker !== created) return;
    settleActive(
      {
        passed: false,
        timedOut: false,
        failure: `regex worker exited with code ${code} before reporting a result`,
      },
      true
    );
  });
  return created;
}

function runNext(): void {
  if (active || pending.length === 0) return;
  const current = pending.shift();
  if (!current) return;
  active = current;
  try {
    const target = getWorker();
    target.ref();
    target.postMessage({
      id: current.id,
      actual: current.actual,
      pattern: current.pattern,
    });
    if (workerOnline) armDeadline(current);
  } catch (error) {
    settleActive(
      {
        passed: false,
        timedOut: false,
        failure: error instanceof Error ? error.message : String(error),
      },
      true
    );
  }
}

function compareRegexInWorker(
  actual: string,
  pattern: string,
  timeoutMs: number
): Promise<RegexWorkerResult> {
  return new Promise((resolve) => {
    nextRequestId += 1;
    pending.push({ id: nextRequestId, actual, pattern, timeoutMs, resolve });
    runNext();
  });
}

/** Compare output asynchronously; every regex runs outside the host thread. */
export async function compareScriptOutputAsync(
  config: ScriptComparisonConfig,
  input: ScriptComparisonInput
): Promise<ScriptComparisonResult> {
  const { compareSource, operator, expected } = resolveScriptComparison(config);
  if (operator !== SCRIPT_OPERATORS.MATCHES || expected === undefined) {
    return compareScriptOutputInline(config, input);
  }

  const actual = readComparisonSource(compareSource, input);
  const timeoutSec = ConfigurationUtils.getRegexTimeoutSeconds();
  const timeoutMs = timeoutSec * 1000;
  const result = await compareRegexInWorker(actual, expected, timeoutMs);
  if (result.timedOut || result.failure !== undefined) {
    const detail = result.timedOut
      ? `timed out after ${timeoutSec}s`
      : `worker failed (${result.failure}) before the ${timeoutSec}s deadline`;
    return {
      passed: false,
      actual,
      error: `Regex /${expected}/ ${detail} on input of ${actual.length} chars; the pattern likely backtracks catastrophically.`,
    };
  }
  return { passed: result.passed, actual };
}
