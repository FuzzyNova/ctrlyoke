import {
  MESSAGE_TYPES,
  type StepStatus,
  type FinalStepPhase,
  type StatusMessageSeverity,
  STATUS_MESSAGE_SEVERITY,
} from "../types/DashboardConstants";
import type { IDashboardSink } from "../types/IDashboardSink";
import type { CliEvent, UndoExecutionTarget } from "../types/WebviewMessageTypes";
import type { WorkflowStep } from "../types/FlightPathTypes";
import type { WorkspaceSnapshot } from "../types/OutputHistoryTypes";

/**
 * PostMessageDashboardSink
 *
 * Implements IDashboardSink by constructing the appropriate message payload
 * for each event and forwarding it to a single `send` callback.
 *
 * Used by WorkflowOrchestrator.replayWorkflowStateTo() to replay a workflow's
 * full state to a single browser WebSocket client without going through the
 * DashboardBroadcastHub (which would affect all connected clients, including
 * the VS Code sidebar).
 */
export class PostMessageDashboardSink implements IDashboardSink {
  constructor(private readonly send: (msg: unknown) => void) {}

  async updateFileSelected(
    fileName: string,
    steps: any[],
    workflowName?: string,
    finalStep?: WorkflowStep | null,
    finalStepRuntime?: { status?: StepStatus; loopCount: number; phase: FinalStepPhase }
  ): Promise<void> {
    this.send({
      type: MESSAGE_TYPES.FILE_SELECTED,
      fileName,
      steps,
      workflowName,
      finalStep: finalStep ?? null,
      finalStepStatus: finalStepRuntime?.status ?? null,
      finalStepLoopCount: finalStepRuntime?.loopCount ?? 0,
      finalStepPhase: finalStepRuntime?.phase ?? null,
    });
  }

  async updateSessionRestored(
    fileName: string,
    steps: any[],
    results: any[],
    executionState: string,
    currentIndex: number,
    workflowName?: string,
    finalStep?: WorkflowStep | null,
    finalStepRuntime?: { status?: StepStatus; loopCount: number; phase: FinalStepPhase }
  ): Promise<void> {
    this.send({
      type: MESSAGE_TYPES.SESSION_RESTORED,
      fileName,
      steps,
      results,
      executionState,
      currentIndex,
      workflowName,
      finalStep: finalStep ?? null,
      finalStepStatus: finalStepRuntime?.status ?? null,
      finalStepLoopCount: finalStepRuntime?.loopCount ?? 0,
      finalStepPhase: finalStepRuntime?.phase ?? null,
    });
  }

  updateExecutionStarted(
    workflowId: string,
    fileName: string,
    totalSteps: number,
    isContinuation?: boolean,
    preserveStepCount?: number
  ): void {
    this.send({
      type: MESSAGE_TYPES.EXECUTION_STARTED,
      workflowId,
      fileName,
      totalSteps,
      ...(isContinuation ? { isContinuation: true, preserveStepCount } : {}),
    });
  }

  notifyRunHistoryUpdated(
    runCount: number,
    runTimestamps?: (number | undefined)[],
    runStates?: (string | undefined)[]
  ): void {
    this.send({ type: MESSAGE_TYPES.RUN_HISTORY_UPDATED, runCount, runTimestamps, runStates });
  }

  updateProgress(current: number, total: number): void {
    this.send({ type: MESSAGE_TYPES.PROGRESS_UPDATE, current, total });
  }

  updateExecutionState(state: string): void {
    this.send({ type: MESSAGE_TYPES.EXECUTION_STATE_CHANGED, state });
  }

  updateExecutionCompleted(): void {
    this.send({ type: MESSAGE_TYPES.EXECUTION_COMPLETED });
  }

  updateStepStatus(
    stepIndex: number,
    status: { state: string; duration?: number; message?: string; endConditionResult?: unknown },
    details?: Record<string, unknown>
  ): void {
    this.send({ type: MESSAGE_TYPES.STEP_STATUS_CHANGED, stepIndex, status, details });
  }

  updateRetryAttempt(stepIndex: number, currentRetry: number, maxRetries: number): void {
    this.send({ type: MESSAGE_TYPES.RETRY_ATTEMPT_CHANGED, stepIndex, currentRetry, maxRetries });
  }

  updateCliOutput(stepIndex: number, output: unknown): void {
    this.send({ type: MESSAGE_TYPES.CLI_OUTPUT, stepIndex, output });
  }

  updateCliStreamingChunk(stepIndex: number, chunk: string): void {
    this.send({ type: MESSAGE_TYPES.CLI_STREAMING_CHUNK, stepIndex, chunk });
  }

  updateCliStreamingEvents(stepIndex: number, events: CliEvent[]): void {
    this.send({ type: MESSAGE_TYPES.CLI_STREAMING_EVENTS, stepIndex, events });
  }

  updateStatusMessage(
    stepIndex: number,
    message: string,
    severity: StatusMessageSeverity = STATUS_MESSAGE_SEVERITY.INFO
  ): void {
    this.send({ type: MESSAGE_TYPES.STATUS_MESSAGE, stepIndex, message, severity });
  }

  updateStepsExtended(steps: any[], finalStep?: WorkflowStep | null, executionState?: string): void {
    this.send({
      type: MESSAGE_TYPES.STEPS_EXTENDED,
      steps,
      finalStep: finalStep ?? null,
      ...(executionState !== undefined ? { executionState } : {}),
    });
  }

  updatePromptDeleted(fileName: string, steps: any[], finalStep?: WorkflowStep | null): void {
    this.send({ type: MESSAGE_TYPES.PROMPT_DELETED, fileName, steps, finalStep: finalStep ?? null });
  }

  updateFinalStep(finalStep: WorkflowStep | null): void {
    this.send({ type: MESSAGE_TYPES.UPDATE_FINAL_PROMPT, finalStep });
  }

  updateFinalStepStatus(status: StepStatus | null, loopCount: number, phase: FinalStepPhase | null): void {
    this.send({ type: MESSAGE_TYPES.FINAL_PROMPT_STATUS_CHANGED, status, loopCount, phase });
  }

  updateFinalStepOutput(loopIndex: number, output: unknown): void {
    this.send({ type: MESSAGE_TYPES.FINAL_PROMPT_OUTPUT, loopIndex, output });
  }

  updateFinalStepStreamingChunk(loopIndex: number, chunk: string): void {
    this.send({ type: MESSAGE_TYPES.FINAL_PROMPT_STREAMING_CHUNK, loopIndex, chunk });
  }

  updateFinalStepStreamingEvents(loopIndex: number, events: CliEvent[]): void {
    this.send({ type: MESSAGE_TYPES.FINAL_PROMPT_STREAMING_EVENTS, loopIndex, events });
  }

  notifyWorkflowStateReset(steps: any[]): void {
    this.send({ type: MESSAGE_TYPES.RESET_WORKFLOW_STATE, steps });
  }

  notifyStartPositionSet(steps: WorkflowStep[], currentIndex: number): void {
    this.send({ type: MESSAGE_TYPES.SET_START_POSITION_CONFIRMED, steps, currentIndex });
  }

  notifyPromptsReordered(steps: WorkflowStep[]): void {
    this.send({ type: MESSAGE_TYPES.REORDER_PROMPTS_CONFIRMED, steps });
  }

  notifyUndoRedoSynced(): void {
    // No-op — acknowledgement only.
  }

  updateWorkflowName(name: string): void {
    this.send({ type: MESSAGE_TYPES.WORKFLOW_NAME_UPDATED, name });
  }

  sendStepUndoDataUpdated(target: UndoExecutionTarget, workspaceSnapshot?: WorkspaceSnapshot): void {
    this.send({ type: MESSAGE_TYPES.STEP_UNDO_DATA_UPDATED, target, workspaceSnapshot });
  }
}
