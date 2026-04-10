/**
 * Shared webview message types and data structures
 * SINGLE SOURCE OF TRUTH for all types shared between extension and React webview
 *
 * This file consolidates:
 * - CLI output data types (CliOutput)
 * - Prompt item types (PromptStep, ExecutionProperties)
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
  FinalStepPhase,
  StepStatus,
  HarnessId,
  MESSAGE_TYPES,
  STATUS_MESSAGE_SEVERITY,
  EXECUTION_MODES,
  STEP_TYPES,
} from "./DashboardConstants";
import type {
  WorkflowSummary,
  McpServerConfig,
  PreCondition,
  PriorContext,
  ToolPermissionsOverride,
  UserHookConfig,
  WorkflowStep,
} from "./FlightPathTypes";
import type { FlightPathGlobalSettings } from "./FlightPathSettings";
import type {
  CliEvent as CliOutputEvent,
  UniversalCliOutput,
  ToolResult,
  UnifiedDiffHunk,
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

// Re-export WorkflowSummary, WorkflowStep, and PreCondition for webview consumers
export type {
  WorkflowSummary,
  WorkflowStep,
  ScriptStep,
  PreCondition,
} from "./FlightPathTypes";

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
  /**
   * Error message when the step failed before or during execution
   * (e.g., prompt send failure, session log not found).
   * When set, the UI renders this with a red border below the CLI command.
   */
  errorMessage?: string;
  /**
   * Source of this output — when "script", the output comes from a script step
   * (shell command, no AI interaction). The UI renders script output as plain
   * stdout/stderr text with an exit code summary rather than structured events.
   */
  source?: typeof STEP_TYPES.SCRIPT;
  /**
   * Exit code from the script step (source: "script" only).
   * 0 = success, non-zero = failure.
   */
  exitCode?: number;
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
 * Matches FlightPathTypes.PromptStep
 */
export interface PromptStep {
  /** Step type discriminant — defaults to "prompt" when absent */
  type?: typeof STEP_TYPES.PROMPT;
  name?: string;
  prompt: string;
  harness?: string;
  model?: string;
  agent?: string | null;
  skills?: string[] | null;
  resumeSession?: boolean;
  sessionId?: string | number;
  mcpServers?: (string | McpServerConfig)[] | null;
  hooks?: UserHookConfig[] | null;
  endCondition?: EndConditionConfig | null;
  preCondition?: PreCondition | null;
  priorContext?: PriorContext;
  additionalArgs?: string | null;
  toolPermissions?: ToolPermissionsOverride | null;
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
  steps: WorkflowStep[];
  executionState: ExecutionState;
  currentIndex: number;
  results: any[];
  finalStep?: WorkflowStep | null;
  finalStepStatus?: StepStatus | null;
  finalStepLoopCount?: number;
  finalStepPhase?: FinalStepPhase | null;
  globalSettings: {
    harness: HarnessId;
    model: string;
    agent: string;
    executionMode: ExecutionMode;
    resumeSession: boolean;
    mcpServers: (string | McpServerConfig)[];
    hooks: UserHookConfig[];
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
  steps: WorkflowStep[];
  workflowName?: string;
  finalStep?: WorkflowStep | null;
  finalStepStatus?: StepStatus | null;
  finalStepLoopCount?: number;
  finalStepPhase?: FinalStepPhase | null;
}

/**
 * Session restored message (extension -> webview)
 */
export interface SessionRestoredMessage {
  type: typeof MESSAGE_TYPES.SESSION_RESTORED;
  fileName: string;
  steps: WorkflowStep[];
  results: any[];
  executionState: ExecutionState;
  currentIndex: number;
  workflowName?: string;
  finalStep?: WorkflowStep | null;
  finalStepStatus?: StepStatus | null;
  finalStepLoopCount?: number;
  finalStepPhase?: FinalStepPhase | null;
}

/**
 * Execution started message (extension -> webview)
 */
export interface ExecutionStartedMessage {
  type: typeof MESSAGE_TYPES.EXECUTION_STARTED;
  /** Workflow instance UUID — used to clear the correct workflow's ai-cli sessions */
  workflowId: string;
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
 * Steps extended message (extension -> webview)
 */
export interface StepsExtendedMessage {
  type: typeof MESSAGE_TYPES.STEPS_EXTENDED;
  steps: WorkflowStep[];
  finalStep?: WorkflowStep | null;
}

/**
 * Prompt deleted message (extension -> webview)
 */
export interface PromptDeletedMessage {
  type: typeof MESSAGE_TYPES.PROMPT_DELETED;
  fileName: string;
  steps: WorkflowStep[];
  finalStep?: WorkflowStep | null;
}

/**
 * Update finalStep message (extension -> webview OR webview -> extension)
 */
export interface UpdateFinalStepMessage {
  type: typeof MESSAGE_TYPES.UPDATE_FINAL_PROMPT;
  finalStep: WorkflowStep | null;
}

/**
 * finalStep runtime status changed message (extension -> webview)
 */
export interface FinalStepStatusChangedMessage {
  type: typeof MESSAGE_TYPES.FINAL_PROMPT_STATUS_CHANGED;
  status: StepStatus | null;
  loopCount: number;
  phase: FinalStepPhase | null;
}

/**
 * finalStep CLI output message (extension -> webview)
 */
export interface FinalStepOutputMessage {
  type: typeof MESSAGE_TYPES.FINAL_PROMPT_OUTPUT;
  loopIndex: number;
  output: CliOutput;
}

/**
 * finalStep streaming chunk message (extension -> webview)
 */
export interface FinalStepStreamingChunkMessage {
  type: typeof MESSAGE_TYPES.FINAL_PROMPT_STREAMING_CHUNK;
  loopIndex: number;
  chunk: string;
}

/**
 * finalStep streaming events message (extension -> webview)
 */
export interface FinalStepStreamingEventsMessage {
  type: typeof MESSAGE_TYPES.FINAL_PROMPT_STREAMING_EVENTS;
  loopIndex: number;
  events: CliEvent[];
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
    mcpServers: (string | McpServerConfig)[];
    hooks: UserHookConfig[];
    respectGitignore?: boolean;
    confirmDeleteOperations?: boolean;
    confirmResetOperations?: boolean;
  };
}

// ============================================================================
// GLOBAL SETTINGS DRAWER TYPES
// ============================================================================

export type SettingSource = "workspace" | "user" | "default";

export interface FullGlobalSettings {
  settings: FlightPathGlobalSettings;
  sources: Partial<Record<keyof FlightPathGlobalSettings, SettingSource>>;
}

/** Webview → Extension: request full settings payload */
export interface GlobalSettingsLoadRequestMessage {
  type: typeof MESSAGE_TYPES.GLOBAL_SETTINGS_LOAD_REQUEST;
}

/** Extension → Webview: full settings payload + sources */
export interface GlobalSettingsLoadedMessage {
  type: typeof MESSAGE_TYPES.GLOBAL_SETTINGS_LOADED;
  settings: FullGlobalSettings;
}

/** Webview → Extension: update a single setting */
export interface UpdateGlobalSettingMessage {
  type: typeof MESSAGE_TYPES.UPDATE_GLOBAL_SETTING;
  path: string;
  value: unknown;
  scope: "workspace" | "user";
}

/** Extension → Webview: acknowledge a setting update */
export interface GlobalSettingUpdatedMessage {
  type: typeof MESSAGE_TYPES.GLOBAL_SETTING_UPDATED;
  path: string;
  value: unknown;
  source: string;
}

/**
 * Reset workflow state message (extension -> webview, bidirectional)
 */
export interface ResetWorkflowStateMessage {
  type: typeof MESSAGE_TYPES.RESET_WORKFLOW_STATE;
  steps: WorkflowStep[];
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
  workflowId?: string;
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
  steps: WorkflowStep[];
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

export type UndoFileAction = "delete" | "restore-content" | "reverse-patch";

export interface UndoFileInstruction {
  /** Workspace-relative POSIX path */
  path: string;
  action: UndoFileAction;
  /** Required when action === "restore-content" */
  contentToRestore?: string;
  /**
   * Required when action === "reverse-patch".
   * The forward-direction diff hunks applied in reverse to restore the file.
   * For prompt-level undo this is the full before→after snapshot patch.
   * For single-event undo this is the per-edit patch from the CLI event.
   */
  structuredPatch?: UnifiedDiffHunk[];
  /**
   * Original line ending style of the file before the edit.
   * When 'crlf', the reverse-patch result is converted from LF back to CRLF
   * to restore the file's original line endings.
   */
  lineEnding?: "crlf";
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

/** Webview → Extension: undo changes across multiple workflow steps */
export interface UndoWorkflowChangesMessage {
  type: typeof MESSAGE_TYPES.UNDO_WORKFLOW_CHANGES;
  data: {
    requestId: string;
    workspacePath: string;
    entries: Array<{
      target: UndoExecutionTarget;
      files: UndoFileInstruction[];
    }>;
  };
}

/** Webview → Extension: redo changes across multiple workflow steps */
export interface RedoWorkflowChangesMessage {
  type: typeof MESSAGE_TYPES.REDO_WORKFLOW_CHANGES;
  data: {
    requestId: string;
    workspacePath: string;
    entries: Array<{
      target: OutputExecutionTarget;
      files: UndoFileInstruction[];
    }>;
  };
}

// ============================================================================
// MCP Discovery Types
// ============================================================================

/**
 * A single MCP server entry discovered from a local config file.
 */
export interface LocalMcpServerEntry {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Where this entry was discovered from */
  source:
    | "vscode-workspace"
    | "vscode-user"
    | "claude-workspace"
    | "claude-user";
}

/**
 * A single MCP server entry from the MCP registry (registry.modelcontextprotocol.io).
 */
export interface RegistryMcpEntry {
  /** Registry-assigned server identifier (qualified name, e.g. "agency.lona/trading") */
  id: string;
  name: string;
  description: string;
  /** npm package name (if available), used to build an install command */
  packageName?: string;
  /** Ready-to-paste install command (e.g. "npx -y @package/name") */
  installCommand?: string;
  /** Environment variables required by this server */
  envVars?: Array<{ name: string; description?: string }>;
  /** Whether this server is officially listed in the registry */
  verified?: boolean;
  /** ISO 8601 timestamp of when this server entry was last updated — used for "Recently Updated" sort */
  updatedAt?: string;
  // ── Remote transport (streamable-http / SSE servers) ──────────────────────
  /** Endpoint URL for remote servers (when no stdio package is available) */
  remoteUrl?: string;
  /** Transport protocol for remote servers */
  remoteTransport?: "streamable-http" | "sse";
  /** Required HTTP headers for remote servers (e.g. Authorization) */
  remoteHeaders?: Array<{
    name: string;
    description?: string;
    isRequired?: boolean;
    isSecret?: boolean;
  }>;
}

export interface RequestMcpLocalServersMessage {
  type: typeof MESSAGE_TYPES.REQUEST_MCP_LOCAL_SERVERS;
}

export interface McpLocalServersResultMessage {
  type: typeof MESSAGE_TYPES.MCP_LOCAL_SERVERS_RESULT;
  servers: LocalMcpServerEntry[];
  error?: string;
}

export interface RequestMcpRegistryMessage {
  type: typeof MESSAGE_TYPES.REQUEST_MCP_REGISTRY;
  query?: string;
  cursor?: string;
  /** ISO 8601 timestamp — when set, fetches only servers updated since this date */
  updatedSince?: string;
}

export interface McpRegistryResultMessage {
  type: typeof MESSAGE_TYPES.MCP_REGISTRY_RESULT;
  servers: RegistryMcpEntry[];
  error?: string;
  query?: string;
  nextCursor?: string;
}

export interface RequestMcpWorkspaceServersMessage {
  type: typeof MESSAGE_TYPES.REQUEST_MCP_WORKSPACE_SERVERS;
}

export interface McpWorkspaceServersResultMessage {
  type: typeof MESSAGE_TYPES.MCP_WORKSPACE_SERVERS_RESULT;
  servers: McpServerConfig[];
  error?: string;
}

export interface SaveMcpWorkspaceServersMessage {
  type: typeof MESSAGE_TYPES.SAVE_MCP_WORKSPACE_SERVERS;
  servers: McpServerConfig[];
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
  | UpdateFinalStepMessage
  | FinalStepStatusChangedMessage
  | FinalStepOutputMessage
  | FinalStepStreamingChunkMessage
  | FinalStepStreamingEventsMessage
  | { type: typeof MESSAGE_TYPES.EXECUTION_COMPLETED }
  | StepsExtendedMessage
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
  | UndoRecordUpdatedMessage
  | McpLocalServersResultMessage
  | McpRegistryResultMessage
  | McpWorkspaceServersResultMessage
  | GlobalSettingsLoadedMessage
  | GlobalSettingUpdatedMessage
  | { type: typeof MESSAGE_TYPES.STARTUP_COMPLETE };
