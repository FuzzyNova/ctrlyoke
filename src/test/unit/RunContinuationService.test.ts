import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, suite, test } from "mocha";
import {
  EXECUTION_STATES,
  PARALLEL_GROUP_ADMISSION,
  QUEUE_POSITION,
  RUNNER_IDS,
  type ExecutionState,
} from "../../types/DashboardConstants";
import { RunContinuationService } from "../../core/orchestration/RunContinuationService";
import type { ParallelGroupTopology } from "../../core/ParallelGroupTopology";
import { WorkflowLineageRepository } from "../../core/orchestration/WorkflowLineageRepository";
import { WorkflowLockManager } from "../../utils/WorkflowLockManager";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import type {
  RunRef,
  RunnerHostIdentity,
  WorkflowKey,
  WorkingFile,
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

suite("RunContinuationService topology append transaction", () => {
  const workflowKey = "topology-append-2026-01-01T00-00-00" as WorkflowKey;
  const runRef = "run-2026-01-01T00-00-00-000Z" as RunRef;
  let workspace: string;

  async function seedRun(
    steps: Array<Record<string, unknown>>,
    parallelGroups: ParallelGroupTopology["parallelGroups"] = []
  ): Promise<void> {
    const descriptorPath = WorkflowPaths.descriptorPath(workspace, workflowKey);
    await fs.mkdir(path.dirname(descriptorPath), { recursive: true });
    await fs.writeFile(
      descriptorPath,
      JSON.stringify({
        schemaVersion: 1,
        workflowKey,
        workflowName: "Topology append",
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
        workflowName: "Topology append",
        startedAt: 0,
        definitionRevision: 1,
        steps,
        parallelGroups,
        _runtime: { currentIndex: 0, executionState: EXECUTION_STATES.IDLE },
      }),
      "utf8"
    );
  }

  afterEach(async () => {
    if (workspace) {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("persists a container batch in one revision with absolute ranges", async () => {
    workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-topology-append-")
    );
    await seedRun(
      [
        { prompt: "existing-0" },
        { prompt: "existing-1" },
        { prompt: "existing-2" },
        { prompt: "existing-group-0" },
        { prompt: "existing-group-1" },
      ],
      [{ id: "existing-group", startIndex: 3, endIndex: 4, failFast: true }]
    );

    const incoming: ParallelGroupTopology = JSON.parse(
      JSON.stringify({
        steps: [
          { prompt: "flat" },
          {
            prompt: "parallel-a",
            _runtime: { stepId: "caller-id", responseText: "remove me" },
            status: "running",
            details: "remove me",
          },
          { prompt: "parallel-b" },
        ],
        parallelGroups: [
          {
            id: "incoming-group",
            startIndex: 1,
            endIndex: 2,
            failFast: false,
          },
        ],
      })
    );

    const appended = await RunContinuationService.appendStepsToRun(
      workspace,
      workflowKey,
      runRef,
      incoming,
      1,
      new WorkflowLineageRepository(),
      false,
      2
    );

    assert.strictEqual(appended.definitionRevision, 2);
    assert.strictEqual(appended.stepsAdded, 3);
    assert.deepStrictEqual(appended.parallelGroupsAdded, [
      { id: "incoming-group", startIndex: 3, endIndex: 4, failFast: false },
    ]);
    assert.deepStrictEqual(appended.workingFile.parallelGroups, [
      { id: "incoming-group", startIndex: 3, endIndex: 4, failFast: false },
      { id: "existing-group", startIndex: 6, endIndex: 7, failFast: true },
    ]);
    assert.strictEqual(appended.workingFile.steps?.length, 8);
    const insertedStep = appended.workingFile.steps?.[4];
    assert.ok(insertedStep);
    assert.strictEqual("status" in insertedStep, false);
    assert.strictEqual("details" in insertedStep, false);
    assert.deepStrictEqual(insertedStep._runtime, {
      stepId: insertedStep._runtime?.stepId,
    });
    assert.ok(appended.workingFile.steps?.[4]._runtime?.stepId);
  });

  test("enforces capacity using flattened members inside the transaction", async () => {
    workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-topology-capacity-")
    );
    await seedRun([{ prompt: "existing-0" }, { prompt: "existing-1" }]);

    await assert.rejects(
      RunContinuationService.appendStepsToRun(
        workspace,
        workflowKey,
        runRef,
        {
          steps: [{ prompt: "member-a" }, { prompt: "member-b" }],
          parallelGroups: [
            { id: "too-large", startIndex: 0, endIndex: 1, failFast: true },
          ],
        },
        1,
        new WorkflowLineageRepository(),
        false,
        QUEUE_POSITION.END,
        { maxQueueSize: 3, unlimited: false }
      ),
      /Current: 2, Adding: 2, Max: 3/
    );

    const run = JSON.parse(
      await fs.readFile(
        WorkflowPaths.runFilePath(workspace, workflowKey, runRef),
        "utf8"
      )
    ) as WorkingFile;
    assert.strictEqual(run.definitionRevision, 1);
    assert.strictEqual(run.steps?.length, 2);
  });

  // The dashboard and CLI append paths own no capacity policy, and the
  // environment the MCP server reads its limit from is unset in their
  // processes. Enforcing unconditionally here would cap them at the default
  // while ignoring the user's configured `queue.maxSize`.
  test("leaves capacity unenforced for a caller that supplies no policy", async () => {
    workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-topology-nopolicy-")
    );
    await seedRun([{ prompt: "existing-0" }, { prompt: "existing-1" }]);

    const appended = await RunContinuationService.appendStepsToRun(
      workspace,
      workflowKey,
      runRef,
      [{ prompt: "tail-a" }, { prompt: "tail-b" }],
      1,
      new WorkflowLineageRepository()
    );

    assert.strictEqual(appended.workingFile.steps?.length, 4);
    assert.strictEqual(appended.stepsAdded, 2);
  });

  test("serializes concurrent appends as whole batches", async () => {
    workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-topology-concurrent-")
    );
    process.env.CTRLYOKE_UNLIMITED_MODE = "true";
    await seedRun([]);

    async function appendWithRetry(
      steps: Array<{ prompt: string }>
    ): Promise<void> {
      for (;;) {
        const run = JSON.parse(
          await fs.readFile(
            WorkflowPaths.runFilePath(workspace, workflowKey, runRef),
            "utf8"
          )
        ) as WorkingFile;
        try {
          await RunContinuationService.appendStepsToRun(
            workspace,
            workflowKey,
            runRef,
            steps,
            run.definitionRevision ?? 1,
            new WorkflowLineageRepository()
          );
          return;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !/revision conflict/i.test(error.message)
          ) {
            throw error;
          }
        }
      }
    }

    await Promise.all([
      appendWithRetry([{ prompt: "batch-a-0" }, { prompt: "batch-a-1" }]),
      appendWithRetry([{ prompt: "batch-b-0" }, { prompt: "batch-b-1" }]),
    ]);

    const run = JSON.parse(
      await fs.readFile(
        WorkflowPaths.runFilePath(workspace, workflowKey, runRef),
        "utf8"
      )
    ) as WorkingFile;
    assert.strictEqual(run.definitionRevision, 3);
    const prompts = run.steps?.map((step) =>
      "prompt" in step ? step.prompt : "script"
    );
    assert.ok(
      JSON.stringify(prompts) ===
        JSON.stringify(["batch-a-0", "batch-a-1", "batch-b-0", "batch-b-1"]) ||
        JSON.stringify(prompts) ===
          JSON.stringify(["batch-b-0", "batch-b-1", "batch-a-0", "batch-a-1"])
    );
  });

  test("linearizes a live append against closing and preserves the active policy", async () => {
    workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-live-join-transaction-")
    );
    await seedRun(
      [
        { prompt: "completed", _runtime: { completedAt: 1 } },
        { prompt: "running", _runtime: { startedAt: 2 } },
        { prompt: "group-pending" },
        { prompt: "later-a" },
        { prompt: "later-b" },
      ],
      [
        { id: "active", startIndex: 1, endIndex: 2, failFast: true },
        { id: "later", startIndex: 3, endIndex: 4, failFast: false },
      ]
    );
    const runPath = WorkflowPaths.runFilePath(workspace, workflowKey, runRef);
    const source = JSON.parse(
      await fs.readFile(runPath, "utf8")
    ) as WorkingFile;
    source._runtime = {
      ...source._runtime,
      currentIndex: 1,
      executionState: EXECUTION_STATES.RUNNING,
      activeParallelGroup: {
        groupId: "active",
        admission: PARALLEL_GROUP_ADMISSION.ACCEPTING,
      },
    };
    await fs.writeFile(runPath, JSON.stringify(source), "utf8");

    const joined =
      await RunContinuationService.appendStepsToActiveParallelGroup(
        workspace,
        workflowKey,
        runRef,
        [{ prompt: "late-a" }, { prompt: "late-b" }],
        1,
        new WorkflowLineageRepository(),
        QUEUE_POSITION.PARALLEL_WITH_CURRENT,
        undefined,
        6
      );
    assert.deepStrictEqual(joined.joinedParallelGroup, {
      id: "active",
      startIndex: 1,
      endIndex: 4,
      promoted: false,
    });
    assert.deepStrictEqual(joined.parallelGroupsAdded, []);
    assert.deepStrictEqual(joined.workingFile.parallelGroups, [
      { id: "active", startIndex: 1, endIndex: 4, failFast: true },
      { id: "later", startIndex: 5, endIndex: 6, failFast: false },
    ]);
    assert.strictEqual(joined.definitionRevision, 2);

    const closing = JSON.parse(
      await fs.readFile(runPath, "utf8")
    ) as WorkingFile;
    closing._runtime = {
      ...closing._runtime,
      currentIndex: closing._runtime?.currentIndex ?? 0,
      executionState:
        closing._runtime?.executionState ?? EXECUTION_STATES.RUNNING,
      activeParallelGroup: {
        groupId: "active",
        admission: PARALLEL_GROUP_ADMISSION.CLOSING,
      },
    };
    await fs.writeFile(runPath, JSON.stringify(closing), "utf8");
    const before = await fs.readFile(runPath, "utf8");
    await assert.rejects(
      RunContinuationService.appendStepsToActiveParallelGroup(
        workspace,
        workflowKey,
        runRef,
        [{ prompt: "too late" }],
        2,
        new WorkflowLineageRepository(),
        QUEUE_POSITION.PARALLEL_WITH_CURRENT,
        undefined,
        6
      ),
      /accepting/i
    );
    assert.strictEqual(await fs.readFile(runPath, "utf8"), before);
  });

  test("promotes a running sequential step and hands settlement to the group", async () => {
    workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-live-promotion-transaction-")
    );
    await seedRun([
      { prompt: "completed", _runtime: { completedAt: 1 } },
      { prompt: "running", _runtime: { startedAt: 2 } },
      { prompt: "pending" },
    ]);
    const runPath = WorkflowPaths.runFilePath(workspace, workflowKey, runRef);
    const source = JSON.parse(
      await fs.readFile(runPath, "utf8")
    ) as WorkingFile;
    source._runtime = {
      ...source._runtime,
      currentIndex: 1,
      executionState: EXECUTION_STATES.RUNNING,
    };
    await fs.writeFile(runPath, JSON.stringify(source), "utf8");

    const joined =
      await RunContinuationService.appendStepsToActiveParallelGroup(
        workspace,
        workflowKey,
        runRef,
        [{ prompt: "sibling-a" }, { prompt: "sibling-b" }],
        1,
        new WorkflowLineageRepository(),
        QUEUE_POSITION.PARALLEL_WITH_CURRENT,
        undefined,
        6
      );
    assert.strictEqual(joined.joinedParallelGroup.promoted, true);
    assert.strictEqual(joined.joinedParallelGroup.startIndex, 1);
    assert.strictEqual(joined.joinedParallelGroup.endIndex, 3);
    assert.strictEqual(joined.parallelGroupsAdded[0].failFast, false);
    assert.strictEqual(joined.workingFile._runtime?.currentIndex, 1);
    assert.deepStrictEqual(joined.workingFile._runtime?.activeParallelGroup, {
      groupId: joined.joinedParallelGroup.id,
      admission: PARALLEL_GROUP_ADMISSION.ACCEPTING,
    });
  });
});

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

  test("refuses to clear internal step properties through clearProperties", async () => {
    workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-step-clear-")
    );
    // Idle: the execution-head guard deliberately stands down, so this is the
    // state in which a completed step is reachable and `_runtime` is worth
    // something. `updates` is already sanitized; `clearProperties` is the only
    // way left to reach it.
    await seedRun(EXECUTION_STATES.IDLE, 0, [
      { prompt: "done", _runtime: { completedAt: 10, sessionId: "abc" } },
      { prompt: "pending" },
    ]);
    const repository = new WorkflowLineageRepository();

    await assert.rejects(
      RunContinuationService.editStepAtRun(
        workspace,
        workflowKey,
        runRef,
        0,
        { updates: {}, clearProperties: ["_runtime"] },
        1,
        repository
      ),
      /Cannot clear internal step property: _runtime/
    );
    await assert.rejects(
      RunContinuationService.editStepAtRun(
        workspace,
        workflowKey,
        runRef,
        1,
        { updates: {}, clearProperties: ["status", "details"] },
        1,
        repository
      ),
      /Cannot clear internal step properties: status, details/
    );

    // The completed step keeps the runtime that anchors it in
    // `immutablePrefixLength`, and an ordinary clear still works.
    const cleared = await RunContinuationService.editStepAtRun(
      workspace,
      workflowKey,
      runRef,
      1,
      { updates: { prompt: "pending" }, clearProperties: ["model"] },
      1,
      repository
    );
    assert.deepStrictEqual(
      (cleared.workingFile.steps![0] as { _runtime?: unknown })._runtime,
      { completedAt: 10, sessionId: "abc" }
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

  test("protects executed steps in finished runs and allows an unexecuted tail", async () => {
    workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-step-finished-mutation-")
    );
    const repository = new WorkflowLineageRepository();

    await seedRun(EXECUTION_STATES.COMPLETED, 2, [
      {
        type: "script",
        script: "exit 0",
        _runtime: { completedAt: 10, terminalStatus: "completed" },
      },
      {
        type: "script",
        script: "exit 0",
        _runtime: { completedAt: 20, terminalStatus: "completed" },
      },
    ]);
    await assert.rejects(
      RunContinuationService.editStepAtRun(
        workspace,
        workflowKey,
        runRef,
        0,
        { updates: { script: "exit 1" } },
        1,
        repository
      ),
      /completed step/i
    );
    await assert.rejects(
      RunContinuationService.removeStepAtRun(
        workspace,
        workflowKey,
        runRef,
        0,
        1,
        repository
      ),
      /completed step/i
    );

    await seedRun(EXECUTION_STATES.ERROR, 1, [
      {
        type: "script",
        script: "exit 1",
        // Terminal status alone must protect this step in a stopped run.
        _runtime: { terminalStatus: "failed" },
      },
      { type: "script", script: "exit 0" },
    ]);
    await assert.rejects(
      RunContinuationService.editStepAtRun(
        workspace,
        workflowKey,
        runRef,
        0,
        { updates: { script: "exit 0" } },
        1,
        repository
      ),
      /completed step/i
    );
    await assert.rejects(
      RunContinuationService.removeStepAtRun(
        workspace,
        workflowKey,
        runRef,
        0,
        1,
        repository
      ),
      /completed step/i
    );

    await seedRun(EXECUTION_STATES.STOPPED, 1, [
      {
        type: "script",
        script: "exit 0",
        _runtime: { completedAt: 10, terminalStatus: "completed" },
      },
      { type: "script", script: "exit 0" },
    ]);
    const edited = await RunContinuationService.editStepAtRun(
      workspace,
      workflowKey,
      runRef,
      1,
      { updates: { script: "exit 2" } },
      1,
      repository
    );
    assert.strictEqual(
      (edited.workingFile.steps![1] as { script: string }).script,
      "exit 2"
    );
    const removed = await RunContinuationService.removeStepAtRun(
      workspace,
      workflowKey,
      runRef,
      1,
      2,
      repository
    );
    assert.strictEqual(removed.workingFile.steps?.length, 1);
  });

  test("returns placement relocation when next lands inside a parallel group", async () => {
    workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-step-placement-")
    );
    await seedRun(EXECUTION_STATES.RUNNING, 1, [
      { prompt: "done", _runtime: { completedAt: 10 } },
      { prompt: "running", _runtime: { startedAt: 11 } },
      { prompt: "sibling" },
      { prompt: "pending" },
    ]);
    const runFilePath = WorkflowPaths.runFilePath(
      workspace,
      workflowKey,
      runRef
    );
    const run = JSON.parse(
      await fs.readFile(runFilePath, "utf8")
    ) as WorkingFile;
    run.parallelGroups = [
      { id: "live-group", startIndex: 1, endIndex: 2, failFast: true },
    ];
    await fs.writeFile(runFilePath, JSON.stringify(run), "utf8");

    const appended = await RunContinuationService.appendStepsToRun(
      workspace,
      workflowKey,
      runRef,
      [{ prompt: "after group" }],
      1,
      new WorkflowLineageRepository(),
      true,
      QUEUE_POSITION.NEXT
    );

    assert.deepStrictEqual(appended.placement, {
      requestedIndex: 2,
      insertedIndex: 3,
      relocation: { kind: "afterParallelGroup", groupId: "live-group" },
    });

    const numeric = await RunContinuationService.appendStepsToRun(
      workspace,
      workflowKey,
      runRef,
      [{ prompt: "numeric after group" }],
      2,
      new WorkflowLineageRepository(),
      true,
      2
    );
    assert.deepStrictEqual(numeric.placement, {
      requestedIndex: 2,
      insertedIndex: 3,
      relocation: { kind: "afterParallelGroup", groupId: "live-group" },
    });
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
