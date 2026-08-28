import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { EXECUTION_STATES, RUNNER_IDS } from "../../types/DashboardConstants";
import { RunContinuationService } from "../../core/orchestration/RunContinuationService";
import { WorkflowLineageRepository } from "../../core/orchestration/WorkflowLineageRepository";
import { WorkflowLockManager } from "../../utils/WorkflowLockManager";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";

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

    async function seedLineage(workspaceRoot: string): Promise<void> {
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
          _runtime: { currentIndex: 0, executionState: EXECUTION_STATES.IDLE },
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
  }
);

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
