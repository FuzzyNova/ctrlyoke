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
let active: PendingComparison | undefined;
let activeTimeout: ReturnType<typeof setTimeout> | undefined;
const pending: PendingComparison[] = [];

function clearActiveTimer(): void {
  if (activeTimeout) clearTimeout(activeTimeout);
  activeTimeout = undefined;
}

function finishActive(result: RegexWorkerResult): void {
  const completed = active;
  if (!completed) return;
  clearActiveTimer();
  active = undefined;
  worker?.unref();
  completed.resolve(result);
  runNext();
}

function resetWorker(failure: string): void {
  const failedWorker = worker;
  worker = undefined;
  clearActiveTimer();
  if (failedWorker) void failedWorker.terminate();
  const completed = active;
  active = undefined;
  completed?.resolve({ passed: false, timedOut: false, failure });
  runNext();
}

function getWorker(): Worker {
  if (worker) return worker;
  const created = new Worker(resolveRegexWorkerPath());
  created.unref();
  worker = created;
  created.on("message", (message: { id: number; passed: unknown }) => {
    if (!active || message.id !== 0) return;
    finishActive({ passed: message.passed === true, timedOut: false });
  });
  created.on("error", (error: Error) => resetWorker(error.message));
  created.on("exit", (code: number) => {
    if (worker === created)
      resetWorker(
        `regex worker exited with code ${code} before reporting a result`
      );
  });
  return created;
}

function runNext(): void {
  if (active || pending.length === 0) return;
  active = pending.shift();
  if (!active) return;
  const current = active;
  worker?.ref();
  activeTimeout = setTimeout(() => {
    const timedOutWorker = worker;
    worker = undefined;
    clearActiveTimer();
    active = undefined;
    if (timedOutWorker) void timedOutWorker.terminate();
    current.resolve({ passed: false, timedOut: true });
    runNext();
  }, current.timeoutMs);
  try {
    getWorker().postMessage({
      id: 0,
      actual: current.actual,
      pattern: current.pattern,
    });
  } catch (error) {
    resetWorker(error instanceof Error ? error.message : String(error));
  }
}

function compareRegexInWorker(
  actual: string,
  pattern: string,
  timeoutMs: number
): Promise<RegexWorkerResult> {
  return new Promise((resolve) => {
    pending.push({ actual, pattern, timeoutMs, resolve });
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
      reason: `Regex /${expected}/ ${detail} on input of ${actual.length} chars; the pattern likely backtracks catastrophically.`,
    };
  }
  return { passed: result.passed, actual };
}
