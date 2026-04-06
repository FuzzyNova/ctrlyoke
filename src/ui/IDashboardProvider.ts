import type { WorkflowSummary, PromptStep } from "../types/FlightPathTypes";
import type { CliOutput } from "../types/WebviewMessageTypes";
import type { StepStatus, FinalPromptPhase } from "../types/DashboardConstants";

/**
 * Platform-agnostic interface for pushing workflow state updates to the dashboard.
 * Implemented by FlightPathWebviewProvider (VS Code) and FlightPathServer (standalone).
 *
 * WorkflowOrchestrator depends only on this interface — never on the concrete
 * FlightPathWebviewProvider — so it can be reused in non-VS Code contexts.
 */
export interface IDashboardProvider {
  // ── Workflow registry events ──────────────────────────────────────────────

  /** Notify that a new workflow was registered in the running registry. */
  notifyWorkflowAdded(summary: WorkflowSummary): void;

  /** Notify that a workflow was removed from the running registry. */
  notifyWorkflowDismissed(workflowId: string): void;

  /** Notify that a workflow's execution summary (state/progress) changed. */
  notifyWorkflowSummaryUpdated(summary: WorkflowSummary): void;

  /** Notify that the active (displayed) workflow changed. */
  notifyActiveWorkflowChanged(workflowId: string): void;

  // ── State initialisation ──────────────────────────────────────────────────

  /** Update the dashboard when a workflow file is selected/loaded. */
  updateFileSelected(
    fileName: string,
    steps: any[],
    workflowName?: string,
    finalPrompt?: PromptStep | null,
    finalPromptRuntime?: {
      status?: StepStatus;
      loopCount: number;
      phase: FinalPromptPhase;
    }
  ): Promise<void>;

  /** Update the dashboard when a session is restored from a working file. */
  updateSessionRestored(
    fileName: string,
    steps: any[],
    results: any[],
    executionState: string,
    currentIndex: number,
    workflowName?: string,
    finalPrompt?: PromptStep | null,
    finalPromptRuntime?: {
      status?: StepStatus;
      loopCount: number;
      phase: FinalPromptPhase;
    }
  ): Promise<void>;

  // ── CLI watch events ──────────────────────────────────────────────────────

  /** Send a live CLI output update for a CLI-managed workflow. */
  notifyCliWatchOutput(
    workflowId: string,
    stepIndex: number,
    output: CliOutput
  ): void;

  /** Notify that a CLI-managed workflow dynamically extended its queue. */
  notifyCliPromptsExtended(workflowId: string, steps: any[]): void;

  // ── Harness availability ──────────────────────────────────────────────────

  /** Update a single harness availability status and push the change to the UI. */
  notifyHarnessAvailability(harnessId: string, available: boolean): void;

  // ── Generic pass-through ──────────────────────────────────────────────────

  /**
   * Send any message to the dashboard.
   * Used by WorkflowInstance / WorkflowExecutor for fine-grained per-step
   * updates (progress, CLI output, step status, etc.).
   */
  postMessage(message: unknown): void;
}
