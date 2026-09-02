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
  resolveQueueInsertIndex,
  WORKFLOW_LOCK_LIVENESS,
  WORKFLOW_LOCK_LOCALITIES,
  WORKTREE_EDIT_KINDS,
  type QueuePosition,
} from "../../types/DashboardConstants";
import { withFileLock } from "../../utils/FileLockUtils";
import { readWorkflowLockOwnershipInspection } from "../../utils/WorkflowLockInspector";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import {
  stripStepRuntime,
  stripViewOnlyWorkflowStepFields,
} from "../WorkflowStepSanitizer";
import { WorkflowLineageRepository } from "./WorkflowLineageRepository";

const RUN_CONTINUATION_ACTIONS = {
  EDIT: "edit",
} as const;

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
    action: "append" | "continue" | "edit" = "continue",
    allowActiveTargetAppend: boolean = false,
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
    const activeTargetAppend =
      allowActiveTargetAppend &&
      action === "append" &&
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
      !activeTargetAppend
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
    if (isAdoptableState && !allowInterruptedRun && !activeTargetAppend) {
      throw new Error(
        `Cannot ${action} while run is in state ${executionState}`
      );
    }
    return {
      definitionRevision: target.definitionRevision ?? 1,
      descriptorRevision: descriptor.revision,
      allowInterruptedRun: allowInterruptedRun || activeTargetAppend,
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
    position: QueuePosition = QUEUE_POSITION.END
  ): Promise<{
    workingFile: WorkingFile;
    definitionRevision: number;
    descriptorRevision: number;
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
        const sourceSteps = source.steps ?? [];
        const insertIndex = Math.max(
          resolveQueueInsertIndex(
            position,
            source._runtime?.currentIndex ?? sourceSteps.length,
            sourceSteps.length
          ),
          immutablePrefixLength(sourceSteps)
        );
        const steps = [...sourceSteps];
        steps.splice(
          insertIndex,
          0,
          ...tail.map((step) =>
            stripViewOnlyWorkflowStepFields(stripStepRuntime([step])[0])
          )
        );
        const workingFile: WorkingFile = {
          ...source,
          lastModifiedAt: Date.now(),
          definitionRevision: sourceRevision + 1,
          steps,
        };
        await writeWorkingFileAtomic(runFilePath, workingFile);
        return {
          workingFile,
          definitionRevision: workingFile.definitionRevision,
          descriptorRevision: descriptor.revision,
          insertIndex,
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

/**
 * Number of leading steps a cross-process insert must never shift. Only steps
 * that already recorded a terminal `completedAt` are immutable: their array
 * index is how `manifest.json`/`events.jsonl` address their recorded attempts,
 * so moving one would re-attribute recorded output to a different step. Pending
 * steps past the execution head stay editable, matching the in-process rule in
 * `PromptQueue.assertEditableDuringExecution`.
 */
function immutablePrefixLength(steps: WorkflowStep[]): number {
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
