import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, suite, test } from "mocha";
import {
  EXECUTION_STATES,
  RUNNER_IDS,
  type ExecutionState,
} from "../../types/DashboardConstants";
import { RunContinuationService } from "../../core/orchestration/RunContinuationService";
import { WorkflowLineageRepository } from "../../core/orchestration/WorkflowLineageRepository";
import { WorkflowLockManager } from "../../utils/WorkflowLockManager";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import type {
  RunRef,
  RunnerHostIdentity,
  WorkflowKey,
} from "../../types/CtrlYokeTypes";

/**
 * A run's definition may be edited while a *different* run of the same lineage
 * executes — only *starting* work (append/continue) is gated by the lineage lock.
 * Editing the executing run itself goes through the orchestrator's in-place live
 * path and never reaches this validator, so a lock naming the target run still
 * blocks a static edit here (the non-resident / CLI case).
 */
suite(
  "RunContinuationService.validateContinuationTarget — edit vs execution lock",
  () => {
    const workflowKey = "edit-lock-2026-01-01T00-00-00" as WorkflowKey;
    const targetRun = "run-2026-01-01T00-00-00-000Z" as RunRef;
    const otherRun = "run-2026-01-02T00-00-00-000Z" as RunRef;

    async function seedLineage(
      workspaceRoot: string,
      executionState: ExecutionState = EXECUTION_STATES.IDLE
    ): Promise<void> {
      const descriptorPath = WorkflowPaths.descriptorPath(
        workspaceRoot,
        workflowKey
      );
      await fs.mkdir(path.dirname(descriptorPath), { recursive: true });
      await fs.writeFile(
        descriptorPath,
        JSON.stringify({
          schemaVersion: 1,
          workflowKey,
          workflowName: "Edit Lock",
          isFavorite: false,
          createdAt: 0,
          lastModifiedAt: 0,
          latestRunRef: targetRun,
          nextRunId: 3,
          revision: 1,
        }),
        "utf8"
      );
      const runFilePath = WorkflowPaths.runFilePath(
        workspaceRoot,
        workflowKey,
        targetRun
      );
      await fs.mkdir(path.dirname(runFilePath), { recursive: true });
      await fs.writeFile(
        runFilePath,
        JSON.stringify({
          steps: [{ prompt: "s0" }, { prompt: "s1" }],
          definitionRevision: 1,
          _runtime: { currentIndex: 0, executionState },
        }),
        "utf8"
      );
    }

    async function liveLock(
      workspaceRoot: string,
      runRef: RunRef
    ): Promise<void> {
      await WorkflowLockManager.acquireLock(workspaceRoot, workflowKey, {
        schemaVersion: 2,
        workflowKey,
        runRef,
        runner: RUNNER_IDS.VSCODE,
        pid: process.pid,
        ownerToken: WorkflowLockManager.generateOwnerToken(),
        hostInstanceId: "test-host",
        executionInstanceId: "test-execution",
        startedAt: Date.now(),
        lastHeartbeat: Date.now(),
      });
    }

    const localObserver: RunnerHostIdentity = {
      runner: RUNNER_IDS.VSCODE,
      hostInstanceId: "test-host",
      pid: process.pid,
    };

    test("allows editing an idle run while a DIFFERENT run holds the lineage lock", async () => {
      const ws = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-edit-lock-")
      );
      try {
        await seedLineage(ws);
        await liveLock(ws, otherRun);
        const repo = new WorkflowLineageRepository();

        const target = await RunContinuationService.validateContinuationTarget(
          ws,
          workflowKey,
          targetRun,
          repo,
          "edit"
        );
        assert.strictEqual(target.definitionRevision, 1);

        // Starting work on the idle run is still blocked while another run executes.
        await assert.rejects(
          RunContinuationService.validateContinuationTarget(
            ws,
            workflowKey,
            targetRun,
            repo,
            "append"
          ),
          /executing/i
        );
        await assert.rejects(
          RunContinuationService.validateContinuationTarget(
            ws,
            workflowKey,
            targetRun,
            repo,
            "continue"
          ),
          /executing/i
        );
      } finally {
        await fs.rm(ws, { recursive: true, force: true });
      }
    });

    test("blocks a static edit of the run that itself holds the lineage lock", async () => {
      const ws = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-edit-lock-self-")
      );
      try {
        await seedLineage(ws);
        await liveLock(ws, targetRun);
        const repo = new WorkflowLineageRepository();

        await assert.rejects(
          RunContinuationService.validateContinuationTarget(
            ws,
            workflowKey,
            targetRun,
            repo,
            "edit"
          ),
          /executing/i
        );
      } finally {
        await fs.rm(ws, { recursive: true, force: true });
      }
    });

    test("allows an explicitly permitted edit of the executing target", async () => {
      const ws = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-edit-lock-active-target-")
      );
      try {
        await seedLineage(ws, EXECUTION_STATES.RUNNING);
        await liveLock(ws, targetRun);

        const target = await RunContinuationService.validateContinuationTarget(
          ws,
          workflowKey,
          targetRun,
          new WorkflowLineageRepository(),
          "edit",
          true
        );
        assert.strictEqual(target.allowInterruptedRun, true);
      } finally {
        await fs.rm(ws, { recursive: true, force: true });
      }
    });

    test("reports a self-owned but untracked continuation as an invariant failure", async () => {
      const ws = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-edit-lock-self-untracked-")
      );
      try {
        await seedLineage(ws);
        await liveLock(ws, targetRun);

        await assert.rejects(
          RunContinuationService.validateContinuationTarget(
            ws,
            workflowKey,
            targetRun,
            new WorkflowLineageRepository(),
            "continue",
            false,
            localObserver
          ),
          /self-owned execution is not tracked/i
        );
      } finally {
        await fs.rm(ws, { recursive: true, force: true });
      }
    });
  }
);

suite("RunContinuationService addressed step mutations", () => {
  const workflowKey =
    "addressed-step-mutations-2026-01-01T00-00-00" as WorkflowKey;
  const runRef = "run-2026-01-01T00-00-00-000Z" as RunRef;
  let workspace: string;

  async function seedRun(
    executionState: ExecutionState,
    currentIndex: number,
    steps: Array<Record<string, unknown>>
  ): Promise<void> {
    const descriptorPath = WorkflowPaths.descriptorPath(workspace, workflowKey);
    await fs.mkdir(path.dirname(descriptorPath), { recursive: true });
    await fs.writeFile(
      descriptorPath,
      JSON.stringify({
        schemaVersion: 1,
        workflowKey,
        workflowName: "Addressed mutations",
        isFavorite: false,
        createdAt: 0,
        lastModifiedAt: 0,
        latestRunRef: runRef,
        nextRunId: 2,
        revision: 1,
      }),
      "utf8"
    );
    const runFilePath = WorkflowPaths.runFilePath(
      workspace,
      workflowKey,
      runRef
    );
    await fs.mkdir(path.dirname(runFilePath), { recursive: true });
    await fs.writeFile(
      runFilePath,
      JSON.stringify({
        workflowName: "Addressed mutations",
        startedAt: 0,
        definitionRevision: 1,
        steps,
        _runtime: { currentIndex, executionState },
      }),
      "utf8"
    );
  }

  afterEach(async () => {
    if (workspace) {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("edits pending steps while running and rejects completed and in-flight steps", async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-step-edit-"));
    await seedRun(EXECUTION_STATES.RUNNING, 1, [
      { prompt: "done", _runtime: { completedAt: 10 } },
      { prompt: "in flight", _runtime: { startedAt: 11 } },
      { prompt: "pending" },
    ]);
    const repository = new WorkflowLineageRepository();

    const edited = await RunContinuationService.editStepAtRun(
      workspace,
      workflowKey,
      runRef,
      2,
      { updates: { prompt: "pending (edited)" } },
      1,
      repository,
      true
    );
    assert.strictEqual(edited.definitionRevision, 2);
    assert.strictEqual(
      (edited.workingFile.steps![2] as { prompt: string }).prompt,
      "pending (edited)"
    );

    await assert.rejects(
      RunContinuationService.editStepAtRun(
        workspace,
        workflowKey,
        runRef,
        0,
        { updates: { prompt: "must stay done" } },
        2,
        repository,
        true
      ),
      /completed step/i
    );
    await assert.rejects(
      RunContinuationService.editStepAtRun(
        workspace,
        workflowKey,
        runRef,
        1,
        { updates: { prompt: "must stay in flight" } },
        2,
        repository,
        true
      ),
      /currently executing/i
    );
    await assert.rejects(
      RunContinuationService.editStepAtRun(
        workspace,
        workflowKey,
        runRef,
        2,
        { updates: { prompt: "stale" } },
        1,
        repository,
        true
      ),
      /Definition revision conflict/
    );
  });

  test("reorders only the pending suffix and keeps the in-flight step fixed", async () => {
    workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-step-reorder-")
    );
    await seedRun(EXECUTION_STATES.RUNNING, 1, [
      { prompt: "done", _runtime: { completedAt: 10 } },
      { prompt: "in flight", _runtime: { startedAt: 11 } },
      { prompt: "pending-a" },
      { prompt: "pending-b" },
    ]);
    const repository = new WorkflowLineageRepository();

    const reordered = await RunContinuationService.reorderPendingStepsAtRun(
      workspace,
      workflowKey,
      runRef,
      [0, 2, 1],
      1,
      repository,
      undefined,
      true
    );
    assert.deepStrictEqual(
      reordered.workingFile.steps!.map(
        (step) => (step as { prompt: string }).prompt
      ),
      ["done", "in flight", "pending-b", "pending-a"]
    );

    await assert.rejects(
      RunContinuationService.reorderPendingStepsAtRun(
        workspace,
        workflowKey,
        runRef,
        [1, 0, 2],
        2,
        repository,
        undefined,
        true
      ),
      /currently executing|completed step/i
    );
  });

  test("rejects insertions that would move the in-flight step, including numeric append positions", async () => {
    workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-step-insert-")
    );
    await seedRun(EXECUTION_STATES.RUNNING, 1, [
      { prompt: "done", _runtime: { completedAt: 10 } },
      { prompt: "in flight", _runtime: { startedAt: 11 } },
      { prompt: "pending" },
    ]);
    const repository = new WorkflowLineageRepository();

    await assert.rejects(
      RunContinuationService.insertStepAtRun(
        workspace,
        workflowKey,
        runRef,
        1,
        { prompt: "must not shift in flight" },
        1,
        repository,
        true
      ),
      /currently executing|completed step/i
    );
    await assert.rejects(
      RunContinuationService.appendStepsToRun(
        workspace,
        workflowKey,
        runRef,
        [{ prompt: "must not shift in flight" }],
        1,
        repository,
        true,
        1
      ),
      /currently executing|completed step/i
    );
  });

  test("allows the paused current step because no step is in flight", async () => {
    workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-step-paused-")
    );
    await seedRun(EXECUTION_STATES.PAUSED, 1, [
      { prompt: "done", _runtime: { completedAt: 10 } },
      { prompt: "next" },
    ]);

    const edited = await RunContinuationService.editStepAtRun(
      workspace,
      workflowKey,
      runRef,
      1,
      { updates: { prompt: "next (edited)" } },
      1,
      new WorkflowLineageRepository(),
      true
    );
    assert.strictEqual(
      (edited.workingFile.steps![1] as { prompt: string }).prompt,
      "next (edited)"
    );
  });
});

/**
 * A paused run whose owning process is gone is adoptable, not permanently
 * stuck. Pause is an in-memory executor state, so the original design treated
 * "paused with no live owner" as impossible and refused it — but a host restart
 * produces exactly that shape routinely, which left paused runs unresumable
 * forever. The lock is the evidence that decides it, identically to an
 * interrupted RUNNING run; a paused run is if anything safer to adopt, having
 * no in-flight harness turn and a `currentIndex` on a clean step boundary.
 */
suite(
  "RunContinuationService.validateContinuationTarget — orphaned paused runs",
  () => {
    const workflowKey = "orphan-paused-2026-01-01T00-00-00" as WorkflowKey;
    const targetRun = "run-2026-01-01T00-00-00-000Z" as RunRef;

    async function seedPausedRun(workspaceRoot: string): Promise<void> {
      const descriptorPath = WorkflowPaths.descriptorPath(
        workspaceRoot,
        workflowKey
      );
      await fs.mkdir(path.dirname(descriptorPath), { recursive: true });
      await fs.writeFile(
        descriptorPath,
        JSON.stringify({
          schemaVersion: 1,
          workflowKey,
          workflowName: "Orphan Paused",
          isFavorite: false,
          createdAt: 0,
          lastModifiedAt: 0,
          latestRunRef: targetRun,
          nextRunId: 2,
          revision: 1,
        }),
        "utf8"
      );
      const runFilePath = WorkflowPaths.runFilePath(
        workspaceRoot,
        workflowKey,
        targetRun
      );
      await fs.mkdir(path.dirname(runFilePath), { recursive: true });
      await fs.writeFile(
        runFilePath,
        JSON.stringify({
          steps: [{ prompt: "s0" }, { prompt: "s1" }],
          definitionRevision: 1,
          _runtime: {
            currentIndex: 1,
            executionState: EXECUTION_STATES.PAUSED,
          },
        }),
        "utf8"
      );
    }

    test("adopts a paused run that no live lock claims", async () => {
      const ws = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-orphan-paused-")
      );
      try {
        await seedPausedRun(ws);

        const target = await RunContinuationService.validateContinuationTarget(
          ws,
          workflowKey,
          targetRun,
          new WorkflowLineageRepository(),
          "continue"
        );

        assert.strictEqual(
          target.allowInterruptedRun,
          true,
          "an ownerless paused run must be adoptable by a fresh execution owner"
        );
        assert.strictEqual(target.definitionRevision, 1);
      } finally {
        await fs.rm(ws, { recursive: true, force: true });
      }
    });

    test("still refuses a paused run that a live lock claims for another process", async () => {
      const ws = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-owned-paused-")
      );
      try {
        await seedPausedRun(ws);
        await WorkflowLockManager.acquireLock(ws, workflowKey, {
          schemaVersion: 2,
          workflowKey,
          runRef: targetRun,
          runner: RUNNER_IDS.VSCODE,
          pid: process.pid,
          ownerToken: WorkflowLockManager.generateOwnerToken(),
          hostInstanceId: "test-host",
          executionInstanceId: "test-execution",
          startedAt: Date.now(),
          lastHeartbeat: Date.now(),
        });

        await assert.rejects(
          RunContinuationService.validateContinuationTarget(
            ws,
            workflowKey,
            targetRun,
            new WorkflowLineageRepository(),
            "continue"
          ),
          /executing/i,
          "a paused run with a live owner must not be stolen"
        );
      } finally {
        await fs.rm(ws, { recursive: true, force: true });
      }
    });
  }
);
