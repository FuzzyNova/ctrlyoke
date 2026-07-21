import * as fs from "fs/promises";
import type {
  RunRef,
  WorkflowKey,
  WorkflowStep,
  WorkingFile,
} from "../../types/CtrlYokeTypes";
import { EXECUTION_STATES, LOCK_STATUS } from "../../types/DashboardConstants";
import { withFileLock } from "../../utils/FileLockUtils";
import {
  inspectWorkflowLock,
  readWorkflowLock,
} from "../../utils/WorkflowLockInspector";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import {
  stripStepRuntime,
  stripViewOnlyWorkflowStepFields,
} from "../WorkflowStepSanitizer";
import { WorkflowLineageRepository } from "./WorkflowLineageRepository";

export interface RunContinuationTarget {
  definitionRevision: number;
  descriptorRevision: number;
  allowInterruptedRun: boolean;
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
    action: "append" | "continue" = "continue",
    allowActiveTargetAppend: boolean = false
  ): Promise<RunContinuationTarget> {
    const [lock, lockStatus, descriptor] = await Promise.all([
      readWorkflowLock(workspaceRoot, workflowKey),
      inspectWorkflowLock(workspaceRoot, workflowKey),
      lineageRepository.readDescriptor(workspaceRoot, workflowKey),
    ]);
    const target = await this.readRun(workspaceRoot, workflowKey, runRef);
    const executionState =
      target._runtime?.executionState ?? EXECUTION_STATES.IDLE;
    const activeTargetAppend =
      allowActiveTargetAppend &&
      action === "append" &&
      lock !== null &&
      lockStatus !== LOCK_STATUS.STALE &&
      lock.runRef === runRef &&
      executionState === EXECUTION_STATES.RUNNING;
    if (lock && lockStatus !== LOCK_STATUS.STALE && !activeTargetAppend) {
      throw new Error("Another run in this workflow lineage is executing");
    }
    if (descriptor.pendingEdit) {
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
    if (executionState === EXECUTION_STATES.PAUSED) {
      throw new Error(
        `Cannot ${action} a paused run without its live execution owner`
      );
    }
    const allowInterruptedRun =
      executionState === EXECUTION_STATES.RUNNING &&
      (lockStatus === LOCK_STATUS.NONE || lockStatus === LOCK_STATUS.STALE);
    if (
      executionState === EXECUTION_STATES.RUNNING &&
      !allowInterruptedRun &&
      !activeTargetAppend
    ) {
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

  static async appendTailToRun(
    workspaceRoot: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    tail: WorkflowStep[],
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number,
    lineageRepository: WorkflowLineageRepository = new WorkflowLineageRepository(),
    allowInterruptedRun: boolean = false
  ): Promise<{
    workingFile: WorkingFile;
    definitionRevision: number;
    descriptorRevision: number;
  }> {
    if (tail.length === 0) {
      throw new Error("Append continuation requires at least one tail step");
    }
    const runFilePath = WorkflowPaths.runFilePath(
      workspaceRoot,
      workflowKey,
      runRef
    );
    return lineageRepository.mutateDescriptorAtRevision(
      workspaceRoot,
      workflowKey,
      expectedDescriptorRevision,
      async (descriptor) => {
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
            throw new Error(
              `Cannot append while run is in state ${sourceState}`
            );
          }
          const workingFile: WorkingFile = {
            ...source,
            lastModifiedAt: Date.now(),
            definitionRevision: sourceRevision + 1,
            steps: [
              ...(source.steps ?? []),
              ...tail.map((step) =>
                stripViewOnlyWorkflowStepFields(stripStepRuntime([step])[0])
              ),
            ],
          };
          await writeWorkingFileAtomic(runFilePath, workingFile);
          return {
            value: {
              workingFile,
              definitionRevision: workingFile.definitionRevision,
              descriptorRevision: expectedDescriptorRevision + 1,
            },
            descriptor,
          };
        });
      }
    );
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
