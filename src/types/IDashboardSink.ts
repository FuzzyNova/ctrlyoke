import type { CliEvent, UndoExecutionTarget } from "./WebviewMessageTypes";
import type { WorkflowStep } from "./FlightPathTypes";
import type {
  FinalStepPhase,
  StepStatus,
  StatusMessageSeverity,
} from "./DashboardConstants";
import type { WorkspaceSnapshot } from "./OutputHistoryTypes";

/**
 * IDashboardSink
 *
 * Minimal interface for posting state updates to the webview dashboard.
 * WorkflowInstance depends on this interface (not the concrete FlightPathWebviewProvider)
 * so it stays free of VS Code API imports.
 *
 * FlightPathWebviewProvider satisfies this interface structurally — no `implements`
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
    workflowId?: string
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
    workflowId?: string
  ): Promise<void>;

  loadOutputHistoryForWorkflow?(workflowFilePath: string): Promise<void>;

  updateExecutionStarted(
    workflowId: string,
    fileName: string,
    totalSteps: number,
    isContinuation?: boolean,
    preserveStepCount?: number
  ): void;

  notifyRunHistoryUpdated(
    runCount: number,
    runTimestamps?: (number | undefined)[],
    runStates?: (string | undefined)[],
    workflowId?: string
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
    workflowId?: string
  ): void;

  updateCliStreamingEvents(
    stepIndex: number,
    events: CliEvent[],
    workflowId?: string
  ): void;

  updateStatusMessage(
    stepIndex: number,
    message: string,
    severity?: StatusMessageSeverity,
    workflowId?: string
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
    workflowId?: string
  ): void;

  updateFinalStepStreamingEvents(
    loopIndex: number,
    events: CliEvent[],
    workflowId?: string
  ): void;

  notifyWorkflowStateReset(steps: any[], workflowId?: string): void;

  notifyStartPositionSet(
    steps: WorkflowStep[],
    currentIndex: number,
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
}
