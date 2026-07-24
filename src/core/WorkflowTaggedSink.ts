import type { IDashboardSink } from "../types/IDashboardSink";
import type { CtrlYokeNotificationEvent } from "../ui/notifications/CompletionNotificationFactory";
import type {
  CliEvent,
  UndoExecutionTarget,
} from "../types/WebviewMessageTypes";
import type { WorkflowStep } from "../types/CtrlYokeTypes";
import type {
  FinalStepPhase,
  StepStatus,
  StatusMessageSeverity,
} from "../types/DashboardConstants";
import type { WorkspaceSnapshot } from "../types/OutputHistoryTypes";

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
    workflowProperties?: Record<string, unknown>
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
      properties
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
    workflowProperties?: Record<string, unknown>
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
      properties
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
    isInjectMode?: boolean
  ): void {
    // workflowId is already the first param here — pass through as-is.
    // Only pass isInjectMode when truthy to avoid adding a trailing undefined arg
    // that breaks deepStrictEqual assertions in tests.
    if (isInjectMode) {
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

  updateExecutionState(state: string): void {
    this.inner.updateExecutionState(state, this.workflowId);
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

  updateCliStreamingChunk(stepIndex: number, chunk: string): void {
    this.inner.updateCliStreamingChunk(stepIndex, chunk, this.workflowId);
  }

  updateCliStreamingEvents(
    stepIndex: number,
    events: CliEvent[],
    attemptIndex?: number,
    runIndex?: number
  ): void {
    this.inner.updateCliStreamingEvents(
      stepIndex,
      events,
      attemptIndex,
      runIndex,
      this.workflowId
    );
  }

  updateContextWindow(stepIndex: number, used: number, size: number): void {
    this.inner.updateContextWindow(stepIndex, used, size, this.workflowId);
  }

  updateStatusMessage(
    stepIndex: number,
    message: string,
    severity?: StatusMessageSeverity
  ): void {
    this.inner.updateStatusMessage(
      stepIndex,
      message,
      severity,
      this.workflowId
    );
  }

  updateStepsExtended(
    steps: any[],
    finalStep?: WorkflowStep | null,
    executionState?: string
  ): void {
    this.inner.updateStepsExtended(
      steps,
      finalStep,
      executionState,
      this.workflowId
    );
  }

  updatePromptDeleted(
    fileName: string,
    steps: any[],
    finalStep?: WorkflowStep | null
  ): void {
    this.inner.updatePromptDeleted(fileName, steps, finalStep);
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

  updateFinalStepStreamingChunk(loopIndex: number, chunk: string): void {
    this.inner.updateFinalStepStreamingChunk(loopIndex, chunk, this.workflowId);
  }

  updateFinalStepStreamingEvents(
    loopIndex: number,
    events: CliEvent[],
    attemptIndex?: number,
    runIndex?: number
  ): void {
    this.inner.updateFinalStepStreamingEvents(
      loopIndex,
      events,
      attemptIndex,
      runIndex,
      this.workflowId
    );
  }

  notifyPromptsReordered(steps: WorkflowStep[]): void {
    this.inner.notifyPromptsReordered(steps, this.workflowId);
  }

  notifyUndoRedoSynced(): void {
    this.inner.notifyUndoRedoSynced();
  }

  updateWorkflowName(name: string): void {
    this.inner.updateWorkflowName(name, this.workflowId);
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
}
