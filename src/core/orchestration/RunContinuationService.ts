import * as fs from "fs/promises";
import { isDeepStrictEqual } from "util";
import type {
  ParallelGroupDefinition,
  RunRef,
  RunnerHostIdentity,
  WorkflowKey,
  WorkflowStep,
  WorkingFile,
} from "../../types/CtrlYokeTypes";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "../../types/CtrlYokeSettings";
import {
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  getEffectiveParallelGroupWidth,
  PARALLEL_GROUP_ADMISSION,
  QUEUE_POSITION,
  STEP_TYPES,
  STEP_CLAIM_OUTCOMES,
  resolveQueueInsertIndex,
  WORKFLOW_LOCK_LIVENESS,
  WORKFLOW_LOCK_LOCALITIES,
  WORKTREE_EDIT_KINDS,
  type ExecutionState,
  type QueuePosition,
} from "../../types/DashboardConstants";
import { withFileLock } from "../../utils/FileLockUtils";
import { writeFileAtomic } from "../../utils/AtomicFileUtils";
import { runStateWriteOptions } from "../../utils/RunStateWrites";
import { invalidateRunSummaryFor } from "./RunSummaryCache";
import {
  buildStepLimitError,
  getEffectiveMaxStepsSource,
  resolveEffectiveMaxSteps,
} from "../../utils/QueueLimitUtils";
import { exceedsLimit } from "../../utils/LimitUtils";
import { readWorkflowLockOwnershipInspection } from "../../utils/WorkflowLockInspector";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { WorkflowLineageRepository } from "./WorkflowLineageRepository";
import { assertDefinitionRevision } from "./RevisionPrecondition";
import {
  appendParallelGroupMembers,
  assertNoParallelSiblingReferences,
  deleteParallelGroupSteps,
  insertParallelGroupTopology,
  normalizeParallelGroupTopology,
  reorderParallelGroupPendingSteps,
  type PendingParallelGroupRange,
  replaceParallelGroupStep,
  promoteStepToParallelGroup,
  resolveParallelGroupInsertIndex,
  PARALLEL_GROUP_INSERT_POSITIONS,
  type ParallelGroupInsertPlacement,
  type ParallelGroupTopology,
} from "../ParallelGroupTopology";
import { isActiveQueueWorkRunning } from "../ParallelGroupRuntime";
import {
  mergeWorkflowStepUpdate,
  stripStepRuntime,
  stripViewOnlyWorkflowStepFields,
} from "../WorkflowStepSanitizer";
import {
  assertStartedStepPositionsPreserved,
  assertStepMutable,
  ensureStepIds,
  findStepIndexById,
} from "../StepIdentity";
import { hasInFlightStep, hasStarted } from "../../utils/StepStatusDerivation";
import {
  assertStepRemovalUnreferenced,
  renumberStepReferences,
} from "../StepReferenceRenumbering";
import { prepareRunFileForWrite } from "../../utils/PersistedSchemaGuard";
import { assertStepIndex } from "./StepIndexValidation";

export const RUN_CONTINUATION_ACTIONS = {
  APPEND: "append",
  CONTINUE: "continue",
  EDIT: "edit",
} as const;

type RunContinuationAction =
  (typeof RUN_CONTINUATION_ACTIONS)[keyof typeof RUN_CONTINUATION_ACTIONS];

/**
 * A completed run has no pending work, so continuing it would only start
 * another final-step pass. Refuse it unless a pending rewind has reopened the
 * run's suffix. Shared by the CLI/MCP and dashboard continuation paths; the
 * dashboard never offers Continue for a completed run either. Appending is the
 * way to add work to a completed run, so this guards `continue` only.
 */
export function assertRunHasWorkToContinue(
  executionState: ExecutionState,
  pendingRewindOnThisRun: boolean
): void {
  if (
    executionState === EXECUTION_STATES.COMPLETED &&
    !pendingRewindOnThisRun
  ) {
    throw new Error(
      "This run has completed and has no pending work to continue; append steps to add work, or re-run the workflow to start a new run"
    );
  }
}

export type RunStepChange =
  | { updates: Partial<WorkflowStep>; clearProperties?: string[] }
  | { replace: WorkflowStep; clearProperties?: string[] };

interface RunDefinitionMutationOptions {
  lineageRepository?: WorkflowLineageRepository;
  allowDuringPendingRewind?: boolean;
  allowInterruptedRun?: boolean;
}

export interface RunContinuationMutationResult {
  workingFile: WorkingFile;
  definitionRevision: number;
  descriptorRevision: number;
}

export interface RunParallelJoinMutationResult {
  workingFile: WorkingFile;
  definitionRevision: number;
  descriptorRevision: number;
  placement: ParallelGroupInsertPlacement;
  insertIndex: number;
  parallelGroupsAdded: ParallelGroupDefinition[];
  stepsAdded: number;
  joinedParallelGroup: {
    id: string;
    startIndex: number;
    endIndex: number;
    promoted: boolean;
  };
}

export type RunStepClaimResult =
  | {
      status: typeof STEP_CLAIM_OUTCOMES.CLAIMED;
      workingFile?: WorkingFile;
      step: WorkflowStep;
      stepIndex: number;
      definitionRevision: number;
    }
  | {
      status:
        | typeof STEP_CLAIM_OUTCOMES.MISSING
        | typeof STEP_CLAIM_OUTCOMES.ALREADY_CLAIMED
        | typeof STEP_CLAIM_OUTCOMES.TERMINAL;
      workingFile?: WorkingFile;
      step?: WorkflowStep;
      stepIndex?: number;
      definitionRevision: number;
    };

export interface RunContinuationTarget {
  definitionRevision: number;
  descriptorRevision: number;
  allowInterruptedRun: boolean;
}

export interface SelfOwnedUntrackedDiagnostic {
  event: "workflow-ownership-invariant";
  workflowKey: WorkflowKey;
  runRef: RunRef;
  locality: "self-owned-but-untracked";
  decision: "preserve-non-mutating";
}

/** Return the pending queue indices that a reorder request may move. */
export function getReorderableStepIndices(workingFile: WorkingFile): number[] {
  const steps = workingFile.steps ?? [];
  const currentIndex = workingFile._runtime?.currentIndex ?? 0;
  const executionIsInFlight = hasInFlightStep(
    workingFile._runtime?.executionState,
    workingFile._runtime?.finalStep?.phase
  );
  return steps
    .map((_, index) => index)
    .filter(
      (index) =>
        index >= currentIndex &&
        !(executionIsInFlight && index === currentIndex) &&
        !hasStarted(steps[index])
    );
}

/**
 * Node-only continuation transaction used by the extension, CLI, and MCP server.
 * It never binds an executor; callers that own execution do that separately.
 */
export class RunContinuationService {
  static async validateContinuationTarget(
    workspaceRoot: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    lineageRepository: WorkflowLineageRepository = new WorkflowLineageRepository(),
    action: RunContinuationAction = RUN_CONTINUATION_ACTIONS.CONTINUE,
    allowActiveTargetOperation: boolean = false,
    observer?: RunnerHostIdentity,
    onOwnershipDiagnostic?: (diagnostic: SelfOwnedUntrackedDiagnostic) => void
  ): Promise<RunContinuationTarget> {
    const [lockInspection, descriptor] = await Promise.all([
      readWorkflowLockOwnershipInspection(workspaceRoot, workflowKey, observer),
      lineageRepository.readDescriptor(workspaceRoot, workflowKey),
    ]);
    const target = await this.readRun(workspaceRoot, workflowKey, runRef);
    const executionState =
      target._runtime?.executionState ?? EXECUTION_STATES.IDLE;
    const activeLock =
      lockInspection.liveness === WORKFLOW_LOCK_LIVENESS.ACTIVE
        ? lockInspection.lock
        : undefined;
    const lockNamesTarget = activeLock?.runRef === runRef;
    // The executing step of a live run may still shape its own queue. Pause
    // means "let the current step finish, then pause", and queuing follow-up
    // work can be part of that step, so PAUSING keeps the exception: appended
    // steps are merged when the step ends and run on Resume. CANCELLING does
    // not — Stop discards the step's outcome.
    const activeTargetOperation =
      allowActiveTargetOperation &&
      (action === RUN_CONTINUATION_ACTIONS.APPEND ||
        action === RUN_CONTINUATION_ACTIONS.EDIT) &&
      activeLock !== undefined &&
      lockNamesTarget &&
      (executionState === EXECUTION_STATES.RUNNING ||
        executionState === EXECUTION_STATES.PAUSING);

    // A self-owned lock without the resident execution object is an invariant
    // failure, not an orphan. Treating it as external or adoptable would let a
    // continuation create a second owner for an execution this process already
    // holds. Editing a different, idle run remains valid while another run in
    // the lineage executes.
    if (
      lockInspection.liveness === WORKFLOW_LOCK_LIVENESS.ACTIVE &&
      lockInspection.locality === WORKFLOW_LOCK_LOCALITIES.SELF &&
      (action !== RUN_CONTINUATION_ACTIONS.EDIT || lockNamesTarget)
    ) {
      const diagnostic: SelfOwnedUntrackedDiagnostic = {
        event: "workflow-ownership-invariant",
        workflowKey,
        runRef: lockInspection.lock.runRef,
        locality: "self-owned-but-untracked",
        decision: "preserve-non-mutating",
      };
      onOwnershipDiagnostic?.(diagnostic);
      if (!onOwnershipDiagnostic) {
        // eslint-disable-next-line no-console -- Node-only continuation diagnostic.
        console.warn(
          `[RunContinuationService] self-owned but untracked execution: ${JSON.stringify(diagnostic)}`
        );
      }
      throw new Error(
        "Self-owned execution is not tracked by this process; refusing continuation"
      );
    }

    if (
      lockInspection.liveness === WORKFLOW_LOCK_LIVENESS.ACTIVE &&
      !activeTargetOperation
    ) {
      // Editing an idle run is allowed even while a *different* run of the same
      // lineage holds the lock — only starting work (append/continue) is gated by
      // another run executing. A lock naming *this* run still blocks a static
      // edit here: the live-executing-run edit path is handled in-place by the
      // orchestrator before it ever reaches this validator, so reaching here with
      // the lock on this run means a non-resident (e.g. CLI) owner.
      if (action !== RUN_CONTINUATION_ACTIONS.EDIT || lockNamesTarget) {
        if (lockNamesTarget) {
          throw new Error(
            `Cannot ${action} while this run is executing (state ${executionState})`
          );
        }
        if (
          lockInspection.locality === WORKFLOW_LOCK_LOCALITIES.INDETERMINATE
        ) {
          throw new Error(
            "Another run in this workflow lineage is executing and ownership is indeterminate"
          );
        }
        throw new Error("Another run in this workflow lineage is executing");
      }
    }
    const pendingRewindOnThisRun =
      descriptor.pendingEdit?.kind === WORKTREE_EDIT_KINDS.REWIND &&
      descriptor.pendingEdit.runRef === runRef;
    if (
      descriptor.pendingEdit &&
      !(action === RUN_CONTINUATION_ACTIONS.EDIT && pendingRewindOnThisRun)
    ) {
      throw new Error("This workflow has a draft or pending continuation");
    }
    if (action === RUN_CONTINUATION_ACTIONS.CONTINUE) {
      assertRunHasWorkToContinue(executionState, pendingRewindOnThisRun);
    }

    if (
      (executionState === EXECUTION_STATES.PAUSING && !activeTargetOperation) ||
      executionState === EXECUTION_STATES.CANCELLING
    ) {
      throw new Error(
        `Cannot ${action} while run is in state ${executionState}`
      );
    }
    // Mirrors `RunLifecycleService.validateExplicitContinuationTarget`: an
    // orphaned run (no live lock naming it) can be adopted by a fresh execution
    // owner from its own persisted position, whether it was left RUNNING by a
    // dead process or PAUSED by one. Keep the two in step — this is the same
    // contract reached from the CLI and MCP server instead of the dashboard.
    const isAdoptableState =
      executionState === EXECUTION_STATES.RUNNING ||
      executionState === EXECUTION_STATES.PAUSED;
    const allowInterruptedRun =
      isAdoptableState &&
      lockInspection.liveness !== WORKFLOW_LOCK_LIVENESS.ACTIVE;
    if (isAdoptableState && !allowInterruptedRun && !activeTargetOperation) {
      throw new Error(
        `Cannot ${action} while run is in state ${executionState}`
      );
    }
    return {
      definitionRevision: target.definitionRevision ?? 1,
      descriptorRevision: descriptor.revision,
      allowInterruptedRun: allowInterruptedRun || activeTargetOperation,
    };
  }

  /**
   * The descriptor lock here is pure mutual exclusion against a concurrent
   * draft-seed/rewind (the `pendingEdit` gate) — appending never writes the
   * descriptor, since a run's own steps are not descriptor content. Only
   * `definitionRevision` (the run file's own revision) is checked; coupling
   * this to the lineage-wide descriptor revision would make appending to one
   * run spuriously conflict with unrelated activity elsewhere in the lineage
   * (another run's rewind, a favorite toggle, a second run being promoted).
   * See `core.instructions.md`.
   */
  static async appendStepsToRun(
    workspaceRoot: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    tail: WorkflowStep[] | ParallelGroupTopology,
    expectedDefinitionRevision: number,
    globalMaxSteps: number,
    lineageRepository: WorkflowLineageRepository = new WorkflowLineageRepository(),
    allowInterruptedRun: boolean = false,
    position: QueuePosition | number = QUEUE_POSITION.END
  ): Promise<{
    workingFile: WorkingFile;
    definitionRevision: number;
    descriptorRevision: number;
    placement: ParallelGroupInsertPlacement;
    /** @deprecated Use placement.insertedIndex. */
    insertIndex: number;
    parallelGroupsAdded: ParallelGroupDefinition[];
    stepsAdded: number;
  }> {
    if (position === QUEUE_POSITION.PARALLEL_WITH_CURRENT) {
      throw new Error(
        "parallelWithCurrent requires the active parallel-group join transaction"
      );
    }
    const incomingTopology = Array.isArray(tail)
      ? normalizeParallelGroupTopology({ steps: tail })
      : normalizeParallelGroupTopology(tail);
    if (incomingTopology.steps.length === 0) {
      throw new Error("Append continuation requires at least one tail step");
    }
    const runFilePath = WorkflowPaths.runFilePath(
      workspaceRoot,
      workflowKey,
      runRef
    );
    const descriptorPath = WorkflowPaths.descriptorPath(
      workspaceRoot,
      workflowKey
    );
    return withFileLock(descriptorPath, async () => {
      const descriptor = await lineageRepository.readDescriptor(
        workspaceRoot,
        workflowKey
      );
      if (descriptor.pendingEdit) {
        throw new Error(
          "Cannot append while this workflow has a draft or pending continuation"
        );
      }
      return withFileLock(runFilePath, async () => {
        const source = await this.readRun(workspaceRoot, workflowKey, runRef);
        const sourceRevision = source.definitionRevision ?? 1;
        assertDefinitionRevision(expectedDefinitionRevision, sourceRevision);
        const sourceState = source._runtime?.executionState;
        if (
          !allowInterruptedRun &&
          (sourceState === EXECUTION_STATES.RUNNING ||
            sourceState === EXECUTION_STATES.PAUSING ||
            sourceState === EXECUTION_STATES.CANCELLING)
        ) {
          throw new Error(`Cannot append while run is in state ${sourceState}`);
        }
        const currentQueueSize = source.steps?.length ?? 0;
        const stepsToAdd = incomingTopology.steps.length;
        // Resolve against the run file read under this lock, so workflow edits
        // take effect at the next append and concurrent appends cannot pass
        // against stale counts.
        const workflowMaxSteps = source.maxSteps;
        const effectiveMaxSteps = resolveEffectiveMaxSteps(
          workflowMaxSteps,
          globalMaxSteps
        );
        if (exceedsLimit(currentQueueSize + stepsToAdd, effectiveMaxSteps)) {
          throw new Error(
            buildStepLimitError(
              currentQueueSize,
              effectiveMaxSteps,
              getEffectiveMaxStepsSource(workflowMaxSteps)
            )
          );
        }
        // Resolve the splice point from the run file read under this same
        // lock. Reading it earlier (or from the caller's snapshot) would let
        // the executing run advance in between and land `next` on the wrong
        // step.
        const sourceTopology = normalizeParallelGroupTopology({
          steps: ensureStepIds(source.steps ?? []),
          parallelGroups: source.parallelGroups,
        });
        const identifiedTail = ensureStepIds([
          ...sourceTopology.steps,
          ...stripStepRuntime(incomingTopology.steps),
        ]).slice(sourceTopology.steps.length);
        const sanitizedIncomingTopology = {
          steps: identifiedTail.map(stripViewOnlyWorkflowStepFields),
          parallelGroups: incomingTopology.parallelGroups,
        };
        const requestedIndex =
          typeof position === "number"
            ? position
            : Math.max(
                resolveQueueInsertIndex(
                  position,
                  source._runtime?.currentIndex ?? sourceTopology.steps.length,
                  sourceTopology.steps.length,
                  sourceTopology.parallelGroups
                ),
                immutablePrefixLength(sourceTopology.steps)
              );
        if (
          typeof position === "number" &&
          (!Number.isInteger(requestedIndex) ||
            requestedIndex < 0 ||
            requestedIndex > sourceTopology.steps.length)
        ) {
          throw new Error(`Invalid insert index: ${requestedIndex}`);
        }
        if (typeof position === "number") {
          assertEditableDuringExecution(
            source,
            sourceTopology.steps,
            requestedIndex,
            "insert"
          );
        }
        const placement = resolveParallelGroupInsertIndex(
          sourceTopology,
          requestedIndex,
          PARALLEL_GROUP_INSERT_POSITIONS.AFTER
        );
        const nextTopology = insertParallelGroupTopology(
          sourceTopology,
          requestedIndex,
          sanitizedIncomingTopology
        );
        const renumbered = renumberStepReferences(
          sourceTopology.steps,
          nextTopology.steps,
          source.finalStep
        );
        assertNoParallelSiblingReferences(
          {
            steps: renumbered.steps,
            parallelGroups: nextTopology.parallelGroups,
          },
          source
        );
        const incomingGroupIds = new Set(
          sanitizedIncomingTopology.parallelGroups.map((group) => group.id)
        );
        const parallelGroupsAdded = nextTopology.parallelGroups.filter(
          (group) => incomingGroupIds.has(group.id)
        );
        const workingFile: WorkingFile = {
          ...source,
          definitionRevision: sourceRevision + 1,
          steps: renumbered.steps,
          ...(renumbered.finalStep ? { finalStep: renumbered.finalStep } : {}),
          parallelGroups: nextTopology.parallelGroups,
          _runtime: {
            currentIndex: source._runtime?.currentIndex ?? 0,
            executionState:
              source._runtime?.executionState ?? EXECUTION_STATES.IDLE,
            ...source._runtime,
            lastActivityAt: Date.now(),
          },
        };
        await writeWorkingFileAtomic(runFilePath, workingFile);
        return {
          workingFile,
          definitionRevision: workingFile.definitionRevision,
          descriptorRevision: descriptor.revision,
          placement,
          insertIndex: placement.insertedIndex,
          parallelGroupsAdded,
          stepsAdded: stepsToAdd,
        };
      });
    });
  }

  /**
   * Atomically admit flat MCP members into the currently executing group.
   *
   * The run-file lock is the cross-process handoff with the executor: a group
   * that has already changed admission to closing wins the race and rejects,
   * while an accepting group is extended before the watcher can reconcile it.
   * The topology transforms are the same pure operations used by PromptQueue;
   * the in-process executor discovers the durable result by step ID.
   */
  static async appendStepsToActiveParallelGroup(
    workspaceRoot: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    steps: WorkflowStep[],
    expectedDefinitionRevision: number,
    globalMaxSteps: number,
    lineageRepository: WorkflowLineageRepository = new WorkflowLineageRepository(),
    position: QueuePosition = QUEUE_POSITION.PARALLEL_WITH_CURRENT,
    configuredParallelWidth = CTRLYOKE_SETTINGS_DEFAULTS.queue.maxParallelSteps
  ): Promise<RunParallelJoinMutationResult> {
    if (position !== QUEUE_POSITION.PARALLEL_WITH_CURRENT) {
      throw new Error(
        "Active parallel-group admission requires position 'parallelWithCurrent'"
      );
    }
    if (steps.length === 0) {
      throw new Error("Parallel-group join requires at least one flat step");
    }

    const runFilePath = WorkflowPaths.runFilePath(
      workspaceRoot,
      workflowKey,
      runRef
    );
    const descriptorPath = WorkflowPaths.descriptorPath(
      workspaceRoot,
      workflowKey
    );
    return withFileLock(descriptorPath, async () => {
      const descriptor = await lineageRepository.readDescriptor(
        workspaceRoot,
        workflowKey
      );
      if (descriptor.pendingEdit) {
        throw new Error(
          "Cannot join while this workflow has a draft or pending continuation"
        );
      }

      return withFileLock(runFilePath, async () => {
        const source = await this.readRun(workspaceRoot, workflowKey, runRef);
        const sourceRevision = source.definitionRevision ?? 1;
        assertDefinitionRevision(expectedDefinitionRevision, sourceRevision);

        const sourceState = source._runtime?.executionState;
        if (sourceState !== EXECUTION_STATES.RUNNING) {
          throw new Error(
            `parallelWithCurrent requires a running queue step; run is in state ${sourceState ?? EXECUTION_STATES.IDLE}`
          );
        }
        if (
          source._runtime?.finalStep?.phase === FINAL_STEP_PHASES.FINAL_STEP
        ) {
          throw new Error(
            "The final step cannot run in parallel. parallelWithCurrent was rejected."
          );
        }
        const effectiveWidth = getEffectiveParallelGroupWidth(
          configuredParallelWidth
        );
        if (effectiveWidth <= 1) {
          throw new Error(
            "Parallel width is 1. Raise queue.maxParallelSteps to run in parallel."
          );
        }

        const sourceTopology = normalizeParallelGroupTopology({
          steps: ensureStepIds(source.steps ?? []),
          parallelGroups: source.parallelGroups,
        });
        const currentIndex = source._runtime?.currentIndex ?? 0;
        const activeRuntime = source._runtime?.activeParallelGroup;
        const containingGroup = sourceTopology.parallelGroups.find(
          (group) =>
            currentIndex >= group.startIndex && currentIndex <= group.endIndex
        );
        if (
          !isActiveQueueWorkRunning(
            sourceTopology.steps,
            currentIndex,
            containingGroup
          )
        ) {
          throw new Error(
            "No queue step is currently running. parallelWithCurrent was rejected."
          );
        }
        if (activeRuntime) {
          if (activeRuntime.admission !== PARALLEL_GROUP_ADMISSION.ACCEPTING) {
            throw new Error(
              "No parallel group is accepting members. parallelWithCurrent was rejected."
            );
          }
          if (
            !containingGroup ||
            containingGroup.id !== activeRuntime.groupId
          ) {
            throw new Error(
              "The active parallel group is missing from the current definition. parallelWithCurrent was rejected."
            );
          }
        } else if (containingGroup) {
          throw new Error(
            "No parallel group is accepting members. parallelWithCurrent was rejected."
          );
        }

        const currentQueueSize = sourceTopology.steps.length;
        const workflowMaxSteps = source.maxSteps;
        const effectiveMaxSteps = resolveEffectiveMaxSteps(
          workflowMaxSteps,
          globalMaxSteps
        );
        if (exceedsLimit(currentQueueSize + steps.length, effectiveMaxSteps)) {
          throw new Error(
            buildStepLimitError(
              currentQueueSize,
              effectiveMaxSteps,
              getEffectiveMaxStepsSource(workflowMaxSteps)
            )
          );
        }

        const identifiedSteps = ensureStepIds([
          ...sourceTopology.steps,
          ...stripStepRuntime(steps).map(stripViewOnlyWorkflowStepFields),
        ]).slice(sourceTopology.steps.length);

        let nextTopology: ParallelGroupTopology;
        let joinedGroupId: string;
        let promoted = false;
        const insertionIndex = containingGroup
          ? containingGroup.endIndex + 1
          : currentIndex + 1;
        if (containingGroup) {
          nextTopology = appendParallelGroupMembers(
            sourceTopology,
            containingGroup.id,
            identifiedSteps
          );
          joinedGroupId = containingGroup.id;
        } else {
          nextTopology = promoteStepToParallelGroup(
            sourceTopology,
            currentIndex,
            identifiedSteps[0],
            { failFast: false }
          );
          const promotedGroup = nextTopology.parallelGroups.find(
            (group) =>
              currentIndex >= group.startIndex && currentIndex <= group.endIndex
          );
          if (!promotedGroup) {
            throw new Error("Failed to create the ad-hoc parallel group");
          }
          joinedGroupId = promotedGroup.id;
          promoted = true;
          if (identifiedSteps.length > 1) {
            nextTopology = appendParallelGroupMembers(
              nextTopology,
              joinedGroupId,
              identifiedSteps.slice(1)
            );
          }
        }

        const renumbered = renumberStepReferences(
          sourceTopology.steps,
          nextTopology.steps,
          source.finalStep
        );
        assertNoParallelSiblingReferences(
          {
            steps: renumbered.steps,
            parallelGroups: nextTopology.parallelGroups,
          },
          source
        );

        const joinedGroup = nextTopology.parallelGroups.find(
          (group) => group.id === joinedGroupId
        );
        if (!joinedGroup) {
          throw new Error(
            `Cannot join parallel group ${joinedGroupId}: group is missing after insertion`
          );
        }
        const placement: ParallelGroupInsertPlacement = {
          requestedIndex: insertionIndex,
          insertedIndex: insertionIndex,
        };
        const workingFile: WorkingFile = {
          ...source,
          definitionRevision: sourceRevision + 1,
          steps: renumbered.steps,
          ...(renumbered.finalStep ? { finalStep: renumbered.finalStep } : {}),
          parallelGroups: nextTopology.parallelGroups,
          _runtime: {
            ...source._runtime!,
            activeParallelGroup: {
              groupId: joinedGroup.id,
              admission: PARALLEL_GROUP_ADMISSION.ACCEPTING,
            },
            lastActivityAt: Date.now(),
          },
        };
        await writeWorkingFileAtomic(runFilePath, workingFile);
        const parallelGroupsAdded = promoted ? [joinedGroup] : [];
        return {
          workingFile,
          definitionRevision: workingFile.definitionRevision,
          descriptorRevision: descriptor.revision,
          placement,
          insertIndex: placement.insertedIndex,
          parallelGroupsAdded,
          stepsAdded: steps.length,
          joinedParallelGroup: {
            id: joinedGroup.id,
            startIndex: joinedGroup.startIndex,
            endIndex: joinedGroup.endIndex,
            promoted,
          },
        };
      });
    });
  }

  /**
   * Atomically claim one run step for dispatch. The descriptor and run-file
   * locks use the same order as the MCP mutation transactions, so a claim and
   * an external edit/remove have one deterministic winner.
   */
  static async claimStepAtRun(
    workspaceRoot: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    stepId: string,
    startedAt: number = Date.now(),
    lineageRepository: WorkflowLineageRepository = new WorkflowLineageRepository()
  ): Promise<RunStepClaimResult> {
    const runFilePath = WorkflowPaths.runFilePath(
      workspaceRoot,
      workflowKey,
      runRef
    );
    const descriptorPath = WorkflowPaths.descriptorPath(
      workspaceRoot,
      workflowKey
    );

    return withFileLock(descriptorPath, async () => {
      // Read the descriptor under the same lock as the mutation paths. The
      // claim does not alter it, but taking this lock is what serializes the
      // claim with append/edit/remove/reorder transactions.
      await lineageRepository.readDescriptor(workspaceRoot, workflowKey);
      return withFileLock(runFilePath, async () => {
        const source = await this.readRun(workspaceRoot, workflowKey, runRef);
        const definitionRevision = source.definitionRevision ?? 1;
        const topology = normalizeParallelGroupTopology({
          steps: source.steps ?? [],
          parallelGroups: source.parallelGroups,
        });
        const stepIndex = findStepIndexById(topology.steps, stepId);
        if (stepIndex < 0) {
          return {
            status: STEP_CLAIM_OUTCOMES.MISSING,
            workingFile: source,
            definitionRevision,
          };
        }

        const step = topology.steps[stepIndex];
        if (step._runtime?.completedAt !== undefined) {
          return {
            status: STEP_CLAIM_OUTCOMES.TERMINAL,
            workingFile: source,
            step,
            stepIndex,
            definitionRevision,
          };
        }
        if (step._runtime?.startedAt !== undefined) {
          return {
            status: STEP_CLAIM_OUTCOMES.ALREADY_CLAIMED,
            workingFile: source,
            step,
            stepIndex,
            definitionRevision,
          };
        }

        const claimedStep: WorkflowStep = {
          ...step,
          _runtime: {
            ...step._runtime,
            startedAt,
          },
        };
        const workingFile: WorkingFile = {
          ...source,
          // Claiming is runtime persistence. It must never create a new
          // definition revision or invalidate the definition snapshot.
          definitionRevision,
          steps: topology.steps.map((candidate, index) =>
            index === stepIndex ? claimedStep : candidate
          ),
          parallelGroups: topology.parallelGroups,
        };
        await writeWorkingFileAtomic(runFilePath, workingFile);
        return {
          status: STEP_CLAIM_OUTCOMES.CLAIMED,
          workingFile,
          step: claimedStep,
          stepIndex,
          definitionRevision,
        };
      });
    });
  }

  /**
   * Edit one explicitly addressed step without binding an executor. The
   * transaction is usable by Node-only callers while the target run executes;
   * the boundary check keeps the completed prefix and in-flight step stable.
   */
  static async editStepAtRun(
    workspaceRoot: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    index: number,
    change: RunStepChange,
    expectedDefinitionRevision: number,
    lineageRepository: WorkflowLineageRepository = new WorkflowLineageRepository(),
    allowInterruptedRun = false
  ): Promise<RunContinuationMutationResult> {
    return this.mutateRunDefinition(
      workspaceRoot,
      workflowKey,
      runRef,
      expectedDefinitionRevision,
      (source) => {
        const topology = normalizeParallelGroupTopology({
          steps: source.steps ?? [],
          parallelGroups: source.parallelGroups,
        });
        assertStepIndex(topology.steps.length, index, "edit");
        assertEditableDuringExecution(source, topology.steps, index, "edit");
        assertPendingRewindSuffix(source, index, "edit");
        assertClearablePropertiesAreEditable(change.clearProperties);
        const incomingStep = stripViewOnlyWorkflowStepFields(
          stripStepRuntime([
            "replace" in change
              ? change.replace
              : (change.updates as WorkflowStep),
          ])[0]
        );
        const mergedStep = mergeWorkflowStepUpdate(
          topology.steps[index],
          incomingStep,
          change.clearProperties
        );
        assertStepHasRequiredContent(mergedStep);
        const nextTopology = replaceParallelGroupStep(
          topology,
          index,
          mergedStep
        );
        assertNoParallelSiblingReferences(nextTopology, source);
        assertStartedStepPositionsPreserved(
          topology.steps,
          nextTopology.steps,
          "edit"
        );
        return {
          workingFile: {
            ...source,
            steps: nextTopology.steps,
            parallelGroups: nextTopology.parallelGroups,
          },
          result: undefined,
        };
      },
      {
        lineageRepository,
        allowDuringPendingRewind: true,
        allowInterruptedRun,
      }
    );
  }

  /** Remove one explicitly addressed step. */
  static async removeStepsAtRun(
    workspaceRoot: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    indices: number[],
    expectedDefinitionRevision: number,
    lineageRepository: WorkflowLineageRepository = new WorkflowLineageRepository(),
    allowInterruptedRun = false
  ): Promise<RunContinuationMutationResult> {
    return this.mutateRunDefinition(
      workspaceRoot,
      workflowKey,
      runRef,
      expectedDefinitionRevision,
      (source) => {
        const topology = normalizeParallelGroupTopology({
          steps: source.steps ?? [],
          parallelGroups: source.parallelGroups,
        });
        const unique = [...new Set(indices)];
        if (unique.length !== indices.length || unique.length === 0) {
          throw new Error(
            "Remove indices must be a non-empty set of unique indices"
          );
        }
        for (const index of unique) {
          assertStepIndex(topology.steps.length, index, "remove");
          assertEditableDuringExecution(
            source,
            topology.steps,
            index,
            "remove"
          );
        }
        const nextTopology = deleteParallelGroupSteps(topology, unique);
        const renumbered = renumberStepReferences(
          topology.steps,
          nextTopology.steps,
          source.finalStep
        );
        assertStepRemovalUnreferenced(renumbered, unique);
        if (isExecutionActiveState(source._runtime?.executionState)) {
          assertStartedStepPositionsPreserved(
            topology.steps,
            nextTopology.steps,
            "remove"
          );
        }
        const currentIndex = source._runtime?.currentIndex ?? 0;
        return {
          workingFile: {
            ...source,
            steps: renumbered.steps,
            ...(renumbered.finalStep
              ? { finalStep: renumbered.finalStep }
              : {}),
            parallelGroups: nextTopology.parallelGroups,
            _runtime: source._runtime
              ? {
                  ...source._runtime,
                  currentIndex:
                    currentIndex -
                    unique.filter((index) => index < currentIndex).length,
                }
              : source._runtime,
          },
          result: undefined,
        };
      },
      { lineageRepository, allowInterruptedRun }
    );
  }

  /** Reorder the pending suffix using absolute workflow step indices. */
  static async reorderStepsAtRun(
    workspaceRoot: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    absoluteOrder: number[],
    expectedDefinitionRevision: number,
    lineageRepository: WorkflowLineageRepository = new WorkflowLineageRepository(),
    pendingGroups?: PendingParallelGroupRange[],
    allowInterruptedRun = false
  ): Promise<RunContinuationMutationResult> {
    return this.reorderStepsWithOrder(
      workspaceRoot,
      workflowKey,
      runRef,
      expectedDefinitionRevision,
      (source, topology, currentIndex) => {
        if (absoluteOrder.some((index) => !Number.isInteger(index))) {
          throw new Error("Reorder indices must be integers");
        }
        const fixedIndices = new Set<number>();
        const movableIndices = getReorderableStepIndices(source);
        const executionIsInFlight = hasInFlightStep(
          source._runtime?.executionState,
          source._runtime?.finalStep?.phase
        );
        for (let index = currentIndex; index < topology.steps.length; index++) {
          const isRunningHead = executionIsInFlight && index === currentIndex;
          if (isRunningHead || hasStarted(topology.steps[index])) {
            fixedIndices.add(index);
          }
        }

        if (movableIndices.length === 0) {
          throw new Error(
            "No steps are pending, so there is nothing to reorder"
          );
        }

        if (
          absoluteOrder.length !== movableIndices.length ||
          absoluteOrder.some(
            (index) =>
              !Number.isInteger(index) || !movableIndices.includes(index)
          ) ||
          new Set(absoluteOrder).size !== absoluteOrder.length
        ) {
          throw new Error(
            `Reorder indices must contain exactly ${movableIndices.length} not-yet-started step indices (${movableIndices.join(", ")})`
          );
        }

        let nextMovable = 0;
        return Array.from(
          { length: topology.steps.length - currentIndex },
          (_, offset) => {
            const absoluteIndex = currentIndex + offset;
            const sourceIndex = fixedIndices.has(absoluteIndex)
              ? absoluteIndex
              : absoluteOrder[nextMovable++];
            return sourceIndex - currentIndex;
          }
        );
      },
      lineageRepository,
      pendingGroups,
      allowInterruptedRun
    );
  }

  private static async reorderStepsWithOrder(
    workspaceRoot: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    expectedDefinitionRevision: number,
    resolvePendingOrder: (
      source: WorkingFile,
      topology: ReturnType<typeof normalizeParallelGroupTopology>,
      currentIndex: number
    ) => number[],
    lineageRepository: WorkflowLineageRepository,
    pendingGroups: PendingParallelGroupRange[] | undefined,
    allowInterruptedRun: boolean
  ): Promise<RunContinuationMutationResult> {
    return this.mutateRunDefinition(
      workspaceRoot,
      workflowKey,
      runRef,
      expectedDefinitionRevision,
      (source) => {
        const topology = normalizeParallelGroupTopology({
          steps: source.steps ?? [],
          parallelGroups: source.parallelGroups,
        });
        const currentIndex = source._runtime?.currentIndex ?? 0;
        const newPendingOrder = resolvePendingOrder(
          source,
          topology,
          currentIndex
        );
        assertPendingReorderIsSafe(source, topology.steps, newPendingOrder);
        const nextTopology = reorderParallelGroupPendingSteps(
          topology,
          currentIndex,
          newPendingOrder,
          pendingGroups,
          hasInFlightStep(
            source._runtime?.executionState,
            source._runtime?.finalStep?.phase
          )
        );
        assertStartedStepPositionsPreserved(
          topology.steps,
          nextTopology.steps,
          "reorder"
        );
        const renumbered = renumberStepReferences(
          topology.steps,
          nextTopology.steps,
          source.finalStep
        );
        assertNoParallelSiblingReferences(
          {
            steps: renumbered.steps,
            parallelGroups: nextTopology.parallelGroups,
          },
          source
        );
        return {
          workingFile: {
            ...source,
            steps: renumbered.steps,
            ...(renumbered.finalStep
              ? { finalStep: renumbered.finalStep }
              : {}),
            parallelGroups: nextTopology.parallelGroups,
          },
          result: undefined,
        };
      },
      { lineageRepository, allowInterruptedRun }
    );
  }

  private static async mutateRunDefinition(
    workspaceRoot: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    expectedDefinitionRevision: number,
    transform: (source: WorkingFile) => {
      workingFile: WorkingFile;
      result: undefined;
    },
    options: RunDefinitionMutationOptions = {}
  ): Promise<RunContinuationMutationResult> {
    const lineageRepository =
      options.lineageRepository ?? new WorkflowLineageRepository();
    const runFilePath = WorkflowPaths.runFilePath(
      workspaceRoot,
      workflowKey,
      runRef
    );
    const descriptorPath = WorkflowPaths.descriptorPath(
      workspaceRoot,
      workflowKey
    );
    return withFileLock(descriptorPath, async () => {
      const descriptor = await lineageRepository.readDescriptor(
        workspaceRoot,
        workflowKey
      );
      if (descriptor.pendingEdit) {
        const pendingRewindOnThisRun =
          descriptor.pendingEdit.kind === WORKTREE_EDIT_KINDS.REWIND &&
          descriptor.pendingEdit.runRef === runRef;
        if (!options.allowDuringPendingRewind || !pendingRewindOnThisRun) {
          throw new Error(
            "Cannot edit while this workflow has a draft or pending continuation"
          );
        }
      }
      return withFileLock(runFilePath, async () => {
        const source = await this.readRun(workspaceRoot, workflowKey, runRef);
        const sourceRevision = source.definitionRevision ?? 1;
        assertDefinitionRevision(expectedDefinitionRevision, sourceRevision);
        const sourceState = source._runtime?.executionState;
        if (
          !options.allowInterruptedRun &&
          isInFlightExecutionState(sourceState)
        ) {
          throw new Error(`Cannot edit while run is in state ${sourceState}`);
        }
        const { workingFile, result } = transform(source);
        // A transform that produced the definition already on disk must not
        // bump `definitionRevision`. That revision is the optimistic-concurrency
        // token every client echoes on its next mutation, so bumping it for a
        // write that persists nothing supersedes a revision the client is still
        // legitimately holding and rejects its *next* real action as a
        // conflict — the manufactured half of "Definition revision conflict"
        // during fast editing/undo. Nothing downstream needs a write here: the
        // bytes are identical, so viewers already hold this content.
        if (isDeepStrictEqual(source, workingFile)) {
          return {
            workingFile: source,
            definitionRevision: sourceRevision,
            descriptorRevision: descriptor.revision,
            result,
          };
        }
        const persisted: WorkingFile = {
          ...workingFile,
          definitionRevision: sourceRevision + 1,
        };
        await writeWorkingFileAtomic(runFilePath, persisted);
        return {
          workingFile: persisted,
          definitionRevision: persisted.definitionRevision,
          descriptorRevision: descriptor.revision,
          result,
        };
      });
    });
  }

  private static async readRun(
    workspaceRoot: string,
    workflowKey: WorkflowKey,
    runRef: RunRef
  ): Promise<WorkingFile> {
    try {
      return JSON.parse(
        await fs.readFile(
          WorkflowPaths.runFilePath(workspaceRoot, workflowKey, runRef),
          "utf8"
        )
      ) as WorkingFile;
    } catch (error) {
      throw new Error(
        `Failed to read run ${workflowKey}/${runRef}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

function isInFlightExecutionState(state: ExecutionState | undefined): boolean {
  return (
    state === EXECUTION_STATES.RUNNING ||
    state === EXECUTION_STATES.PAUSING ||
    state === EXECUTION_STATES.CANCELLING
  );
}

function isExecutionActiveState(state: ExecutionState | undefined): boolean {
  return isInFlightExecutionState(state) || state === EXECUTION_STATES.PAUSED;
}

/**
 * Keep addressed Node-only mutations aligned with PromptQueue's execution
 * boundary. The persisted executed prefix and terminal step states remain
 * immutable after execution stops; only the in-flight head check is transient.
 */
export function assertEditableDuringExecution(
  source: WorkingFile,
  steps: WorkflowStep[],
  index: number,
  operation: string
): void {
  const currentIndex = source._runtime?.currentIndex ?? 0;
  const step = steps[index];
  const isExecutedPrefix = index < currentIndex;
  const hasTerminalStatus = step?._runtime?.terminalStatus !== undefined;
  if (isExecutedPrefix || hasTerminalStatus) {
    assertStepMutable(step, operation, "completedPrefix");
    if (!hasStarted(step)) {
      // Older or partial working files may carry the run boundary or terminal
      // status without the timestamps assertStepMutable normally uses as proof.
      throw new Error(`Cannot ${operation} a completed step`);
    }
  }

  if (!isExecutionActiveState(source._runtime?.executionState)) return;
  assertStepMutable(step, operation);
  if (
    index === currentIndex &&
    hasInFlightStep(
      source._runtime?.executionState,
      source._runtime?.finalStep?.phase
    )
  ) {
    // Legacy working files may predate per-step claim metadata. Keep the
    // execution-head boundary as a compatibility backstop until they claim.
    if (!hasStarted(step)) {
      throw new Error(
        index < currentIndex
          ? `Cannot ${operation} a completed step while the workflow is running`
          : `Cannot ${operation} the currently executing step`
      );
    }
  }
}

/**
 * Fields an addressed edit may never reach through `clearProperties`.
 * `updates`/`replace` are already sanitized by `stripStepRuntime` and
 * `stripViewOnlyWorkflowStepFields`, but `buildClearUpdates` writes whatever
 * keys it is handed straight onto the merged step. Without this, a caller
 * could clear `_runtime` — erasing `completedAt`, and with it the step's
 * membership in `immutablePrefixLength`, which is the conservative insertion
 * floor retained for numeric cross-process positions and legacy files. The
 * queue's disk merge uses stepId directly; this floor is not a second merge
 * identity rule.
 */
const NON_CLEARABLE_STEP_PROPERTIES = ["_runtime", "status", "details", "type"];

function assertClearablePropertiesAreEditable(
  clearProperties: string[] | undefined
): void {
  const rejected = clearProperties?.filter((property) =>
    NON_CLEARABLE_STEP_PROPERTIES.includes(property)
  );
  if (rejected?.length) {
    throw new Error(
      `Cannot clear internal step ${rejected.length === 1 ? "property" : "properties"}: ${rejected.join(", ")}`
    );
  }
}

function assertStepHasRequiredContent(step: WorkflowStep): void {
  if (step.type === STEP_TYPES.SCRIPT) {
    if (typeof step.script !== "string" || step.script.trim().length === 0) {
      throw new Error("A script step must keep a non-empty script");
    }
    return;
  }
  if (typeof step.prompt !== "string" || step.prompt.trim().length === 0) {
    throw new Error("A prompt step must keep a non-empty prompt");
  }
}

function assertPendingRewindSuffix(
  source: WorkingFile,
  index: number,
  operation: string
): void {
  const boundary = source._runtime?.pendingRewind?.fromStepIndex;
  if (boundary !== undefined && index < boundary) {
    throw new Error(
      `Cannot ${operation} a preserved prefix step while a continuation is pending`
    );
  }
}

function assertPendingReorderIsSafe(
  source: WorkingFile,
  steps: WorkflowStep[],
  newPendingOrder: number[]
): void {
  if (source._runtime?.pendingRewind) return;
  if (!isExecutionActiveState(source._runtime?.executionState)) return;

  const currentIndex = source._runtime?.currentIndex ?? 0;
  // The topology transform performs the actual structural validation against
  // every started step. This preflight only retains the legacy current-index
  // boundary for files that have not yet been claimed by ID.
  if (
    hasInFlightStep(
      source._runtime?.executionState,
      source._runtime?.finalStep?.phase
    ) &&
    newPendingOrder.length > 0 &&
    !hasStarted(steps[currentIndex]) &&
    newPendingOrder[0] !== 0
  ) {
    throw new Error("Cannot reorder the currently executing step");
  }
}

/**
 * Conservative floor for a numeric cross-process insert. Steps that already
 * recorded a terminal `completedAt` remain index anchors because
 * `manifest.json`/`events.jsonl` address their recorded attempts by position.
 * The actual structural rule is `assertStartedStepPositionsPreserved`; this
 * helper only keeps legacy, ID-less callers from attempting an obviously unsafe
 * prefix splice before that validator runs.
 */
export function immutablePrefixLength(steps: WorkflowStep[]): number {
  let boundary = 0;
  steps.forEach((step, index) => {
    if (step._runtime?.completedAt !== undefined) {
      boundary = index + 1;
    }
  });
  return boundary;
}

/**
 * These are run working files mid-execution, so they get the same
 * transient-rename budget `WorkingFileManager`'s writes get: a hand-rolled
 * `writeFile` + `rename` pair here had none, and a Windows `EPERM` from a
 * reader holding the destination for a few milliseconds failed the whole run.
 *
 * `invalidateRunSummaryFor` is the write-through hook `RunSummaryCache`
 * requires of every in-process writer of a cached run file.
 */
async function writeWorkingFileAtomic(
  filePath: string,
  workingFile: WorkingFile
): Promise<void> {
  const stamped = prepareRunFileForWrite(workingFile, filePath);
  try {
    await writeFileAtomic(
      filePath,
      JSON.stringify(stamped, null, 2),
      runStateWriteOptions(filePath, "RunContinuationService")
    );
  } catch (error) {
    throw new Error(
      `Failed to write working file: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    invalidateRunSummaryFor(filePath);
  }
}
