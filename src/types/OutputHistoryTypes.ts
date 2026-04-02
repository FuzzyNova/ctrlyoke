import { ExecutionState, FINAL_PROMPT_PHASES } from "./DashboardConstants";
import type {
  WorkflowRuntimeCommand,
  WorkflowRuntimeState,
} from "./FlightPathTypes";
import {
  CliOutput,
  UndoFileInstruction,
} from "./WebviewMessageTypes";
import type { StatusMessage } from "./WebviewMessageTypes";
import type { UnifiedDiffHunk } from "./CliOutputTypes";

export type OutputExecutionTarget =
  | { kind: typeof FINAL_PROMPT_PHASES.QUEUE; stepIndex: number }
  | { kind: typeof FINAL_PROMPT_PHASES.FINAL_PROMPT; loopIndex: number };

export interface OrderedHistoryEntryBase {
  timestampMs: number;
  sequence: number;
}

export interface OrderedCliHistoryEntry extends OrderedHistoryEntryBase {
  kind: "cli";
  target: OutputExecutionTarget;
  attemptIndex: number;
  cliOutput: CliOutput;
}

export interface OrderedStatusHistoryEntry extends OrderedHistoryEntryBase {
  kind: "status";
  target: OutputExecutionTarget;
  statusMessage: StatusMessage;
}

export interface OrderedRuntimeHistoryEntry extends OrderedHistoryEntryBase {
  kind: "runtime";
  transition: {
    command: WorkflowRuntimeCommand;
    previous: WorkflowRuntimeState;
    current: WorkflowRuntimeState;
  };
}

export type OrderedHistoryEntry =
  | OrderedCliHistoryEntry
  | OrderedStatusHistoryEntry
  | OrderedRuntimeHistoryEntry;

/**
 * Complete output history for a single workflow run.
 * Timeline-backed runs are projected into this shape from
 * manifest.json + events.jsonl storage.
 */
export interface WorkflowOutputHistory {
  schemaVersion: "1.1.0";

  // Run metadata
  workflowId: string;
  runId: number;
  startedAt: number;
  completedAt?: number;
  executionState: ExecutionState;

  // Per-step outputs (keyed by stepIndex)
  promptOutputs: {
    [stepIndex: number]: StepOutput;
  };

  // Per-loop finalPrompt outputs (keyed by loopIndex)
  finalPromptOutputs?: {
    [loopIndex: number]: StepOutput;
  };

  // Canonical ordered entries for timeline-backed runs.
  orderedEntries: OrderedHistoryEntry[];
}

/**
 * Output data for a single workflow step.
 * Only stores workspace/undo metadata — CLI outputs and status messages
 * are stored in orderedEntries on WorkflowOutputHistory.
 */
export interface StepOutput {
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
