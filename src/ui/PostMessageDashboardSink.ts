import {
  MESSAGE_TYPES,
  type StepStatus,
  type FinalStepPhase,
  type ExecutionPhase,
  type StatusMessageSeverity,
  type ExecutionMode,
  STATUS_MESSAGE_SEVERITY,
} from "../types/DashboardConstants";
import type { IDashboardSink } from "../types/IDashboardSink";
import type {
  CliEvent,
  UndoExecutionTarget,
} from "../types/WebviewMessageTypes";
import type {
  WorkflowStep,
  WorkflowViewAddress,
  WorktreeRunProjection,
  ParallelGroupDefinition,
} from "../types/CtrlYokeTypes";
import type { WorkspaceSnapshot } from "../types/OutputHistoryTypes";
import type { CtrlYokeNotificationEvent } from "./notifications/CompletionNotificationFactory";
import type { HarnessUsageSnapshot } from "../types/UsageTypes";
import { secretRedactionService } from "../utils/SecretRedactionService";

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
  private readonly send: (msg: unknown) => void;

  constructor(send: (msg: unknown) => void) {
    this.send = (message) => send(secretRedactionService.redactValue(message));
  }

  updateHarnessUsage(snapshots: HarnessUsageSnapshot[]): void {
    this.send({
      type: MESSAGE_TYPES.HARNESS_USAGE_UPDATED,
      snapshots,
    });
  }

  updateWorktreeMerge(
    address: Extract<WorkflowViewAddress, { kind: "run" }>,
    worktree: WorktreeRunProjection
  ): void {
    this.send({
      type: MESSAGE_TYPES.WORKTREE_MERGE_RESULT,
      address,
      worktree,
    });
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
    workflowId?: string,
    workflowProperties?: Record<string, unknown>,
    parallelGroups?: ParallelGroupDefinition[],
    activeStepIndices?: number[]
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
      ...(parallelGroups !== undefined ? { parallelGroups } : {}),
      ...(activeStepIndices !== undefined ? { activeStepIndices } : {}),
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
    workflowProperties?: Record<string, unknown>,
    parallelGroups?: ParallelGroupDefinition[],
    activeStepIndices?: number[]
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
      ...(parallelGroups !== undefined ? { parallelGroups } : {}),
      ...(activeStepIndices !== undefined ? { activeStepIndices } : {}),
    });
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
    this.send({
      type: MESSAGE_TYPES.EXECUTION_STARTED,
      workflowId,
      fileName,
      totalSteps,
      ...(isContinuation ? { isContinuation: true, preserveStepCount } : {}),
      ...(isInjectMode ? { isInjectMode: true } : {}),
      ...(executionMode !== undefined ? { executionMode } : {}),
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

  updateExecutionState(
    state: string,
    workflowId?: string,
    activeStepIndices?: number[]
  ): void {
    this.send({
      type: MESSAGE_TYPES.EXECUTION_STATE_CHANGED,
      state,
      ...(workflowId !== undefined ? { workflowId } : {}),
      ...(activeStepIndices !== undefined ? { activeStepIndices } : {}),
    });
  }

  updateActiveStepIndices(
    activeStepIndices: number[],
    workflowId?: string
  ): void {
    this.send({
      type: MESSAGE_TYPES.ACTIVE_STEP_INDICES_CHANGED,
      activeStepIndices,
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
    phase?: ExecutionPhase,
    workflowId?: string,
    timestampMs?: number,
    sequence?: number,
    attemptIndex?: number,
    runIndex?: number
  ): void {
    this.send({
      type: MESSAGE_TYPES.CLI_STREAMING_CHUNK,
      stepIndex,
      chunk,
      ...(phase !== undefined ? { phase } : {}),
      ...(attemptIndex !== undefined ? { attemptIndex } : {}),
      ...(runIndex !== undefined ? { runIndex } : {}),
      ...(timestampMs !== undefined ? { timestampMs } : {}),
      ...(sequence !== undefined ? { sequence } : {}),
      ...(workflowId !== undefined ? { workflowId } : {}),
    });
  }

  updateCliStreamingEvents(
    stepIndex: number,
    events: CliEvent[],
    attemptIndex?: number,
    runIndex?: number,
    workflowId?: string,
    phase?: ExecutionPhase,
    timestampMs?: number,
    sequence?: number
  ): void {
    this.send({
      type: MESSAGE_TYPES.CLI_STREAMING_EVENTS,
      stepIndex,
      events,
      ...(attemptIndex !== undefined ? { attemptIndex } : {}),
      ...(runIndex !== undefined ? { runIndex } : {}),
      ...(phase !== undefined ? { phase } : {}),
      ...(timestampMs !== undefined ? { timestampMs } : {}),
      ...(sequence !== undefined ? { sequence } : {}),
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
    workflowId?: string,
    timestampMs?: number
  ): void {
    this.send({
      type: MESSAGE_TYPES.STATUS_MESSAGE,
      stepIndex,
      message,
      severity,
      ...(workflowId !== undefined ? { workflowId } : {}),
      ...(timestampMs !== undefined ? { timestampMs } : {}),
    });
  }

  updateStepsExtended(
    steps: any[],
    finalStep?: WorkflowStep | null,
    executionState?: string,
    definitionRevision?: number,
    workflowId?: string,
    parallelGroups?: ParallelGroupDefinition[]
  ): void {
    this.send({
      type: MESSAGE_TYPES.STEPS_EXTENDED,
      steps,
      finalStep: finalStep ?? null,
      ...(executionState !== undefined ? { executionState } : {}),
      ...(definitionRevision !== undefined ? { definitionRevision } : {}),
      ...(workflowId !== undefined ? { workflowId } : {}),
      ...(parallelGroups !== undefined ? { parallelGroups } : {}),
    });
  }

  updatePromptDeleted(
    fileName: string,
    steps: any[],
    finalStep?: WorkflowStep | null,
    parallelGroups?: ParallelGroupDefinition[]
  ): void {
    this.send({
      type: MESSAGE_TYPES.PROMPT_DELETED,
      fileName,
      steps,
      finalStep: finalStep ?? null,
      ...(parallelGroups !== undefined ? { parallelGroups } : {}),
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
    phase?: ExecutionPhase,
    workflowId?: string,
    timestampMs?: number,
    sequence?: number,
    attemptIndex?: number,
    runIndex?: number
  ): void {
    this.send({
      type: MESSAGE_TYPES.FINAL_PROMPT_STREAMING_CHUNK,
      loopIndex,
      chunk,
      ...(phase !== undefined ? { phase } : {}),
      ...(attemptIndex !== undefined ? { attemptIndex } : {}),
      ...(runIndex !== undefined ? { runIndex } : {}),
      ...(timestampMs !== undefined ? { timestampMs } : {}),
      ...(sequence !== undefined ? { sequence } : {}),
      ...(workflowId !== undefined ? { workflowId } : {}),
    });
  }

  updateFinalStepStreamingEvents(
    loopIndex: number,
    events: CliEvent[],
    attemptIndex?: number,
    runIndex?: number,
    workflowId?: string,
    phase?: ExecutionPhase,
    timestampMs?: number,
    sequence?: number
  ): void {
    this.send({
      type: MESSAGE_TYPES.FINAL_PROMPT_STREAMING_EVENTS,
      loopIndex,
      events,
      ...(attemptIndex !== undefined ? { attemptIndex } : {}),
      ...(runIndex !== undefined ? { runIndex } : {}),
      ...(phase !== undefined ? { phase } : {}),
      ...(timestampMs !== undefined ? { timestampMs } : {}),
      ...(sequence !== undefined ? { sequence } : {}),
      ...(workflowId !== undefined ? { workflowId } : {}),
    });
  }

  notifyPromptsReordered(
    steps: WorkflowStep[],
    workflowId?: string,
    parallelGroups?: ParallelGroupDefinition[]
  ): void {
    this.send({
      type: MESSAGE_TYPES.REORDER_PROMPTS_CONFIRMED,
      steps,
      ...(workflowId !== undefined ? { workflowId } : {}),
      ...(parallelGroups !== undefined ? { parallelGroups } : {}),
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

  notifyNotificationEvent(event: CtrlYokeNotificationEvent): void {
    this.send({
      type: MESSAGE_TYPES.NOTIFICATION_EVENT,
      event,
    });
  }
}
