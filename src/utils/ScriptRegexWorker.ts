import { parentPort } from "worker_threads";

parentPort?.on(
  "message",
  ({
    id,
    actual,
    pattern,
  }: {
    id: number;
    actual: string;
    pattern: string;
  }) => {
    try {
      parentPort?.postMessage({ id, passed: new RegExp(pattern).test(actual) });
    } catch {
      // Invalid patterns retain the existing comparison behavior: they fail.
      parentPort?.postMessage({ id, passed: false });
    }
  }
);
