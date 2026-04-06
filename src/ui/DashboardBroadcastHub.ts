import type { WorkflowStep, WorkflowSummary } from "../types/FlightPathTypes";
import type {
  FinalPromptPhase,
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
 * The VS Code sidebar is the first client today. Hosted browser clients can be
 * added later without changing orchestrator or workflow-instance call sites.
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

  notifyActiveWorkflowChanged(workflowId: string): void {
    for (const client of this.clients) {
      client.notifyActiveWorkflowChanged(workflowId);
    }
  }

  async updateFileSelected(
    fileName: string,
    steps: any[],
    workflowName?: string,
    finalPrompt?: WorkflowStep | null,
    finalPromptRuntime?: {
      status?: StepStatus;
      loopCount: number;
      phase: FinalPromptPhase;
    }
  ): Promise<void> {
    for (const client of this.clients) {
      await client.updateFileSelected?.(
        fileName,
        steps,
        workflowName,
        finalPrompt,
        finalPromptRuntime
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
    finalPrompt?: WorkflowStep | null,
    finalPromptRuntime?: {
      status?: StepStatus;
      loopCount: number;
      phase: FinalPromptPhase;
    }
  ): Promise<void> {
    for (const client of this.clients) {
      await client.updateSessionRestored?.(
        fileName,
        steps,
        results,
        executionState,
        currentIndex,
        workflowName,
        finalPrompt,
        finalPromptRuntime
      );
    }
  }

  async loadOutputHistoryForWorkflow(workflowFilePath: string): Promise<void> {
    for (const client of this.clients) {
      await client.loadOutputHistoryForWorkflow?.(workflowFilePath);
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
    runStates?: (string | undefined)[]
  ): void {
    for (const client of this.clients) {
      client.notifyRunHistoryUpdated?.(runCount, runTimestamps, runStates);
    }
  }

  updateProgress(current: number, total: number): void {
    for (const client of this.clients) {
      client.updateProgress?.(current, total);
    }
  }

  updateExecutionState(state: string): void {
    for (const client of this.clients) {
      client.updateExecutionState?.(state);
    }
  }

  updateExecutionCompleted(): void {
    for (const client of this.clients) {
      client.updateExecutionCompleted?.();
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
    details?: Record<string, unknown>
  ): void {
    for (const client of this.clients) {
      client.updateStepStatus?.(stepIndex, status, details);
    }
  }

  updateRetryAttempt(
    stepIndex: number,
    currentRetry: number,
    maxRetries: number
  ): void {
    for (const client of this.clients) {
      client.updateRetryAttempt?.(stepIndex, currentRetry, maxRetries);
    }
  }

  updateCliOutput(stepIndex: number, output: unknown): void {
    for (const client of this.clients) {
      client.updateCliOutput?.(stepIndex, output);
    }
  }

  updateCliStreamingChunk(stepIndex: number, chunk: string): void {
    for (const client of this.clients) {
      client.updateCliStreamingChunk?.(stepIndex, chunk);
    }
  }

  updateCliStreamingEvents(stepIndex: number, events: CliEvent[]): void {
    for (const client of this.clients) {
      client.updateCliStreamingEvents?.(stepIndex, events);
    }
  }

  updateStatusMessage(
    stepIndex: number,
    message: string,
    severity?: StatusMessageSeverity
  ): void {
    for (const client of this.clients) {
      client.updateStatusMessage?.(stepIndex, message, severity);
    }
  }

  updateStepsExtended(
    steps: any[],
    finalPrompt?: WorkflowStep | null,
    executionState?: string
  ): void {
    for (const client of this.clients) {
      client.updateStepsExtended?.(steps, finalPrompt, executionState);
    }
  }

  updatePromptDeleted(
    fileName: string,
    steps: any[],
    finalPrompt?: WorkflowStep | null
  ): void {
    for (const client of this.clients) {
      client.updatePromptDeleted?.(fileName, steps, finalPrompt);
    }
  }

  updateFinalPrompt(finalPrompt: WorkflowStep | null): void {
    for (const client of this.clients) {
      client.updateFinalPrompt?.(finalPrompt);
    }
  }

  updateFinalPromptStatus(
    status: StepStatus | null,
    loopCount: number,
    phase: FinalPromptPhase | null
  ): void {
    for (const client of this.clients) {
      client.updateFinalPromptStatus?.(status, loopCount, phase);
    }
  }

  updateFinalPromptOutput(loopIndex: number, output: unknown): void {
    for (const client of this.clients) {
      client.updateFinalPromptOutput?.(loopIndex, output);
    }
  }

  updateFinalPromptStreamingChunk(loopIndex: number, chunk: string): void {
    for (const client of this.clients) {
      client.updateFinalPromptStreamingChunk?.(loopIndex, chunk);
    }
  }

  updateFinalPromptStreamingEvents(
    loopIndex: number,
    events: CliEvent[]
  ): void {
    for (const client of this.clients) {
      client.updateFinalPromptStreamingEvents?.(loopIndex, events);
    }
  }

  notifyWorkflowStateReset(steps: any[]): void {
    for (const client of this.clients) {
      client.notifyWorkflowStateReset?.(steps);
    }
  }

  notifyStartPositionSet(steps: WorkflowStep[], currentIndex: number): void {
    for (const client of this.clients) {
      client.notifyStartPositionSet?.(steps, currentIndex);
    }
  }

  notifyPromptsReordered(steps: WorkflowStep[]): void {
    for (const client of this.clients) {
      client.notifyPromptsReordered?.(steps);
    }
  }

  notifyUndoRedoSynced(): void {
    for (const client of this.clients) {
      client.notifyUndoRedoSynced?.();
    }
  }

  updateWorkflowName(name: string): void {
    for (const client of this.clients) {
      client.updateWorkflowName?.(name);
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
