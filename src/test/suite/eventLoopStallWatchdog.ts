import * as fs from "fs";
import * as inspector from "inspector";
import type Mocha from "mocha";
import { isMainThread, parentPort, Worker, workerData } from "worker_threads";

/**
 * Kills the extension host when a test stops its event loop from turning.
 *
 * Mocha's per-test timeout is itself a timer, so a test that never yields --
 * a synchronous loop, or a promise chain that keeps queueing microtasks --
 * can never time out. One such test (an end condition retried forever) ran
 * 100,000+ iterations in 90 s, each logging, and exhausted the machine's
 * commit memory: other applications crashed and the machine needed a
 * reboot. A worker thread has its own event loop, so it can see that the main
 * thread's heartbeat stopped and end the host. VS Code then exits the test run
 * with a failure. The extension host's stderr is not forwarded to the runner,
 * so the worker writes which test was running to {@link STALL_REPORT_ENV_VAR}'s
 * file, which `runTest.ts` prints for a failed shard.
 */

/** How long the event loop may stay blocked, in ms; `0` disables the guard. */
export const STALL_LIMIT_ENV_VAR = "CTRLYOKE_TEST_STALL_LIMIT_MS";

/**
 * Far above any healthy synchronous stretch (the suite's async timeout is
 * 30 s, and waiting asynchronously never blocks the loop), yet well inside the
 * ~90 s the runaway test took to exhaust memory.
 */
/** File the worker writes its verdict to before killing the host. */
export const STALL_REPORT_ENV_VAR = "CTRLYOKE_TEST_STALL_REPORT_PATH";

const DEFAULT_STALL_LIMIT_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 1_000;
const CHECK_INTERVAL_MS = 1_000;
const WORKER_KIND = "ctrlyoke-event-loop-stall-watchdog";

interface WatchdogWorkerData {
  readonly kind: typeof WORKER_KIND;
  readonly heartbeat: SharedArrayBuffer;
  readonly stallLimitMs: number;
  readonly pid: number;
  readonly reportPath: string | undefined;
}

export function stallLimitFromEnv(
  env: NodeJS.ProcessEnv = process.env
): number | undefined {
  const raw = env[STALL_LIMIT_ENV_VAR]?.trim();
  const limit = raw ? Number(raw) : Number.NaN;
  // Only an explicit 0 turns the guard off; anything unparseable keeps it.
  if (!Number.isFinite(limit)) return DEFAULT_STALL_LIMIT_MS;
  return limit > 0 ? limit : undefined;
}

/**
 * Tracks the main thread's heartbeat counter and reports how long it has gone
 * unchanged once that passes the limit. Pure, so the decision is testable
 * without a worker.
 */
export class StallDetector {
  private lastBeat: number | undefined;
  private lastBeatAt = 0;

  constructor(private readonly stallLimitMs: number) {}

  /** Returns the stall duration once it reaches the limit, else undefined. */
  observe(beat: number, now: number): number | undefined {
    if (beat !== this.lastBeat) {
      this.lastBeat = beat;
      this.lastBeatAt = now;
      return undefined;
    }
    const stalledMs = now - this.lastBeatAt;
    return stalledMs >= this.stallLimitMs ? stalledMs : undefined;
  }
}

/** Start watching for the duration of `runner`'s run. */
export function startEventLoopStallWatchdog(runner: Mocha.Runner): void {
  const stallLimitMs = stallLimitFromEnv();
  // A debugger paused at a breakpoint blocks the loop by design.
  if (stallLimitMs === undefined || inspector.url() !== undefined) return;

  const heartbeat = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const beats = new Int32Array(heartbeat);
  const data: WatchdogWorkerData = {
    kind: WORKER_KIND,
    heartbeat,
    stallLimitMs,
    pid: process.pid,
    reportPath: process.env[STALL_REPORT_ENV_VAR],
  };
  const worker = new Worker(__filename, { workerData: data });
  worker.unref();
  const timer = setInterval(
    () => Atomics.add(beats, 0, 1),
    HEARTBEAT_INTERVAL_MS
  );
  timer.unref();

  // Mocha announces a test before running its beforeEach hooks, so a hook's
  // title only stands in while that hook runs.
  let currentTest = "(before the first test)";
  runner.on("test", (test) => {
    currentTest = test.fullTitle();
    worker.postMessage(currentTest);
  });
  runner.on("hook", (hook) => worker.postMessage(hook.fullTitle()));
  runner.on("hook end", () => worker.postMessage(currentTest));
  runner.once("end", () => {
    clearInterval(timer);
    void worker.terminate();
  });
}

function runWorker(data: WatchdogWorkerData): void {
  const beats = new Int32Array(data.heartbeat);
  const detector = new StallDetector(data.stallLimitMs);
  let current = "(before the first test)";
  parentPort?.on("message", (title: string) => {
    current = title;
  });
  setInterval(() => {
    const stalledMs = detector.observe(Atomics.load(beats, 0), Date.now());
    if (stalledMs === undefined) return;
    const report =
      `[event-loop-stall-watchdog] The extension host's event loop was blocked for ${Math.round(stalledMs / 1000)}s ` +
      `(limit ${STALL_LIMIT_ENV_VAR}=${data.stallLimitMs}ms), so no Mocha timeout could fire; killed the extension host. ` +
      `Last test or hook started: ${current}\n`;
    // Synchronous writes only: the main thread is the one that is stuck.
    try {
      if (data.reportPath) fs.writeFileSync(data.reportPath, report);
      else fs.writeSync(2, report);
    } finally {
      process.kill(data.pid, "SIGKILL");
    }
  }, CHECK_INTERVAL_MS);
}

if (!isMainThread && (workerData as WatchdogWorkerData)?.kind === WORKER_KIND) {
  runWorker(workerData as WatchdogWorkerData);
}
