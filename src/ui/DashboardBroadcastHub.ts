import type { WorkflowStep, WorkflowSummary } from "../types/FlightPathTypes";
import type {
  FinalStepPhase,
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

export type DashboardClient = IDashboardProvider & Partial<IDashboardSink>;

/**
 * Broadcasts dashboard updates to every registered dashboard client.
 *
 * One client is designated the "panel client" (the VS Code sidebar) via
 * setPanelClient(). Certain messages — notably ACTIVE_WORKFLOW_CHANGED — must
 * only go to the panel client, never broadcast. All other clients (browser
 * WebSocket connections) receive those messages only through per-client paths
 * such as replayWorkflowStateTo().
 */
export class DashboardBroadcastHub
  implements IDashboardProvider, IDashboardSink
{
  private readonly clients: DashboardClient[] = [];
  /** The VS Code sidebar panel — the only client that receives hub-driven ACTIVE_WORKFLOW_CHANGED. */
  private panelClient: DashboardClient | null = null;

  /**
   * Register the VS Code sidebar as the panel client.
   * Also adds it to the broadcast list via addClient().
   */
  setPanelClient(client: DashboardClient): void {
    this.panelClient = client;
    this.addClient(client);
  }

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
    if (this.panelClient === client) {
      this.panelClient = null;
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

  notifyActiveWorkflowChanged(workflowId: string): void {
    // ACTIVE_WORKFLOW_CHANGED is always per-client, never broadcast.
    // Only the VS Code sidebar panel receives it via the hub. Browser clients
    // receive it exclusively through replayWorkflowStateTo(), which sends directly
    // via the client's scoped postMessage.
    this.panelClient?.notifyActiveWorkflowChanged(workflowId);
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
    workflowId?: string
  ): Promise<void> {
    for (const client of this.clients) {
      await client.updateFileSelected?.(
        fileName,
        steps,
        workflowName,
        finalStep,
        finalStepRuntime,
        workflowId
      );
    }
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
    workflowId?: string
  ): Promise<void> {
    for (const client of this.clients) {
      await client.updateSessionRestored?.(
        fileName,
        steps,
        results,
        executionState,
        currentIndex,
        workflowName,
        finalStep,
        finalStepRuntime,
        workflowId
      );
    }
  }

  async loadOutputHistoryForWorkflow(workflowFilePath: string, workflowInstanceId?: string): Promise<void> {
    for (const client of this.clients) {
      await client.loadOutputHistoryForWorkflow?.(workflowFilePath, workflowInstanceId);
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

  notifyCliPromptsExtended(workflowId: string, steps: any[]): void {
    for (const client of this.clients) {
      client.notifyCliPromptsExtended(workflowId, steps);
    }
  }

  notifyHarnessAvailability(harnessId: string, available: boolean): void {
    for (const client of this.clients) {
      client.notifyHarnessAvailability(harnessId, available);
    }
  }

  postMessage(message: unknown): void {
    for (const client of this.clients) {
      client.postMessage(message);
    }
  }

  updateExecutionStarted(
    workflowId: string,
    fileName: string,
    totalSteps: number,
    isContinuation?: boolean,
    preserveStepCount?: number
  ): void {
    for (const client of this.clients) {
      client.updateExecutionStarted?.(
        workflowId,
        fileName,
        totalSteps,
        isContinuation,
        preserveStepCount
      );
    }
  }

  notifyRunHistoryUpdated(
    runCount: number,
    runTimestamps?: (number | undefined)[],
    runStates?: (string | undefined)[],
    workflowId?: string
  ): void {
    for (const client of this.clients) {
      client.notifyRunHistoryUpdated?.(
        runCount,
        runTimestamps,
        runStates,
        workflowId
      );
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
    workflowId?: string
  ): void {
    for (const client of this.clients) {
      client.updateCliStreamingChunk?.(stepIndex, chunk, workflowId);
    }
  }

  updateCliStreamingEvents(
    stepIndex: number,
    events: CliEvent[],
    workflowId?: string
  ): void {
    for (const client of this.clients) {
      client.updateCliStreamingEvents?.(stepIndex, events, workflowId);
    }
  }

  updateStatusMessage(
    stepIndex: number,
    message: string,
    severity?: StatusMessageSeverity,
    workflowId?: string
  ): void {
    for (const client of this.clients) {
      client.updateStatusMessage?.(stepIndex, message, severity, workflowId);
    }
  }

  updateStepsExtended(
    steps: any[],
    finalStep?: WorkflowStep | null,
    executionState?: string,
    workflowId?: string
  ): void {
    for (const client of this.clients) {
      client.updateStepsExtended?.(
        steps,
        finalStep,
        executionState,
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
    workflowId?: string
  ): void {
    for (const client of this.clients) {
      client.updateFinalStepStreamingChunk?.(loopIndex, chunk, workflowId);
    }
  }

  updateFinalStepStreamingEvents(
    loopIndex: number,
    events: CliEvent[],
    workflowId?: string
  ): void {
    for (const client of this.clients) {
      client.updateFinalStepStreamingEvents?.(loopIndex, events, workflowId);
    }
  }

  notifyWorkflowStateReset(steps: any[], workflowId?: string): void {
    for (const client of this.clients) {
      client.notifyWorkflowStateReset?.(steps, workflowId);
    }
  }

  notifyStartPositionSet(
    steps: WorkflowStep[],
    currentIndex: number,
    workflowId?: string
  ): void {
    for (const client of this.clients) {
      client.notifyStartPositionSet?.(steps, currentIndex, workflowId);
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
}
