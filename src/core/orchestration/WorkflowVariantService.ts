import type { HarnessId } from "../../types/DashboardConstants";
import { EXECUTION_STATES } from "../../types/DashboardConstants";
import type {
  WorkflowStep,
  WorkflowViewAddress,
  WorkingFile,
} from "../../types/CtrlYokeTypes";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { getErrorMessage } from "../../utils/ErrorUtils";
import {
  stripStepRuntime,
  stripViewOnlyWorkflowStepFields,
} from "../WorkflowStepSanitizer";
import { WorkingFileManager } from "../WorkingFileManager";
import {
  WorkflowLineageRepository,
  type CreatedLineage,
} from "./WorkflowLineageRepository";
import { WORKFLOW_VIEW_ADDRESS_KIND } from "../../types/DashboardConstants";

export interface WorkflowVariantRequest {
  source: WorkflowViewAddress;
  workflowName: string;
  overrides?: {
    harness?: HarnessId;
    model?: string;
  };
}

interface WorkingFileAccess {
  readWorkingFileFromDisk(workingFilePath: string): Promise<WorkingFile>;
  writeWorkingFileAtomic(
    workingFilePath: string,
    workingFile: WorkingFile
  ): Promise<void>;
}

function sanitizeStep(step: WorkflowStep): WorkflowStep {
  return stripViewOnlyWorkflowStepFields(stripStepRuntime([step])[0]);
}

/**
 * Creates an independent workflow lineage from one explicitly addressed draft
 * or run. This service owns no live workflow instance and is safe for future
 * CLI/MCP callers.
 */
export class WorkflowVariantService {
  private readonly workingFileManager: WorkingFileAccess;

  constructor(
    private readonly workspaceRoot: string,
    private readonly lineageRepository: WorkflowLineageRepository = new WorkflowLineageRepository(),
    workingFileManager: WorkingFileAccess = WorkingFileManager
  ) {
    this.workingFileManager = workingFileManager;
  }

  async createWorkflowVariant(
    request: WorkflowVariantRequest
  ): Promise<Extract<WorkflowViewAddress, { kind: "draft" }>> {
    if (!this.workspaceRoot) {
      throw new Error(
        "A workspace root is required to create a workflow variant"
      );
    }
    const workflowName = request.workflowName.trim();
    if (!workflowName) {
      throw new Error("Workflow name is required");
    }

    const sourceDescriptor = await this.lineageRepository.readDescriptor(
      this.workspaceRoot,
      request.source.workflowKey
    );
    const sourceFilePath = this.resolveSourceFilePath(request.source);
    const source =
      await this.workingFileManager.readWorkingFileFromDisk(sourceFilePath);
    const createdAt = Date.now();
    const workingFile = this.buildDraft(source, request.overrides, createdAt);

    let created: CreatedLineage | undefined;
    try {
      created = await this.lineageRepository.createLineage(
        this.workspaceRoot,
        workflowName,
        workflowName,
        sourceDescriptor.originalFile,
        {
          sourceWorkflowKey: request.source.workflowKey,
          ...(request.source.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN
            ? { sourceRunRef: request.source.runRef }
            : {}),
          sourceWorkflowName: sourceDescriptor.workflowName,
          variantCreatedAt: createdAt,
        }
      );
      await this.workingFileManager.writeWorkingFileAtomic(
        created.draftFilePath,
        workingFile
      );
    } catch (error) {
      if (created) {
        try {
          await this.lineageRepository.removeIncompleteLineage(
            this.workspaceRoot,
            created.workflowKey
          );
        } catch (rollbackError) {
          throw new Error(
            `Failed to create workflow variant: ${getErrorMessage(
              error
            )}; rollback also failed: ${getErrorMessage(rollbackError)}`
          );
        }
      }
      throw new Error(
        `Failed to create workflow variant: ${getErrorMessage(error)}`
      );
    }

    return {
      workflowKey: created.workflowKey,
      kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
    };
  }

  private resolveSourceFilePath(source: WorkflowViewAddress): string {
    return source.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN
      ? WorkflowPaths.runFilePath(
          this.workspaceRoot,
          source.workflowKey,
          source.runRef
        )
      : WorkflowPaths.draftFilePath(this.workspaceRoot, source.workflowKey);
  }

  private buildDraft(
    source: WorkingFile,
    overrides: WorkflowVariantRequest["overrides"],
    createdAt: number
  ): WorkingFile {
    const {
      _runtime: _sourceRuntime,
      startedAt: _sourceStartedAt,
      ...authoredDefinition
    } = source;
    return {
      ...authoredDefinition,
      startedAt: createdAt,
      definitionRevision: 1,
      steps: (source.steps ?? []).map(sanitizeStep),
      ...(source.finalStep
        ? { finalStep: sanitizeStep(source.finalStep) }
        : {}),
      ...(overrides?.harness ? { harness: overrides.harness } : {}),
      ...(overrides?.model ? { model: overrides.model } : {}),
      _runtime: {
        currentIndex: 0,
        executionState: EXECUTION_STATES.IDLE,
      },
    };
  }
}
