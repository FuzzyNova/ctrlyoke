import { ExecutionState } from "./DashboardConstants";
import { CliOutput, StatusMessage } from "./WebviewMessageTypes";

/**
 * Complete output history for a single workflow run.
 * Stored in .flightpath/.history/<workflow-id>/run-N-<timestamp>.json
 *
 * IMPORTANT: Uses CliOutput[] from WebviewMessageTypes.ts for per-step outputs.
 * Each CliOutput already contains .prompt (unexpanded prompt text) and .cliCommand,
 * so history rendering shows the same Prompt → CLI Command → Output view as live mode.
 *
 * History is rendered as a self-contained snapshot — all steps from this run are shown
 * regardless of how many prompts are currently in the workflow.
 */
export interface WorkflowOutputHistory {
  // Schema version for future migrations
  schemaVersion: "1.0.0";

  // Run metadata
  workflowId: string; // Working file basename (e.g., "workflow-2024-01-21T10-30-00")
  runId: number; // Sequential run number (1, 2, 3, ...)
  startedAt: number; // Run start timestamp (ms since epoch)
  completedAt?: number; // Run completion timestamp (undefined if incomplete)
  executionState: ExecutionState; // Final state (completed, error, stopped, etc.)

  // Total step count for this run (used to render all steps in order)
  // May differ from current workflow prompt count if prompts were added/deleted
  runStepCount: number;

  // Per-step outputs (keyed by stepIndex, indices 0..runStepCount-1)
  // Each CliOutput includes .prompt (unexpanded text) and .cliCommand for full fidelity
  promptOutputs: {
    [stepIndex: number]: StepOutput;
  };
}

/**
 * Output data for a single workflow step.
 * Stores the exact data from workflowStore for that step.
 *
 * CliOutput already contains:
 * - .prompt: the unexpanded prompt text shown in the output header
 * - .cliCommand: the actual CLI command that was run
 * - .response: the plain text response
 * - .structured: structured events (tool calls, thinking blocks, etc.)
 * - .tokens: token usage statistics
 * - .elapsed: execution time
 * - .timestampMs: when the output was created
 */
export interface StepOutput {
  /** All CLI outputs for this step (initial attempt + any retries) */
  cliOutputs: CliOutput[];
  /** Status messages for this step (e.g., "Prompt 1 started at 2:20 PM") */
  statusMessages: StatusMessage[];
}
