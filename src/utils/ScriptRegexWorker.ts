import { parentPort, workerData } from "worker_threads";

const { actual, pattern } = workerData as {
  actual: string;
  pattern: string;
};

try {
  // The input is sent in full. The parent owns the timeout and terminates this
  // worker if a pathological pattern exceeds its budget.
  parentPort?.postMessage(new RegExp(pattern).test(actual));
} catch {
  // Invalid patterns retain the existing comparison behavior: they fail.
  parentPort?.postMessage(false);
}
