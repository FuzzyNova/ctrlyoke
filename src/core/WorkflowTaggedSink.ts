import type { IDashboardSink } from "../types/IDashboardSink";
import type { CtrlYokeNotificationEvent } from "../ui/notifications/CompletionNotificationFactory";
import type {
  CliEvent,
  UndoExecutionTarget,
} from "../types/WebviewMessageTypes";
import type {
  WorkflowStep,
  ParallelGroupDefinition,
  WorkflowViewAddress,
  WorktreeRunProjection,
} from "../types/CtrlYokeTypes";
import type {
  FinalStepPhase,
  ExecutionPhase,
  ExecutionMode,
  StepStatus,
  StatusMessageSeverity,
} from "../types/DashboardConstants";
import type { WorkspaceSnapshot } from "../types/OutputHistoryTypes";
import type { HarnessUsageSnapshot } from "../types/UsageTypes";

/**
 * WorkflowTaggedSink
 *
 * Thin proxy around IDashboardSink that injects `workflowId` into every
 * live-update method call. Each WorkflowInstance holds one of these wrapping
 * the DashboardBroadcastHub so all messages are automatically tagged without
 * changes to WorkflowInstance call sites.
 */
export class WorkflowTaggedSink implements IDashboardSink {
  constructor(
    private readonly inner: IDashboardSink,
    private readonly workflowId: string
  ) {}

  updateWorktreeMerge(
    address: Extract<WorkflowViewAddress, { kind: "run" }>,
    worktree: WorktreeRunProjection
  ): void {
    this.inner.updateWorktreeMerge(address, worktree);
  }

  async updateFileSelected(
    fileName: string,
    steps: any[],
    workflowName?: string,
    finalStep?: WorkflowStep | null,
    finalStepRuntime?: {
      status?: StepStatus;
      loopCount: number;
      phase: FinalStepPhase;
    },
    workflowIdOrProperties?: string | Record<string, unknown>,
    workflowProperties?: Record<string, unknown>,
    parallelGroups?: ParallelGroupDefinition[],
    activeStepIndices?: number[]
  ): Promise<void> {
    const properties =
      typeof workflowIdOrProperties === "string"
        ? workflowProperties
        : workflowIdOrProperties;
    return this.inner.updateFileSelected(
      fileName,
      steps,
      workflowName,
      finalStep,
      finalStepRuntime,
      this.workflowId,
      properties,
      parallelGroups,
      activeStepIndices
    );
  }

  async updateSessionRestored(
    fileName: string,
    steps: any[],
    results: any[],
    executionState: string,
    currentIndex: number,
    workflowName?: string,
    finalStep?: WorkflowStep | null,
    finalStepRuntime?: {
      status?: StepStatus;
      loopCount: number;
      phase: FinalStepPhase;
    },
    workflowIdOrProperties?: string | Record<string, unknown>,
    workflowProperties?: Record<string, unknown>,
    parallelGroups?: ParallelGroupDefinition[],
    activeStepIndices?: number[],
    definitionRevision?: number
  ): Promise<void> {
    const properties =
      typeof workflowIdOrProperties === "string"
        ? workflowProperties
        : workflowIdOrProperties;
    return this.inner.updateSessionRestored(
      fileName,
      steps,
      results,
      executionState,
      currentIndex,
      workflowName,
      finalStep,
      finalStepRuntime,
      this.workflowId,
      properties,
      parallelGroups,
      activeStepIndices,
      definitionRevision
    );
  }

  async loadOutputHistoryForWorkflow?(workflowFilePath: string): Promise<void> {
    return this.inner.loadOutputHistoryForWorkflow?.(
      workflowFilePath,
      this.workflowId
    );
  }

  updateExecutionStarted(
    workflowId: string,
    fileName: string,
    totalSteps: number,
    isContinuation?: boolean,
    preserveStepCount?: number,
    isInjectMode?: boolean,
    executionMode?: ExecutionMode
  ): void {
    // workflowId is already the first param here — pass through as-is.
    // Preserve the legacy argument shape when the optional fields are absent.
    if (executionMode !== undefined) {
      this.inner.updateExecutionStarted(
        workflowId,
        fileName,
        totalSteps,
        isContinuation,
        preserveStepCount,
        isInjectMode,
        executionMode
      );
    } else if (isInjectMode) {
      this.inner.updateExecutionStarted(
        workflowId,
        fileName,
        totalSteps,
        isContinuation,
        preserveStepCount,
        true
      );
    } else {
      this.inner.updateExecutionStarted(
        workflowId,
        fileName,
        totalSteps,
        isContinuation,
        preserveStepCount
      );
    }
  }

  updateProgress(current: number, total: number): void {
    this.inner.updateProgress(current, total, this.workflowId);
  }

  updateExecutionState(
    state: string,
    workflowIdOrActive?: string | number[],
    activeStepIndices?: number[]
  ): void {
    this.inner.updateExecutionState(
      state,
      this.workflowId,
      Array.isArray(workflowIdOrActive)
        ? workflowIdOrActive
        : activeStepIndices
    );
  }

  updateActiveStepIndices(activeStepIndices: number[]): void {
    this.inner.updateActiveStepIndices?.(activeStepIndices, this.workflowId);
  }

  updateExecutionCompleted?(): void {
    this.inner.updateExecutionCompleted?.(this.workflowId);
  }

  updateStepStatus(
    stepIndex: number,
    status: {
      state: string;
      duration?: number;
      message?: string;
      endConditionResult?: unknown;
    },
    details?: Record<string, unknown>
  ): void {
    this.inner.updateStepStatus(stepIndex, status, details, this.workflowId);
  }

  updateRetryAttempt(
    stepIndex: number,
    currentRetry: number,
    maxRetries: number
  ): void {
    this.inner.updateRetryAttempt(
      stepIndex,
      currentRetry,
      maxRetries,
      this.workflowId
    );
  }

  updateCliOutput(stepIndex: number, output: unknown): void {
    this.inner.updateCliOutput(stepIndex, output, this.workflowId);
  }

  updateCliStreamingChunk(
    stepIndex: number,
    chunk: string,
    phase?: ExecutionPhase,
    _workflowId?: string,
    timestampMs?: number,
    sequence?: number,
    attemptIndex?: number,
    runIndex?: number
  ): void {
    this.inner.updateCliStreamingChunk(
      stepIndex,
      chunk,
      phase,
      this.workflowId,
      timestampMs,
      sequence,
      attemptIndex,
      runIndex
    );
  }

  updateCliStreamingEvents(
    stepIndex: number,
    events: CliEvent[],
    attemptIndex?: number,
    runIndex?: number,
    _workflowId?: string,
    phase?: ExecutionPhase,
    timestampMs?: number,
    sequence?: number
  ): void {
    this.inner.updateCliStreamingEvents(
      stepIndex,
      events,
      attemptIndex,
      runIndex,
      this.workflowId,
      phase,
      timestampMs,
      sequence
    );
  }

  updateContextWindow(stepIndex: number, used: number, size: number): void {
    this.inner.updateContextWindow(stepIndex, used, size, this.workflowId);
  }

  updateStatusMessage(
    stepIndex: number,
    message: string,
    severity?: StatusMessageSeverity,
    _workflowId?: string,
    timestampMs?: number
  ): void {
    this.inner.updateStatusMessage(
      stepIndex,
      message,
      severity,
      this.workflowId,
      timestampMs
    );
  }

  updateStepsExtended(
    steps: any[],
    finalStep?: WorkflowStep | null,
    executionState?: string,
    definitionRevision?: number,
    _workflowId?: string,
    parallelGroups?: ParallelGroupDefinition[]
  ): void {
    this.inner.updateStepsExtended(
      steps,
      finalStep,
      executionState,
      definitionRevision,
      this.workflowId,
      parallelGroups
    );
  }

  updatePromptDeleted(
    fileName: string,
    steps: any[],
    finalStep?: WorkflowStep | null,
    parallelGroups?: ParallelGroupDefinition[]
  ): void {
    this.inner.updatePromptDeleted(fileName, steps, finalStep, parallelGroups);
  }

  updateFinalStep(finalStep: WorkflowStep | null): void {
    this.inner.updateFinalStep(finalStep, this.workflowId);
  }

  updateFinalStepStatus(
    status: StepStatus | null,
    loopCount: number,
    phase: FinalStepPhase | null
  ): void {
    this.inner.updateFinalStepStatus(status, loopCount, phase, this.workflowId);
  }

  updateFinalStepOutput(loopIndex: number, output: unknown): void {
    this.inner.updateFinalStepOutput(loopIndex, output, this.workflowId);
  }

  updateFinalStepStreamingChunk(
    loopIndex: number,
    chunk: string,
    phase?: ExecutionPhase,
    _workflowId?: string,
    timestampMs?: number,
    sequence?: number,
    attemptIndex?: number,
    runIndex?: number
  ): void {
    this.inner.updateFinalStepStreamingChunk(
      loopIndex,
      chunk,
      phase,
      this.workflowId,
      timestampMs,
      sequence,
      attemptIndex,
      runIndex
    );
  }

  updateFinalStepStreamingEvents(
    loopIndex: number,
    events: CliEvent[],
    attemptIndex?: number,
    runIndex?: number,
    _workflowId?: string,
    phase?: ExecutionPhase,
    timestampMs?: number,
    sequence?: number
  ): void {
    this.inner.updateFinalStepStreamingEvents(
      loopIndex,
      events,
      attemptIndex,
      runIndex,
      this.workflowId,
      phase,
      timestampMs,
      sequence
    );
  }

  notifyPromptsReordered(
    steps: WorkflowStep[],
    _workflowId?: string,
    parallelGroups?: ParallelGroupDefinition[]
  ): void {
    this.inner.notifyPromptsReordered(steps, this.workflowId, parallelGroups);
  }

  notifyUndoRedoSynced(): void {
    this.inner.notifyUndoRedoSynced();
  }

  updateWorkflowName(name: string): void {
    this.inner.updateWorkflowName(name, this.workflowId);
  }

  updateStepColor(
    index: number,
    color: string | null,
    definitionRevision?: number
  ): void {
    this.inner.updateStepColor(
      index,
      color,
      definitionRevision,
      this.workflowId
    );
  }

  sendStepUndoDataUpdated(
    target: UndoExecutionTarget,
    workspaceSnapshot?: WorkspaceSnapshot
  ): void {
    this.inner.sendStepUndoDataUpdated(target, workspaceSnapshot);
  }

  notifyNotificationEvent(event: CtrlYokeNotificationEvent): void {
    this.inner.notifyNotificationEvent?.(event);
  }

  updateHarnessUsage(snapshots: HarnessUsageSnapshot[]): void {
    this.inner.updateHarnessUsage(snapshots);
  }
}
