import { ExecutionState, FINAL_PROMPT_PHASES } from "./DashboardConstants";
import {
  CliOutput,
  StatusMessage,
  UndoFileInstruction,
} from "./WebviewMessageTypes";
import type { UnifiedDiffHunk } from "./CliOutputTypes";

export type OutputExecutionTarget =
  | { kind: typeof FINAL_PROMPT_PHASES.QUEUE; stepIndex: number }
  | { kind: typeof FINAL_PROMPT_PHASES.FINAL_PROMPT; loopIndex: number };

export interface OutputTimelineEntry {
  key: string;
  target: OutputExecutionTarget;
  firstOutputAt: number;
}

/**
 * Complete output history for a single workflow run.
 *
 * Legacy runs are stored directly as .json files.
 * Timeline-backed runs are projected into this same shape from
 * manifest.json + events.jsonl storage so existing consumers stay stable.
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
  // 1.0.0 is retained for backward-compatible reads.
  schemaVersion: "1.0.0" | "1.1.0";

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

  // Per-loop finalPrompt outputs (keyed by loopIndex, indices 0..N)
  // Optional for backward compatibility with schemaVersion 1.0.0 histories.
  finalPromptOutputs?: {
    [loopIndex: number]: StepOutput;
  };

  // Chronological metadata for rendering mixed queue/finalPrompt outputs
  // without relying on numeric queue indices.
  outputTimeline?: OutputTimelineEntry[];
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
  /** Workspace snapshot captured around this step's execution (for undo) */
  workspaceSnapshot?: WorkspaceSnapshot;
  /** Undo record: set if user has applied undo for this step */
  undoRecord?: UndoRecord;
}

// UndoExecutionTarget is identical in shape to OutputExecutionTarget but semantically
// scoped to undo operations. Use a type alias to keep things DRY.
export type UndoExecutionTarget = OutputExecutionTarget;

/**
 * Record of an undo operation applied to a step's changes.
 * Persisted in StepOutput so history view can show redo buttons.
 */
export interface UndoRecord {
  /** Timestamp when undo was applied (ms since epoch) */
  appliedAt: number;
  /** Paths of files successfully restored */
  restoredFiles: string[];
  /**
   * Instructions to re-apply the AI's changes (redo).
   * Captured by reading current file content just before it was overwritten.
   */
  redoInstructions: UndoFileInstruction[];
  /** True while redo has been applied (undo available again) */
  isRedone?: boolean;
  /** Timestamp when redo was last applied */
  redoneAt?: number;
}

export type UndoDialogScope =
  | { mode: "prompt"; target: UndoExecutionTarget }
  | {
      mode: "singleFile";
      target: UndoExecutionTarget;
      attemptIndex: number;
      path: string;
    };

export type PromptChangeType = "created" | "modified" | "deleted";

export interface SnapshotFileChange {
  /** Workspace-relative POSIX path (forward slashes, no leading slash) */
  path: string;
  changeType: PromptChangeType;
  /**
   * Content to restore for 'deleted' files.
   * Undefined if content capture was skipped.
   */
  contentToRestore?: string;
  /** True if before-content was skipped due to size (>512 KB) or binary detection. */
  contentCaptureSkipped?: boolean;
  /**
   * SHA-256 of file content after the prompt completed.
   * Enables reliable drift detection: if current hash differs at dialog-open time,
   * show an amber warning "File has changed since this prompt completed".
   */
  afterHash?: string;
  /**
   * Structured patch (before→after) for modified files.
   * Used for display diff and prompt-level undo via reverse-patch.
   * More storage-efficient than full contentToRestore for modified files.
   * Always stored with LF-normalized line endings for consistent display.
   */
  structuredPatch?: UnifiedDiffHunk[];
  /**
   * Original line ending style of the file before the prompt ran.
   * Only set to 'crlf' when the before-content had CRLF endings.
   * Used by reverse-patch undo to restore the correct line endings
   * without needing to store the full file content.
   */
  lineEnding?: "crlf";
}

export interface WorkspaceSnapshot {
  /** Timestamp when the after-snapshot was captured */
  capturedAt: number;
  /** Strategy used to capture the snapshot ('git' or 'filesystem'). */
  strategy: "git" | "filesystem";
  /**
   * Files changed during this prompt that have NO structured event attribution.
   * May include changes from parallel workflows — shown with a warning in the dialog.
   */
  changedFiles: SnapshotFileChange[];
}
