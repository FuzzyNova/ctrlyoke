import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { PromptQueue } from "../core/PromptQueue";
import {
  CONDITION_ACTIONS,
  EXECUTION_STATES,
  PARALLEL_GROUP_ADMISSION,
  STEP_TYPES,
  STEP_STATUS,
  PROMPT_TERMINAL_STATUS,
  STEP_CLAIM_OUTCOMES,
} from "../types/DashboardConstants";
import {
  ParallelGroupDefinition,
  PromptStep,
  PromptFile,
  StepExecutionOutcome,
  WorkingFile,
} from "../types/CtrlYokeTypes";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { RunContinuationService } from "../core/orchestration/RunContinuationService";
import * as WorkflowPaths from "../utils/WorkflowPaths";
import { withFileLock } from "../utils/FileLockUtils";

/**
 * Helper to wrap prompts array into PromptFile for tests
 */
function createPromptFile(
  steps: PromptStep[],
  parallelGroups: ParallelGroupDefinition[] = []
): PromptFile {
  return { steps, parallelGroups };
}

async function startQueueExecution(queue: PromptQueue): Promise<void> {
  if (queue.getState().steps.length === 0) {
    return;
  }

  if (queue.getRuntimeStateMachine().startExecution()) {
    await queue.commitRuntimeTransition();
  }
}

async function pauseQueueExecution(queue: PromptQueue): Promise<void> {
  if (queue.getRuntimeStateMachine().pause()) {
    queue.getRuntimeStateMachine().confirmPaused();
    await queue.commitRuntimeTransition();
  }
}

async function resumeQueueExecution(queue: PromptQueue): Promise<void> {
  if (queue.getRuntimeStateMachine().resume()) {
    await queue.commitRuntimeTransition();
  }
}

async function requestQueueStop(queue: PromptQueue): Promise<void> {
  if (!queue.getRuntimeStateMachine().requestStop()) {
    return;
  }

  queue.markInFlightPromptCancelled();
  await queue.commitRuntimeTransition({ persist: false });
}

async function confirmQueueStopped(queue: PromptQueue): Promise<void> {
  if (!queue.getRuntimeStateMachine().confirmStopped()) {
    return;
  }

  queue.finalizeCancelledPromptAfterStop();
  await queue.commitRuntimeTransition();
}

async function markQueueCompleted(queue: PromptQueue): Promise<void> {
  queue.getRuntimeStateMachine().complete();
  await queue.commitRuntimeTransition();
}

async function markQueueErrored(queue: PromptQueue): Promise<void> {
  await startQueueExecution(queue);
  await queue.markStepAsSent(queue.getState().currentIndex);
  queue.finalizeFailedInFlightPrompt("Error");
  queue.getRuntimeStateMachine().fail();
  await queue.commitRuntimeTransition({ persist: false });
}

async function failCurrentPrompt(
  queue: PromptQueue,
  error: string = "Test error"
): Promise<void> {
  await startQueueExecution(queue);
  await queue.markStepAsSent(queue.getState().currentIndex);
  queue.finalizeFailedInFlightPrompt(error);
  queue.getRuntimeStateMachine().fail();
  await queue.commitRuntimeTransition({ persist: false });
}

suite("PromptQueue State Machine Tests", () => {
  let queue: PromptQueue;
  const samplePrompts: PromptStep[] = [
    { prompt: "First prompt" },
    { prompt: "Second prompt" },
    { prompt: "Third prompt" },
  ];

  setup(() => {
    queue = new PromptQueue();
  });

  suite("Initialization", () => {
    test("should start with idle state", () => {
      const state = queue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.IDLE);
    });

    test("should start with empty prompts and results", () => {
      const state = queue.getState();
      assert.strictEqual(state.steps.length, 0);
      assert.strictEqual(state.results.length, 0);
    });

    test("should start with currentIndex at 0", () => {
      const state = queue.getState();
      assert.strictEqual(state.currentIndex, 0);
    });

    test("should have stopped set to false initially", () => {
      const state = queue.getState();
      assert.strictEqual(state.stopped, false);
    });
  });

  suite("loadPrompts", () => {
    test("should load prompts correctly", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      const state = queue.getState();
      assert.strictEqual(state.steps.length, 3);
    });

    test("should create corresponding results for each prompt", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      const state = queue.getState();
      assert.strictEqual(state.results.length, 3);
      state.results.forEach((result) => {
        assert.strictEqual(result.status, STEP_STATUS.PENDING);
      });
    });

    test("should reset currentIndex on load", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      const state = queue.getState();
      assert.strictEqual(state.currentIndex, 0);
    });

    test("should keep status as IDLE after loading", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      const state = queue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.IDLE);
    });

    test("should clear completedIndices on new load", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      const state = queue.getState();
      assert.strictEqual(state.completedIndices.size, 0);
    });

    test("should preserve enabled flags on loaded steps", () => {
      queue.loadPrompts(
        createPromptFile([
          { prompt: "disabled prompt", enabled: false },
          { prompt: "enabled prompt" },
        ])
      );

      const state = queue.getState();
      assert.strictEqual(state.steps[0].enabled, false);
      assert.strictEqual(state.steps[1].enabled, undefined);
    });

    test("assigns stable IDs to every loaded queue step", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      const ids = queue.getState().steps.map((step) => step._runtime?.stepId);
      assert.ok(ids.every((id): id is string => id !== undefined));
      assert.strictEqual(new Set(ids).size, ids.length);
    });

    test("does not invent startedAt when persisting unrelated runtime metadata", async () => {
      queue.loadPrompts(createPromptFile([{ prompt: "pending" }]));

      await queue.persistRuntimeMetadata(0, { sessionId: "session" });

      assert.strictEqual(
        queue.getState().steps[0]._runtime?.startedAt,
        undefined
      );
    });

    test("claims by ID without bumping the definition revision and refuses a second claim", async () => {
      const workspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-prompt-queue-claim-")
      );

      try {
        const steps: PromptStep[] = [{ prompt: "claim me" }];
        const draftPath = await queue.createWorkingFile(
          "claim-workflow",
          steps,
          workspace
        );
        queue.loadPrompts({ steps }, draftPath);
        const promotion = await queue.promoteToNewRun(workspace, 100);
        assert.ok(promotion);

        const stepId = queue.getState().steps[0]._runtime?.stepId;
        assert.ok(stepId);
        const revision = queue.getState().definitionRevision;

        const claim = await queue.claimStepById(stepId, 123, workspace);
        assert.strictEqual(claim.status, STEP_CLAIM_OUTCOMES.CLAIMED);
        assert.strictEqual(claim.stepIndex, 0);
        assert.strictEqual(claim.step._runtime?.startedAt, 123);
        assert.strictEqual(claim.definitionRevision, revision);
        assert.strictEqual(queue.getState().definitionRevision, revision);

        const persisted = JSON.parse(
          await fs.readFile(promotion.workingFilePath, "utf8")
        ) as WorkingFile;
        assert.strictEqual(persisted.definitionRevision, revision);
        assert.strictEqual(persisted.steps?.[0]._runtime?.startedAt, 123);

        const secondClaim = await queue.claimStepById(stepId, 456, workspace);
        assert.strictEqual(
          secondClaim.status,
          STEP_CLAIM_OUTCOMES.ALREADY_CLAIMED
        );
      } finally {
        await fs.rm(workspace, { recursive: true, force: true });
      }
    });

    test("skips a step removed before its claim without fabricating settlement", async () => {
      const workspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-prompt-queue-claim-missing-")
      );

      try {
        const steps: PromptStep[] = [
          { prompt: "removed" },
          { prompt: "survivor" },
        ];
        const draftPath = await queue.createWorkingFile(
          "claim-missing-workflow",
          steps,
          workspace
        );
        queue.loadPrompts({ steps }, draftPath);
        const promotion = await queue.promoteToNewRun(workspace, 100);
        assert.ok(promotion);
        const removedId = queue.getState().steps[0]._runtime?.stepId;
        assert.ok(removedId);

        await RunContinuationService.removeStepAtRun(
          workspace,
          queue.getState().workflowKey!,
          promotion.runRef,
          0,
          queue.getState().definitionRevision
        );

        const claim = await queue.claimStepById(removedId, 123, workspace);
        assert.strictEqual(claim.status, STEP_CLAIM_OUTCOMES.MISSING);
        assert.strictEqual(queue.getState().steps.length, 1);
        assert.strictEqual(
          queue.getState().steps[0]._runtime?.completedAt,
          undefined
        );
        assert.strictEqual(
          queue.getState().steps[0]._runtime?.startedAt,
          undefined
        );
      } finally {
        await fs.rm(workspace, { recursive: true, force: true });
      }
    });

    test("makes claim-versus-mutation ordering deterministic through the shared lock", async () => {
      const workspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-prompt-queue-claim-race-")
      );

      try {
        const steps: PromptStep[] = [{ prompt: "race" }];
        const draftPath = await queue.createWorkingFile(
          "claim-race-workflow",
          steps,
          workspace
        );
        queue.loadPrompts({ steps }, draftPath);
        const promotion = await queue.promoteToNewRun(workspace, 100);
        assert.ok(promotion);
        const workflowKey = queue.getState().workflowKey!;
        const stepId = queue.getState().steps[0]._runtime?.stepId;
        assert.ok(stepId);

        const descriptorLockPath = `${WorkflowPaths.descriptorPath(
          workspace,
          workflowKey
        )}.lock`;
        // The claim must acquire the descriptor lock first and then wait on
        // the run lock. Holding the run lock makes the subsequent mutation
        // wait behind that descriptor lock, fixing the winner by lock order.
        const pending = await withFileLock(
          promotion.workingFilePath,
          async () => {
            const claimPromise = RunContinuationService.claimStepAtRun(
              workspace,
              workflowKey,
              promotion.runRef,
              stepId,
              123
            );
            let sawDescriptorLock = false;
            for (let attempt = 0; attempt < 100; attempt += 1) {
              try {
                await fs.access(descriptorLockPath);
                sawDescriptorLock = true;
                break;
              } catch {
                await new Promise((resolve) => setTimeout(resolve, 1));
              }
            }
            assert.ok(sawDescriptorLock);
            const mutationPromise = RunContinuationService.removeStepAtRun(
              workspace,
              workflowKey,
              promotion.runRef,
              0,
              1
            );
            return { claimPromise, mutationPromise };
          }
        );
        const [claim, mutation] = await Promise.all([
          pending.claimPromise,
          pending.mutationPromise,
        ]);
        assert.strictEqual(claim.status, STEP_CLAIM_OUTCOMES.CLAIMED);
        assert.strictEqual(mutation.definitionRevision, 2);
        const persisted = JSON.parse(
          await fs.readFile(promotion.workingFilePath, "utf8")
        ) as WorkingFile;
        assert.strictEqual(persisted.steps?.length, 0);
      } finally {
        await fs.rm(workspace, { recursive: true, force: true });
      }
    });

    test("backfills missing IDs during recovery and preserves existing runtime facts", async () => {
      const workspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-prompt-queue-recovery-")
      );

      try {
        const workingFilePath = await queue.createWorkingFile(
          "recovery-workflow",
          [{ prompt: "first" }, { prompt: "started sibling" }],
          workspace
        );
        const workingFile = JSON.parse(
          await fs.readFile(workingFilePath, "utf8")
        ) as PromptFile;
        const originalId = workingFile.steps![0]._runtime?.stepId;
        workingFile.steps![1]._runtime = { startedAt: 42 };
        await fs.writeFile(
          workingFilePath,
          JSON.stringify(workingFile, null, 2)
        );

        const recovered = new PromptQueue();
        await recovered.restoreFromWorkingFile(workingFilePath);
        const recoveredSteps = recovered.getState().steps;
        const recoveredIds = recoveredSteps.map(
          (step) => step._runtime?.stepId
        );

        assert.strictEqual(recoveredIds[0], originalId);
        assert.ok(recoveredIds[1]);
        assert.strictEqual(recoveredSteps[1]._runtime?.startedAt, 42);
        assert.strictEqual(new Set(recoveredIds).size, recoveredIds.length);

        const persisted = JSON.parse(
          await fs.readFile(workingFilePath, "utf8")
        ) as PromptFile;
        assert.ok(persisted.steps![1]._runtime?.stepId);
      } finally {
        await fs.rm(workspace, { recursive: true, force: true });
      }
    });

    test("rebuilds admission only for a resumed unsettled group", async () => {
      const workspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-prompt-queue-admission-")
      );

      try {
        const workingFilePath = await queue.createWorkingFile(
          "admission-recovery",
          [{ prompt: "one" }, { prompt: "two" }],
          workspace
        );
        const workingFile = await queue.readWorkingFile(workingFilePath);
        workingFile.parallelGroups = [
          { id: "recover-group", startIndex: 0, endIndex: 1, failFast: true },
        ];
        workingFile._runtime = {
          currentIndex: 0,
          executionState: EXECUTION_STATES.RUNNING,
          activeParallelGroup: {
            groupId: "recover-group",
            admission: PARALLEL_GROUP_ADMISSION.CLOSING,
          },
        };
        await fs.writeFile(
          workingFilePath,
          JSON.stringify(workingFile, null, 2)
        );

        const resumed = new PromptQueue();
        await resumed.restoreFromWorkingFile(workingFilePath);
        assert.deepStrictEqual(resumed.getActiveParallelGroupRuntime(), {
          groupId: "recover-group",
          admission: PARALLEL_GROUP_ADMISSION.ACCEPTING,
        });

        resumed.getRuntimeStateMachine().restore({
          status: EXECUTION_STATES.STOPPED,
          stopped: true,
          totalPausedDuration: 0,
        });
        workingFile._runtime.executionState = EXECUTION_STATES.STOPPED;
        await fs.writeFile(
          workingFilePath,
          JSON.stringify(workingFile, null, 2)
        );
        const stopped = new PromptQueue();
        await stopped.restoreFromWorkingFile(workingFilePath);
        assert.strictEqual(stopped.getActiveParallelGroupRuntime(), undefined);
        assert.strictEqual(
          (await stopped.readWorkingFile(workingFilePath))._runtime
            ?.activeParallelGroup,
          undefined
        );
      } finally {
        await fs.rm(workspace, { recursive: true, force: true });
      }
    });

    test("preserves IDs through edit, replacement, and reorder", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      const before = queue
        .getState()
        .steps.map((step) => step._runtime?.stepId);

      await queue.updatePrompt(0, { prompt: "edited" });
      await queue.replaceStep(1, { prompt: "replaced" });
      await queue.reorderPendingPrompts([2, 0, 1]);

      const after = queue.getState().steps.map((step) => step._runtime?.stepId);
      assert.deepStrictEqual(new Set(after), new Set(before));
      assert.strictEqual(after[0], before[2]);
      assert.strictEqual(after[1], before[0]);
      assert.strictEqual(after[2], before[1]);
    });

    test("should preserve workflowKey/runRef already on the queue (createWorkingFile always runs immediately before this in production)", () => {
      (queue as any).state.workflowKey = "some-workflow-key";
      (queue as any).state.runRef = "run-2026-07-20T00-00-00-000Z";

      queue.loadPrompts(createPromptFile(samplePrompts));

      const state = queue.getState();
      assert.strictEqual(state.workflowKey, "some-workflow-key");
      assert.strictEqual(state.runRef, "run-2026-07-20T00-00-00-000Z");
    });

    test("promotes a fresh draft after loadPrompts preserves its lineage identity", async () => {
      const workspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-prompt-queue-promotion-")
      );

      try {
        await queue.createWorkingFile(
          "fresh-workflow",
          [{ prompt: "fresh step" }],
          workspace
        );
        const workflowKey = queue.getState().workflowKey;

        queue.loadPrompts(createPromptFile([{ prompt: "fresh step" }]));
        const promotion = await queue.promoteToNewRun(workspace, Date.now());

        assert.ok(workflowKey);
        assert.ok(promotion);
        assert.strictEqual(queue.getState().workflowKey, workflowKey);
        assert.strictEqual(queue.getState().runRef, promotion!.runRef);
        await assert.doesNotReject(() => fs.access(promotion!.workingFilePath));
      } finally {
        await fs.rm(workspace, { recursive: true, force: true });
      }
    });
  });

  suite("deletePrompt", () => {
    test("should not allow deleting the current prompt while pause is pending", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await startQueueExecution(queue);

      assert.strictEqual(queue.getRuntimeStateMachine().pause(), true);
      await queue.commitRuntimeTransition();

      await assert.rejects(
        queue.deletePrompt(0),
        /Cannot delete the currently executing step/
      );
    });

    suite("parallel topology mutations", () => {
      const grouped = {
        steps: [
          { prompt: "before", color: "#111111" },
          { prompt: "member-a", color: "#222222" },
          { prompt: "member-b", color: "#333333" },
          { prompt: "member-c", color: "#444444" },
          { prompt: "after", color: "#555555" },
        ],
        parallelGroups: [
          { id: "group-1", startIndex: 1, endIndex: 3, failFast: false },
        ],
      };

      setup(() => {
        queue.loadPrompts(grouped);
      });

      test("exposes normalized groups on queue state and preserves them on edits", async () => {
        await queue.updatePrompt(2, { name: "renamed" });
        await queue.replaceStep(1, { prompt: "replacement" });
        const state = queue.getState();
        assert.deepStrictEqual(state.parallelGroups, [
          { id: "group-1", startIndex: 1, endIndex: 3, failFast: false },
        ]);
      });

      test("snaps insertion inside a group after the group", async () => {
        await queue.insertStepAfterIndex(1, {
          prompt: "inserted",
          color: "#abcdef",
        });
        const state = queue.getState();
        assert.deepStrictEqual(
          state.steps.map((step) => (step as PromptStep).prompt),
          ["before", "member-a", "member-b", "member-c", "inserted", "after"]
        );
        assert.deepStrictEqual(state.parallelGroups, [
          { id: "group-1", startIndex: 1, endIndex: 3, failFast: false },
        ]);
        assert.deepStrictEqual(
          state.steps.map((step) => step.color),
          ["#111111", "#222222", "#333333", "#444444", "#abcdef", "#555555"]
        );
      });

      test("shrinks and unwraps groups when members are deleted", async () => {
        await queue.deletePrompt(2);
        assert.deepStrictEqual(
          queue.getState().steps.map((step) => step.color),
          ["#111111", "#222222", "#444444", "#555555"]
        );
        assert.deepStrictEqual(queue.getState().parallelGroups, [
          { id: "group-1", startIndex: 1, endIndex: 2, failFast: false },
        ]);
        await queue.deletePrompt(1);
        assert.deepStrictEqual(queue.getState().parallelGroups, []);
      });

      test("reorders pending members without losing group topology", async () => {
        await queue.reorderPendingPrompts([0, 2, 1, 3, 4]);
        const state = queue.getState();
        assert.deepStrictEqual(
          state.steps.map((step) => (step as PromptStep).prompt),
          ["before", "member-b", "member-a", "member-c", "after"]
        );
        assert.deepStrictEqual(
          state.steps.map((step) => step.color),
          ["#111111", "#333333", "#222222", "#444444", "#555555"]
        );
        assert.deepStrictEqual(state.parallelGroups, [
          { id: "group-1", startIndex: 1, endIndex: 3, failFast: false },
        ]);
      });

      test("snaps pending rewind boundaries to a group's start", () => {
        queue.applyPendingRewind(2, 1, 2, false);
        assert.strictEqual(queue.getState().currentIndex, 1);
        assert.deepStrictEqual(queue.getState().pendingRewind, {
          fromStepIndex: 1,
          baseDefinitionRevision: 1,
        });
      });

      test("carries groups through undo/redo sync and rejects invalid reorder ranges", async () => {
        await queue.syncStepsForUndoRedo(grouped.steps, grouped.parallelGroups);
        assert.deepStrictEqual(
          queue.getState().parallelGroups,
          grouped.parallelGroups
        );
        await assert.rejects(
          queue.reorderPendingPrompts([0, 0, 1, 2, 3]),
          /permutation/
        );
      });

      test("appends group members and bumps the definition revision once per call", async () => {
        const initialRevision = queue.getState().definitionRevision;

        await queue.appendParallelGroupMember("group-1", {
          prompt: "member-d",
        });
        assert.strictEqual(
          queue.getState().definitionRevision,
          initialRevision + 1
        );
        assert.strictEqual(queue.getState().parallelGroups[0].endIndex, 4);

        await queue.appendParallelGroupMember("group-1", {
          prompt: "member-e",
        });
        assert.strictEqual(
          queue.getState().definitionRevision,
          initialRevision + 2
        );
        assert.deepStrictEqual(
          queue.getState().steps.map((step) => (step as PromptStep).prompt),
          [
            "before",
            "member-a",
            "member-b",
            "member-c",
            "member-d",
            "member-e",
            "after",
          ]
        );
        assert.strictEqual(queue.getState().parallelGroups[0].endIndex, 5);
      });

      test("promotes a started step without changing its runtime or fail-fast policy", async () => {
        const runtime = { stepId: "started-anchor", startedAt: 1234 };
        queue.loadPrompts({
          steps: [
            { prompt: "started", _runtime: runtime },
            { prompt: "after" },
          ],
        });

        await queue.promoteStepToParallelGroup(0, { prompt: "sibling" });

        const state = queue.getState();
        assert.deepStrictEqual(state.parallelGroups, [
          {
            id: state.parallelGroups[0].id,
            startIndex: 0,
            endIndex: 1,
            failFast: false,
          },
        ]);
        assert.deepStrictEqual(state.steps[0]._runtime, runtime);
        assert.deepStrictEqual(
          state.steps.map((step) => (step as PromptStep).prompt),
          ["started", "sibling", "after"]
        );
      });

      test("rejects appending to settled and cancelling groups", async () => {
        queue.loadPrompts({
          steps: [
            { prompt: "settled-a", _runtime: { completedAt: 1 } },
            { prompt: "settled-b", _runtime: { completedAt: 2 } },
          ],
          parallelGroups: [
            { id: "settled", startIndex: 0, endIndex: 1, failFast: false },
          ],
        });
        await assert.rejects(
          queue.appendParallelGroupMember("settled", { prompt: "late" }),
          /settled parallel group/
        );

        queue.loadPrompts({
          steps: [
            {
              prompt: "cancelling",
              _runtime: { terminalStatus: PROMPT_TERMINAL_STATUS.CANCELLED },
            },
            { prompt: "pending" },
          ],
          parallelGroups: [
            {
              id: "cancelling",
              startIndex: 0,
              endIndex: 1,
              failFast: false,
            },
          ],
        });
        await assert.rejects(
          queue.appendParallelGroupMember("cancelling", { prompt: "late" }),
          /cancelling or stopping parallel group/
        );
      });
    });
  });

  suite("Runtime State Projection - startExecution()", () => {
    test("should transition IDLE -> RUNNING", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await startQueueExecution(queue);
      const state = queue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.RUNNING);
    });

    test("should not change state if already RUNNING", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await startQueueExecution(queue);
      await startQueueExecution(queue); // Call again
      const state = queue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.RUNNING);
    });

    test("should keep queue IDLE when start is requested without prompts", async () => {
      await startQueueExecution(queue);
      const state = queue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.IDLE);
    });

    test("should clear stopped flag when restarting from STOPPED", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await startQueueExecution(queue);
      await requestQueueStop(queue);
      await confirmQueueStopped(queue);
      assert.strictEqual(queue.getState().stopped, true);
      await startQueueExecution(queue);
      assert.strictEqual(queue.getState().stopped, false);
    });
  });

  suite("Runtime State Projection - pause()", () => {
    test("should transition RUNNING -> PAUSED", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await startQueueExecution(queue);
      await pauseQueueExecution(queue);
      const state = queue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.PAUSED);
    });

    test("should record pause timestamp", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await startQueueExecution(queue);
      const beforePause = Date.now();
      await pauseQueueExecution(queue);
      const state = queue.getState();
      assert.ok(state.pausedTime);
      assert.ok(state.pausedTime >= beforePause);
    });

    test("should not change state if not RUNNING", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await pauseQueueExecution(queue);
      const state = queue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.IDLE);
    });
  });

  suite("Runtime State Projection - resume()", () => {
    test("should transition PAUSED -> RUNNING", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await startQueueExecution(queue);
      await pauseQueueExecution(queue);
      assert.strictEqual(queue.getState().status, EXECUTION_STATES.PAUSED);
      await resumeQueueExecution(queue);
      assert.strictEqual(queue.getState().status, EXECUTION_STATES.RUNNING);
    });

    test("should calculate paused duration", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await startQueueExecution(queue);
      await pauseQueueExecution(queue);

      // Wait a small amount to measure pause duration
      // Use 100ms sleep with >= 50ms assertion to tolerate timer inaccuracy
      await new Promise((resolve) => setTimeout(resolve, 100));

      await resumeQueueExecution(queue);
      const state = queue.getState();
      assert.ok(
        state.totalPausedDuration >= 50,
        `Expected totalPausedDuration >= 50ms but got ${state.totalPausedDuration}ms`
      );
    });

    test("should clear pausedTime after resume", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await startQueueExecution(queue);
      await pauseQueueExecution(queue);
      assert.ok(queue.getState().pausedTime);
      await resumeQueueExecution(queue);
      assert.strictEqual(queue.getState().pausedTime, undefined);
    });

    test("should not change state if not PAUSED", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await startQueueExecution(queue);
      await resumeQueueExecution(queue);
      const state = queue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.RUNNING);
    });
  });

  suite("Runtime State Projection - requestStop()/confirmStopped()", () => {
    test("should transition to CANCELLING, then STOPPED after confirmedStopped", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await startQueueExecution(queue);
      await requestQueueStop(queue);
      let state = queue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.CANCELLING);

      await confirmQueueStopped(queue);
      state = queue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.STOPPED);
    });

    test("should advance currentIndex past cancelled prompt after confirmedStopped", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await startQueueExecution(queue);
      // Simulate moving forward past first prompt
      await queue.markStepAsSent(queue.getState().currentIndex);
      await queue.commitStepOutcomeAndAdvance({
        target: { kind: "queue", stepIndex: queue.getState().currentIndex },
        status: "completed",
      });
      assert.strictEqual(queue.getState().currentIndex, 1);

      // Stop while on second prompt
      await queue.markStepAsSent(queue.getState().currentIndex);
      await requestQueueStop(queue);
      await confirmQueueStopped(queue);

      const state = queue.getState();
      assert.strictEqual(state.currentIndex, 2); // Advanced past cancelled prompt
      assert.ok(state.completedIndices.size >= 2); // Both prompts recorded
      // First prompt completed, second prompt cancelled
      assert.strictEqual(state.results[0].status, STEP_STATUS.COMPLETED);
      assert.strictEqual(state.results[1].status, STEP_STATUS.CANCELLED);
    });

    test("should mark SENT prompts as CANCELLED", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await startQueueExecution(queue);
      await queue.markStepAsSent(queue.getState().currentIndex);
      assert.strictEqual(queue.getState().results[0].status, STEP_STATUS.SENT);
      await requestQueueStop(queue);
      assert.strictEqual(
        queue.getState().results[0].status,
        STEP_STATUS.CANCELLED
      );
    });

    test("should set stopped flag", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await startQueueExecution(queue);
      await requestQueueStop(queue);
      assert.strictEqual(queue.getState().stopped, true);
    });

    test("should not mark PENDING prompts as CANCELLED", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await startQueueExecution(queue);
      await requestQueueStop(queue);
      // The first prompt was never marked as sent, so it remains PENDING.
      // Actually stop marks SENT as CANCELLED, PENDING stays PENDING
      // But currentIndex is reset, so we check result[1] which was never touched
      assert.strictEqual(
        queue.getState().results[1].status,
        STEP_STATUS.PENDING
      );
    });
  });

  suite("restart()", () => {
    test("should reset currentIndex to 0", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await startQueueExecution(queue);
      await queue.markStepAsSent(queue.getState().currentIndex);
      await queue.commitStepOutcomeAndAdvance({
        target: { kind: "queue", stepIndex: queue.getState().currentIndex },
        status: "completed",
      });
      await queue.restart();
      assert.strictEqual(queue.getState().currentIndex, 0);
    });

    test("should reset all results to PENDING", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await startQueueExecution(queue);
      await queue.markStepAsSent(queue.getState().currentIndex);
      await queue.commitStepOutcomeAndAdvance({
        target: { kind: "queue", stepIndex: queue.getState().currentIndex },
        status: "completed",
      });
      await queue.restart();
      queue.getState().results.forEach((result) => {
        assert.strictEqual(result.status, STEP_STATUS.PENDING);
      });
    });

    test("should clear completedIndices", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await startQueueExecution(queue);
      await queue.markStepAsSent(queue.getState().currentIndex);
      await queue.commitStepOutcomeAndAdvance({
        target: { kind: "queue", stepIndex: queue.getState().currentIndex },
        status: "completed",
      });
      assert.ok(queue.getState().completedIndices.size > 0);
      await queue.restart();
      assert.strictEqual(queue.getState().completedIndices.size, 0);
    });

    test("should reset execution time tracking", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      queue.getRuntimeStateMachine().startExecutionTimer();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await queue.restart();
      const state = queue.getState();
      assert.strictEqual(state.totalExecutionTime, 0);
      assert.strictEqual(state.totalPausedDuration, 0);
    });

    test("should keep prompts loaded", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await queue.restart();
      assert.strictEqual(queue.getState().steps.length, 3);
    });

    test("should reset to IDLE status", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await startQueueExecution(queue);
      await queue.restart();
      assert.strictEqual(queue.getState().status, EXECUTION_STATES.IDLE);
    });

    test("should update working file without completedPrompts after restart", async () => {
      // Create a temporary working file
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        // Skip test if no workspace (test environment limitation)
        return;
      }

      queue.loadPrompts(createPromptFile(samplePrompts));
      const workingFilePath = await queue.createWorkingFile(
        "test.ctrlyoke.json",
        samplePrompts,
        workspaceFolder.uri.fsPath
      );

      // Complete some prompts
      await startQueueExecution(queue);
      await queue.markStepAsSent(queue.getState().currentIndex);
      await queue.commitStepOutcomeAndAdvance({
        target: { kind: "queue", stepIndex: queue.getState().currentIndex },
        status: "completed",
      });

      // Verify completedIndices has entries
      assert.ok(queue.getState().completedIndices.size > 0);

      // Restart should clear completedIndices AND update working file
      await queue.restart();
      assert.strictEqual(queue.getState().completedIndices.size, 0);

      // Read working file to verify completedPrompts is not present (new format)
      const workingFile = await queue.readWorkingFile(workingFilePath);
      assert.ok(
        workingFile._runtime,
        "Working file should have _runtime section"
      );
      assert.strictEqual(
        (workingFile._runtime as any).completedPrompts,
        undefined,
        "Working file should not have completedPrompts array"
      );

      // Cleanup
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(workingFilePath));
      } catch {
        // Ignore cleanup errors
      }
    });
  });

  suite("setStartPosition()", () => {
    test("marks the prefix skipped, moves currentIndex, and persists to the draft", async () => {
      const workspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-draft-start-position-")
      );
      try {
        const draftPath = await queue.createWorkingFile(
          "start-position-workflow",
          samplePrompts,
          workspace
        );
        queue.loadPrompts(createPromptFile(samplePrompts), draftPath);

        await queue.setStartPosition(2);

        const state = queue.getState();
        assert.strictEqual(state.currentIndex, 2);
        assert.deepStrictEqual(
          state.results.map((result) => result.status),
          [STEP_STATUS.SKIPPED, STEP_STATUS.SKIPPED, STEP_STATUS.PENDING]
        );
        assert.deepStrictEqual([...state.completedIndices], ["0", "1"]);
        assert.strictEqual(state.steps[2]._runtime?.terminalStatus, undefined);

        const draft = (await queue.readWorkingFile(draftPath)) as WorkingFile;
        assert.strictEqual(draft._runtime?.currentIndex, 2);
        assert.strictEqual(
          draft.steps?.[0]._runtime?.terminalStatus,
          PROMPT_TERMINAL_STATUS.SKIPPED
        );
        assert.strictEqual(
          draft.steps?.[1]._runtime?.terminalStatus,
          PROMPT_TERMINAL_STATUS.SKIPPED
        );
        assert.strictEqual(
          draft.steps?.[2]._runtime?.terminalStatus,
          undefined
        );
        // A start position is runtime, not definition: the revision the client
        // echoes back on its next edit must not move.
        assert.strictEqual(draft.definitionRevision, 1);
      } finally {
        await fs.rm(workspace, { recursive: true, force: true });
      }
    });

    test("returns to a pristine draft when the position moves back to the first step", async () => {
      const workspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-draft-start-position-reset-")
      );
      try {
        const draftPath = await queue.createWorkingFile(
          "start-position-reset-workflow",
          samplePrompts,
          workspace
        );
        queue.loadPrompts(createPromptFile(samplePrompts), draftPath);

        await queue.setStartPosition(2);
        await queue.setStartPosition(0);

        const state = queue.getState();
        assert.strictEqual(state.currentIndex, 0);
        assert.deepStrictEqual(
          state.results.map((result) => result.status),
          [STEP_STATUS.PENDING, STEP_STATUS.PENDING, STEP_STATUS.PENDING]
        );
        assert.strictEqual(state.completedIndices.size, 0);

        const draft = (await queue.readWorkingFile(draftPath)) as WorkingFile;
        assert.strictEqual(draft._runtime?.currentIndex, 0);
        draft.steps?.forEach((step) => {
          assert.strictEqual(step._runtime?.terminalStatus, undefined);
          assert.strictEqual(step._runtime?.completedAt, undefined);
        });
      } finally {
        await fs.rm(workspace, { recursive: true, force: true });
      }
    });

    test("snaps a position inside a parallel group to the group's first member", async () => {
      queue.loadPrompts({
        steps: [
          { prompt: "before" },
          { prompt: "member-a" },
          { prompt: "member-b" },
          { prompt: "after" },
        ],
        parallelGroups: [
          { id: "group-1", startIndex: 1, endIndex: 2, failFast: false },
        ],
      });

      await queue.setStartPosition(2);

      const state = queue.getState();
      assert.strictEqual(state.currentIndex, 1);
      assert.deepStrictEqual(
        state.results.map((result) => result.status),
        [
          STEP_STATUS.SKIPPED,
          STEP_STATUS.PENDING,
          STEP_STATUS.PENDING,
          STEP_STATUS.PENDING,
        ]
      );
    });

    test("rejects a position that leaves nothing to run", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await assert.rejects(
        () => queue.setStartPosition(samplePrompts.length),
        /Start position must leave at least one suffix step to run/
      );
    });

    test("refuses to reposition a promoted run in place", async () => {
      const workspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-promoted-start-position-")
      );
      try {
        const draftPath = await queue.createWorkingFile(
          "promoted-start-position-workflow",
          samplePrompts,
          workspace
        );
        queue.loadPrompts(createPromptFile(samplePrompts), draftPath);
        assert.ok(await queue.promoteToNewRun(workspace, Date.now()));

        await assert.rejects(
          () => queue.setStartPosition(1),
          /a promoted run rewinds instead/
        );
      } finally {
        await fs.rm(workspace, { recursive: true, force: true });
      }
    });
  });

  suite("clearQueue()", () => {
    test("should reset the execution state", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await startQueueExecution(queue);
      queue.clearQueue();
      assert.strictEqual(queue.getState().status, EXECUTION_STATES.IDLE);
    });

    test("should empty prompts array", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      queue.clearQueue();
      assert.strictEqual(queue.getState().steps.length, 0);
    });

    test("should empty results array", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      queue.clearQueue();
      assert.strictEqual(queue.getState().results.length, 0);
    });
  });

  suite("Prompt Navigation", () => {
    test("hasNext() should return true when prompts remain", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      assert.strictEqual(queue.hasNext(), true);
    });

    test("hasNext() should return false at end of queue", async () => {
      queue.loadPrompts(createPromptFile([{ prompt: "Only one" }]));
      await startQueueExecution(queue);
      await queue.markStepAsSent(queue.getState().currentIndex);
      await queue.commitStepOutcomeAndAdvance({
        target: { kind: "queue", stepIndex: queue.getState().currentIndex },
        status: "completed",
      });
      assert.strictEqual(queue.hasNext(), false);
    });

    test("hasNext() should return false when queue is empty", () => {
      assert.strictEqual(queue.hasNext(), false);
    });

    test("getCurrentPrompt() should return current prompt", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      const current = queue.getCurrentPrompt();
      assert.ok(current);
      assert.strictEqual((current as PromptStep).prompt, "First prompt");
    });

    test("getCurrentPrompt() should return null at end of queue", async () => {
      queue.loadPrompts(createPromptFile([{ prompt: "Only one" }]));
      await startQueueExecution(queue);
      await queue.markStepAsSent(queue.getState().currentIndex);
      await queue.commitStepOutcomeAndAdvance({
        target: { kind: "queue", stepIndex: queue.getState().currentIndex },
        status: "completed",
      });
      assert.strictEqual(queue.getCurrentPrompt(), null);
    });

    test("getCurrentPrompt() should return null when queue is empty", () => {
      assert.strictEqual(queue.getCurrentPrompt(), null);
    });
  });

  suite("markStepAsSent()", () => {
    test("should update result status to SENT", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await startQueueExecution(queue);
      await queue.markStepAsSent(queue.getState().currentIndex);
      const state = queue.getState();
      assert.strictEqual(state.results[0].status, STEP_STATUS.SENT);
    });

    test("should update result timestamp", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await startQueueExecution(queue);
      const before = new Date();
      await queue.markStepAsSent(queue.getState().currentIndex);
      const state = queue.getState();
      assert.ok(state.results[0].timestamp >= before);
    });

    test("should not modify if no next prompt", async () => {
      queue.loadPrompts(createPromptFile([{ prompt: "Only one" }]));
      await startQueueExecution(queue);
      await queue.markStepAsSent(queue.getState().currentIndex);
      await queue.commitStepOutcomeAndAdvance({
        target: { kind: "queue", stepIndex: queue.getState().currentIndex },
        status: "completed",
      });
      // Now at end of queue
      await queue.markStepAsSent(queue.getState().currentIndex);
      // Should not throw or cause issues
      assert.strictEqual(queue.hasNext(), false);
    });
  });

  suite("commitStepOutcomeAndAdvance()", () => {
    test("should mark result as COMPLETED", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await startQueueExecution(queue);
      await queue.markStepAsSent(queue.getState().currentIndex);
      await queue.commitStepOutcomeAndAdvance({
        target: { kind: "queue", stepIndex: queue.getState().currentIndex },
        status: "completed",
      });
      const state = queue.getState();
      assert.strictEqual(state.results[0].status, STEP_STATUS.COMPLETED);
    });

    suite("target-keyed execution primitives", () => {
      test("keeps retry counters isolated while sharing pass/fail budget per target", () => {
        queue.loadPrompts(
          createPromptFile([
            {
              prompt: "First",
              endCondition: {
                script: "check.js",
                expected: "true",
                retryPrompt: "Retry",
                maxRetries: 2,
              },
            },
            {
              prompt: "Second",
              endCondition: {
                script: "check.js",
                expected: "true",
                retryPrompt: "Retry",
                maxRetries: 2,
              },
            },
          ])
        );
        const firstTarget = { kind: "queue" as const, stepIndex: 0 };
        const secondTarget = { kind: "queue" as const, stepIndex: 1 };

        queue.incrementRetryCount(firstTarget);
        queue.incrementRetryCount(firstTarget);
        queue.incrementRetryCount(secondTarget);

        assert.strictEqual(queue.getRetryCount(firstTarget), 2);
        assert.strictEqual(queue.getRetryCount(secondTarget), 1);
        assert.strictEqual(
          queue.canRetry(queue.getState().steps[0] as PromptStep, firstTarget),
          false
        );
        assert.strictEqual(
          queue.canPassRetry(
            queue.getState().steps[0] as PromptStep,
            firstTarget
          ),
          false
        );
        assert.strictEqual(
          queue.canRetry(queue.getState().steps[1] as PromptStep, secondTarget),
          true
        );
      });

      test("joins reverse-order target completion without advancing early", async () => {
        queue.loadPrompts(
          createPromptFile([{ prompt: "First" }, { prompt: "Second" }])
        );
        const group = {
          id: "group-1",
          startIndex: 0,
          endIndex: 1,
          failFast: true,
        };

        const fakeIntegration = async (
          stepIndex: number
        ): Promise<StepExecutionOutcome> => {
          const target = { kind: "queue" as const, stepIndex };
          await new Promise<void>((resolve) =>
            setTimeout(resolve, stepIndex === 0 ? 10 : 0)
          );
          const outcome = { target, status: "completed" as const };
          await queue.persistStepOutcome(outcome);
          return outcome;
        };

        const outcomes = await Promise.all([
          fakeIntegration(0),
          fakeIntegration(1),
        ]);

        assert.strictEqual(queue.getState().currentIndex, 0);
        await queue.commitParallelGroupJoin(group, outcomes);

        const state = queue.getState();
        assert.strictEqual(state.currentIndex, 2);
        assert.deepStrictEqual(
          state.results.map((result) => result.status),
          [STEP_STATUS.COMPLETED, STEP_STATUS.COMPLETED]
        );
      });
    });

    test("should add prompt identity to completedIndices", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await startQueueExecution(queue);
      await queue.markStepAsSent(queue.getState().currentIndex);
      await queue.commitStepOutcomeAndAdvance({
        target: { kind: "queue", stepIndex: queue.getState().currentIndex },
        status: "completed",
      });
      const state = queue.getState();
      assert.ok(state.completedIndices.size > 0);
    });

    test("should increment currentIndex", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await startQueueExecution(queue);
      assert.strictEqual(queue.getState().currentIndex, 0);
      await queue.markStepAsSent(queue.getState().currentIndex);
      await queue.commitStepOutcomeAndAdvance({
        target: { kind: "queue", stepIndex: queue.getState().currentIndex },
        status: "completed",
      });
      assert.strictEqual(queue.getState().currentIndex, 1);
    });

    test("should reset retry count", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await startQueueExecution(queue);
      queue.incrementRetryCount();
      queue.incrementRetryCount();
      assert.strictEqual(queue.getCurrentRetryCount(), 2);
      await queue.markStepAsSent(queue.getState().currentIndex);
      await queue.commitStepOutcomeAndAdvance({
        target: { kind: "queue", stepIndex: queue.getState().currentIndex },
        status: "completed",
      });
      assert.strictEqual(queue.getCurrentRetryCount(), 0);
    });
  });

  suite("finalizeFailedInFlightPrompt()", () => {
    test("should mark result as FAILED", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await failCurrentPrompt(queue);
      const state = queue.getState();
      assert.strictEqual(state.results[0].status, STEP_STATUS.FAILED);
    });

    test("should set error message on result", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await failCurrentPrompt(queue, "Test error message");
      const state = queue.getState();
      assert.strictEqual(state.results[0].error, "Test error message");
    });

    test("should transition status to ERROR when runtime fails", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await failCurrentPrompt(queue);
      const state = queue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.ERROR);
    });

    test("should advance currentIndex past the failed prompt", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      assert.strictEqual(queue.getState().currentIndex, 0);
      await failCurrentPrompt(queue);
      assert.strictEqual(queue.getState().currentIndex, 1);
    });

    test("should record terminalStatus as failed on the prompt runtime", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await failCurrentPrompt(queue);
      const prompt = queue.getState().steps[0];
      assert.strictEqual(
        prompt._runtime?.terminalStatus,
        PROMPT_TERMINAL_STATUS.FAILED
      );
    });
  });

  suite("Retry Functionality", () => {
    test("incrementRetryCount() should increment counter", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      assert.strictEqual(queue.getCurrentRetryCount(), 0);
      queue.incrementRetryCount();
      assert.strictEqual(queue.getCurrentRetryCount(), 1);
    });

    test("incrementRetryCount() should update result retryCount", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      queue.incrementRetryCount();
      queue.incrementRetryCount();
      const state = queue.getState();
      assert.strictEqual(state.results[0].retryCount, 2);
    });

    test("resetRetryCount() should set counter to zero", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      queue.incrementRetryCount();
      queue.incrementRetryCount();
      queue.resetRetryCount();
      assert.strictEqual(queue.getCurrentRetryCount(), 0);
    });

    test("getCurrentRetryCount() should return current count", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      queue.incrementRetryCount();
      assert.strictEqual(queue.getCurrentRetryCount(), 1);
    });

    test("canRetry() should return false when no retryPrompt", () => {
      const prompt: PromptStep = {
        prompt: "Test",
        endCondition: { script: "test.py", expected: "true" },
      };
      queue.loadPrompts(createPromptFile([prompt]));
      assert.strictEqual(queue.canRetry(prompt), false);
    });

    test("canRetry() should return true when retries remain", () => {
      const prompt: PromptStep = {
        prompt: "Test",
        endCondition: {
          script: "test.py",
          expected: "true",
          maxRetries: 3,
          retryPrompt: "Try again",
        },
      };
      queue.loadPrompts(createPromptFile([prompt]));
      assert.strictEqual(queue.canRetry(prompt), true);
    });

    test("canRetry() should return false when maxRetries exhausted", () => {
      const prompt: PromptStep = {
        prompt: "Test",
        endCondition: {
          script: "test.py",
          expected: "true",
          maxRetries: 2,
          retryPrompt: "Try again",
        },
      };
      queue.loadPrompts(createPromptFile([prompt]));
      queue.incrementRetryCount();
      queue.incrementRetryCount();
      assert.strictEqual(queue.canRetry(prompt), false);
    });

    test("canRetry() should always return true for unlimited retries (-1)", () => {
      const prompt: PromptStep = {
        prompt: "Test",
        endCondition: {
          script: "test.py",
          expected: "true",
          maxRetries: -1,
          retryPrompt: "Try again",
        },
      };
      queue.loadPrompts(createPromptFile([prompt]));
      // Increment many times
      for (let i = 0; i < 100; i++) {
        queue.incrementRetryCount();
      }
      assert.strictEqual(queue.canRetry(prompt), true);
    });

    test("canPassRetry() should not require a pass retry prompt", () => {
      const prompt: PromptStep = {
        prompt: "Test",
        endCondition: {
          script: "test.py",
          expected: "true",
          maxRetries: 1,
          onPass: "retry",
        },
      };
      queue.loadPrompts(createPromptFile([prompt]));
      assert.strictEqual(queue.canPassRetry(prompt), true);
    });

    test("canPassRetry() should be bounded by the shared retry counter", () => {
      const prompt: PromptStep = {
        prompt: "Test",
        endCondition: {
          script: "test.py",
          expected: "true",
          maxRetries: 2,
          onPass: "retry",
        },
      };
      queue.loadPrompts(createPromptFile([prompt]));
      queue.incrementRetryCount();
      queue.incrementRetryCount();
      assert.strictEqual(queue.canPassRetry(prompt), false);
    });

    test("getEffectivePassRetryPrompt() should prefer the explicit template", () => {
      const prompt: PromptStep = {
        prompt: "Test",
        endCondition: {
          script: "test.py",
          expected: "true",
          passRetryPrompt: "Explicit",
        },
      };
      queue.loadPrompts(createPromptFile([prompt]));
      assert.strictEqual(queue.getEffectivePassRetryPrompt(prompt), "Explicit");
    });

    test("getEffectivePassRetryPrompt() should use the settings default", () => {
      const original = ConfigurationUtils.getDefaultPassRetryPrompt;
      ConfigurationUtils.getDefaultPassRetryPrompt = () => "From settings";
      try {
        const prompt: PromptStep = {
          prompt: "Test",
          endCondition: { script: "test.py", expected: "true" },
        };
        queue.loadPrompts(createPromptFile([prompt]));
        assert.strictEqual(
          queue.getEffectivePassRetryPrompt(prompt),
          "From settings"
        );
      } finally {
        ConfigurationUtils.getDefaultPassRetryPrompt = original;
      }
    });
  });

  suite("Progress Tracking", () => {
    test("getProgress() should return correct total", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      const progress = queue.getProgress();
      assert.strictEqual(progress.total, 3);
    });

    test("getProgress() should return correct current", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await startQueueExecution(queue);
      await queue.markStepAsSent(queue.getState().currentIndex);
      await queue.commitStepOutcomeAndAdvance({
        target: { kind: "queue", stepIndex: queue.getState().currentIndex },
        status: "completed",
      });
      const progress = queue.getProgress();
      assert.strictEqual(progress.current, 1);
    });

    test("getProgress() should calculate percentage correctly", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await startQueueExecution(queue);
      await queue.markStepAsSent(queue.getState().currentIndex);
      await queue.commitStepOutcomeAndAdvance({
        target: { kind: "queue", stepIndex: queue.getState().currentIndex },
        status: "completed",
      });
      const progress = queue.getProgress();
      assert.strictEqual(progress.percentage, 33); // 1/3 = 33%
    });

    test("getProgress() should handle empty queue", () => {
      const progress = queue.getProgress();
      assert.strictEqual(progress.total, 0);
      assert.strictEqual(progress.current, 0);
      assert.strictEqual(progress.percentage, 0);
    });

    test("getCompletedCount() should count completed prompts", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await startQueueExecution(queue);
      await queue.markStepAsSent(queue.getState().currentIndex);
      await queue.commitStepOutcomeAndAdvance({
        target: { kind: "queue", stepIndex: queue.getState().currentIndex },
        status: "completed",
      });
      assert.strictEqual(queue.getCompletedCount(), 1);
    });

    test("getState() should expose the failed prompt count", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await failCurrentPrompt(queue, "Error");
      assert.strictEqual(
        queue
          .getState()
          .results.filter((result) => result.status === STEP_STATUS.FAILED)
          .length,
        1
      );
    });
  });

  suite("Execution Time Tracking", () => {
    test("startExecutionTimer() should set startTime", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      queue.getRuntimeStateMachine().startExecutionTimer();
      const state = queue.getState();
      assert.ok(state.startTime);
      assert.ok(state.startTime > 0);
    });

    test("getActiveExecutionTime() should return elapsed time", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      queue.getRuntimeStateMachine().startExecutionTimer();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const elapsed = queue.getRuntimeStateMachine().getActiveExecutionTime();
      assert.ok(elapsed >= 50);
    });

    test("getActiveExecutionTime() should exclude paused duration", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      queue.getRuntimeStateMachine().startExecutionTimer();
      await startQueueExecution(queue);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await pauseQueueExecution(queue);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await resumeQueueExecution(queue);
      await new Promise((resolve) => setTimeout(resolve, 20));

      const active = queue.getRuntimeStateMachine().getActiveExecutionTime();
      // Should be roughly 40ms (20 + 20), not 140ms (20 + 100 + 20)
      assert.ok(active < 100, `Expected < 100ms but got ${active}ms`);
    });

    test("getActiveExecutionTime() should return 0 if not started", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      assert.strictEqual(
        queue.getRuntimeStateMachine().getActiveExecutionTime(),
        0
      );
    });
  });

  suite("Event Emission", () => {
    test("should emit state change on loadPrompts", (done) => {
      const disposable = queue.onDidChangeState((state) => {
        assert.strictEqual(state.steps.length, 3);
        disposable.dispose();
        done();
      });
      queue.loadPrompts(createPromptFile(samplePrompts));
    });

    test("should emit state change on start", (done) => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      const disposable = queue.onDidChangeState((state) => {
        if (state.status === EXECUTION_STATES.RUNNING) {
          disposable.dispose();
          done();
        }
      });
      void startQueueExecution(queue);
    });

    test("should emit state change on pause", (done) => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      void startQueueExecution(queue).then(() => {
        const disposable = queue.onDidChangeState((state) => {
          if (state.status === EXECUTION_STATES.PAUSED) {
            disposable.dispose();
            done();
          }
        });
        void pauseQueueExecution(queue);
      });
    });

    test("should emit state change on resume", (done) => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      void startQueueExecution(queue).then(() => {
        void pauseQueueExecution(queue);
        // Wait a tick for pause event to fire
        setTimeout(() => {
          const disposable = queue.onDidChangeState((state) => {
            if (state.status === EXECUTION_STATES.RUNNING) {
              disposable.dispose();
              done();
            }
          });
          void resumeQueueExecution(queue);
        }, 10);
      });
    });

    test("should emit state change on stop", (done) => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      void startQueueExecution(queue).then(() => {
        const disposable = queue.onDidChangeState((state) => {
          if (state.status === EXECUTION_STATES.CANCELLING && state.stopped) {
            disposable.dispose();
            done();
          }
        });
        void requestQueueStop(queue);
      });
    });
  });

  suite("Queue Extension Stats", () => {
    test("getState() should expose queue extension statistics", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      const stats = queue.getState();
      assert.strictEqual(stats.queueExtensions, 0);
      assert.strictEqual(stats.steps.length, 3);
      assert.strictEqual(stats.lastReloadTime, undefined);
    });
  });

  suite("Runtime completion/error projection", () => {
    test("markQueueCompleted() should set status to COMPLETED", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await markQueueCompleted(queue);
      assert.strictEqual(queue.getState().status, EXECUTION_STATES.COMPLETED);
    });

    test("markQueueErrored() should set status to ERROR", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await markQueueErrored(queue);
      assert.strictEqual(queue.getState().status, EXECUTION_STATES.ERROR);
    });

    test("appendSteps() should not reopen a completed workflow on its own", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await markQueueCompleted(queue);

      await queue.appendSteps([{ prompt: "follow-up" }], "test");

      assert.strictEqual(
        queue.getRuntimeStateMachine().status,
        EXECUTION_STATES.COMPLETED
      );
      assert.strictEqual(queue.getState().status, EXECUTION_STATES.COMPLETED);
    });
  });

  suite("insertStepAfterIndex", () => {
    test("assigns fresh IDs to inserted and appended steps", async () => {
      queue.loadPrompts(createPromptFile([{ prompt: "original" }]));
      const originalId = queue.getState().steps[0]._runtime?.stepId;

      await queue.insertStepAfterIndex(0, { prompt: "inserted" });
      await queue.appendSteps([{ prompt: "appended" }], "test");

      const ids = queue.getState().steps.map((step) => step._runtime?.stepId);
      assert.ok(ids.every((id): id is string => id !== undefined));
      assert.strictEqual(new Set(ids).size, ids.length);
      assert.strictEqual(ids[0], originalId);
    });

    test("should shift currentIndex and completedIndices when inserting before the current prompt", async () => {
      const steps: PromptStep[] = [
        { prompt: "p0" },
        { prompt: "p1" },
        { prompt: "p2" },
        { prompt: "p3" },
      ];
      queue.loadPrompts(createPromptFile(steps));
      (queue as any).state.currentIndex = 2;
      (queue as any).state.completedIndices = new Set(["0", "1"]);
      (queue as any).state.results[0].status = STEP_STATUS.COMPLETED;
      (queue as any).state.results[1].status = STEP_STATUS.COMPLETED;

      await queue.insertStepAfterIndex(0, {
        name: "inserted",
        prompt: "inserted prompt",
        enabled: false,
        model: "gpt-5.4",
      });

      const state = queue.getState();
      assert.deepStrictEqual(
        state.steps.map((step) => (step as PromptStep).prompt),
        ["p0", "inserted prompt", "p1", "p2", "p3"]
      );
      const { _runtime: insertedRuntime, ...insertedStep } = state.steps[1];
      assert.deepStrictEqual(insertedStep, {
        name: "inserted",
        prompt: "inserted prompt",
        enabled: false,
        model: "gpt-5.4",
      });
      assert.ok(insertedRuntime?.stepId);
      assert.strictEqual(state.currentIndex, 3);
      assert.deepStrictEqual([...state.completedIndices].sort(), ["0", "2"]);
      assert.strictEqual(state.results[1].prompt, "inserted prompt");
      assert.strictEqual(state.results[1].status, STEP_STATUS.PENDING);
    });

    test("should preserve script-step shape and leave currentIndex unchanged when inserting after pending work", async () => {
      const steps: PromptStep[] = [
        { prompt: "p0" },
        { prompt: "p1" },
        { prompt: "p2" },
      ];
      queue.loadPrompts(createPromptFile(steps));
      (queue as any).state.currentIndex = 1;
      (queue as any).state.completedIndices = new Set(["0"]);
      (queue as any).state.results[0].status = STEP_STATUS.COMPLETED;

      await queue.insertStepAfterIndex(2, {
        type: STEP_TYPES.SCRIPT,
        name: "inserted script",
        script: "npm test",
        enabled: true,
        timeoutSec: 0.03,
        onPass: CONDITION_ACTIONS.CONTINUE,
        onFail: CONDITION_ACTIONS.STOP_WORKFLOW,
      } as any);

      const state = queue.getState();
      assert.strictEqual(state.currentIndex, 1);
      const { _runtime: insertedRuntime, ...insertedStep } = state.steps[3];
      assert.deepStrictEqual(insertedStep, {
        type: STEP_TYPES.SCRIPT,
        name: "inserted script",
        script: "npm test",
        enabled: true,
        timeoutSec: 0.03,
        onPass: CONDITION_ACTIONS.CONTINUE,
        onFail: CONDITION_ACTIONS.STOP_WORKFLOW,
      });
      assert.ok(insertedRuntime?.stepId);
      assert.strictEqual(state.results[3].prompt, "npm test");
      assert.strictEqual(state.results[3].status, STEP_STATUS.PENDING);
    });
  });

  suite("pending rewind", () => {
    test("preserves the prefix and permits definition edits only in the rewound suffix", async () => {
      queue.loadPrompts(
        createPromptFile([
          {
            prompt: "prefix",
            _runtime: {
              startedAt: 1,
              completedAt: 2,
              sessionId: "prefix-session",
            },
          },
          {
            prompt: "suffix",
            _runtime: {
              startedAt: 3,
              completedAt: 4,
              sessionId: "suffix-session",
            },
          },
        ])
      );
      (queue as any).state.results[0].status = STEP_STATUS.COMPLETED;
      (queue as any).state.results[1].status = STEP_STATUS.COMPLETED;

      queue.applyPendingRewind(1, 4, 5, false);

      assert.strictEqual(queue.getState().currentIndex, 1);
      assert.strictEqual(queue.getState().definitionRevision, 5);
      assert.deepStrictEqual(queue.getState().pendingRewind, {
        fromStepIndex: 1,
        baseDefinitionRevision: 4,
      });
      assert.strictEqual(
        queue.getState().steps[0]._runtime?.sessionId,
        "prefix-session"
      );
      assert.ok(queue.getState().steps[1]._runtime?.stepId);
      assert.strictEqual(
        Object.keys(queue.getState().steps[1]._runtime ?? {}).length,
        1,
        "rewound suffix runtime must retain only step identity"
      );
      assert.strictEqual(
        queue.getState().results[1].status,
        STEP_STATUS.PENDING
      );

      await assert.rejects(
        () => queue.updatePrompt(0, { prompt: "edited prefix" }),
        /preserved prefix/i
      );
      await queue.updatePrompt(1, { prompt: "edited suffix" });
      assert.strictEqual(
        (queue.getState().steps[1] as PromptStep).prompt,
        "edited suffix"
      );
      await assert.rejects(
        () => queue.updateWorkflowName("not allowed"),
        /continuation is pending/i
      );
    });

    test("keeps PAUSED state when applying an addressed paused-run rewind", () => {
      queue.loadPrompts(
        createPromptFile([{ prompt: "prefix" }, { prompt: "suffix" }])
      );
      queue.getRuntimeStateMachine().restore({
        status: EXECUTION_STATES.PAUSED,
        stopped: false,
        totalPausedDuration: 0,
      });

      queue.applyPendingRewind(1, 1, 2, true);

      assert.strictEqual(queue.getState().status, EXECUTION_STATES.PAUSED);
      assert.strictEqual(queue.getState().currentIndex, 1);
    });
  });

  suite("reorderPendingPrompts", () => {
    test("should keep done-prefix unchanged and reorder pending section", async () => {
      const steps: PromptStep[] = [
        { prompt: "p0" },
        { prompt: "p1" },
        { prompt: "p2" },
        { prompt: "p3" },
        { prompt: "p4" },
      ];
      queue.loadPrompts(createPromptFile(steps));
      (queue as any).state.currentIndex = 2;

      // Pending slice is [p2, p3, p4] at slice positions [0, 1, 2].
      // Move slice[2]=p4 to front: [2, 0, 1]
      await queue.reorderPendingPrompts([2, 0, 1]);

      const state = queue.getState();
      assert.strictEqual((state.steps[0] as PromptStep).prompt, "p0");
      assert.strictEqual((state.steps[1] as PromptStep).prompt, "p1");
      assert.strictEqual((state.steps[2] as PromptStep).prompt, "p4");
      assert.strictEqual((state.steps[3] as PromptStep).prompt, "p2");
      assert.strictEqual((state.steps[4] as PromptStep).prompt, "p3");
    });

    test("should reorder results in sync with prompts", async () => {
      const steps: PromptStep[] = [
        { prompt: "p0" },
        { prompt: "p1" },
        { prompt: "p2" },
        { prompt: "p3" },
        { prompt: "p4" },
      ];
      queue.loadPrompts(createPromptFile(steps));
      (queue as any).state.currentIndex = 2;

      // Pending slice is [p2, p3, p4] at slice positions [0, 1, 2].
      // Move slice[2]=p4 to front: [2, 0, 1]
      await queue.reorderPendingPrompts([2, 0, 1]);

      const state = queue.getState();
      assert.strictEqual(state.results[0].prompt, "p0");
      assert.strictEqual(state.results[1].prompt, "p1");
      assert.strictEqual(state.results[2].prompt, "p4");
      assert.strictEqual(state.results[3].prompt, "p2");
      assert.strictEqual(state.results[4].prompt, "p3");
    });

    test("should produce correct order after successive reorders", async () => {
      const steps: PromptStep[] = [
        { prompt: "p0" },
        { prompt: "p1" },
        { prompt: "p2" },
      ];
      queue.loadPrompts(createPromptFile(steps));
      (queue as any).state.currentIndex = 0;

      // First reorder: move p0 to last → [1, 2, 0]
      await queue.reorderPendingPrompts([1, 2, 0]);
      let state = queue.getState();
      assert.strictEqual((state.steps[0] as PromptStep).prompt, "p1");
      assert.strictEqual((state.steps[1] as PromptStep).prompt, "p2");
      assert.strictEqual((state.steps[2] as PromptStep).prompt, "p0");

      // Second reorder: move the new first (p1) to last → [1, 2, 0]
      // Current pending slice: [p1, p2, p0]; move slice[0]=p1 to end
      await queue.reorderPendingPrompts([1, 2, 0]);
      state = queue.getState();
      assert.strictEqual((state.steps[0] as PromptStep).prompt, "p2");
      assert.strictEqual((state.steps[1] as PromptStep).prompt, "p0");
      assert.strictEqual((state.steps[2] as PromptStep).prompt, "p1");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("Editing during execution — pending region only", () => {
    const fiveSteps: PromptStep[] = [
      { prompt: "s0" },
      { prompt: "s1" },
      { prompt: "s2" },
      { prompt: "s3" },
      { prompt: "s4" },
    ];

    // Loads five steps, enters RUNNING, then places execution at step 1 so that
    // step 0 is completed, step 1 is the running step, and steps 2–4 are pending.
    async function runningAtStepOne(q: PromptQueue): Promise<void> {
      q.loadPrompts(createPromptFile(fiveSteps));
      await startQueueExecution(q);
      (q as any).state.currentIndex = 1;
      assert.strictEqual(q.getState().status, EXECUTION_STATES.RUNNING);
    }

    test("reorder keeps the running step pinned and reorders the tail", async () => {
      await runningAtStepOne(queue);
      // Pending slice is [s1, s2, s3, s4]; keep s1 first, move s4 ahead of s2/s3.
      await queue.reorderPendingPrompts([0, 3, 1, 2]);
      const steps = queue.getState().steps as PromptStep[];
      assert.deepStrictEqual(
        steps.map((s) => s.prompt),
        ["s0", "s1", "s4", "s2", "s3"]
      );
    });

    test("reorder rejects moving the running step out of position 0", async () => {
      await runningAtStepOne(queue);
      await assert.rejects(
        () => queue.reorderPendingPrompts([1, 0, 2, 3]),
        /currently executing step/i
      );
    });

    test("delete rejects the running step and completed steps, allows pending", async () => {
      await runningAtStepOne(queue);
      await assert.rejects(
        () => queue.deletePrompt(1),
        /currently executing step/i
      );
      await assert.rejects(
        () => queue.deletePrompt(0),
        /completed step while the workflow is running/i
      );
      await queue.deletePrompt(3);
      const steps = queue.getState().steps as PromptStep[];
      assert.deepStrictEqual(
        steps.map((s) => s.prompt),
        ["s0", "s1", "s2", "s4"]
      );
    });

    test("update rejects the running/completed steps, allows a pending step", async () => {
      await runningAtStepOne(queue);
      await assert.rejects(
        () => queue.updatePrompt(1, { prompt: "edited running" }),
        /currently executing step/i
      );
      await assert.rejects(
        () => queue.updatePrompt(0, { prompt: "edited completed" }),
        /completed step while the workflow is running/i
      );
      await queue.updatePrompt(3, { prompt: "edited pending" });
      assert.strictEqual(
        (queue.getState().steps[3] as PromptStep).prompt,
        "edited pending"
      );
    });

    test("insert must land after the running step", async () => {
      await runningAtStepOne(queue);
      // afterIndex 0 → insertIndex 1 (the running step slot) → rejected.
      await assert.rejects(
        () => queue.insertStepAfterIndex(0, { prompt: "nope" }),
        /currently executing step/i
      );
      // afterIndex 1 → insertIndex 2 (right after the running step) → allowed.
      await queue.insertStepAfterIndex(1, { prompt: "inserted" });
      const steps = queue.getState().steps as PromptStep[];
      assert.deepStrictEqual(
        steps.map((s) => s.prompt),
        ["s0", "s1", "inserted", "s2", "s3", "s4"]
      );
    });

    // A pause is only ever confirmed at a step boundary, so PAUSED leaves
    // `currentIndex` pointing at the next PENDING step — editing that step is
    // the whole point of pausing and must be allowed.
    async function pausedAtStepTwo(q: PromptQueue): Promise<void> {
      q.loadPrompts(createPromptFile(fiveSteps));
      await startQueueExecution(q);
      (q as any).state.currentIndex = 2;
      await pauseQueueExecution(q);
      assert.strictEqual(q.getState().status, EXECUTION_STATES.PAUSED);
    }

    test("paused allows editing the next step to run", async () => {
      await pausedAtStepTwo(queue);
      await queue.updatePrompt(2, { prompt: "edited next" });
      assert.strictEqual(
        (queue.getState().steps[2] as PromptStep).prompt,
        "edited next"
      );
    });

    test("paused still rejects editing a completed step", async () => {
      await pausedAtStepTwo(queue);
      await assert.rejects(
        () => queue.updatePrompt(1, { prompt: "edited completed" }),
        /completed step while the workflow is running/i
      );
    });

    test("paused allows deleting the next step to run", async () => {
      await pausedAtStepTwo(queue);
      await queue.deletePrompt(2);
      const state = queue.getState();
      assert.deepStrictEqual(
        (state.steps as PromptStep[]).map((s) => s.prompt),
        ["s0", "s1", "s3", "s4"]
      );
      assert.strictEqual(state.currentIndex, 2);
    });

    test("paused insert before the next step runs the inserted step next", async () => {
      await pausedAtStepTwo(queue);
      // afterIndex 1 → insertIndex 2, the paused boundary itself.
      await queue.insertStepAfterIndex(1, { prompt: "inserted" });
      const state = queue.getState();
      assert.deepStrictEqual(
        (state.steps as PromptStep[]).map((s) => s.prompt),
        ["s0", "s1", "inserted", "s2", "s3", "s4"]
      );
      // currentIndex must not shift past the new step, or it would be skipped.
      assert.strictEqual(state.currentIndex, 2);
    });

    test("paused allows reordering the next step out of position 0", async () => {
      await pausedAtStepTwo(queue);
      // Pending slice is [s2, s3, s4]; move s2 to the end.
      await queue.reorderPendingPrompts([1, 2, 0]);
      assert.deepStrictEqual(
        (queue.getState().steps as PromptStep[]).map((s) => s.prompt),
        ["s0", "s1", "s3", "s4", "s2"]
      );
    });

    test("idle editing is unrestricted (completed/current steps remain editable)", async () => {
      queue.loadPrompts(createPromptFile(fiveSteps));
      (queue as any).state.currentIndex = 2;
      // IDLE: nothing is executing, so any step may be edited/deleted.
      await queue.updatePrompt(0, { prompt: "edited idle" });
      await queue.deletePrompt(1);
      const steps = queue.getState().steps as PromptStep[];
      assert.strictEqual((steps[0] as PromptStep).prompt, "edited idle");
      assert.strictEqual(steps.length, 4);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("mergeDiskSteps — session ID preservation", () => {
    test("should preserve in-memory _runtime.sessionId when MCP appends a new prompt", () => {
      // Simulate: prompt[0] ran, session ID set in memory but not yet persisted to disk
      queue.loadPrompts(createPromptFile([{ prompt: "prompt-0" }]));
      const originalStepId = queue.getState().steps[0]._runtime?.stepId;
      (queue as any).state.steps[0]._runtime = {
        stepId: originalStepId,
        harness: "copilot-cli",
        model: "claude-sonnet-4.5",
        sessionId: "b52bceab-9c03-49b3-8324-4220292e9acb",
        startedAt: 1000,
        completedAt: 2000,
      };

      // Disk has the completed boundary and a new MCP prompt, but its session
      // metadata has not been flushed yet.
      const diskPrompts: PromptStep[] = [
        {
          prompt: "prompt-0",
          _runtime: { startedAt: 1000, completedAt: 2000 },
        },
        { prompt: "prompt-1-mcp" }, // new from MCP
      ];

      (queue as any).mergeDiskSteps(diskPrompts);

      const state = queue.getState();
      assert.strictEqual(
        state.steps.length,
        2,
        "should have 2 prompts after merge"
      );
      assert.strictEqual(
        state.steps[0]._runtime?.sessionId,
        "b52bceab-9c03-49b3-8324-4220292e9acb",
        "session ID must be preserved from memory, not lost to disk replacement"
      );
      assert.strictEqual(
        state.steps[0]._runtime?.stepId,
        originalStepId,
        "the index fallback must backfill an older disk snapshot without changing identity"
      );
      assert.deepStrictEqual(Object.keys(state.steps[1]._runtime ?? {}), [
        "stepId",
      ]);
    });

    test("should adopt persisted enabled changes while preserving in-memory runtime", () => {
      queue.loadPrompts(
        createPromptFile([{ prompt: "prompt-0", enabled: true }])
      );
      const stepId = queue.getState().steps[0]._runtime?.stepId;
      (queue as any).state.steps[0]._runtime = {
        stepId,
        sessionId: "s0",
        startedAt: 1000,
        completedAt: 2000,
      };

      (queue as any).mergeDiskSteps([
        {
          prompt: "prompt-0",
          enabled: false,
          _runtime: { startedAt: 1000, completedAt: 2000 },
        },
        { prompt: "prompt-1-mcp" },
      ]);

      const state = queue.getState();
      assert.strictEqual(state.steps[0].enabled, false);
      assert.strictEqual(state.steps[0]._runtime?.sessionId, "s0");
      assert.strictEqual((state.steps[1] as PromptStep).prompt, "prompt-1-mcp");
    });

    test("should merge an appended duplicate prompt and keep runtime by index", () => {
      queue.loadPrompts(
        createPromptFile([{ prompt: "repeat" }, { prompt: "repeat" }])
      );
      (queue as any).state.steps[0]._runtime = {
        sessionId: "first-session",
        startedAt: 1000,
        completedAt: 2000,
      };
      (queue as any).state.steps[1]._runtime = {
        sessionId: "second-session",
        startedAt: 3000,
        completedAt: 4000,
      };

      const mergedCount = (queue as any).mergeDiskSteps([
        { prompt: "repeat", _runtime: { startedAt: 10, completedAt: 20 } },
        { prompt: "repeat", _runtime: { startedAt: 30, completedAt: 40 } },
        { prompt: "repeat" },
      ]);

      const state = queue.getState();
      assert.strictEqual(mergedCount.length, 1);
      assert.deepStrictEqual(
        state.steps.map((step) => (step as PromptStep).prompt),
        ["repeat", "repeat", "repeat"]
      );
      assert.strictEqual(state.steps[0]._runtime?.sessionId, "first-session");
      assert.strictEqual(
        state.steps[0]._runtime?.completedAt,
        2000,
        "runtime must stay attached to the first index"
      );
      assert.strictEqual(
        state.steps[1]._runtime?.sessionId,
        "second-session",
        "identical prompts must not share a session ID"
      );
      assert.strictEqual(state.steps[1]._runtime?.completedAt, 4000);
      assert.deepStrictEqual(Object.keys(state.steps[2]._runtime ?? {}), [
        "stepId",
      ]);
      assert.strictEqual(state.results.length, 3);
    });

    test("keeps every started group member keyed by stepId across pending changes", () => {
      queue.loadPrompts(
        createPromptFile(
          [
            { prompt: "member-0" },
            { prompt: "member-1" },
            { prompt: "pending" },
          ],
          [{ id: "group", startIndex: 0, endIndex: 1, failFast: true }]
        )
      );
      const initial = queue.getState();
      const [member0Id, member1Id, pendingId] = initial.steps.map(
        (step) => step._runtime?.stepId
      );
      assert.ok(member0Id && member1Id && pendingId);

      (queue as any).state.steps[0]._runtime = {
        stepId: member0Id,
        sessionId: "member-0-session",
        startedAt: 10,
      };
      (queue as any).state.steps[1]._runtime = {
        stepId: member1Id,
        sessionId: "member-1-session",
        startedAt: 11,
      };
      (queue as any).state.results[0] = {
        prompt: "member-0",
        status: STEP_STATUS.RUNNING,
        timestamp: new Date(),
        preCondition: { passed: true, stdout: "gate-0" },
      };
      (queue as any).state.results[1] = {
        prompt: "member-1",
        status: STEP_STATUS.RUNNING,
        timestamp: new Date(),
        endCondition: { passed: true, stdout: "gate-1" },
      };

      const insertedId = "inserted-pending-id";
      (queue as any).mergeDiskSteps([
        { prompt: "member-0", _runtime: { stepId: member0Id } },
        { prompt: "member-1", _runtime: { stepId: member1Id } },
        { prompt: "inserted", _runtime: { stepId: insertedId } },
        { prompt: "pending", _runtime: { stepId: pendingId } },
      ]);

      let state = queue.getState();
      assert.strictEqual(
        state.steps[0]._runtime?.sessionId,
        "member-0-session"
      );
      assert.strictEqual(
        state.steps[1]._runtime?.sessionId,
        "member-1-session"
      );
      assert.strictEqual(state.results[0].preCondition?.stdout, "gate-0");
      assert.strictEqual(state.results[1].endCondition?.stdout, "gate-1");
      assert.strictEqual(state.steps[2]._runtime?.stepId, insertedId);

      (queue as any).mergeDiskSteps([
        { prompt: "member-0", _runtime: { stepId: member0Id } },
        { prompt: "member-1", _runtime: { stepId: member1Id } },
        { prompt: "inserted", _runtime: { stepId: insertedId } },
      ]);

      state = queue.getState();
      assert.strictEqual(state.steps.length, 3);
      assert.strictEqual(
        state.steps[0]._runtime?.sessionId,
        "member-0-session"
      );
      assert.strictEqual(
        state.steps[1]._runtime?.sessionId,
        "member-1-session"
      );
      assert.strictEqual(state.results[0].preCondition?.stdout, "gate-0");
      assert.strictEqual(state.results[1].endCondition?.stdout, "gate-1");
    });

    test("does not alias duplicate prompt text when disk order changes by ID", () => {
      queue.loadPrompts(
        createPromptFile([{ prompt: "repeat" }, { prompt: "repeat" }])
      );
      const [firstId, secondId] = queue
        .getState()
        .steps.map((step) => step._runtime?.stepId);
      assert.ok(firstId && secondId);
      (queue as any).state.steps[0]._runtime = {
        stepId: firstId,
        sessionId: "first-session",
        startedAt: 10,
      };
      (queue as any).state.steps[1]._runtime = {
        stepId: secondId,
        sessionId: "second-session",
        startedAt: 11,
      };

      (queue as any).mergeDiskSteps([
        { prompt: "repeat", _runtime: { stepId: secondId } },
        { prompt: "repeat", _runtime: { stepId: firstId } },
      ]);

      const state = queue.getState();
      assert.strictEqual(state.steps[0]._runtime?.sessionId, "second-session");
      assert.strictEqual(state.steps[1]._runtime?.sessionId, "first-session");
    });

    test("should use the shorter disk/memory immutable boundary", () => {
      queue.loadPrompts(
        createPromptFile([
          { prompt: "completed", _runtime: { startedAt: 1, completedAt: 2 } },
          { prompt: "shifted" },
        ])
      );
      (queue as any).state.steps[0]._runtime = {
        sessionId: "completed-session",
        completedAt: 2,
      };
      (queue as any).state.steps[1]._runtime = {
        sessionId: "memory-only-session",
        completedAt: 4,
      };

      (queue as any).mergeDiskSteps([
        { prompt: "completed", _runtime: { startedAt: 1, completedAt: 2 } },
        { prompt: "inserted" },
        { prompt: "shifted" },
      ]);

      const state = queue.getState();
      assert.strictEqual(
        state.steps[0]._runtime?.sessionId,
        "completed-session"
      );
      assert.ok(
        state.steps[2]._runtime?.stepId,
        "a disk-spliced step receives its own identity"
      );
      assert.strictEqual(
        Object.keys(state.steps[2]._runtime ?? {}).length,
        1,
        "a disk-spliced step must not inherit execution runtime from a shifted index"
      );
    });

    test("preserves the running step's runtime and condition summaries", () => {
      queue.loadPrompts(
        createPromptFile([{ prompt: "first" }, { prompt: "second" }])
      );
      (queue as any).state.steps[0]._runtime = {
        sessionId: "first-session",
        startedAt: 1,
        completedAt: 2,
      };
      // The running step: started, not completed, so it sits past the completed
      // boundary — and disk has not seen its session or gate output yet.
      (queue as any).state.steps[1]._runtime = {
        sessionId: "running-session",
        startedAt: 5,
      };
      (queue as any).state.currentIndex = 1;
      (queue as any).state.results[1] = {
        prompt: "second",
        status: STEP_STATUS.RUNNING,
        timestamp: new Date(),
        preCondition: { passed: true, stdout: "gate-output" },
      };

      const newSteps = (queue as any).mergeDiskSteps([
        { prompt: "first", _runtime: { startedAt: 1, completedAt: 2 } },
        { prompt: "second" },
        { prompt: "appended mid-run" },
      ]);

      const state = queue.getState();
      assert.strictEqual(newSteps.length, 1, "the append must be detected");
      assert.strictEqual(
        state.steps[1]._runtime?.sessionId,
        "running-session",
        "a mid-run merge must not drop the running step's session ID"
      );
      assert.strictEqual(
        (state.results[1] as { preCondition?: { stdout?: string } })
          .preCondition?.stdout,
        "gate-output",
        "condition summaries feed $preCondition substitution and must survive a merge"
      );
      assert.strictEqual(state.results[1].status, STEP_STATUS.RUNNING);
      assert.strictEqual(state.results[2].status, STEP_STATUS.PENDING);
    });

    test("mergeStepsFromDisk returns a positive count for a real append", async () => {
      const tempRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-prompt-queue-merge-")
      );
      const workingFilePath = path.join(tempRoot, "workflow.json");
      try {
        queue.loadPrompts(
          createPromptFile([{ prompt: "existing" }]),
          workingFilePath
        );
        await fs.writeFile(
          workingFilePath,
          JSON.stringify({
            steps: [{ prompt: "existing" }, { prompt: "existing" }],
          }),
          "utf8"
        );

        assert.strictEqual(await queue.mergeStepsFromDisk(), 1);
        assert.strictEqual(queue.getState().steps.length, 2);
      } finally {
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    });
  });

  // `updateWorkingFileDirect`'s merge treats disk as authoritative for step
  // order and parallel-group topology, so a local definition mutation that
  // only exists in memory must write with `skipMerge`. Without it the merge
  // rebuilds the queue from the pre-mutation disk snapshot and the write
  // silently persists the *old* definition — which is why these assertions
  // read the file back rather than only inspecting `getState()`.
  suite(
    "local definition mutations survive the disk-authoritative merge",
    () => {
      async function withWorkingFile(
        steps: PromptStep[],
        run: (queue: PromptQueue, workingFilePath: string) => Promise<void>
      ): Promise<void> {
        const tempRoot = await fs.mkdtemp(
          path.join(os.tmpdir(), "ctrlyoke-prompt-queue-persist-")
        );
        const workingFilePath = path.join(tempRoot, "workflow.json");
        try {
          const queue = new PromptQueue();
          queue.loadPrompts(createPromptFile(steps), workingFilePath);
          await fs.writeFile(
            workingFilePath,
            JSON.stringify({ steps, parallelGroups: [] }),
            "utf8"
          );
          await run(queue, workingFilePath);
        } finally {
          await fs.rm(tempRoot, { recursive: true, force: true });
        }
      }

      async function readPersisted(workingFilePath: string): Promise<{
        prompts: string[];
        parallelGroups: ParallelGroupDefinition[];
      }> {
        const raw = JSON.parse(await fs.readFile(workingFilePath, "utf8"));
        return {
          prompts: (raw.steps as PromptStep[]).map((step) => step.prompt),
          parallelGroups: raw.parallelGroups ?? [],
        };
      }

      test("reorderPendingPrompts persists the new order", async () => {
        await withWorkingFile(
          [{ prompt: "p0" }, { prompt: "p1" }, { prompt: "p2" }],
          async (queue, workingFilePath) => {
            await queue.reorderPendingPrompts([0, 2, 1]);
            const persisted = await readPersisted(workingFilePath);
            assert.deepStrictEqual(persisted.prompts, ["p0", "p2", "p1"]);
          }
        );
      });

      test("reorderPendingPrompts persists a newly created parallel group", async () => {
        await withWorkingFile(
          [{ prompt: "p0" }, { prompt: "p1" }, { prompt: "p2" }],
          async (queue, workingFilePath) => {
            await queue.reorderPendingPrompts(
              [0, 1, 2],
              [{ start: 1, end: 2, failFast: true }]
            );
            const persisted = await readPersisted(workingFilePath);
            assert.strictEqual(persisted.parallelGroups.length, 1);
            assert.strictEqual(persisted.parallelGroups[0].startIndex, 1);
            assert.strictEqual(persisted.parallelGroups[0].endIndex, 2);
            assert.strictEqual(persisted.parallelGroups[0].failFast, true);
          }
        );
      });

      test("insertStepAfterIndex persists the inserted step", async () => {
        await withWorkingFile(
          [{ prompt: "p0" }, { prompt: "p1" }],
          async (queue, workingFilePath) => {
            await queue.insertStepAfterIndex(0, { prompt: "inserted" });
            const persisted = await readPersisted(workingFilePath);
            assert.deepStrictEqual(persisted.prompts, ["p0", "inserted", "p1"]);
          }
        );
      });

      test("round-trips promoted topology and runtime through the working file", async () => {
        const tempRoot = await fs.mkdtemp(
          path.join(os.tmpdir(), "ctrlyoke-prompt-queue-promotion-")
        );
        try {
          const steps: PromptStep[] = [
            { prompt: "started", _runtime: { startedAt: 42 } },
            { prompt: "tail" },
          ];
          const workingFilePath = await queue.createWorkingFile(
            "promotion-workflow",
            steps,
            tempRoot
          );
          queue.loadPrompts({ steps }, workingFilePath);

          await queue.promoteStepToParallelGroup(0, { prompt: "sibling" });

          const persisted = await queue.readWorkingFile(workingFilePath);
          assert.strictEqual(persisted.parallelGroups?.length, 1);
          assert.strictEqual(persisted.parallelGroups?.[0].startIndex, 0);
          assert.strictEqual(persisted.parallelGroups?.[0].endIndex, 1);
          assert.strictEqual(persisted.parallelGroups?.[0].failFast, false);
          assert.strictEqual(persisted.steps?.[0]._runtime?.startedAt, 42);

          const recovered = new PromptQueue();
          await recovered.restoreFromWorkingFile(workingFilePath);
          assert.deepStrictEqual(
            recovered.getState().parallelGroups,
            persisted.parallelGroups
          );
          assert.strictEqual(
            recovered.getState().steps[0]._runtime?.startedAt,
            42
          );
        } finally {
          await fs.rm(tempRoot, { recursive: true, force: true });
        }
      });
    }
  );

  suite("syncStepsForUndoRedo", () => {
    test("does not restore archived or incoming suffix runtime during a pending rewind", async () => {
      queue.loadPrompts(
        createPromptFile([
          { prompt: "prefix", _runtime: { startedAt: 0, completedAt: 1 } },
          {
            prompt: "suffix",
            _runtime: { sessionId: "stale", startedAt: 1, completedAt: 2 },
          },
        ])
      );
      queue.applyPendingRewind(1, 1, 2, false);

      await queue.syncStepsForUndoRedo([
        { prompt: "prefix", _runtime: { startedAt: 0, completedAt: 1 } },
        {
          prompt: "suffix edited",
          _runtime: { sessionId: "stale", startedAt: 1, completedAt: 2 },
        },
      ] as any);

      const state = queue.getState();
      assert.strictEqual(state.steps[0]._runtime?.completedAt, 1);
      assert.ok(state.steps[1]._runtime?.stepId);
      assert.strictEqual(Object.keys(state.steps[1]._runtime ?? {}).length, 1);
      assert.strictEqual(state.results[1].status, STEP_STATUS.PENDING);
    });

    test("should restore runtime from a redone step and strip webview-only fields", async () => {
      queue.loadPrompts(createPromptFile([{ prompt: "p0" }]));

      await queue.syncStepsForUndoRedo([
        {
          prompt: "p0",
          status: STEP_STATUS.COMPLETED,
          _runtime: {
            sessionId: "s0",
            startedAt: 10,
            completedAt: 20,
          },
        } as any,
        {
          prompt: "p1",
          status: STEP_STATUS.COMPLETED,
          details: { ignored: true },
          _runtime: {
            sessionId: "s1",
            startedAt: 100,
            completedAt: 200,
          },
        } as any,
      ]);

      const state = queue.getState();
      assert.strictEqual(state.steps.length, 2);
      assert.strictEqual(state.currentIndex, 2);
      assert.strictEqual((state.steps[0] as any).status, undefined);
      assert.strictEqual((state.steps[1] as any).status, undefined);
      assert.strictEqual((state.steps[1] as any).details, undefined);
      assert.strictEqual(state.steps[1]._runtime?.sessionId, "s1");
      assert.strictEqual(state.results[1].status, STEP_STATUS.COMPLETED);
    });

    test("should not copy shifted runtime onto a restored deleted prompt", async () => {
      queue.loadPrompts(
        createPromptFile([
          { prompt: "p0" },
          {
            prompt: "p2",
            _runtime: {
              sessionId: "s2",
              startedAt: 300,
              completedAt: 400,
            },
          },
        ])
      );

      await queue.syncStepsForUndoRedo([
        { prompt: "p0" },
        {
          prompt: "p1",
          _runtime: {
            sessionId: "s1",
            startedAt: 100,
            completedAt: 200,
          },
        } as any,
        {
          prompt: "p2",
          _runtime: {
            sessionId: "s2",
            startedAt: 300,
            completedAt: 400,
          },
        } as any,
      ]);

      const state = queue.getState();
      assert.strictEqual(state.steps[1]._runtime?.sessionId, "s1");
      assert.strictEqual(state.steps[2]._runtime?.sessionId, "s2");
    });

    test("should restore deleted prompt runtime from the queue archive when webview snapshot lacks it", async () => {
      queue.loadPrompts(
        createPromptFile([
          {
            prompt: "p0",
            _runtime: {
              sessionId: "s0",
              startedAt: 100,
              completedAt: 200,
            },
          },
        ])
      );
      (queue as any).state.currentIndex = 1;

      await queue.deletePrompt(0);
      await queue.syncStepsForUndoRedo([{ prompt: "p0" }]);

      const state = queue.getState();
      assert.strictEqual(state.steps[0]._runtime?.sessionId, "s0");
      assert.strictEqual(state.currentIndex, 1);
      assert.strictEqual(state.results[0].status, STEP_STATUS.COMPLETED);
    });

    test("should restore shifted completed prompt runtime after undoing delete", async () => {
      queue.loadPrompts(
        createPromptFile([
          {
            prompt: "p0",
            _runtime: {
              sessionId: "s0",
              startedAt: 100,
              completedAt: 200,
            },
          },
          {
            prompt: "p1",
            _runtime: {
              sessionId: "s1",
              startedAt: 300,
              completedAt: 400,
            },
          },
        ])
      );
      (queue as any).state.currentIndex = 2;

      await queue.deletePrompt(0);
      await queue.syncStepsForUndoRedo([{ prompt: "p0" }, { prompt: "p1" }]);

      const state = queue.getState();
      assert.strictEqual(state.steps[0]._runtime?.sessionId, "s0");
      assert.strictEqual(state.steps[1]._runtime?.sessionId, "s1");
      assert.strictEqual(state.currentIndex, 2);
      assert.strictEqual(state.results[0].status, STEP_STATUS.COMPLETED);
      assert.strictEqual(state.results[1].status, STEP_STATUS.COMPLETED);
    });

    test("should restore completed added prompt runtime when redo snapshot lacks it", async () => {
      queue.loadPrompts(
        createPromptFile([
          {
            prompt: "p0",
            _runtime: {
              sessionId: "s0",
              startedAt: 100,
              completedAt: 200,
            },
          },
          {
            prompt: "added",
            _runtime: {
              sessionId: "s-added",
              startedAt: 300,
              completedAt: 400,
            },
          },
        ])
      );
      (queue as any).state.currentIndex = 2;

      await queue.syncStepsForUndoRedo([{ prompt: "p0" }]);
      await queue.syncStepsForUndoRedo([{ prompt: "p0" }, { prompt: "added" }]);

      const state = queue.getState();
      assert.strictEqual(state.steps[0]._runtime?.sessionId, "s0");
      assert.strictEqual(state.steps[1]._runtime?.sessionId, "s-added");
      assert.strictEqual(state.currentIndex, 2);
      assert.strictEqual(state.results[1].status, STEP_STATUS.COMPLETED);
    });

    test("should merge archived terminal fields and ignore history-only stats when redo snapshot has partial runtime", async () => {
      queue.loadPrompts(
        createPromptFile([
          {
            prompt: "p0",
            _runtime: {
              sessionId: "s0",
              startedAt: 100,
              completedAt: 200,
            },
          },
          {
            prompt: "added",
            _runtime: {
              sessionId: "s-added",
              startedAt: 300,
              completedAt: 400,
              elapsed: 8.7,
              contextWindowUsed: 11424,
              contextWindowSize: 200000,
            },
          },
        ])
      );
      (queue as any).state.currentIndex = 2;

      await queue.syncStepsForUndoRedo([{ prompt: "p0" }]);
      await queue.syncStepsForUndoRedo([
        { prompt: "p0" },
        {
          prompt: "added",
          status: STEP_STATUS.COMPLETED,
          _runtime: {
            sessionId: "s-added",
            elapsed: 9.1,
            contextWindowUsed: 12000,
            contextWindowSize: 200000,
          },
        } as any,
      ]);

      const state = queue.getState();
      assert.strictEqual(state.steps[1]._runtime?.sessionId, "s-added");
      assert.strictEqual(state.steps[1]._runtime?.startedAt, 300);
      assert.strictEqual(state.steps[1]._runtime?.completedAt, 400);
      assert.strictEqual(state.steps[1]._runtime?.elapsed, undefined);
      assert.strictEqual(state.steps[1]._runtime?.contextWindowUsed, undefined);
      assert.strictEqual(state.steps[1]._runtime?.contextWindowSize, undefined);
      assert.strictEqual(state.currentIndex, 2);
      assert.strictEqual(state.results[1].status, STEP_STATUS.COMPLETED);
    });
  });
});
