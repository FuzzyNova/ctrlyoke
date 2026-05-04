import {
  MESSAGE_TYPES,
  type StepStatus,
  type FinalStepPhase,
  type StatusMessageSeverity,
  STATUS_MESSAGE_SEVERITY,
} from "../types/DashboardConstants";
import type { IDashboardSink } from "../types/IDashboardSink";
import type {
  CliEvent,
  UndoExecutionTarget,
} from "../types/WebviewMessageTypes";
import type { WorkflowStep } from "../types/FlightPathTypes";
import type { WorkspaceSnapshot } from "../types/OutputHistoryTypes";
import type { FlightPathNotificationEvent } from "./notifications/CompletionNotificationFactory";

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
    finalStepRuntime?: {
      status?: StepStatus;
      loopCount: number;
      phase: FinalStepPhase;
    },
    workflowId?: string,
    workflowProperties?: Record<string, unknown>
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
      ...(workflowId !== undefined ? { workflowId } : {}),
      ...(workflowProperties !== undefined ? { workflowProperties } : {}),
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
    finalStepRuntime?: {
      status?: StepStatus;
      loopCount: number;
      phase: FinalStepPhase;
    },
    workflowId?: string,
    workflowProperties?: Record<string, unknown>
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
      ...(workflowId !== undefined ? { workflowId } : {}),
      ...(workflowProperties !== undefined ? { workflowProperties } : {}),
    });
  }

  updateExecutionStarted(
    workflowId: string,
    fileName: string,
    totalSteps: number,
    isContinuation?: boolean,
    preserveStepCount?: number,
    isInjectMode?: boolean
  ): void {
    this.send({
      type: MESSAGE_TYPES.EXECUTION_STARTED,
      workflowId,
      fileName,
      totalSteps,
      ...(isContinuation ? { isContinuation: true, preserveStepCount } : {}),
      ...(isInjectMode ? { isInjectMode: true } : {}),
    });
  }

  notifyRunHistoryUpdated(
    runCount: number,
    runTimestamps?: (number | undefined)[],
    runStates?: (string | undefined)[],
    workflowId?: string
  ): void {
    this.send({
      type: MESSAGE_TYPES.RUN_HISTORY_UPDATED,
      runCount,
      runTimestamps,
      runStates,
      ...(workflowId !== undefined ? { workflowId } : {}),
    });
  }

  updateProgress(current: number, total: number, workflowId?: string): void {
    this.send({
      type: MESSAGE_TYPES.PROGRESS_UPDATE,
      current,
      total,
      ...(workflowId !== undefined ? { workflowId } : {}),
    });
  }

  updateExecutionState(state: string, workflowId?: string): void {
    this.send({
      type: MESSAGE_TYPES.EXECUTION_STATE_CHANGED,
      state,
      ...(workflowId !== undefined ? { workflowId } : {}),
    });
  }

  updateExecutionCompleted(workflowId?: string): void {
    this.send({
      type: MESSAGE_TYPES.EXECUTION_COMPLETED,
      ...(workflowId !== undefined ? { workflowId } : {}),
    });
  }

  updateStepStatus(
    stepIndex: number,
    status: {
      state: string;
      duration?: number;
      message?: string;
      endConditionResult?: unknown;
    },
    details?: Record<string, unknown>,
    workflowId?: string
  ): void {
    this.send({
      type: MESSAGE_TYPES.STEP_STATUS_CHANGED,
      stepIndex,
      status,
      details,
      ...(workflowId !== undefined ? { workflowId } : {}),
    });
  }

  updateRetryAttempt(
    stepIndex: number,
    currentRetry: number,
    maxRetries: number,
    workflowId?: string
  ): void {
    this.send({
      type: MESSAGE_TYPES.RETRY_ATTEMPT_CHANGED,
      stepIndex,
      currentRetry,
      maxRetries,
      ...(workflowId !== undefined ? { workflowId } : {}),
    });
  }

  updateCliOutput(
    stepIndex: number,
    output: unknown,
    workflowId?: string
  ): void {
    this.send({
      type: MESSAGE_TYPES.CLI_OUTPUT,
      stepIndex,
      output,
      ...(workflowId !== undefined ? { workflowId } : {}),
    });
  }

  updateCliStreamingChunk(
    stepIndex: number,
    chunk: string,
    workflowId?: string
  ): void {
    this.send({
      type: MESSAGE_TYPES.CLI_STREAMING_CHUNK,
      stepIndex,
      chunk,
      ...(workflowId !== undefined ? { workflowId } : {}),
    });
  }

  updateCliStreamingEvents(
    stepIndex: number,
    events: CliEvent[],
    attemptIndex?: number,
    runIndex?: number,
    workflowId?: string
  ): void {
    this.send({
      type: MESSAGE_TYPES.CLI_STREAMING_EVENTS,
      stepIndex,
      events,
      ...(attemptIndex !== undefined ? { attemptIndex } : {}),
      ...(runIndex !== undefined ? { runIndex } : {}),
      ...(workflowId !== undefined ? { workflowId } : {}),
    });
  }

  updateContextWindow(
    stepIndex: number,
    used: number,
    size: number,
    workflowId?: string
  ): void {
    this.send({
      type: MESSAGE_TYPES.CONTEXT_WINDOW_UPDATE,
      stepIndex,
      used,
      size,
      ...(workflowId !== undefined ? { workflowId } : {}),
    });
  }

  updateStatusMessage(
    stepIndex: number,
    message: string,
    severity: StatusMessageSeverity = STATUS_MESSAGE_SEVERITY.INFO,
    workflowId?: string
  ): void {
    this.send({
      type: MESSAGE_TYPES.STATUS_MESSAGE,
      stepIndex,
      message,
      severity,
      ...(workflowId !== undefined ? { workflowId } : {}),
    });
  }

  updateStepsExtended(
    steps: any[],
    finalStep?: WorkflowStep | null,
    executionState?: string,
    workflowId?: string
  ): void {
    this.send({
      type: MESSAGE_TYPES.STEPS_EXTENDED,
      steps,
      finalStep: finalStep ?? null,
      ...(executionState !== undefined ? { executionState } : {}),
      ...(workflowId !== undefined ? { workflowId } : {}),
    });
  }

  updatePromptDeleted(
    fileName: string,
    steps: any[],
    finalStep?: WorkflowStep | null
  ): void {
    this.send({
      type: MESSAGE_TYPES.PROMPT_DELETED,
      fileName,
      steps,
      finalStep: finalStep ?? null,
    });
  }

  updateFinalStep(finalStep: WorkflowStep | null, workflowId?: string): void {
    this.send({
      type: MESSAGE_TYPES.UPDATE_FINAL_PROMPT,
      finalStep,
      ...(workflowId !== undefined ? { workflowId } : {}),
    });
  }

  updateFinalStepStatus(
    status: StepStatus | null,
    loopCount: number,
    phase: FinalStepPhase | null,
    workflowId?: string
  ): void {
    this.send({
      type: MESSAGE_TYPES.FINAL_PROMPT_STATUS_CHANGED,
      status,
      loopCount,
      phase,
      ...(workflowId !== undefined ? { workflowId } : {}),
    });
  }

  updateFinalStepOutput(
    loopIndex: number,
    output: unknown,
    workflowId?: string
  ): void {
    this.send({
      type: MESSAGE_TYPES.FINAL_PROMPT_OUTPUT,
      loopIndex,
      output,
      ...(workflowId !== undefined ? { workflowId } : {}),
    });
  }

  updateFinalStepStreamingChunk(
    loopIndex: number,
    chunk: string,
    workflowId?: string
  ): void {
    this.send({
      type: MESSAGE_TYPES.FINAL_PROMPT_STREAMING_CHUNK,
      loopIndex,
      chunk,
      ...(workflowId !== undefined ? { workflowId } : {}),
    });
  }

  updateFinalStepStreamingEvents(
    loopIndex: number,
    events: CliEvent[],
    attemptIndex?: number,
    runIndex?: number,
    workflowId?: string
  ): void {
    this.send({
      type: MESSAGE_TYPES.FINAL_PROMPT_STREAMING_EVENTS,
      loopIndex,
      events,
      ...(attemptIndex !== undefined ? { attemptIndex } : {}),
      ...(runIndex !== undefined ? { runIndex } : {}),
      ...(workflowId !== undefined ? { workflowId } : {}),
    });
  }

  notifyWorkflowStateReset(steps: any[], workflowId?: string): void {
    this.send({
      type: MESSAGE_TYPES.RESET_WORKFLOW_STATE,
      steps,
      ...(workflowId !== undefined ? { workflowId } : {}),
    });
  }

  notifyStartPositionSet(
    steps: WorkflowStep[],
    currentIndex: number,
    workflowId?: string
  ): void {
    this.send({
      type: MESSAGE_TYPES.SET_START_POSITION_CONFIRMED,
      steps,
      currentIndex,
      ...(workflowId !== undefined ? { workflowId } : {}),
    });
  }

  notifyPromptsReordered(steps: WorkflowStep[], workflowId?: string): void {
    this.send({
      type: MESSAGE_TYPES.REORDER_PROMPTS_CONFIRMED,
      steps,
      ...(workflowId !== undefined ? { workflowId } : {}),
    });
  }

  notifyUndoRedoSynced(): void {
    // No-op — acknowledgement only.
  }

  updateWorkflowName(name: string, workflowId?: string): void {
    this.send({
      type: MESSAGE_TYPES.WORKFLOW_NAME_UPDATED,
      workflowName: name,
      ...(workflowId !== undefined ? { workflowId } : {}),
    });
  }

  sendStepUndoDataUpdated(
    target: UndoExecutionTarget,
    workspaceSnapshot?: WorkspaceSnapshot
  ): void {
    this.send({
      type: MESSAGE_TYPES.STEP_UNDO_DATA_UPDATED,
      target,
      workspaceSnapshot,
    });
  }

  notifyNotificationEvent(event: FlightPathNotificationEvent): void {
    this.send({
      type: MESSAGE_TYPES.NOTIFICATION_EVENT,
      event,
    });
  }
}
