/**
 * Shared webview message types and data structures
 * SINGLE SOURCE OF TRUTH for all types shared between extension and React webview
 *
 * This file consolidates:
 * - CLI output data types (CliOutput)
 * - Prompt item types (PromptItem, ExecutionProperties)
 * - Message payload interfaces (InitMessageData, FileSelectedMessage, etc.)
 * - CLI event data interfaces (re-exported from CliOutputTypes for consistency)
 * - Retry and status types (RetryState, StatusMessage, etc.)
 *
 * Used by:
 * - Extension: src/ui/FlightPathWebviewProvider.ts
 * - React webview: src/ui/webview-react/store/workflowStore.ts
 * - React webview: src/ui/webview-react/components/**
 */

import {
  ExecutionState,
  FinalPromptPhase,
  StepStatus,
  HarnessId,
  MESSAGE_TYPES,
  STATUS_MESSAGE_SEVERITY,
  EXECUTION_MODES,
} from "./DashboardConstants";
import type { WorkflowSummary } from "./FlightPathTypes";
import type {
  CliEvent as CliOutputEvent,
  UniversalCliOutput,
  ToolResult,
} from "./CliOutputTypes";
import type {
  WorkspaceSnapshot,
  UndoExecutionTarget,
  OutputExecutionTarget,
  PromptChangeType,
  UndoRecord,
} from "./OutputHistoryTypes";

// ============================================================================
// IMPORT TYPES FROM DASHBOARDCONSTANTS
// ============================================================================

export {
  MESSAGE_TYPES,
  EXECUTION_STATES,
  STEP_STATUS,
  STATUS_MESSAGE_SEVERITY,
  EXECUTION_MODES,
  ACTION_TYPES,
  HARNESS_IDS,
  CLI_EVENT_TYPES,
  OPERATION_STATUS,
  type MessageType,
  type StatusMessageSeverity,
  type ActionType,
} from "./DashboardConstants";

// Re-export WorkflowSummary for multi-workflow coordination messages
export type { WorkflowSummary } from "./FlightPathTypes";

// ============================================================================
// MESSAGE TYPE HELPERS - Extract literal types from MESSAGE_TYPES constants
// ============================================================================

/** Severity level type (single source from STATUS_MESSAGE_SEVERITY) */
type StatusSeverity =
  (typeof STATUS_MESSAGE_SEVERITY)[keyof typeof STATUS_MESSAGE_SEVERITY];

/** Execution mode type (single source from EXECUTION_MODES) */
type ExecutionMode = (typeof EXECUTION_MODES)[keyof typeof EXECUTION_MODES];

// ============================================================================
// CLI OUTPUT DATA TYPES
// ============================================================================

/**
 * Token statistics for a CLI response
 */
export interface TokenStats {
  prompt: number;
  completion: number;
  /** Cache-read tokens (billed at reduced rate) */
  cached?: number;
  /** Cache-creation tokens — Claude only */
  cacheCreated?: number;
  /** Total input tokens occupying the context window (last API turn) */
  contextWindowUsed?: number;
  /** Model's total context window capacity in tokens */
  contextWindowSize?: number;
}

/**
 * CLI output for a step (unified across extension and webview)
 * May have multiple outputs for retries (stored in array by attemptIndex)
 * Single source of truth for all CLI response data
 */
export interface CliOutput {
  /** The prompt text that was sent */
  prompt: string;
  /** Plain text response (streaming or complete) */
  response: string;
  /** Structured output with tool calls, thinking blocks, and metadata (CLI only) */
  structured?: StructuredOutput;
  /** Execution time in seconds */
  elapsed: number;
  /** Token usage statistics */
  tokens?: TokenStats;
  /** Whether the response is still streaming */
  isStreaming: boolean;
  /** The CLI command executed (for debugging) */
  cliCommand?: string;
  /** The working directory where the command was executed */
  workingDirectory?: string;
  /** Timestamp when the output was created (milliseconds since epoch) */
  timestampMs?: number;
  /** Explicit attempt index: 0 = initial attempt, 1+ = retry
   * @default 0
   */
  attemptIndex?: number;
  /**
   * When true, the harness emits pre-formatted plain text (no markdown).
   * Set from provider config; carried on every CliOutput (streaming and final) so
   * the UI can skip the Streamdown pipeline even before the final parse completes.
   */
  rawTextOutput?: boolean;
}

// ============================================================================
// CLI EVENT DATA TYPES (Re-exported from CliOutputTypes for consistency)
// ============================================================================

/**
 * Re-export CLI event types from CliOutputTypes (single source of truth for CLI structures)
 * These types are used throughout the codebase for structured CLI output handling.
 */

// Re-export event data types
export type {
  CliEventData,
  TextData,
  BashCommandData,
  FileReadData,
  FileWriteData,
  FileEditData,
  FileDeleteData,
  McpToolCallData,
  WebSearchData,
  ThinkingBlock,
  ToolCall,
  ToolResultData,
  UniversalCliOutput,
  UnifiedDiffHunk,
} from "./CliOutputTypes";

// Alias for the detailed CliEvent type from CliOutputTypes
export type CliEvent = CliOutputEvent;

// Alias for tool result (from CliOutputTypes)
export type { ToolResult };

/**
 * Structured output with events (compatible with UniversalCliOutput)
 */
export type StructuredOutput = UniversalCliOutput;

/**
 * Status message for output display
 */
export interface OutputStatusMessage {
  message: string;
  severity: StatusSeverity;
  timestamp: string;
  timestampMs: number;
}

// ============================================================================
// PROMPT & WORKFLOW TYPES
// ============================================================================

/**
 * End condition configuration for prompt validation
 */
export interface EndConditionConfig {
  script: string;
  returns?: string;
  timeout?: number;
  maxRetries?: number;
  retryPrompt?: string;
}

/**
 * Prompt item shape (used in workflowStore and throughout webview)
 * Matches FlightPathTypes.PromptItem
 */
export interface PromptItem {
  name?: string;
  prompt: string;
  harness?: string;
  model?: string;
  agent?: string | null;
  skills?: string[] | null;
  resumeSession?: boolean;
  sessionId?: string | number;
  allowDynamicExtension?: boolean;
  endCondition?: EndConditionConfig | null;
  priorContext?: import("./FlightPathTypes").PriorContext;
  additionalArgs?: string | null;
  _runtime?: {
    harness?: string;
    model?: string;
    sessionId?: string;
    startedAt?: number;
    completedAt?: number;
    retryCount?: number;
    isRetry?: boolean;
    responseText?: string;
  };
  // Status for UI display
  status?: StepStatus;
}

/**
 * Retry state for a step
 */
export interface RetryState {
  currentRetry: number;
  maxRetries: number;
}

/**
 * Status message for a step
 */
export interface StatusMessage {
  message: string;
  severity: StatusSeverity;
  timestamp: number;
}

// ============================================================================
// MESSAGE PAYLOAD TYPES
// ============================================================================

/**
 * Initial state message (extension -> webview on ready)
 */
export interface InitMessageData {
  fileName: string;
  workflowName: string;
  prompts: PromptItem[];
  executionState: ExecutionState;
  currentIndex: number;
  results: any[];
  finalPrompt?: PromptItem | null;
  finalPromptStatus?: StepStatus | null;
  finalPromptLoopCount?: number;
  finalPromptPhase?: FinalPromptPhase | null;
  globalSettings: {
    harness: HarnessId;
    model: string;
    agent: string;
    executionMode: ExecutionMode;
    resumeSession: boolean;
    allowDynamicExtension: boolean;
  };
  workflowProperties: Record<string, any>;
  modelOptions: Record<HarnessId, Array<{ value: string; label: string }>>;
  harnessStatus: Record<
    string,
    { available: boolean; status: string; message?: string }
  >;
  availableAgents: Array<{ name: string; path: string; description?: string }>;
}

/**
 * File selected message (extension -> webview)
 */
export interface FileSelectedMessage {
  type: typeof MESSAGE_TYPES.FILE_SELECTED;
  fileName: string;
  prompts: PromptItem[];
  workflowName?: string;
  finalPrompt?: PromptItem | null;
  finalPromptStatus?: StepStatus | null;
  finalPromptLoopCount?: number;
  finalPromptPhase?: FinalPromptPhase | null;
}

/**
 * Session restored message (extension -> webview)
 */
export interface SessionRestoredMessage {
  type: typeof MESSAGE_TYPES.SESSION_RESTORED;
  fileName: string;
  prompts: PromptItem[];
  results: any[];
  executionState: ExecutionState;
  currentIndex: number;
  workflowName?: string;
  finalPrompt?: PromptItem | null;
  finalPromptStatus?: StepStatus | null;
  finalPromptLoopCount?: number;
  finalPromptPhase?: FinalPromptPhase | null;
}

/**
 * Execution started message (extension -> webview)
 */
export interface ExecutionStartedMessage {
  type: typeof MESSAGE_TYPES.EXECUTION_STARTED;
  fileName: string;
  totalSteps: number;
  /**
   * When true, this execution continues a previously completed run (prompts were appended).
   * The webview should preserve existing output for steps 0..preserveStepCount-1.
   */
  isContinuation?: boolean;
  /**
   * Number of steps from the previous run whose output should be preserved.
   * Only meaningful when isContinuation=true.
   */
  preserveStepCount?: number;
}

/**
 * Execution state changed message (extension -> webview)
 */
export interface ExecutionStateChangedMessage {
  type: typeof MESSAGE_TYPES.EXECUTION_STATE_CHANGED;
  state: ExecutionState;
}

/**
 * Progress update message (extension -> webview)
 */
export interface ProgressUpdateMessage {
  type: typeof MESSAGE_TYPES.PROGRESS_UPDATE;
  current: number;
  total: number;
}

/**
 * Step status changed message (extension -> webview)
 */
export interface StepStatusChangedMessage {
  type: typeof MESSAGE_TYPES.STEP_STATUS_CHANGED;
  stepIndex: number;
  status: StepStatus;
  details?: any;
}

/**
 * Retry attempt changed message (extension -> webview)
 */
export interface RetryAttemptChangedMessage {
  type: typeof MESSAGE_TYPES.RETRY_ATTEMPT_CHANGED;
  stepIndex: number;
  currentRetry: number;
  maxRetries: number;
}

/**
 * CLI output message (extension -> webview)
 */
export interface CliOutputMessage {
  type: typeof MESSAGE_TYPES.CLI_OUTPUT;
  stepIndex: number;
  output: CliOutput;
}

/**
 * CLI streaming chunk message (extension -> webview)
 */
export interface CliStreamingChunkMessage {
  type: typeof MESSAGE_TYPES.CLI_STREAMING_CHUNK;
  stepIndex: number;
  chunk: string;
}

/**
 * CLI streaming events message (extension -> webview)
 */
export interface CliStreamingEventsMessage {
  type: typeof MESSAGE_TYPES.CLI_STREAMING_EVENTS;
  stepIndex: number;
  events: CliEvent[];
}

/**
 * Status message (extension -> webview)
 */
export interface StatusMessageMessage {
  type: typeof MESSAGE_TYPES.STATUS_MESSAGE;
  stepIndex: number;
  message: string;
  severity: StatusSeverity;
}

/**
 * Prompts extended message (extension -> webview)
 */
export interface PromptsExtendedMessage {
  type: typeof MESSAGE_TYPES.PROMPTS_EXTENDED;
  prompts: PromptItem[];
  finalPrompt?: PromptItem | null;
}

/**
 * Prompt deleted message (extension -> webview)
 */
export interface PromptDeletedMessage {
  type: typeof MESSAGE_TYPES.PROMPT_DELETED;
  fileName: string;
  prompts: PromptItem[];
  finalPrompt?: PromptItem | null;
}

/**
 * Update finalPrompt message (extension -> webview OR webview -> extension)
 */
export interface UpdateFinalPromptMessage {
  type: typeof MESSAGE_TYPES.UPDATE_FINAL_PROMPT;
  finalPrompt: PromptItem | null;
}

/**
 * finalPrompt runtime status changed message (extension -> webview)
 */
export interface FinalPromptStatusChangedMessage {
  type: typeof MESSAGE_TYPES.FINAL_PROMPT_STATUS_CHANGED;
  status: StepStatus | null;
  loopCount: number;
  phase: FinalPromptPhase | null;
}

/**
 * finalPrompt CLI output message (extension -> webview)
 */
export interface FinalPromptOutputMessage {
  type: typeof MESSAGE_TYPES.FINAL_PROMPT_OUTPUT;
  loopIndex: number;
  output: CliOutput;
}

/**
 * Model options update message (extension -> webview)
 */
export interface ModelOptionsUpdateMessage {
  type: typeof MESSAGE_TYPES.MODEL_OPTIONS_UPDATE;
  data: {
    modelOptions: Record<HarnessId, Array<{ value: string; label: string }>>;
  };
}

/**
 * Harness status update message (extension -> webview)
 */
export interface HarnessStatusUpdateMessage {
  type: typeof MESSAGE_TYPES.HARNESS_STATUS_UPDATE;
  data: {
    harnessStatus: Record<
      string,
      { available: boolean; status: string; message?: string }
    >;
  };
}

/**
 * Agents update message (extension -> webview)
 */
export interface AgentsUpdateMessage {
  type: typeof MESSAGE_TYPES.AGENTS_UPDATE;
  data: {
    availableAgents: Array<{
      name: string;
      path: string;
      description?: string;
    }>;
  };
}

/**
 * Skills update message (extension -> webview)
 */
export interface SkillsUpdateMessage {
  type: typeof MESSAGE_TYPES.SKILLS_UPDATE;
  data: {
    availableSkills: Array<{
      name: string;
      path: string;
      description?: string;
    }>;
  };
}

/**
 * Workflow properties update message (extension -> webview)
 */
export interface WorkflowPropertiesUpdateMessage {
  type: typeof MESSAGE_TYPES.WORKFLOW_PROPERTIES_UPDATE;
  workflowProperties: Record<string, any>;
}

/**
 * Open new workflow modal message (extension -> webview)
 */
export interface OpenNewWorkflowModalMessage {
  type: typeof MESSAGE_TYPES.OPEN_NEW_WORKFLOW_MODAL;
  templates: Array<{
    id: string;
    name: string;
    description: string;
    variables?: Record<string, any>;
    isBuiltIn: boolean;
  }>;
  workflowsDir: string;
  defaultTemplateId?: string;
}

/**
 * Recent workflows message (extension -> webview)
 */
export interface RecentWorkflowsMessage {
  type: typeof MESSAGE_TYPES.RECENT_WORKFLOWS;
  workflows: Array<{ name: string; path: string; lastUsed: number }>;
}

/**
 * Save workflow dialog data message (extension -> webview)
 * Sent when the user clicks the Save button; provides the default path / format.
 */
export interface SaveWorkflowDialogDataMessage {
  type: typeof MESSAGE_TYPES.SAVE_WORKFLOW_DIALOG_DATA;
  defaultPath: string;
  defaultFormat: "yaml" | "json";
  workflowsDir: string;
}

/**
 * Workflow saved message (extension -> webview)
 */
export interface WorkflowSavedMessage {
  type: typeof MESSAGE_TYPES.WORKFLOW_SAVED;
  filePath: string;
}

/**
 * Workflow save failed message (extension -> webview)
 */
export interface WorkflowSaveFailedMessage {
  type: typeof MESSAGE_TYPES.WORKFLOW_SAVE_FAILED;
  error: string;
}

/**
 * Workflows list message (extension -> webview, multi-workflow coordination)
 */
export interface WorkflowsListMessage {
  type: typeof MESSAGE_TYPES.WORKFLOWS_LIST;
  workflows: WorkflowSummary[];
}

/**
 * Workflow added message (extension -> webview, multi-workflow coordination)
 */
export interface WorkflowAddedMessage {
  type: typeof MESSAGE_TYPES.WORKFLOW_ADDED;
  summary: WorkflowSummary;
}

/**
 * Workflow dismissed message (extension -> webview, multi-workflow coordination)
 */
export interface WorkflowDismissedMessage {
  type: typeof MESSAGE_TYPES.WORKFLOW_DISMISSED;
  workflowId: string;
}

/**
 * Workflow summary updated message (extension -> webview, multi-workflow coordination)
 */
export interface WorkflowSummaryUpdatedMessage {
  type: typeof MESSAGE_TYPES.WORKFLOW_SUMMARY_UPDATED;
  summary: WorkflowSummary;
}

/**
 * Active workflow changed message (extension -> webview, multi-workflow coordination)
 */
export interface ActiveWorkflowChangedMessage {
  type: typeof MESSAGE_TYPES.ACTIVE_WORKFLOW_CHANGED;
  workflowId: string;
}

/**
 * Global settings updated message (extension -> webview)
 */
export interface GlobalSettingsUpdatedMessage {
  type: typeof MESSAGE_TYPES.GLOBAL_SETTINGS_UPDATED;
  globalSettings: {
    harness: HarnessId;
    model: string;
    harnessDefaultModels?: Record<HarnessId, string>;
    harnessDefaultAdditionalArgs?: Record<HarnessId, string>;
    agent: string;
    skills?: string[];
    executionMode: ExecutionMode;
    resumeSession: boolean;
    allowDynamicExtension: boolean;
    respectGitignore?: boolean;
    confirmDeleteOperations?: boolean;
    confirmResetOperations?: boolean;
  };
}

/**
 * Reset workflow state message (extension -> webview, bidirectional)
 */
export interface ResetWorkflowStateMessage {
  type: typeof MESSAGE_TYPES.RESET_WORKFLOW_STATE;
  prompts: PromptItem[];
}

/**
 * Run history updated message (extension -> webview)
 */
export interface RunHistoryUpdatedMessage {
  type: typeof MESSAGE_TYPES.RUN_HISTORY_UPDATED;
  runCount: number;
  runTimestamps?: (number | undefined)[];
  runStates?: (string | undefined)[];
}

/**
 * Output history loaded message (extension -> webview)
 * NOTE: Uses `any` for `history` to avoid circular dependency with OutputHistoryTypes.
 */
export interface OutputHistoryLoadedMessage {
  type: typeof MESSAGE_TYPES.OUTPUT_HISTORY_LOADED;
  history: unknown;
  availableRuns: number;
  currentRunIndex: number;
  runTimestamps?: (number | undefined)[];
  runStates?: (string | undefined)[];
}

/**
 * Set start position message (webview -> extension)
 */
export interface SetStartPositionMessage {
  type: typeof MESSAGE_TYPES.SET_START_POSITION;
  toIndex: number;
}

/**
 * Set start position confirmed message (extension -> webview)
 */
export interface SetStartPositionConfirmedMessage {
  type: typeof MESSAGE_TYPES.SET_START_POSITION_CONFIRMED;
  prompts: PromptItem[];
  currentIndex: number;
}

/**
 * Reorder prompts message (webview -> extension)
 * newPendingOrder is an array of 0-based positions within the current pending
 * slice (not absolute indices into the full prompts array). Using slice-relative
 * positions avoids stale-index bugs after successive reorders.
 */
export interface ReorderPromptsMessage {
  type: typeof MESSAGE_TYPES.REORDER_PROMPTS;
  newPendingOrder: number[];
}

// ============================================================================
// PROMPT UNDO TYPES
// ============================================================================

// Re-export for webview consumers
export type {
  WorkspaceSnapshot,
  SnapshotFileChange,
  PromptChangeType,
  UndoExecutionTarget,
  UndoDialogScope,
  UndoRecord,
} from "./OutputHistoryTypes";

export type UndoFileAction = "delete" | "restore-content" | "git-restore";

export interface UndoFileInstruction {
  /** Workspace-relative POSIX path */
  path: string;
  action: UndoFileAction;
  /** Required when action === "restore-content" */
  contentToRestore?: string;
}

export interface UndoResult {
  restoredFiles: string[];
  failedFiles: Array<{ path: string; error: string }>;
  /** Instructions to re-apply the AI's changes (redo). Populated after a successful undo. */
  redoInstructions: UndoFileInstruction[];
}

/**
 * Attribution tier for undo candidates shown in the dialog.
 * tier1: event-attributed (high confidence — from CliOutput structured events)
 * tier2: snapshot-only (lower confidence — may include parallel workflow changes)
 */
export type UndoCandidateTier = "tier1" | "tier2";

export interface UndoFileCandidate {
  path: string;
  changeType: PromptChangeType;
  tier: UndoCandidateTier;
  /** Resolved undo instruction (null if non-undoable) */
  instruction: UndoFileInstruction | null;
  /** True if content capture was skipped — row shown as disabled */
  contentCaptureSkipped?: boolean;
  /** SHA-256 hash of content after prompt completed (for drift detection) */
  afterHash?: string;
  /** True when strategy=git and file was at HEAD before prompt */
  wasAtHead?: boolean;
  /** Old file content (before the AI edit) — for diff display in undo dialog */
  oldContent?: string;
  /** New file content (after the AI edit) — for diff display in undo dialog */
  newContent?: string;
  /** Structured diff hunks (Claude CLI) — for diff display in undo dialog */
  structuredPatch?: Array<{
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }>;
}

/**
 * Extension → Webview: emitted after a prompt target completes with live snapshot
 */
export interface StepUndoDataUpdatedMessage {
  type: typeof MESSAGE_TYPES.STEP_UNDO_DATA_UPDATED;
  target: UndoExecutionTarget;
  workspaceSnapshot?: WorkspaceSnapshot;
}

/**
 * Webview → Extension: request to restore selected files
 */
export interface UndoPromptChangesMessage {
  type: typeof MESSAGE_TYPES.UNDO_PROMPT_CHANGES;
  data: {
    requestId: string;
    target: UndoExecutionTarget;
    workspacePath: string;
    files: UndoFileInstruction[];
  };
}

/**
 * Extension → Webview: result of the restore operation
 */
export interface UndoPromptResultMessage {
  type: typeof MESSAGE_TYPES.UNDO_PROMPT_RESULT;
  data: {
    requestId: string;
    target: UndoExecutionTarget;
    restoredFiles: string[];
    failedFiles: Array<{ path: string; error: string }>;
  };
}

/** Extension → Webview: undo record updated (after undo/redo applied or on history load) */
export interface UndoRecordUpdatedMessage {
  type: typeof MESSAGE_TYPES.UNDO_RECORD_UPDATED;
  target: OutputExecutionTarget;
  undoRecord: UndoRecord;
}

/** Webview → Extension: request to redo previously undone changes */
export interface RedoPromptChangesMessage {
  type: typeof MESSAGE_TYPES.REDO_PROMPT_CHANGES;
  data: {
    requestId: string;
    target: OutputExecutionTarget;
    workspacePath: string;
    files: UndoFileInstruction[];
  };
}

/**
 * Union type for all incoming messages from extension to webview
 */
export type IncomingMessage =
  | { type: typeof MESSAGE_TYPES.INIT; data: InitMessageData }
  | FileSelectedMessage
  | SessionRestoredMessage
  | ExecutionStartedMessage
  | ExecutionStateChangedMessage
  | ProgressUpdateMessage
  | StepStatusChangedMessage
  | RetryAttemptChangedMessage
  | CliOutputMessage
  | CliStreamingChunkMessage
  | CliStreamingEventsMessage
  | StatusMessageMessage
  | UpdateFinalPromptMessage
  | FinalPromptStatusChangedMessage
  | FinalPromptOutputMessage
  | { type: typeof MESSAGE_TYPES.EXECUTION_COMPLETED }
  | PromptsExtendedMessage
  | PromptDeletedMessage
  | ModelOptionsUpdateMessage
  | HarnessStatusUpdateMessage
  | AgentsUpdateMessage
  | SkillsUpdateMessage
  | WorkflowPropertiesUpdateMessage
  | { type: typeof MESSAGE_TYPES.WORKFLOW_LOADED }
  | { type: typeof MESSAGE_TYPES.WORKFLOW_UNLOADED }
  | OpenNewWorkflowModalMessage
  | { type: typeof MESSAGE_TYPES.WORKFLOW_NAME_UPDATED; workflowName: string }
  | RecentWorkflowsMessage
  | { type: typeof MESSAGE_TYPES.TEMPLATE_INFO; template: any }
  | { type: typeof MESSAGE_TYPES.DEFAULT_TEMPLATE_SET; templateId: string }
  | { type: typeof MESSAGE_TYPES.WORKFLOW_CREATED; filePath: string }
  | {
      type: typeof MESSAGE_TYPES.COMPLETIONS_RESPONSE;
      completions: any[];
      trigger: string;
    }
  | {
      type: typeof MESSAGE_TYPES.ATTACHMENT_TOKEN_COUNTS_RESPONSE;
      /** Map from reference key (e.g. "file:src/foo.ts") to token count */
      counts: Record<string, number>;
    }
  | SaveWorkflowDialogDataMessage
  | WorkflowSavedMessage
  | WorkflowSaveFailedMessage
  | WorkflowsListMessage
  | WorkflowAddedMessage
  | WorkflowDismissedMessage
  | WorkflowSummaryUpdatedMessage
  | ActiveWorkflowChangedMessage
  | GlobalSettingsUpdatedMessage
  | ResetWorkflowStateMessage
  | RunHistoryUpdatedMessage
  | OutputHistoryLoadedMessage
  | SetStartPositionConfirmedMessage
  | StepUndoDataUpdatedMessage
  | UndoPromptResultMessage
  | UndoRecordUpdatedMessage;
