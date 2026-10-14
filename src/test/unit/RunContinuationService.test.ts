import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, suite, test } from "mocha";
import {
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  PARALLEL_GROUP_ADMISSION,
  QUEUE_POSITION,
  RUNNER_IDS,
  type ExecutionState,
} from "../../types/DashboardConstants";
import {
  assertEditableDuringExecution,
  RunContinuationService,
} from "../../core/orchestration/RunContinuationService";
import type { ParallelGroupTopology } from "../../core/ParallelGroupTopology";
import { WorkflowLineageRepository } from "../../core/orchestration/WorkflowLineageRepository";
import { WorkflowLockManager } from "../../utils/WorkflowLockManager";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import type {
  RunRef,
  RunnerHostIdentity,
  PromptStep,
  WorkflowKey,
  WorkflowStep,
  WorkingFile,
} from "../../types/CtrlYokeTypes";

suite("RunContinuationService addressed step editability", () => {
  test("rejects completed and started indices before an addressed batch writes", () => {
    const source: WorkingFile = {
      startedAt: 0,
      definitionRevision: 1,
      steps: [
        { prompt: "done", _runtime: { startedAt: 1, completedAt: 2 } },
        { prompt: "pending" },
      ],
      _runtime: { currentIndex: 1, executionState: EXECUTION_STATES.IDLE },
    };
    assert.throws(
      () => assertEditableDuringExecution(source, source.steps!, 0, "update"),
      /Cannot update a completed step/
    );
    assert.doesNotThrow(() =>
      assertEditableDuringExecution(source, source.steps!, 1, "update")
    );
  });
});

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

    test("allows the executing target's own append/edit while pausing, not while cancelling", async () => {
      const ws = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-edit-lock-pausing-")
      );
      try {
        const repo = new WorkflowLineageRepository();
        await seedLineage(ws, EXECUTION_STATES.PAUSING);
        await liveLock(ws, targetRun);
        for (const action of ["append", "edit"] as const) {
          const target =
            await RunContinuationService.validateContinuationTarget(
              ws,
              workflowKey,
              targetRun,
              repo,
              action,
              true
            );
          assert.strictEqual(target.allowInterruptedRun, true);
        }
        // Without the active-target opt-in a pausing run stays locked, and the
        // error names this run's state rather than a phantom sibling run.
        await assert.rejects(
          RunContinuationService.validateContinuationTarget(
            ws,
            workflowKey,
            targetRun,
            repo,
            "continue"
          ),
          (error: Error) =>
            /pausing/.test(error.message) && !/Another run/.test(error.message)
        );

        await seedLineage(ws, EXECUTION_STATES.CANCELLING);
        await assert.rejects(
          RunContinuationService.validateContinuationTarget(
            ws,
            workflowKey,
            targetRun,
            repo,
            "append",
            true
          ),
          (error: Error) =>
            /cancelling/.test(error.message) &&
            !/Another run/.test(error.message)
        );
      } finally {
        await fs.rm(ws, { recursive: true, force: true });
      }
    });

    test("refuses to continue a completed run but still allows appending to it", async () => {
      const ws = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-continue-completed-")
      );
      try {
        await seedLineage(ws, EXECUTION_STATES.COMPLETED);
        const repo = new WorkflowLineageRepository();

        // A completed run has no pending work; continuing it would only start
        // another final-step pass.
        await assert.rejects(
          RunContinuationService.validateContinuationTarget(
            ws,
            workflowKey,
            targetRun,
            repo,
            "continue"
          ),
          /completed and has no pending work to continue; append steps/
        );
        const appendTarget =
          await RunContinuationService.validateContinuationTarget(
            ws,
            workflowKey,
            targetRun,
            repo,
            "append"
          );
        assert.strictEqual(appendTarget.definitionRevision, 1);

        for (const state of [
          EXECUTION_STATES.STOPPED,
          EXECUTION_STATES.ERROR,
          EXECUTION_STATES.IDLE,
        ]) {
          await seedLineage(ws, state);
          await assert.doesNotReject(
            RunContinuationService.validateContinuationTarget(
              ws,
              workflowKey,
              targetRun,
              repo,
              "continue"
            ),
            `continue should be allowed from ${state}`
          );
        }
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

  test("removeStepsAtRun rejects an invalid batch without writing, then removes in one revision", async () => {
    workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-remove-batch-")
    );
    await seedRun([
      { prompt: "zero" },
      { prompt: "one" },
      { prompt: "two" },
      { prompt: "three" },
    ]);
    const filePath = WorkflowPaths.runFilePath(workspace, workflowKey, runRef);
    await assert.rejects(
      RunContinuationService.removeStepsAtRun(
        workspace,
        workflowKey,
        runRef,
        [1, 9],
        1,
        new WorkflowLineageRepository()
      ),
      /remove index/i
    );
    let file = JSON.parse(await fs.readFile(filePath, "utf8")) as WorkingFile;
    assert.strictEqual(file.steps?.length, 4);
    const removed = await RunContinuationService.removeStepsAtRun(
      workspace,
      workflowKey,
      runRef,
      [1, 3],
      1,
      new WorkflowLineageRepository()
    );
    file = removed.workingFile;
    assert.deepStrictEqual(
      file.steps?.map((step) => (step as { prompt: string }).prompt),
      ["zero", "two"]
    );
    assert.strictEqual(removed.definitionRevision, 2);
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
      100,
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

  test("rejects sibling references in appended groups but permits earlier steps", async () => {
    workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-sibling-append-")
    );
    await seedRun([{ prompt: "earlier" }, { prompt: "existing" }]);
    const filePath = WorkflowPaths.runFilePath(workspace, workflowKey, runRef);
    const before = await fs.readFile(filePath, "utf8");

    await assert.rejects(
      RunContinuationService.appendStepsToRun(
        workspace,
        workflowKey,
        runRef,
        {
          steps: [
            { prompt: "member-a" },
            {
              prompt: "member-b",
              resumeSession: true,
              sessionId: 3,
              priorContext: [3],
            },
          ],
          parallelGroups: [
            {
              id: "sibling-target",
              startIndex: 0,
              endIndex: 1,
              failFast: true,
            },
          ],
        },
        1,
        100,
        new WorkflowLineageRepository()
      ),
      /Numeric priorContext reference 3 cannot target a sibling in parallel group \(steps 3, 4\); Step 4: Numeric sessionId reference 3 cannot target a sibling in parallel group \(steps 3, 4\)/
    );
    assert.strictEqual(await fs.readFile(filePath, "utf8"), before);

    const valid = await RunContinuationService.appendStepsToRun(
      workspace,
      workflowKey,
      runRef,
      {
        steps: [
          { prompt: "valid-member-a" },
          { prompt: "valid-member-b", priorContext: [1] },
        ],
        parallelGroups: [
          { id: "earlier-target", startIndex: 0, endIndex: 1, failFast: true },
        ],
      },
      1,
      100,
      new WorkflowLineageRepository()
    );
    assert.strictEqual(valid.workingFile.steps?.length, 4);
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
        3,
        new WorkflowLineageRepository(),
        false,
        QUEUE_POSITION.END
      ),
      /Step limit reached: this run has 2\/3 steps \(setting queue\.maxSteps: 3\)/
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

  test("uses the required global limit supplied by in-process callers", async () => {
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
      100,
      new WorkflowLineageRepository()
    );

    assert.strictEqual(appended.workingFile.steps?.length, 4);
    assert.strictEqual(appended.stepsAdded, 2);
  });

  test("reads a changed workflow maxSteps value on the next locked append", async () => {
    workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-topology-live-limit-")
    );
    await seedRun([{ prompt: "existing" }]);
    const runPath = WorkflowPaths.runFilePath(workspace, workflowKey, runRef);
    const source = JSON.parse(
      await fs.readFile(runPath, "utf8")
    ) as WorkingFile;
    source.maxSteps = 2;
    await fs.writeFile(runPath, JSON.stringify(source), "utf8");

    const first = await RunContinuationService.appendStepsToRun(
      workspace,
      workflowKey,
      runRef,
      [{ prompt: "fits current cap" }],
      1,
      10,
      new WorkflowLineageRepository()
    );
    const edited = first.workingFile;
    edited.maxSteps = 1;
    await fs.writeFile(runPath, JSON.stringify(edited), "utf8");

    await assert.rejects(
      RunContinuationService.appendStepsToRun(
        workspace,
        workflowKey,
        runRef,
        [{ prompt: "over edited cap" }],
        first.definitionRevision,
        10,
        new WorkflowLineageRepository()
      ),
      /this run has 2\/1 steps \(workflow maxSteps: 1\)/
    );
  });

  test("serializes concurrent appends as whole batches", async () => {
    workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-topology-concurrent-")
    );
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
            100,
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
    source.steps![3] = {
      ...source.steps![3],
      sessionId: 3,
    } as WorkflowStep;
    source.finalStep = {
      prompt: "final",
      sessionId: 5,
      priorContext: [4, 5],
    };
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
        100,
        new WorkflowLineageRepository(),
        QUEUE_POSITION.PARALLEL_WITH_CURRENT,
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
    assert.strictEqual(
      (joined.workingFile.steps?.[5] as PromptStep).sessionId,
      3
    );
    // Authored references are positions and are never rewritten; the
    // insert reports the final step whose targets shifted instead.
    assert.strictEqual(
      (joined.workingFile.finalStep as PromptStep).sessionId,
      5
    );
    assert.deepStrictEqual(
      (joined.workingFile.finalStep as PromptStep).priorContext,
      [4, 5]
    );
    assert.strictEqual(
      joined.warning,
      "Inserted 2 steps. Step references in Final step now point at a different or missing step; check them."
    );
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
        100,
        new WorkflowLineageRepository(),
        QUEUE_POSITION.PARALLEL_WITH_CURRENT,
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
        100,
        new WorkflowLineageRepository(),
        QUEUE_POSITION.PARALLEL_WITH_CURRENT,
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

  test("rejects a live-group join that references an existing sibling", async () => {
    workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-live-sibling-reference-")
    );
    await seedRun(
      [
        { prompt: "completed", _runtime: { completedAt: 1 } },
        { prompt: "running", _runtime: { startedAt: 2 } },
        { prompt: "existing member" },
      ],
      [{ id: "active-group", startIndex: 1, endIndex: 2, failFast: true }]
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
        groupId: "active-group",
        admission: PARALLEL_GROUP_ADMISSION.ACCEPTING,
      },
    };
    await fs.writeFile(runPath, JSON.stringify(source), "utf8");
    const before = await fs.readFile(runPath, "utf8");

    await assert.rejects(
      RunContinuationService.appendStepsToActiveParallelGroup(
        workspace,
        workflowKey,
        runRef,
        [{ prompt: "joined", resumeSession: true, sessionId: 3 }],
        1,
        100,
        new WorkflowLineageRepository(),
        QUEUE_POSITION.PARALLEL_WITH_CURRENT,
        6
      ),
      /Numeric sessionId reference 3 cannot target a sibling in parallel group \(steps 2, 3, 4\)/
    );
    assert.strictEqual(await fs.readFile(runPath, "utf8"), before);
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
    steps: Array<Record<string, unknown>>,
    finalStepPhase?: string
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
        _runtime: {
          currentIndex,
          executionState,
          ...(finalStepPhase ? { finalStep: { phase: finalStepPhase } } : {}),
        },
      }),
      "utf8"
    );
  }

  afterEach(async () => {
    if (workspace) {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  // Regression guard — do not "fix" by making references follow their targets.
  // `$step:N`, `priorContext: [N]`, and `sessionId: N` are positions the author
  // chose (often for where a step will be after they move it). An insert,
  // reorder, or removal must leave every authored field byte-for-byte as
  // written and only report shifted references through `warning`. See
  // core.instructions.md ("Topology edits never rewrite authored settings").
  test("never rewrites authored references on insert, reorder, or removal", async () => {
    workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-authored-references-")
    );
    await seedRun(EXECUTION_STATES.IDLE, 0, [
      { prompt: "one" },
      { prompt: "two" },
      { prompt: "three" },
      { prompt: "four" },
      {
        prompt: "five uses $step:1-4 and $step:summary:2",
        priorContext: [1, 2, 3, 4],
        sessionId: 3,
        endCondition: { script: "true", retryPrompt: "retry with $step:4" },
      },
      { prompt: "six", priorContext: [4], sessionId: 2 },
    ]);
    const runPath = WorkflowPaths.runFilePath(workspace, workflowKey, runRef);
    const seeded = JSON.parse(
      await fs.readFile(runPath, "utf8")
    ) as WorkingFile;
    await fs.writeFile(
      runPath,
      JSON.stringify({
        ...seeded,
        priorContext: [2, 4],
        sessionId: 1,
        finalStep: { prompt: "final $step:3", priorContext: [5], sessionId: 4 },
      }),
      "utf8"
    );

    const authored = (file: WorkingFile) => ({
      steps: Object.fromEntries(
        (file.steps ?? []).map((step) => {
          const { _runtime: _ignored, ...fields } = step as PromptStep;
          return [fields.prompt.split(" ")[0], fields];
        })
      ),
      priorContext: file.priorContext,
      sessionId: file.sessionId,
      finalStep: file.finalStep,
    });
    const before = authored(
      JSON.parse(await fs.readFile(runPath, "utf8")) as WorkingFile
    );
    const repository = new WorkflowLineageRepository();

    const inserted = await RunContinuationService.appendStepsToRun(
      workspace,
      workflowKey,
      runRef,
      [{ prompt: "inserted" }],
      1,
      100,
      repository,
      false,
      1
    );
    assert.ok(inserted.warning, "an insert that shifts references warns");
    const reordered = await RunContinuationService.reorderStepsAtRun(
      workspace,
      workflowKey,
      runRef,
      [0, 1, 2, 3, 5, 4, 6],
      inserted.definitionRevision,
      repository
    );
    assert.ok(reordered.warning, "a reorder that shifts references warns");
    const removed = await RunContinuationService.removeStepsAtRun(
      workspace,
      workflowKey,
      runRef,
      [2, 3],
      reordered.definitionRevision,
      repository
    );
    assert.ok(removed.warning, "a removal that shifts references warns");

    const after = authored(
      JSON.parse(await fs.readFile(runPath, "utf8")) as WorkingFile
    );
    const { one, four, five, six } = before.steps;
    assert.deepStrictEqual(after.steps, {
      one,
      four,
      five,
      six,
      inserted: { prompt: "inserted" },
    });
    assert.deepStrictEqual(after.priorContext, before.priorContext);
    assert.strictEqual(after.sessionId, before.sessionId);
    assert.deepStrictEqual(after.finalStep, before.finalStep);
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

  test("rejects editing a parallel member to target its sibling", async () => {
    workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-edit-sibling-reference-")
    );
    await seedRun(EXECUTION_STATES.IDLE, 0, [
      { prompt: "before group" },
      { prompt: "member-a" },
      { prompt: "member-b" },
    ]);
    const runPath = WorkflowPaths.runFilePath(workspace, workflowKey, runRef);
    const source = JSON.parse(
      await fs.readFile(runPath, "utf8")
    ) as WorkingFile;
    source.parallelGroups = [
      { id: "edit-group", startIndex: 1, endIndex: 2, failFast: true },
    ];
    await fs.writeFile(runPath, JSON.stringify(source), "utf8");
    const before = await fs.readFile(runPath, "utf8");

    await assert.rejects(
      RunContinuationService.editStepAtRun(
        workspace,
        workflowKey,
        runRef,
        2,
        { updates: { resumeSession: true, sessionId: 2 } },
        1,
        new WorkflowLineageRepository()
      ),
      /Numeric sessionId reference 2 cannot target a sibling in parallel group \(steps 2, 3\)/
    );
    assert.strictEqual(await fs.readFile(runPath, "utf8"), before);
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

    const reordered = await RunContinuationService.reorderStepsAtRun(
      workspace,
      workflowKey,
      runRef,
      [3, 2],
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
      RunContinuationService.reorderStepsAtRun(
        workspace,
        workflowKey,
        runRef,
        [1, 2],
        2,
        repository,
        undefined,
        true
      ),
      /exactly 2 not-yet-started step indices/i
    );
  });

  test("rejects split parallel-group orders without writing and allows whole-group moves", async () => {
    workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-step-reorder-group-split-")
    );
    await seedRun(EXECUTION_STATES.RUNNING, 1, [
      { prompt: "done", _runtime: { completedAt: 10 } },
      { prompt: "inflight", _runtime: { startedAt: 11 } },
      { prompt: "g1" },
      { prompt: "g2" },
      { prompt: "tail" },
    ]);
    const runFilePath = WorkflowPaths.runFilePath(
      workspace,
      workflowKey,
      runRef
    );
    const workingFile = JSON.parse(
      await fs.readFile(runFilePath, "utf8")
    ) as WorkingFile;
    workingFile.parallelGroups = [
      { id: "G", startIndex: 2, endIndex: 3, failFast: true },
    ];
    await fs.writeFile(runFilePath, JSON.stringify(workingFile), "utf8");
    const before = await fs.readFile(runFilePath, "utf8");
    const repository = new WorkflowLineageRepository();

    for (const order of [
      [2, 4, 3],
      [3, 4, 2],
    ]) {
      await assert.rejects(
        RunContinuationService.reorderStepsAtRun(
          workspace,
          workflowKey,
          runRef,
          order,
          1,
          repository,
          undefined,
          true
        ),
        /parallel group G .*indices 2, 3/i
      );
      assert.strictEqual(await fs.readFile(runFilePath, "utf8"), before);
    }

    const reordered = await RunContinuationService.reorderStepsAtRun(
      workspace,
      workflowKey,
      runRef,
      [4, 2, 3],
      1,
      repository,
      undefined,
      true
    );
    assert.deepStrictEqual(
      reordered.workingFile.steps!.map(
        (step) => (step as { prompt: string }).prompt
      ),
      ["done", "inflight", "tail", "g1", "g2"]
    );
    assert.deepStrictEqual(reordered.workingFile.parallelGroups, [
      { id: "G", startIndex: 3, endIndex: 4, failFast: true },
    ]);
  });

  test("reorder_steps rejects creating a group with a sibling reference", async () => {
    workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-step-reorder-sibling-reference-")
    );
    const repository = new WorkflowLineageRepository();
    const runFilePath = WorkflowPaths.runFilePath(
      workspace,
      workflowKey,
      runRef
    );

    for (const reference of [
      { resumeSession: true, sessionId: 2 },
      { priorContext: [2] },
    ]) {
      await seedRun(EXECUTION_STATES.IDLE, 0, [
        { prompt: "first" },
        { prompt: "group sibling" },
        { prompt: "dragged", ...reference },
      ]);
      const before = await fs.readFile(runFilePath, "utf8");

      await assert.rejects(
        RunContinuationService.reorderStepsAtRun(
          workspace,
          workflowKey,
          runRef,
          [0, 1, 2],
          1,
          repository,
          [{ start: 1, end: 2, failFast: false }]
        ),
        /cannot target a sibling in parallel group/i
      );
      assert.strictEqual(await fs.readFile(runFilePath, "utf8"), before);
    }
  });

  test("explains that a run with no pending steps cannot be reordered", async () => {
    workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-step-reorder-empty-")
    );
    await seedRun(EXECUTION_STATES.RUNNING, 1, [
      { prompt: "done", _runtime: { completedAt: 10 } },
      { prompt: "in flight", _runtime: { startedAt: 11 } },
    ]);

    await assert.rejects(
      RunContinuationService.reorderStepsAtRun(
        workspace,
        workflowKey,
        runRef,
        [],
        1,
        new WorkflowLineageRepository(),
        undefined,
        true
      ),
      /no steps are pending, so there is nothing to reorder/i
    );
  });

  test("rejects numeric append positions that would move the in-flight step", async () => {
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
      RunContinuationService.appendStepsToRun(
        workspace,
        workflowKey,
        runRef,
        [{ prompt: "must not shift in flight" }],
        1,
        100,
        repository,
        true,
        1
      ),
      /currently executing|completed step/i
    );
  });

  test("allows mutations to steps appended by a running final step", async () => {
    workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-final-step-mutations-")
    );
    const repository = new WorkflowLineageRepository();
    const finalStepPhase = FINAL_STEP_PHASES.FINAL_STEP;

    async function appendTwoSteps(): Promise<void> {
      await seedRun(
        EXECUTION_STATES.RUNNING,
        1,
        [{ prompt: "done", _runtime: { completedAt: 10 } }],
        finalStepPhase
      );
      await RunContinuationService.appendStepsToRun(
        workspace,
        workflowKey,
        runRef,
        [{ prompt: "appended-a" }, { prompt: "appended-b" }],
        1,
        100,
        repository,
        true
      );
    }

    await appendTwoSteps();
    const edited = await RunContinuationService.editStepAtRun(
      workspace,
      workflowKey,
      runRef,
      1,
      { updates: { prompt: "appended-a (edited)" } },
      2,
      repository,
      true
    );
    assert.strictEqual(
      (edited.workingFile.steps![1] as { prompt: string }).prompt,
      "appended-a (edited)"
    );

    await appendTwoSteps();
    const removed = await RunContinuationService.removeStepsAtRun(
      workspace,
      workflowKey,
      runRef,
      [1],
      2,
      repository,
      true
    );
    assert.deepStrictEqual(
      removed.workingFile.steps!.map(
        (step) => (step as { prompt: string }).prompt
      ),
      ["done", "appended-b"]
    );

    await appendTwoSteps();
    const reordered = await RunContinuationService.reorderStepsAtRun(
      workspace,
      workflowKey,
      runRef,
      [2, 1],
      2,
      repository,
      undefined,
      true
    );
    assert.deepStrictEqual(
      reordered.workingFile.steps!.map(
        (step) => (step as { prompt: string }).prompt
      ),
      ["done", "appended-b", "appended-a"]
    );

    await appendTwoSteps();
    const appendedAtEnd = await RunContinuationService.appendStepsToRun(
      workspace,
      workflowKey,
      runRef,
      [{ prompt: "appended-at-end" }],
      2,
      100,
      repository,
      true,
      3
    );
    assert.strictEqual(appendedAtEnd.insertIndex, 3);
    assert.strictEqual(appendedAtEnd.workingFile.steps?.length, 4);
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
      RunContinuationService.removeStepsAtRun(
        workspace,
        workflowKey,
        runRef,
        [0],
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
      RunContinuationService.removeStepsAtRun(
        workspace,
        workflowKey,
        runRef,
        [0],
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
    const removed = await RunContinuationService.removeStepsAtRun(
      workspace,
      workflowKey,
      runRef,
      [1],
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
      100,
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
      100,
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
