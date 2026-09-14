import * as fs from "fs/promises";
import type {
  RunRef,
  RunnerHostIdentity,
  WorkflowKey,
  WorkflowStep,
  WorkingFile,
} from "../../types/CtrlYokeTypes";
import {
  EXECUTION_STATES,
  QUEUE_POSITION,
  STEP_CLAIM_OUTCOMES,
  resolveQueueInsertIndex,
  WORKFLOW_LOCK_LIVENESS,
  WORKFLOW_LOCK_LOCALITIES,
  WORKTREE_EDIT_KINDS,
  type ExecutionState,
  type QueuePosition,
} from "../../types/DashboardConstants";
import { withFileLock } from "../../utils/FileLockUtils";
import { readWorkflowLockOwnershipInspection } from "../../utils/WorkflowLockInspector";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { WorkflowLineageRepository } from "./WorkflowLineageRepository";
import {
  deleteParallelGroupStep,
  insertParallelGroupSteps,
  normalizeParallelGroupTopology,
  reorderParallelGroupPendingSteps,
  type PendingParallelGroupRange,
  replaceParallelGroupStep,
  resolveParallelGroupInsertIndex,
  PARALLEL_GROUP_INSERT_POSITIONS,
  type ParallelGroupInsertPlacement,
} from "../ParallelGroupTopology";
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
  hasStarted,
} from "../StepIdentity";

const RUN_CONTINUATION_ACTIONS = {
  APPEND: "append",
  CONTINUE: "continue",
  EDIT: "edit",
} as const;

type RunContinuationAction =
  (typeof RUN_CONTINUATION_ACTIONS)[keyof typeof RUN_CONTINUATION_ACTIONS];

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
    const activeTargetOperation =
      allowActiveTargetOperation &&
      (action === RUN_CONTINUATION_ACTIONS.APPEND ||
        action === RUN_CONTINUATION_ACTIONS.EDIT) &&
      activeLock !== undefined &&
      lockNamesTarget &&
      executionState === EXECUTION_STATES.RUNNING;

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

    if (
      executionState === EXECUTION_STATES.PAUSING ||
      executionState === EXECUTION_STATES.CANCELLING
    ) {
      throw new Error(
        `Cannot ${action} while run is in state ${executionState}`
      );
    }
    // Mirrors `WorkflowOrchestrator.validateExplicitContinuationTarget`: an
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
    tail: WorkflowStep[],
    expectedDefinitionRevision: number,
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
  }> {
    if (tail.length === 0) {
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
        if (sourceRevision !== expectedDefinitionRevision) {
          throw new Error(
            `Definition revision conflict: expected ${expectedDefinitionRevision}, found ${sourceRevision}`
          );
        }
        const sourceState = source._runtime?.executionState;
        if (
          !allowInterruptedRun &&
          (sourceState === EXECUTION_STATES.RUNNING ||
            sourceState === EXECUTION_STATES.PAUSING ||
            sourceState === EXECUTION_STATES.CANCELLING)
        ) {
          throw new Error(`Cannot append while run is in state ${sourceState}`);
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
          ...tail.map((step) => stripStepRuntime([step])[0]),
        ]).slice(sourceTopology.steps.length);
        const requestedIndex =
          typeof position === "number"
            ? position
            : Math.max(
                resolveQueueInsertIndex(
                  position,
                  source._runtime?.currentIndex ?? sourceTopology.steps.length,
                  sourceTopology.steps.length
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
        const nextTopology = insertParallelGroupSteps(
          sourceTopology,
          requestedIndex,
          identifiedTail.map(stripViewOnlyWorkflowStepFields)
        );
        const workingFile: WorkingFile = {
          ...source,
          lastModifiedAt: Date.now(),
          definitionRevision: sourceRevision + 1,
          steps: nextTopology.steps,
          parallelGroups: nextTopology.parallelGroups,
        };
        await writeWorkingFileAtomic(runFilePath, workingFile);
        return {
          workingFile,
          definitionRevision: workingFile.definitionRevision,
          descriptorRevision: descriptor.revision,
          placement,
          insertIndex: placement.insertedIndex,
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
          lastModifiedAt: Math.max(
            Date.now(),
            (source.lastModifiedAt ?? 0) + 1
          ),
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
        assertStepIndex(topology.steps, index, "edit");
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
        const nextTopology = replaceParallelGroupStep(
          topology,
          index,
          mergeWorkflowStepUpdate(
            topology.steps[index],
            incomingStep,
            change.clearProperties
          )
        );
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

  /** Insert one step at an explicit array position. */
  static async insertStepAtRun(
    workspaceRoot: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    index: number,
    step: WorkflowStep,
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
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index > topology.steps.length
        ) {
          throw new Error(`Invalid insert index: ${index}`);
        }
        assertEditableDuringExecution(source, topology.steps, index, "insert");
        const placement = resolveParallelGroupInsertIndex(
          topology,
          index,
          PARALLEL_GROUP_INSERT_POSITIONS.AFTER
        );
        const insertIndex = placement.insertedIndex;
        const identifiedStep = ensureStepIds([
          ...topology.steps,
          stripStepRuntime([step])[0],
        ]).at(-1)!;
        const nextTopology = insertParallelGroupSteps(topology, index, [
          stripViewOnlyWorkflowStepFields(identifiedStep),
        ]);
        assertStartedStepPositionsPreserved(
          topology.steps,
          nextTopology.steps,
          "insert"
        );
        const currentIndex = source._runtime?.currentIndex ?? 0;
        return {
          workingFile: {
            ...source,
            steps: nextTopology.steps,
            parallelGroups: nextTopology.parallelGroups,
            _runtime: source._runtime
              ? {
                  ...source._runtime,
                  currentIndex:
                    insertIndex < currentIndex
                      ? currentIndex + 1
                      : currentIndex,
                }
              : source._runtime,
          },
          result: undefined,
        };
      },
      { lineageRepository, allowInterruptedRun }
    );
  }

  /** Remove one explicitly addressed step. */
  static async removeStepAtRun(
    workspaceRoot: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    index: number,
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
        assertStepIndex(topology.steps, index, "remove");
        assertEditableDuringExecution(source, topology.steps, index, "remove");
        const nextTopology = deleteParallelGroupStep(topology, index);
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
            steps: nextTopology.steps,
            parallelGroups: nextTopology.parallelGroups,
            _runtime: source._runtime
              ? {
                  ...source._runtime,
                  currentIndex:
                    index < currentIndex ? currentIndex - 1 : currentIndex,
                }
              : source._runtime,
          },
          result: undefined,
        };
      },
      { lineageRepository, allowInterruptedRun }
    );
  }

  /** Reorder pending steps while preserving the execution prefix. */
  static async reorderPendingStepsAtRun(
    workspaceRoot: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    newPendingOrder: number[],
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
      () => newPendingOrder,
      lineageRepository,
      pendingGroups,
      allowInterruptedRun
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
      (_source, _topology, currentIndex) => {
        if (absoluteOrder.some((index) => !Number.isInteger(index))) {
          throw new Error("Reorder indices must be integers");
        }
        return absoluteOrder.map((index) => {
          if (index < currentIndex) {
            throw new Error(
              "Cannot reorder a completed step while the workflow is running"
            );
          }
          return index - currentIndex;
        });
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
        const effectivePendingGroups =
          pendingGroups ?? buildPendingGroupRanges(topology, currentIndex);
        const nextTopology = reorderParallelGroupPendingSteps(
          topology,
          currentIndex,
          newPendingOrder,
          effectivePendingGroups,
          isInFlightExecutionState(source._runtime?.executionState)
        );
        assertStartedStepPositionsPreserved(
          topology.steps,
          nextTopology.steps,
          "reorder"
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
        if (sourceRevision !== expectedDefinitionRevision) {
          throw new Error(
            `Definition revision conflict: expected ${expectedDefinitionRevision}, found ${sourceRevision}`
          );
        }
        const sourceState = source._runtime?.executionState;
        if (
          !options.allowInterruptedRun &&
          isInFlightExecutionState(sourceState)
        ) {
          throw new Error(`Cannot edit while run is in state ${sourceState}`);
        }
        const { workingFile, result } = transform(source);
        const persisted: WorkingFile = {
          ...workingFile,
          lastModifiedAt: Date.now(),
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

function assertStepIndex(
  steps: WorkflowStep[],
  index: number,
  operation: string
): void {
  if (!Number.isInteger(index) || index < 0 || index >= steps.length) {
    throw new Error(`Invalid ${operation} index: ${index}`);
  }
}

/**
 * Keep addressed Node-only mutations aligned with PromptQueue's execution
 * boundary. A pending rewind owns its own suffix policy, so it deliberately
 * bypasses this execution-head check.
 */
function assertEditableDuringExecution(
  source: WorkingFile,
  steps: WorkflowStep[],
  index: number,
  operation: string
): void {
  if (source._runtime?.pendingRewind) return;
  if (!isExecutionActiveState(source._runtime?.executionState)) return;

  const currentIndex = source._runtime?.currentIndex ?? 0;
  const step = steps[index];
  assertStepMutable(
    step,
    operation,
    index < currentIndex ? "completedPrefix" : undefined
  );
  if (
    index < currentIndex ||
    (index === currentIndex &&
      isInFlightExecutionState(source._runtime?.executionState))
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
const NON_CLEARABLE_STEP_PROPERTIES = ["_runtime", "status", "details"];

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
    isInFlightExecutionState(source._runtime?.executionState) &&
    newPendingOrder.length > 0 &&
    !hasStarted(steps[currentIndex])
  ) {
    throw new Error("Cannot reorder the currently executing step");
  }
}

function buildPendingGroupRanges(
  topology: ReturnType<typeof normalizeParallelGroupTopology>,
  currentIndex: number
): PendingParallelGroupRange[] {
  return topology.parallelGroups
    .filter((group) => group.endIndex >= currentIndex)
    .map((group) => ({
      id: group.id,
      start: Math.max(group.startIndex, currentIndex) - currentIndex,
      end: group.endIndex - currentIndex,
      failFast: group.failFast,
    }));
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

async function writeWorkingFileAtomic(
  filePath: string,
  workingFile: WorkingFile
): Promise<void> {
  const temporaryPath = `${filePath}.tmp`;
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(workingFile, null, 2));
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => {});
    throw new Error(
      `Failed to write working file: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
