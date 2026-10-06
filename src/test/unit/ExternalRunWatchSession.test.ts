import * as assert from "assert";
import { suite, test } from "mocha";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { ExternalRunWatchSession } from "../../core/orchestration/ExternalRunWatchSession";
import { NodeFileWatcherFactory } from "../../platform/NodeFileWatcher";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import type {
  RunRef,
  RunnerHostIdentity,
  WorkflowKey,
  WorkflowRunnerLock,
} from "../../types/CtrlYokeTypes";
import {
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  RUNNER_IDS,
  STEP_STATUS,
} from "../../types/DashboardConstants";
import type { ActiveExternalLockInspection } from "../../core/orchestration/ExternalExecutionResolver";

function makeInspection(
  workflowKey: WorkflowKey,
  runRef: RunRef
): ActiveExternalLockInspection {
  const lock: WorkflowRunnerLock = {
    schemaVersion: 2,
    workflowKey,
    runRef,
    runner: RUNNER_IDS.CLI,
    pid: process.pid,
    hostInstanceId: "watch-test-host",
    executionInstanceId: "watch-test-execution",
    ownerToken: "watch-test-owner",
    startedAt: Date.now(),
    lastHeartbeat: Date.now(),
  };
  return { liveness: "active", locality: "external", lock };
}

const observer: RunnerHostIdentity = {
  runner: RUNNER_IDS.VSCODE,
  hostInstanceId: "observer-host",
  pid: 999999,
};

suite("ExternalRunWatchSession", () => {
  test("pins its manifest path to the exact constructed workflowKey/runRef, never 'newest'", () => {
    const workspaceFolderPath = "C:\\dev\\some-workspace";
    const workflowKey = "my-workflow-2026-07-20T10-30-00" as WorkflowKey;
    const runRef = "run-2026-07-20T10-30-00-000Z" as RunRef;
    const workingFilePath = WorkflowPaths.runFilePath(
      workspaceFolderPath,
      workflowKey,
      runRef
    );

    const session = new ExternalRunWatchSession(
      workingFilePath,
      workflowKey,
      runRef,
      workspaceFolderPath,
      makeInspection(workflowKey, runRef),
      observer,
      () => {},
      () => {},
      () => {},
      new NodeFileWatcherFactory()
    );

    assert.strictEqual(
      session.getActiveHistoryFilePath(),
      WorkflowPaths.manifestPath(workspaceFolderPath, workflowKey, runRef)
    );
  });

  test("tracks last-known output count per step independently", () => {
    const workspaceFolderPath = "C:\\dev\\some-workspace";
    const workflowKey = "my-workflow-2026-07-20T10-30-00" as WorkflowKey;
    const runRef = "run-2026-07-20T10-30-00-000Z" as RunRef;
    const session = new ExternalRunWatchSession(
      WorkflowPaths.runFilePath(workspaceFolderPath, workflowKey, runRef),
      workflowKey,
      runRef,
      workspaceFolderPath,
      makeInspection(workflowKey, runRef),
      observer,
      () => {},
      () => {},
      () => {},
      new NodeFileWatcherFactory()
    );

    assert.strictEqual(session.getAndUpdateLastKnownOutputCount(0, 3), 0);
    assert.strictEqual(session.getAndUpdateLastKnownOutputCount(0, 5), 3);
    assert.strictEqual(session.getAndUpdateLastKnownOutputCount(1, 1), 0);
  });

  test("forwards the persisted token aggregate through working-file updates", async () => {
    const workspaceFolderPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-cli-watch-")
    );
    try {
      const workflowKey = "watch-tokens" as WorkflowKey;
      const runRef = "run-2026-07-20T10-30-00-000Z" as RunRef;
      const workingFilePath = path.join(workspaceFolderPath, "workflow.json");
      const tokenTotals = {
        total: 18,
        coverage: "complete" as const,
        reportedAttemptCount: 1,
        attemptCount: 1,
        isFinal: false,
        byHarness: {},
        byLocalDay: {},
      };
      await fs.writeFile(
        workingFilePath,
        JSON.stringify({
          steps: [{ prompt: "step" }],
          _runtime: {
            currentIndex: 1,
            executionState: "running",
            tokenTotals,
          },
        }),
        "utf8"
      );

      let update: Record<string, unknown> | undefined;
      let updateSteps: readonly unknown[] | undefined;
      const session = new ExternalRunWatchSession(
        workingFilePath,
        workflowKey,
        runRef,
        workspaceFolderPath,
        makeInspection(workflowKey, runRef),
        observer,
        (summary, steps) => {
          update = summary as Record<string, unknown>;
          updateSteps = steps;
        },
        () => {},
        () => {},
        new NodeFileWatcherFactory()
      );
      await (
        session as unknown as { handleWorkingFileChange: () => Promise<void> }
      ).handleWorkingFileChange();

      assert.deepStrictEqual(update?.tokenTotals, tokenTotals);
      assert.strictEqual(update?.currentStep, 1);
      // The steps ride along so the orchestrator can re-derive per-step
      // statuses on every change without a second read of the working file.
      assert.deepStrictEqual(updateSteps, [{ prompt: "step" }]);
    } finally {
      await fs.rm(workspaceFolderPath, { recursive: true, force: true });
    }
  });

  test("forwards final-step definition and runtime state through updates", async () => {
    const workspaceFolderPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-cli-watch-final-step-")
    );
    try {
      const workflowKey = "watch-final-step" as WorkflowKey;
      const runRef = "run-2026-08-30T10-30-00-000Z" as RunRef;
      const workingFilePath = path.join(workspaceFolderPath, "workflow.json");
      await fs.writeFile(
        workingFilePath,
        JSON.stringify({
          finalStep: { prompt: "final" },
          steps: [{ prompt: "step" }],
          _runtime: {
            currentIndex: 1,
            executionState: EXECUTION_STATES.RUNNING,
            finalStep: {
              phase: FINAL_STEP_PHASES.FINAL_STEP,
              loopCount: 0,
              status: STEP_STATUS.RUNNING,
            },
          },
        }),
        "utf8"
      );

      let update: Record<string, unknown> | undefined;
      const session = new ExternalRunWatchSession(
        workingFilePath,
        workflowKey,
        runRef,
        workspaceFolderPath,
        makeInspection(workflowKey, runRef),
        observer,
        (summary) => {
          update = summary as Record<string, unknown>;
        },
        () => {},
        () => {},
        new NodeFileWatcherFactory()
      );
      await (
        session as unknown as { handleWorkingFileChange: () => Promise<void> }
      ).handleWorkingFileChange();

      assert.strictEqual(update?.hasFinalStep, true);
      assert.strictEqual(update?.finalStepRunning, true);
    } finally {
      await fs.rm(workspaceFolderPath, { recursive: true, force: true });
    }
  });

  test("finishes when the working file is terminal even if the runner lock remains", async () => {
    const workspaceFolderPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-terminal-watch-")
    );
    try {
      const workflowKey = "watch-terminal" as WorkflowKey;
      const runRef = "run-2026-08-28T16-28-23-000Z" as RunRef;
      const workingFilePath = path.join(workspaceFolderPath, "workflow.json");
      await fs.writeFile(
        workingFilePath,
        JSON.stringify({
          steps: [{ prompt: "done" }],
          _runtime: {
            currentIndex: 1,
            executionState: EXECUTION_STATES.COMPLETED,
          },
        }),
        "utf8"
      );

      let finished = 0;
      const session = new ExternalRunWatchSession(
        workingFilePath,
        workflowKey,
        runRef,
        workspaceFolderPath,
        makeInspection(workflowKey, runRef),
        observer,
        () => undefined,
        () => undefined,
        () => {
          finished += 1;
        },
        new NodeFileWatcherFactory()
      );
      await (
        session as unknown as { handleWorkingFileChange: () => Promise<void> }
      ).handleWorkingFileChange();

      assert.strictEqual(
        finished,
        1,
        "terminal runtime state should end the watch without waiting for lock deletion"
      );
    } finally {
      await fs.rm(workspaceFolderPath, { recursive: true, force: true });
    }
  });

  test("ends the old session when the lock acquisition is replaced", async () => {
    const workspaceFolderPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-replaced-owner-watch-")
    );
    try {
      const workflowKey = "watch-replaced-owner" as WorkflowKey;
      const runRef = "run-2026-08-28T16-28-23-000Z" as RunRef;
      const workingFilePath = WorkflowPaths.runFilePath(
        workspaceFolderPath,
        workflowKey,
        runRef
      );
      await fs.mkdir(path.dirname(workingFilePath), { recursive: true });
      await fs.writeFile(
        workingFilePath,
        JSON.stringify({
          workflowName: "replacement",
          startedAt: Date.now(),
          steps: [{ prompt: "live" }],
          _runtime: {
            currentIndex: 0,
            executionState: EXECUTION_STATES.RUNNING,
          },
        }),
        "utf8"
      );

      const expected = makeInspection(workflowKey, runRef);
      const lockPath = WorkflowPaths.runnerLockPath(
        workspaceFolderPath,
        workflowKey
      );
      await fs.writeFile(lockPath, JSON.stringify(expected.lock), "utf8");
      let finished = 0;
      const session = new ExternalRunWatchSession(
        workingFilePath,
        workflowKey,
        runRef,
        workspaceFolderPath,
        expected,
        observer,
        () => undefined,
        () => undefined,
        () => {
          finished += 1;
        },
        new NodeFileWatcherFactory()
      );

      await fs.writeFile(
        lockPath,
        JSON.stringify({
          ...expected.lock,
          ownerToken: "replacement-owner",
        }),
        "utf8"
      );
      await (
        session as unknown as { validateCurrentLock: () => Promise<void> }
      ).validateCurrentLock();

      assert.strictEqual(finished, 1);
    } finally {
      await fs.rm(workspaceFolderPath, { recursive: true, force: true });
    }
  });
});
