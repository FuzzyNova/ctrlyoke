import type { WorkflowStep, WorkflowSummary } from "../types/CtrlYokeTypes";
import type {
  FinalStepPhase,
  ExecutionPhase,
  HarnessId,
  ExecutionMode,
  StatusMessageSeverity,
  StepStatus,
} from "../types/DashboardConstants";
import type {
  CliEvent,
  CliOutput,
  UndoExecutionTarget,
} from "../types/WebviewMessageTypes";
import type { WorkspaceSnapshot } from "../types/OutputHistoryTypes";
import type { IDashboardSink } from "../types/IDashboardSink";
import type { IDashboardProvider } from "./IDashboardProvider";
import { MESSAGE_TYPES } from "../types/DashboardConstants";
import type { CtrlYokeNotificationEvent } from "./notifications/CompletionNotificationFactory";

export type DashboardClient = IDashboardProvider & Partial<IDashboardSink>;

/**
 * Broadcasts dashboard updates to every registered dashboard client.
 *
 * All clients (the VS Code panel and browser WebSocket connections)
 * receive ACTIVE_WORKFLOW_CHANGED exclusively through per-client paths such
 * as replayWorkflowStateTo() — never via the hub. The hub's role is limited
 * to broadcasting workflow-registry events and generic messages.
 */
export class DashboardBroadcastHub
  implements IDashboardProvider, IDashboardSink
{
  private readonly clients: DashboardClient[] = [];

  addClient(client: DashboardClient): void {
    if (!this.clients.includes(client)) {
      this.clients.push(client);
    }
  }

  removeClient(client: DashboardClient): void {
    const index = this.clients.indexOf(client);
    if (index !== -1) {
      this.clients.splice(index, 1);
    }
  }

  notifyWorkflowAdded(summary: WorkflowSummary): void {
    for (const client of this.clients) {
      client.notifyWorkflowAdded(summary);
    }
  }

  notifyWorkflowDismissed(workflowId: string): void {
    for (const client of this.clients) {
      client.notifyWorkflowDismissed(workflowId);
    }
  }

  notifyWorkflowSummaryUpdated(summary: WorkflowSummary): void {
    for (const client of this.clients) {
      client.notifyWorkflowSummaryUpdated(summary);
    }
  }

  /** No-op: ACTIVE_WORKFLOW_CHANGED is sent per-client via replayWorkflowStateTo, never broadcast. */
  notifyActiveWorkflowChanged(_workflowId: string): void {}

  async loadOutputHistoryForWorkflow(
    workflowFilePath: string,
    workflowInstanceId?: string
  ): Promise<void> {
    for (const client of this.clients) {
      await client.loadOutputHistoryForWorkflow?.(
        workflowFilePath,
        workflowInstanceId
      );
    }
  }

  notifyCliWatchOutput(
    workflowId: string,
    stepIndex: number,
    output: CliOutput
  ): void {
    for (const client of this.clients) {
      client.notifyCliWatchOutput(workflowId, stepIndex, output);
    }
  }

  notifyCliPromptsExtended(
    workflowId: string,
    steps: any[],
    definitionRevision?: number
  ): void {
    for (const client of this.clients) {
      client.notifyCliPromptsExtended(workflowId, steps, definitionRevision);
    }
  }

  notifyHarnessAvailability(
    harnessId: HarnessId,
    available: boolean,
    installHint: string
  ): void {
    for (const client of this.clients) {
      client.notifyHarnessAvailability(harnessId, available, installHint);
    }
  }

  postMessage(message: unknown): void {
    for (const client of this.clients) {
      client.postMessage(message);
    }
  }

  /** Broadcast STARTUP_COMPLETE to all currently-registered clients. */
  notifyStartupComplete(): void {
    for (const client of this.clients) {
      client.postMessage({ type: MESSAGE_TYPES.STARTUP_COMPLETE });
    }
  }

  /** No-op: full state is delivered per-client via replayWorkflowStateTo, never broadcast. */
  async updateFileSelected(): Promise<void> {}

  /** No-op: full state is delivered per-client via replayWorkflowStateTo, never broadcast. */
  async updateSessionRestored(): Promise<void> {}

  updateExecutionStarted(
    workflowId: string,
    fileName: string,
    totalSteps: number,
    isContinuation?: boolean,
    preserveStepCount?: number,
    isInjectMode?: boolean,
    executionMode?: ExecutionMode
  ): void {
    for (const client of this.clients) {
      if (executionMode !== undefined) {
        client.updateExecutionStarted?.(
          workflowId,
          fileName,
          totalSteps,
          isContinuation,
          preserveStepCount,
          isInjectMode,
          executionMode
        );
      } else if (isInjectMode !== undefined) {
        client.updateExecutionStarted?.(
          workflowId,
          fileName,
          totalSteps,
          isContinuation,
          preserveStepCount,
          isInjectMode
        );
      } else {
        client.updateExecutionStarted?.(
          workflowId,
          fileName,
          totalSteps,
          isContinuation,
          preserveStepCount
        );
      }
    }
  }

  updateProgress(current: number, total: number, workflowId?: string): void {
    for (const client of this.clients) {
      client.updateProgress?.(current, total, workflowId);
    }
  }

  updateExecutionState(state: string, workflowId?: string): void {
    for (const client of this.clients) {
      client.updateExecutionState?.(state, workflowId);
    }
  }

  updateExecutionCompleted(workflowId?: string): void {
    for (const client of this.clients) {
      client.updateExecutionCompleted?.(workflowId);
    }
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
    for (const client of this.clients) {
      client.updateStepStatus?.(stepIndex, status, details, workflowId);
    }
  }

  updateRetryAttempt(
    stepIndex: number,
    currentRetry: number,
    maxRetries: number,
    workflowId?: string
  ): void {
    for (const client of this.clients) {
      client.updateRetryAttempt?.(
        stepIndex,
        currentRetry,
        maxRetries,
        workflowId
      );
    }
  }

  updateCliOutput(
    stepIndex: number,
    output: unknown,
    workflowId?: string
  ): void {
    for (const client of this.clients) {
      client.updateCliOutput?.(stepIndex, output, workflowId);
    }
  }

  updateCliStreamingChunk(
    stepIndex: number,
    chunk: string,
    phase?: ExecutionPhase,
    workflowId?: string
  ): void {
    for (const client of this.clients) {
      client.updateCliStreamingChunk?.(stepIndex, chunk, phase, workflowId);
    }
  }

  updateCliStreamingEvents(
    stepIndex: number,
    events: CliEvent[],
    attemptIndex?: number,
    runIndex?: number,
    workflowId?: string
  ): void {
    for (const client of this.clients) {
      client.updateCliStreamingEvents?.(
        stepIndex,
        events,
        attemptIndex,
        runIndex,
        workflowId
      );
    }
  }

  updateContextWindow(
    stepIndex: number,
    used: number,
    size: number,
    workflowId?: string
  ): void {
    for (const client of this.clients) {
      client.updateContextWindow?.(stepIndex, used, size, workflowId);
    }
  }

  updateStatusMessage(
    stepIndex: number,
    message: string,
    severity?: StatusMessageSeverity,
    workflowId?: string,
    timestampMs?: number
  ): void {
    for (const client of this.clients) {
      client.updateStatusMessage?.(
        stepIndex,
        message,
        severity,
        workflowId,
        timestampMs
      );
    }
  }

  updateStepsExtended(
    steps: any[],
    finalStep?: WorkflowStep | null,
    executionState?: string,
    definitionRevision?: number,
    workflowId?: string
  ): void {
    for (const client of this.clients) {
      client.updateStepsExtended?.(
        steps,
        finalStep,
        executionState,
        definitionRevision,
        workflowId
      );
    }
  }

  updatePromptDeleted(
    fileName: string,
    steps: any[],
    finalStep?: WorkflowStep | null
  ): void {
    for (const client of this.clients) {
      client.updatePromptDeleted?.(fileName, steps, finalStep);
    }
  }

  updateFinalStep(finalStep: WorkflowStep | null, workflowId?: string): void {
    for (const client of this.clients) {
      client.updateFinalStep?.(finalStep, workflowId);
    }
  }

  updateFinalStepStatus(
    status: StepStatus | null,
    loopCount: number,
    phase: FinalStepPhase | null,
    workflowId?: string
  ): void {
    for (const client of this.clients) {
      client.updateFinalStepStatus?.(status, loopCount, phase, workflowId);
    }
  }

  updateFinalStepOutput(
    loopIndex: number,
    output: unknown,
    workflowId?: string
  ): void {
    for (const client of this.clients) {
      client.updateFinalStepOutput?.(loopIndex, output, workflowId);
    }
  }

  updateFinalStepStreamingChunk(
    loopIndex: number,
    chunk: string,
    phase?: ExecutionPhase,
    workflowId?: string
  ): void {
    for (const client of this.clients) {
      client.updateFinalStepStreamingChunk?.(
        loopIndex,
        chunk,
        phase,
        workflowId
      );
    }
  }

  updateFinalStepStreamingEvents(
    loopIndex: number,
    events: CliEvent[],
    attemptIndex?: number,
    runIndex?: number,
    workflowId?: string
  ): void {
    for (const client of this.clients) {
      client.updateFinalStepStreamingEvents?.(
        loopIndex,
        events,
        attemptIndex,
        runIndex,
        workflowId
      );
    }
  }

  notifyPromptsReordered(steps: WorkflowStep[], workflowId?: string): void {
    for (const client of this.clients) {
      client.notifyPromptsReordered?.(steps, workflowId);
    }
  }

  notifyUndoRedoSynced(): void {
    for (const client of this.clients) {
      client.notifyUndoRedoSynced?.();
    }
  }

  updateWorkflowName(name: string, workflowId?: string): void {
    for (const client of this.clients) {
      client.updateWorkflowName?.(name, workflowId);
    }
  }

  sendStepUndoDataUpdated(
    target: UndoExecutionTarget,
    workspaceSnapshot?: WorkspaceSnapshot
  ): void {
    for (const client of this.clients) {
      client.sendStepUndoDataUpdated?.(target, workspaceSnapshot);
    }
  }

  notifyNotificationEvent(event: CtrlYokeNotificationEvent): void {
    for (const client of this.clients) {
      client.notifyNotificationEvent?.(event);
    }
  }
}
