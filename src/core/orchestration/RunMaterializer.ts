import * as fs from "fs";
import {
  EXECUTION_STATES,
  type ExecutionState,
} from "../../types/DashboardConstants";
import type {
  WorkflowKey,
  WorkflowLineageDescriptor,
  WorkingFile,
  WorkingFileRuntime,
} from "../../types/CtrlYokeTypes";
import {
  TIMELINE_EVENT_TYPES,
  type WorkflowTimelineEventDraft,
  type WorkflowDefinitionSnapshot,
} from "../../types/WorkflowTimelineTypes";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { WorkflowLineageRepository } from "./WorkflowLineageRepository";
import { OutputHistoryManager } from "./OutputHistoryManager";
import { TimelineRecorder } from "./TimelineRecorder";
import { WorkingFileManager } from "../WorkingFileManager";

export interface RunMaterializationInput {
  workspaceRoot: string;
  workflowName: string;
  definition: Record<string, unknown>;
  events: AsyncIterable<WorkflowTimelineEventDraft>;
  executionState?: ExecutionState;
  currentIndex?: number;
  runtimeState?: Partial<
    Pick<WorkingFileRuntime, "currentIndex" | "executionState">
  >;
  startedAt?: number;
  provenance: NonNullable<WorkflowLineageDescriptor["importedFrom"]>;
}

export interface MaterializedRun {
  workflowKey: WorkflowKey;
  runRef: import("../../types/CtrlYokeTypes").RunRef;
  runFilePath: string;
  manifestPath: string;
}

/** Shared disk pipeline for imported run sources. */
export class RunMaterializer {
  constructor(
    private readonly lineageRepository = new WorkflowLineageRepository(),
    private readonly timelineRecorder = new TimelineRecorder()
  ) {}

  async materialize(input: RunMaterializationInput): Promise<MaterializedRun> {
    const executionState =
      input.runtimeState?.executionState ??
      input.executionState ??
      EXECUTION_STATES.COMPLETED;
    if (
      executionState === EXECUTION_STATES.RUNNING ||
      executionState === EXECUTION_STATES.PAUSED ||
      executionState === EXECUTION_STATES.PAUSING ||
      executionState === EXECUTION_STATES.CANCELLING
    ) {
      throw new Error("Imported runs must have a settled execution state.");
    }
    const startedAt = input.startedAt ?? Date.now();
    const created = await this.lineageRepository.createLineage(
      input.workspaceRoot,
      input.workflowName,
      input.workflowName,
      undefined,
      undefined,
      { importedFrom: input.provenance }
    );
    let allocation:
      Awaited<ReturnType<WorkflowLineageRepository["allocateRun"]>> | undefined;
    try {
      allocation = await this.lineageRepository.allocateRun(
        input.workspaceRoot,
        created.workflowKey
      );
      const descriptor = await this.lineageRepository.readDescriptor(
        input.workspaceRoot,
        created.workflowKey
      );
      const steps = Array.isArray(input.definition.steps)
        ? input.definition.steps
        : [];
      const definition = {
        ...input.definition,
        startedAt,
        definitionRevision: 1,
        steps,
      } as WorkingFile;
      const workingFile: WorkingFile = {
        ...definition,
        _runtime: {
          currentIndex:
            input.runtimeState?.currentIndex ??
            input.currentIndex ??
            steps.length,
          executionState,
          executionEndTime: Date.now(),
        },
      };
      await WorkingFileManager.writeWorkingFileAtomic(
        allocation.stagingRunFilePath,
        workingFile
      );
      const initialDefinition: WorkflowDefinitionSnapshot = {
        workflowName: descriptor.workflowName,
        steps: workingFile.steps ?? [],
        finalStep: workingFile.finalStep,
        worktree: workingFile.worktree,
        parallelGroups: workingFile.parallelGroups,
      };
      const history = new OutputHistoryManager(input.workspaceRoot);
      const initialized = await history.initializeRunAt(
        created.workflowKey,
        allocation.runRef,
        allocation.stagingRunDir,
        allocation.runId,
        startedAt,
        [],
        initialDefinition
      );
      const manifestPath = initialized.filePath;
      if (!manifestPath)
        throw new Error("Could not initialize imported run history.");
      let batch: WorkflowTimelineEventDraft[] = [];
      for await (const event of input.events) {
        batch.push(event);
        if (batch.length === 250) {
          await this.timelineRecorder.appendEvents(manifestPath, batch);
          batch = [];
        }
      }
      if (batch.length)
        await this.timelineRecorder.appendEvents(manifestPath, batch);
      await history.finalizeRun(manifestPath, executionState, steps.length);
      await this.timelineRecorder.appendEvents(manifestPath, [
        {
          eventType: TIMELINE_EVENT_TYPES.RUN_IMPORTED,
          timestampMs: Date.now(),
          payload: {},
        },
      ]);
      await WorkingFileManager.publishAnchoredRun(
        input.workspaceRoot,
        created.workflowKey,
        allocation,
        workingFile,
        this.lineageRepository
      );
      await history.refreshSearchIndex();
      return {
        workflowKey: created.workflowKey,
        runRef: allocation.runRef,
        runFilePath: WorkflowPaths.runFilePath(
          input.workspaceRoot,
          created.workflowKey,
          allocation.runRef
        ),
        manifestPath: WorkflowPaths.manifestPath(
          input.workspaceRoot,
          created.workflowKey,
          allocation.runRef
        ),
      };
    } catch (error) {
      if (allocation)
        await fs.promises
          .rm(allocation.stagingRunDir, { recursive: true, force: true })
          .catch(() => undefined);
      await this.lineageRepository
        .removeIncompleteLineage(input.workspaceRoot, created.workflowKey)
        .catch(() => undefined);
      throw error;
    }
  }
}
