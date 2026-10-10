import * as fs from "fs/promises";
import type {
  WorkflowStep,
  WorkingFile,
  WorkingFileWorktreeRuntime,
  RunRef,
  WorkflowKey,
} from "../../types/CtrlYokeTypes";
import {
  ACTIVE_EXECUTION_STATES,
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  WORKFLOW_LOCK_LIVENESS,
  type ExecutionState,
} from "../../types/DashboardConstants";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import {
  stripLegacyWorkingFileLineageMetadata,
  getLineageLastModifiedAt,
} from "../../utils/WorkingFileMetadata";
import { readWorkflowLockInspection } from "../../utils/WorkflowLockInspector";
import { WorkflowLineageRepository } from "./WorkflowLineageRepository";

export const MAX_GLOBAL_STATUS_RESULTS = 100;

export interface GlobalWorkflowStatusSelector {
  workflowKey?: WorkflowKey;
  runRef?: RunRef;
}

/** One executing workflow, as both MCP `global_status` and `ctrlyoke status` report it. */
export interface GlobalWorkflowStatusRow {
  workflowKey: WorkflowKey;
  runRef: RunRef | null;
  workflowName: string;
  executionState: ExecutionState;
  harness: string | null;
  model: string | null;
  /** 1-based position of the step being executed, or null while finalStep runs. */
  currentStep: number | null;
  /** 1-based final-step pass when finalStep is running; otherwise null. */
  finalStepPass: number | null;
  totalSteps: number;
  completedSteps: number;
  startedAt: number | null;
  lastModifiedAt: number | null;
  workingFile: string;
  runDirectory: string;
  worktree?: Pick<
    WorkingFileWorktreeRuntime,
    "mode" | "branchName" | "worktreePath" | "lifecycleState" | "directoryState"
  >;
  worktreeNotice?: string;
}

export interface GlobalWorkflowStatusResult {
  workspaceRoot: string;
  workflowCount: number;
  workflows: GlobalWorkflowStatusRow[];
  truncated: boolean;
  omittedCount: number;
  note?: string;
}

/**
 * Surface-specific wording for the errors this service raises. The service is
 * shared, but each caller names its own inputs: MCP tool arguments are
 * `workflowKey`/`runRef`, while the CLI's are `--workflow`/`--run`.
 */
export interface GlobalWorkflowStatusWording {
  /** Prefix naming the surface, e.g. the MCP tool name. */
  surface: string;
  /** Error when a run is selected without its workflow. */
  runRequiresWorkflow: string;
  /** Sentence telling the caller how to list the workflow keys that exist. */
  listWorkflowsHint: string;
}

/** MCP `global_status` wording; its strings are part of the tool's contract. */
export const MCP_GLOBAL_STATUS_WORDING: GlobalWorkflowStatusWording = {
  surface: "global_status",
  runRequiresWorkflow: "runRef requires workflowKey",
  listWorkflowsHint:
    "Call global_status with no arguments to see the workflow keys that exist.",
};

/** Collects the read-only executing-workflow projection shared by MCP and CLI. */
export class GlobalWorkflowStatusService {
  constructor(
    private readonly workspaceRoot: string,
    private readonly lineageRepository = new WorkflowLineageRepository(),
    private readonly wording: GlobalWorkflowStatusWording = MCP_GLOBAL_STATUS_WORDING
  ) {}

  async getStatus(
    selector: GlobalWorkflowStatusSelector = {}
  ): Promise<GlobalWorkflowStatusResult> {
    const { surface } = this.wording;
    if (selector.runRef !== undefined && selector.workflowKey === undefined) {
      throw new Error(`${surface}: ${this.wording.runRequiresWorkflow}`);
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
            const lockInspection = await readWorkflowLockInspection(
              this.workspaceRoot,
              workflowKey
            );
            if (
              lockInspection.liveness !== WORKFLOW_LOCK_LIVENESS.ABSENT &&
              lockInspection.lock.workflowKey === workflowKey
            ) {
              try {
                WorkflowPaths.assertValidRunRef(lockInspection.lock.runRef);
                const lockedRunPath = WorkflowPaths.runFilePath(
                  this.workspaceRoot,
                  workflowKey,
                  lockInspection.lock.runRef
                );
                await fs.access(lockedRunPath);
                runRef = lockInspection.lock.runRef;
              } catch {
                // An invalid or orphaned lock must not hide the latest run.
              }
            }
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
              `${surface}: no workflow '${workflowKey}' was found under ${this.workspaceRoot} (${describeError(error)}). ${this.wording.listWorkflowsHint}`
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
          const finalStepRunning =
            runtime.finalStep?.phase === FINAL_STEP_PHASES.FINAL_STEP;
          const totalSteps = allSteps.length;
          const row: GlobalWorkflowStatusRow = {
            workflowKey,
            runRef,
            workflowName: descriptor.workflowName,
            executionState: runtime.executionState,
            harness: data.harness ?? null,
            model: data.model ?? null,
            currentStep: finalStepRunning
              ? null
              : Math.min(runtime.currentIndex + 1, totalSteps),
            finalStepPass: finalStepRunning
              ? (runtime.finalStep?.loopCount ?? 0) + 1
              : null,
            totalSteps,
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
          return row;
        } catch (error) {
          if (narrowed) {
            throw new Error(
              `${surface}: workflow '${workflowKey}'${runRef ? ` run '${runRef}'` : ""} could not be read from ${filePath} (${describeError(error)}).`
            );
          }
          return null;
        }
      })
    );
    const validWorkflows = workflows.filter(
      (workflow): workflow is GlobalWorkflowStatusRow => workflow !== null
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
