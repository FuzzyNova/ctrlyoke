import type { IDashboardSink } from "../types/IDashboardSink";
import type {
  CliEvent,
  UndoExecutionTarget,
} from "../types/WebviewMessageTypes";
import type { WorkflowStep } from "../types/FlightPathTypes";
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
    }
  ): Promise<void> {
    return this.inner.updateFileSelected(
      fileName,
      steps,
      workflowName,
      finalStep,
      finalStepRuntime,
      this.workflowId
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
    }
  ): Promise<void> {
    return this.inner.updateSessionRestored(
      fileName,
      steps,
      results,
      executionState,
      currentIndex,
      workflowName,
      finalStep,
      finalStepRuntime,
      this.workflowId
    );
  }

  async loadOutputHistoryForWorkflow?(workflowFilePath: string): Promise<void> {
    return this.inner.loadOutputHistoryForWorkflow?.(workflowFilePath);
  }

  updateExecutionStarted(
    workflowId: string,
    fileName: string,
    totalSteps: number,
    isContinuation?: boolean,
    preserveStepCount?: number
  ): void {
    // workflowId is already the first param here — pass through as-is
    this.inner.updateExecutionStarted(
      workflowId,
      fileName,
      totalSteps,
      isContinuation,
      preserveStepCount
    );
  }

  notifyRunHistoryUpdated(
    runCount: number,
    runTimestamps?: (number | undefined)[],
    runStates?: (string | undefined)[]
  ): void {
    this.inner.notifyRunHistoryUpdated(
      runCount,
      runTimestamps,
      runStates,
      this.workflowId
    );
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

  updateCliStreamingEvents(stepIndex: number, events: CliEvent[]): void {
    this.inner.updateCliStreamingEvents(stepIndex, events, this.workflowId);
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

  updateFinalStepStreamingEvents(loopIndex: number, events: CliEvent[]): void {
    this.inner.updateFinalStepStreamingEvents(
      loopIndex,
      events,
      this.workflowId
    );
  }

  notifyWorkflowStateReset(steps: any[]): void {
    this.inner.notifyWorkflowStateReset(steps, this.workflowId);
  }

  notifyStartPositionSet(steps: WorkflowStep[], currentIndex: number): void {
    this.inner.notifyStartPositionSet(steps, currentIndex, this.workflowId);
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
}
