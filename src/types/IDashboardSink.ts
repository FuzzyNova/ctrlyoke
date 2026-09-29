import type { CliEvent, UndoExecutionTarget } from "./WebviewMessageTypes";
import type {
  WorkflowStep,
  WorkflowViewAddress,
  WorktreeRunProjection,
  ParallelGroupDefinition,
  WorkflowValidationWarning,
} from "./CtrlYokeTypes";
import type {
  FinalStepPhase,
  ExecutionPhase,
  ExecutionMode,
  StepStatus,
  StatusMessageSeverity,
} from "./DashboardConstants";
import type { WorkspaceSnapshot } from "./OutputHistoryTypes";
import type { CtrlYokeNotificationEvent } from "../ui/notifications/CompletionNotificationFactory";
import type { HarnessUsageSnapshot } from "./UsageTypes";

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
    workflowProperties?: Record<string, unknown>,
    parallelGroups?: ParallelGroupDefinition[],
    activeStepIndices?: number[],
    schemaWarnings?: WorkflowValidationWarning[]
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
    workflowProperties?: Record<string, unknown>,
    parallelGroups?: ParallelGroupDefinition[],
    activeStepIndices?: number[],
    definitionRevision?: number,
    schemaWarnings?: WorkflowValidationWarning[]
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

  updateExecutionState(
    state: string,
    workflowId?: string,
    activeStepIndices?: number[]
  ): void;

  updateActiveStepIndices?(
    activeStepIndices: number[],
    workflowId?: string
  ): void;

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
    workflowId?: string,
    timestampMs?: number,
    sequence?: number,
    attemptIndex?: number,
    runIndex?: number
  ): void;

  updateCliStreamingEvents(
    stepIndex: number,
    events: CliEvent[],
    attemptIndex?: number,
    runIndex?: number,
    workflowId?: string,
    phase?: ExecutionPhase,
    timestampMs?: number,
    sequence?: number
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
    definitionRevision?: number,
    workflowId?: string,
    parallelGroups?: ParallelGroupDefinition[],
    runtimePromotionUndoSuppressed?: boolean
  ): void;

  updateStepColor(
    index: number,
    color: string | null,
    definitionRevision?: number,
    workflowId?: string
  ): void;

  updatePromptDeleted(
    fileName: string,
    steps: any[],
    finalStep?: WorkflowStep | null,
    parallelGroups?: ParallelGroupDefinition[],
    definitionRevision?: number,
    workflowId?: string
  ): void;

  updateFinalStep(
    finalStep: WorkflowStep | null,
    workflowId?: string,
    definitionRevision?: number
  ): void;

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
    workflowId?: string,
    timestampMs?: number,
    sequence?: number,
    attemptIndex?: number,
    runIndex?: number
  ): void;

  updateFinalStepStreamingEvents(
    loopIndex: number,
    events: CliEvent[],
    attemptIndex?: number,
    runIndex?: number,
    workflowId?: string,
    phase?: ExecutionPhase,
    timestampMs?: number,
    sequence?: number
  ): void;

  notifyPromptsReordered(
    steps: WorkflowStep[],
    workflowId?: string,
    parallelGroups?: ParallelGroupDefinition[],
    definitionRevision?: number
  ): void;

  /** Called after webview undo/redo to acknowledge the sync (no-op response needed; kept for extensibility). */
  notifyUndoRedoSynced(): void;

  updateWorkflowName(
    name: string,
    workflowId?: string,
    definitionRevision?: number
  ): void;

  sendStepUndoDataUpdated(
    target: UndoExecutionTarget,
    workspaceSnapshot?: WorkspaceSnapshot,
    workflowId?: string
  ): void;

  /** Deliver a ctrlyoke notification event (completion or hook) to the sink. */
  notifyNotificationEvent?(event: CtrlYokeNotificationEvent): void;

  /** Broadcast normalized provider quota plus ctrlyoke-observed usage. */
  updateHarnessUsage(snapshots: HarnessUsageSnapshot[]): void;

  updateWorktreeMerge(
    address: Extract<WorkflowViewAddress, { kind: "run" }>,
    worktree: WorktreeRunProjection
  ): void;
}
