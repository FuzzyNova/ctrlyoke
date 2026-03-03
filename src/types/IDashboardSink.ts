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
    workflowName?: string
  ): Promise<void>;

  updateSessionRestored(
    fileName: string,
    prompts: any[],
    results: any[],
    executionState: string,
    currentIndex: number,
    workflowName?: string
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

  updatePromptsExtended(prompts: any[]): void;

  updatePromptDeleted(fileName: string, prompts: any[]): void;

  notifyWorkflowStateReset(prompts: any[]): void;

  applyPendingWorkflowProperties(): Promise<void>;
}
