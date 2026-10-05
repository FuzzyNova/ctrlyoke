import type {
  ParallelGroupDefinition,
  WorkflowSummary,
  CoordinationScopeSnapshot,
} from "../types/CtrlYokeTypes";
import type { CliOutput } from "../types/WebviewMessageTypes";
import type { HarnessId } from "../types/DashboardConstants";
import type { HarnessAvailabilityReport } from "../types/WebviewMessageTypes";

/**
 * Platform-agnostic interface for pushing workflow state updates to the dashboard.
 * Implemented by CtrlYokeWebviewProvider (VS Code) and CtrlYokeServer (standalone).
 *
 * WorkflowOrchestrator depends only on this interface — never on the concrete
 * CtrlYokeWebviewProvider — so it can be reused in non-VS Code contexts.
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

  /** Broadcast the current execution-root coordination projection. */
  notifyCoordinationScopeUpdated?(scope: CoordinationScopeSnapshot): void;

  // ── CLI watch events ──────────────────────────────────────────────────────

  /** Send a live CLI output update for a CLI-managed workflow. */
  notifyCliWatchOutput(
    workflowId: string,
    stepIndex: number,
    output: CliOutput
  ): void;

  /** Notify that a CLI-managed workflow dynamically extended its queue. */
  notifyCliPromptsExtended(
    workflowId: string,
    steps: any[],
    definitionRevision?: number,
    parallelGroups?: ParallelGroupDefinition[]
  ): void;

  // ── Harness availability ──────────────────────────────────────────────────

  /** Update a single harness availability status and push the change to the UI. */
  notifyHarnessAvailability(
    harnessId: HarnessId,
    report: HarnessAvailabilityReport
  ): void;

  // ── Generic pass-through ──────────────────────────────────────────────────

  /**
   * Send any message to the dashboard.
   * Used by WorkflowInstance / WorkflowExecutor for fine-grained per-step
   * updates (progress, CLI output, step status, etc.).
   */
  postMessage(message: unknown): void;
}
