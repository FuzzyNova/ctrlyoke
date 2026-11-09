import * as fs from "fs";
import {
  ACTIVE_EXECUTION_STATES,
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  NO_TURN_STARTED_STATUS,
  PROMPT_TERMINAL_STATUS,
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
  TIMELINE_ATTEMPT_TERMINAL_STATES,
  type WorkflowTimelineEventDraft,
  type WorkflowDefinitionSnapshot,
  type TimelineAttemptTerminalState,
} from "../../types/WorkflowTimelineTypes";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { WorkflowLineageRepository } from "./WorkflowLineageRepository";
import { OutputHistoryManager } from "./OutputHistoryManager";
import { TimelineRecorder } from "./TimelineRecorder";
import { WorkingFileManager } from "../WorkingFileManager";
import { getErrorMessage } from "../../utils/ErrorUtils";

export interface RunMaterializationInput {
  workspaceRoot: string;
  workflowName: string;
  definition: Record<string, unknown>;
  /** Full run working file when the source contains runtime step state. */
  workingFile?: WorkingFile;
  events: AsyncIterable<WorkflowTimelineEventDraft>;
  executionState?: ExecutionState;
  currentIndex?: number;
  runtimeState?: Partial<WorkingFileRuntime>;
  startedAt?: number;
  activeExecutionMs?: number;
  provenance: NonNullable<WorkflowLineageDescriptor["importedFrom"]>;
  beforeEvents?: (identity: {
    workflowKey: WorkflowKey;
    runRef: import("../../types/CtrlYokeTypes").RunRef;
  }) => Promise<{
    runtimeState?: Partial<WorkingFileRuntime>;
    rollback?: () => Promise<void>;
  }>;
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
    // History-only bundles predate (and intentionally omit) the live working
    // file. Preserve their step state by projecting it from the durable attempt
    // events before the working file and its initial definition are written.
    let events = input.events;
    if (!input.workingFile) {
      const buffered: WorkflowTimelineEventDraft[] = [];
      for await (const event of input.events) buffered.push(event);
      events = (async function* () {
        yield* buffered;
      })();
      input = {
        ...input,
        definition: projectAttemptRuntime(input.definition, buffered),
      };
    }
    const executionState =
      input.runtimeState?.executionState ??
      input.workingFile?._runtime?.executionState ??
      input.executionState ??
      EXECUTION_STATES.COMPLETED;
    if (ACTIVE_EXECUTION_STATES.has(executionState)) {
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
    let rollback: (() => Promise<void>) | undefined;
    try {
      allocation = await this.lineageRepository.allocateRun(
        input.workspaceRoot,
        created.workflowKey
      );
      const prepared = await input.beforeEvents?.({
        workflowKey: created.workflowKey,
        runRef: allocation.runRef,
      });
      rollback = prepared?.rollback;
      const descriptor = await this.lineageRepository.readDescriptor(
        input.workspaceRoot,
        created.workflowKey
      );
      const sourceFile = input.workingFile
        ? { ...input.definition, ...input.workingFile }
        : input.definition;
      const steps = Array.isArray(sourceFile.steps) ? sourceFile.steps : [];
      const definition = {
        ...sourceFile,
        startedAt,
        definitionRevision: 1,
        steps,
      } as WorkingFile;
      const workingFile: WorkingFile = {
        ...definition,
        _runtime: {
          ...(prepared?.runtimeState ??
            input.runtimeState ??
            input.workingFile?._runtime),
          currentIndex:
            prepared?.runtimeState?.currentIndex ??
            input.runtimeState?.currentIndex ??
            input.workingFile?._runtime?.currentIndex ??
            input.currentIndex ??
            steps.length,
          executionState:
            prepared?.runtimeState?.executionState ?? executionState,
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
      let terminalTimestamp: number | undefined;
      for await (const event of events) {
        if (event.eventType === TIMELINE_EVENT_TYPES.RUN_TERMINATED) {
          terminalTimestamp = event.timestampMs;
        }
        batch.push(event);
        if (batch.length === 250) {
          await this.timelineRecorder.appendEvents(manifestPath, batch);
          batch = [];
        }
      }
      if (batch.length)
        await this.timelineRecorder.appendEvents(manifestPath, batch);
      await history.finalizeRun(
        manifestPath,
        executionState,
        steps.length,
        input.activeExecutionMs,
        terminalTimestamp === undefined
          ? {}
          : {
              appendTerminationEvent: false,
              completedAt: terminalTimestamp,
            }
      );
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
      let rollbackError: unknown;
      try {
        await rollback?.();
      } catch (cleanupError) {
        rollbackError = cleanupError;
      }
      if (allocation)
        await fs.promises
          .rm(allocation.stagingRunDir, { recursive: true, force: true })
          .catch(() => undefined);
      await this.lineageRepository
        .removeIncompleteLineage(input.workspaceRoot, created.workflowKey)
        .catch(() => undefined);
      if (rollbackError) {
        throw new Error(
          `${getErrorMessage(error)}; imported workspace rollback failed: ${getErrorMessage(rollbackError)}`
        );
      }
      throw error;
    }
  }
}

function projectAttemptRuntime(
  definition: Record<string, unknown>,
  events: WorkflowTimelineEventDraft[]
): Record<string, unknown> {
  const queue = Array.isArray(definition.steps)
    ? (definition.steps as Array<Record<string, unknown>>)
    : [];
  const finalStep = definition.finalStep as Record<string, unknown> | undefined;
  const projections = new Map<string, Record<string, unknown>>();
  const keyOf = (target: unknown): string | undefined => {
    if (!target || typeof target !== "object") return undefined;
    const record = target as {
      kind?: string;
      stepIndex?: number;
      loopIndex?: number;
    };
    if (
      record.kind === FINAL_STEP_PHASES.QUEUE &&
      Number.isInteger(record.stepIndex)
    )
      return `queue:${record.stepIndex}`;
    if (
      record.kind === FINAL_STEP_PHASES.FINAL_STEP &&
      Number.isInteger(record.loopIndex)
    )
      return FINAL_STEP_PHASES.FINAL_STEP;
    return undefined;
  };
  const terminalStatus = (state: TimelineAttemptTerminalState) => {
    switch (state) {
      case TIMELINE_ATTEMPT_TERMINAL_STATES.COMPLETED:
        return PROMPT_TERMINAL_STATUS.COMPLETED;
      case TIMELINE_ATTEMPT_TERMINAL_STATES.FAILED:
        return PROMPT_TERMINAL_STATUS.FAILED;
      case TIMELINE_ATTEMPT_TERMINAL_STATES.CANCELLED:
      case TIMELINE_ATTEMPT_TERMINAL_STATES.STOPPED:
        return PROMPT_TERMINAL_STATUS.CANCELLED;
      case NO_TURN_STARTED_STATUS:
        return PROMPT_TERMINAL_STATUS.NO_TURN_STARTED;
      default:
        return undefined;
    }
  };
  for (const event of events) {
    const key = keyOf((event as { target?: unknown }).target);
    if (!key) continue;
    if (event.eventType === TIMELINE_EVENT_TYPES.ATTEMPT_STARTED) {
      const projection = projections.get(key) ?? {};
      projection.startedAt = event.timestampMs;
      delete projection.completedAt;
      delete projection.terminalStatus;
      projections.set(key, projection);
    } else if (event.eventType === TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED) {
      const projection = projections.get(key) ?? {};
      projection.completedAt = event.timestampMs;
      if (typeof projection.startedAt === "number") {
        projection.elapsed =
          Math.max(0, event.timestampMs - projection.startedAt) / 1000;
      }
      projection.terminalStatus = terminalStatus(event.payload.terminalState);
      projections.set(key, projection);
    }
  }
  const withRuntime = (step: Record<string, unknown>, key: string) => {
    const runtime = projections.get(key);
    return runtime ? { ...step, _runtime: { ...runtime } } : step;
  };
  return {
    ...definition,
    steps: queue.map((step, index) => withRuntime(step, `queue:${index}`)),
    ...(finalStep
      ? { finalStep: withRuntime(finalStep, FINAL_STEP_PHASES.FINAL_STEP) }
      : {}),
  };
}
