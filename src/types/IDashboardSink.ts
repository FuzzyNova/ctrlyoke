import type { CliEvent, UndoExecutionTarget } from "./WebviewMessageTypes";
import type { WorkflowStep } from "./CtrlYokeTypes";
import type {
  FinalStepPhase,
  ExecutionPhase,
  ExecutionMode,
  StepStatus,
  StatusMessageSeverity,
} from "./DashboardConstants";
import type { WorkspaceSnapshot } from "./OutputHistoryTypes";
import type { CtrlYokeNotificationEvent } from "../ui/notifications/CompletionNotificationFactory";

/**
 * IDashboardSink
 *
 * Minimal interface for posting state updates to the webview dashboard.
 * WorkflowInstance depends on this interface (not the concrete CtrlYokeWebviewProvider)
 * so it stays free of VS Code API imports.
 *
 * CtrlYokeWebviewProvider satisfies this interface structurally — no `implements`
 * declaration is required.
 */
export interface IDashboardSink {
  updateFileSelected(
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
  ): Promise<void>;

  updateSessionRestored(
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
  ): Promise<void>;

  loadOutputHistoryForWorkflow?(
    workflowFilePath: string,
    workflowInstanceId?: string
  ): Promise<void>;

  updateExecutionStarted(
    workflowId: string,
    fileName: string,
    totalSteps: number,
    isContinuation?: boolean,
    preserveStepCount?: number,
    isInjectMode?: boolean,
    executionMode?: ExecutionMode
  ): void;

  updateProgress(current: number, total: number, workflowId?: string): void;

  updateExecutionState(state: string, workflowId?: string): void;

  updateExecutionCompleted?(workflowId?: string): void;

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
  ): void;

  updateRetryAttempt(
    stepIndex: number,
    currentRetry: number,
    maxRetries: number,
    workflowId?: string
  ): void;

  updateCliOutput(
    stepIndex: number,
    output: unknown,
    workflowId?: string
  ): void;

  updateCliStreamingChunk(
    stepIndex: number,
    chunk: string,
    phase?: ExecutionPhase,
    workflowId?: string
  ): void;

  updateCliStreamingEvents(
    stepIndex: number,
    events: CliEvent[],
    attemptIndex?: number,
    runIndex?: number,
    workflowId?: string
  ): void;

  updateContextWindow(
    stepIndex: number,
    used: number,
    size: number,
    workflowId?: string
  ): void;

  updateStatusMessage(
    stepIndex: number,
    message: string,
    severity?: StatusMessageSeverity,
    workflowId?: string,
    /** Origination time on the extension-host clock. Must be threaded through to
     *  the webview rather than re-stamped on receipt — see PostMessageDashboardSink. */
    timestampMs?: number
  ): void;

  updateStepsExtended(
    steps: any[],
    finalStep?: WorkflowStep | null,
    executionState?: string,
    workflowId?: string
  ): void;

  updatePromptDeleted(
    fileName: string,
    steps: any[],
    finalStep?: WorkflowStep | null
  ): void;

  updateFinalStep(finalStep: WorkflowStep | null, workflowId?: string): void;

  updateFinalStepStatus(
    status: StepStatus | null,
    loopCount: number,
    phase: FinalStepPhase | null,
    workflowId?: string
  ): void;

  updateFinalStepOutput(
    loopIndex: number,
    output: unknown,
    workflowId?: string
  ): void;

  updateFinalStepStreamingChunk(
    loopIndex: number,
    chunk: string,
    phase?: ExecutionPhase,
    workflowId?: string
  ): void;

  updateFinalStepStreamingEvents(
    loopIndex: number,
    events: CliEvent[],
    attemptIndex?: number,
    runIndex?: number,
    workflowId?: string
  ): void;

  notifyPromptsReordered(steps: WorkflowStep[], workflowId?: string): void;

  /** Called after webview undo/redo to acknowledge the sync (no-op response needed; kept for extensibility). */
  notifyUndoRedoSynced(): void;

  updateWorkflowName(name: string, workflowId?: string): void;

  sendStepUndoDataUpdated(
    target: UndoExecutionTarget,
    workspaceSnapshot?: WorkspaceSnapshot
  ): void;

  /** Deliver a ctrlyoke notification event (completion or hook) to the sink. */
  notifyNotificationEvent?(event: CtrlYokeNotificationEvent): void;
}
