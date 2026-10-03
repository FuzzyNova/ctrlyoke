import * as fs from "fs/promises";
import type {
  WorkflowStep,
  WorkingFile,
  RunRef,
  WorkflowKey,
} from "../../types/CtrlYokeTypes";
import {
  ACTIVE_EXECUTION_STATES,
  EXECUTION_STATES,
} from "../../types/DashboardConstants";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import {
  stripLegacyWorkingFileLineageMetadata,
  getLineageLastModifiedAt,
} from "../../utils/WorkingFileMetadata";
import { WorkflowLineageRepository } from "./WorkflowLineageRepository";

export const MAX_GLOBAL_STATUS_RESULTS = 100;

export interface GlobalWorkflowStatusSelector {
  workflowKey?: WorkflowKey;
  runRef?: RunRef;
}

export interface GlobalWorkflowStatusResult {
  workspaceRoot: string;
  workflowCount: number;
  workflows: Array<Record<string, unknown>>;
  truncated: boolean;
  omittedCount: number;
  note?: string;
}

/** Collects the read-only executing-workflow projection shared by MCP and CLI. */
export class GlobalWorkflowStatusService {
  constructor(
    private readonly workspaceRoot: string,
    private readonly lineageRepository = new WorkflowLineageRepository()
  ) {}

  async getStatus(
    selector: GlobalWorkflowStatusSelector = {}
  ): Promise<GlobalWorkflowStatusResult> {
    if (selector.runRef !== undefined && selector.workflowKey === undefined) {
      throw new Error("global_status: runRef requires workflowKey");
    }
    if (selector.workflowKey !== undefined) {
      WorkflowPaths.assertValidWorkflowKey(selector.workflowKey);
    }
    if (selector.runRef !== undefined) {
      WorkflowPaths.assertValidRunRef(selector.runRef);
    }

    const workflowKeys = selector.workflowKey
      ? [selector.workflowKey]
      : await this.lineageRepository.listLineageKeys(this.workspaceRoot);
    const narrowed = selector.workflowKey !== undefined;
    const notes: string[] = [];
    const workflows = await Promise.all(
      workflowKeys.map(async (workflowKey) => {
        let filePath: string;
        let runRef: RunRef | null;
        try {
          if (selector.runRef) {
            filePath = WorkflowPaths.runFilePath(
              this.workspaceRoot,
              workflowKey,
              selector.runRef
            );
            runRef = selector.runRef;
          } else {
            const descriptor = await this.lineageRepository.readDescriptor(
              this.workspaceRoot,
              workflowKey
            );
            runRef = descriptor.latestRunRef ?? null;
            filePath = runRef
              ? WorkflowPaths.runFilePath(
                  this.workspaceRoot,
                  workflowKey,
                  runRef
                )
              : WorkflowPaths.draftFilePath(this.workspaceRoot, workflowKey);
          }
        } catch (error) {
          if (narrowed) {
            throw new Error(
              `global_status: no workflow '${workflowKey}' was found under ${this.workspaceRoot} (${describeError(error)}). Call global_status with no arguments to see the workflow keys that exist.`
            );
          }
          return null;
        }
        try {
          const content = await fs.readFile(filePath, "utf8");
          const data = stripLegacyWorkingFileLineageMetadata(
            JSON.parse(content) as WorkingFile
          );
          const runtime = data._runtime || {
            currentIndex: 0,
            executionState: EXECUTION_STATES.IDLE,
          };
          if (!ACTIVE_EXECUTION_STATES.has(runtime.executionState)) {
            if (narrowed) {
              notes.push(
                `${workflowKey}${runRef ? `/${runRef}` : " (never run)"} exists but is not executing (state: ${runtime.executionState}), so it is not listed here.`
              );
            }
            return null;
          }
          const allSteps = (data.steps || []) as WorkflowStep[];
          const descriptor = await this.lineageRepository.readDescriptor(
            this.workspaceRoot,
            workflowKey
          );
          const completedCount = allSteps.filter(
            (step) => step._runtime?.completedAt !== undefined
          ).length;
          return {
            workflowKey,
            runRef,
            workflowName: descriptor.workflowName,
            executionState: runtime.executionState,
            harness: data.harness ?? null,
            model: data.model ?? null,
            currentStep: runtime.currentIndex + 1,
            totalSteps: allSteps.length,
            completedSteps: completedCount,
            startedAt: data.startedAt ?? null,
            lastModifiedAt: await getLineageLastModifiedAt(
              this.workspaceRoot,
              workflowKey,
              descriptor.lastModifiedAt
            ),
            workingFile: filePath,
            runDirectory: WorkflowPaths.runDirectoryForWorkingFile(filePath),
            ...(runtime.worktree
              ? {
                  worktree: {
                    mode: runtime.worktree.mode,
                    branchName: runtime.worktree.branchName,
                    worktreePath: runtime.worktree.worktreePath,
                    lifecycleState: runtime.worktree.lifecycleState,
                    directoryState: runtime.worktree.directoryState,
                  },
                }
              : {}),
            ...(runtime.worktreeNotice
              ? { worktreeNotice: runtime.worktreeNotice }
              : {}),
          };
        } catch (error) {
          if (narrowed) {
            throw new Error(
              `global_status: workflow '${workflowKey}'${runRef ? ` run '${runRef}'` : ""} could not be read from ${filePath} (${describeError(error)}).`
            );
          }
          return null;
        }
      })
    );
    const validWorkflows = workflows.filter(
      (workflow): workflow is NonNullable<typeof workflow> => workflow !== null
    );
    const omittedCount = Math.max(
      0,
      validWorkflows.length - MAX_GLOBAL_STATUS_RESULTS
    );
    const limitedWorkflows = validWorkflows.slice(0, MAX_GLOBAL_STATUS_RESULTS);
    return {
      workspaceRoot: this.workspaceRoot,
      workflowCount: limitedWorkflows.length,
      workflows: limitedWorkflows,
      truncated: omittedCount > 0,
      omittedCount,
      ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
    };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
