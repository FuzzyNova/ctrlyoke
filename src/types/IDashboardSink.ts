import type { CliEvent } from "./WebviewMessageTypes";
import type { PromptItem } from "./FlightPathTypes";
import type { FinalPromptPhase, StepStatus } from "./DashboardConstants";

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
    prompts: any[],
    workflowName?: string,
    finalPrompt?: PromptItem | null,
    finalPromptRuntime?: {
      status?: StepStatus;
      loopCount: number;
      phase: FinalPromptPhase;
    }
  ): Promise<void>;

  updateSessionRestored(
    fileName: string,
    prompts: any[],
    results: any[],
    executionState: string,
    currentIndex: number,
    workflowName?: string,
    finalPrompt?: PromptItem | null,
    finalPromptRuntime?: {
      status?: StepStatus;
      loopCount: number;
      phase: FinalPromptPhase;
    }
  ): Promise<void>;

  updateExecutionStarted(
    fileName: string,
    totalSteps: number,
    isContinuation?: boolean,
    preserveStepCount?: number
  ): void;

  notifyRunHistoryUpdated(
    runCount: number,
    runTimestamps?: (number | undefined)[],
    runStates?: (string | undefined)[]
  ): void;

  updateProgress(current: number, total: number): void;

  updateExecutionState(state: string): void;

  updateStepStatus(
    stepIndex: number,
    status: {
      state: string;
      duration?: number;
      message?: string;
      endConditionResult?: unknown;
    },
    details?: Record<string, unknown>
  ): void;

  updateRetryAttempt(
    stepIndex: number,
    currentRetry: number,
    maxRetries: number
  ): void;

  updateCliOutput(stepIndex: number, output: unknown): void;

  updateCliStreamingChunk(stepIndex: number, chunk: string): void;

  updateCliStreamingEvents(stepIndex: number, events: CliEvent[]): void;

  updatePromptsExtended(prompts: any[], finalPrompt?: PromptItem | null): void;

  updatePromptDeleted(
    fileName: string,
    prompts: any[],
    finalPrompt?: PromptItem | null
  ): void;

  updateFinalPrompt(finalPrompt: PromptItem | null): void;

  updateFinalPromptStatus(
    status: StepStatus | null,
    loopCount: number,
    phase: FinalPromptPhase | null
  ): void;

  updateFinalPromptOutput(loopIndex: number, output: unknown): void;

  notifyWorkflowStateReset(prompts: any[]): void;

  notifyStartPositionSet(prompts: PromptItem[], currentIndex: number): void;

  notifyPromptsReordered(prompts: PromptItem[]): void;
}
