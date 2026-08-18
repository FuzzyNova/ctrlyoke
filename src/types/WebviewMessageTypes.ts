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
 * - Extension: src/ui/CtrlYokeWebviewProvider.ts
 * - React webview: src/ui/webview-react/store/workflowStore.ts
 * - React webview: src/ui/webview-react/components/**
 */

import {
  ExecutionState,
  FinalStepPhase,
  StepStatus,
  HarnessId,
  AnyTargetId,
  PromptEditorInsertMode,
  MESSAGE_TYPES,
  STATUS_MESSAGE_SEVERITY,
  EXECUTION_MODES,
  STEP_TYPES,
  PREVIEW_SCOPES,
  type TokenTotalConfidence,
  type ScriptOutputSource,
  type ExecutionPhase,
  type UndoFileAction,
  type CompletionNotificationSeverity,
  type UserFeedbackSeverity,
  type EndConditionScriptType,
  type HookEvent,
  type NotificationKind,
  type SettingScope,
  type SettingWriteScope,
  type WorktreeManagementAction,
  type WorkflowFileFormat,
} from "./DashboardConstants";
import type {
  ErrorBehavior,
  WorkflowSummary,
  McpServerConfig,
  PreCondition,
  PriorContext,
  ToolPermissionsOverride,
  UserHookConfig,
  WorkflowStep,
  WorkflowViewAddress,
  WorkflowKey,
  RunRef,
  WorkingFile,
  WorkflowRunNavigationSummary,
  WorkflowTokenTotals,
  ScriptVerdict,
} from "./CtrlYokeTypes";
import type {
  CtrlYokeGlobalSettings,
  TerminalSettings,
} from "./CtrlYokeSettings";
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
import type {
  HistorySearchQuery,
  HistorySearchResponse,
  RunSummary,
} from "./WorkflowTimelineTypes";
import type { WorkflowOutputHistory } from "./OutputHistoryTypes";
import type { ScriptCompletionItem } from "../completions/ScriptCommandCompletionHelpers";
import type { HarnessCapabilityRegistrySnapshot } from "./CompatibilityTypes";
import type { WorkflowExecutionPreview } from "./ExecutionPreviewTypes";
import type {
  HarnessUsageSnapshot,
  WorkspaceStatsSnapshot,
} from "./UsageTypes";
import type {
  AttemptCostEstimate,
  AttemptCostUnavailableReason,
} from "./CtrlYokeTypes";

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
  SETTING_SCOPES,
  type MessageType,
  type StatusMessageSeverity,
  type ActionType,
  type AnyTargetId,
  type SettingScope,
  type SettingWriteScope,
} from "./DashboardConstants";

// Re-export WorkflowSummary, WorkflowStep, and PreCondition for webview consumers
export type {
  WorkflowSummary,
  WorkflowStep,
  ScriptStep,
  PreCondition,
} from "./CtrlYokeTypes";

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
  /** Cache-read tokens (billed at reduced rate). */
  cached?: number;
  /** Cache-creation tokens — Claude only. */
  cacheCreated?: number;
  /** Cumulative reasoning output tokens, when reported separately. */
  reasoning?: number;
  /**
   * Normalized cumulative total for the attempt (provider-reported or parser
   * accumulated, as described by `totalConfidence`). Prefer this over
   * `prompt + completion`: whether cache tokens are already inside `prompt`
   * varies by harness, so the sum is wrong for at least half of them.
   */
  total?: number;
  /** Total input tokens occupying the context window (last API turn). */
  contextWindowUsed?: number;
  /** Model's total context window capacity in tokens. */
  contextWindowSize?: number;
  /** Compaction events observed during this attempt. Context, not a total source. */
  compactionCount?: number;
  /** Sum of known pre-compaction token counts. Best effort, display only. */
  compactedContextTokens?: number;
  /** Where `total` came from. Drives whether the UI may compare it as exact. */
  totalConfidence?: TokenTotalConfidence;
  /** Cost estimate for this attempt. Absent when unpriceable. */
  cost?: AttemptCostEstimate;
  /** Why `cost` is absent when token totals exist. */
  costUnavailableReason?: AttemptCostUnavailableReason;
}

/**
 * CLI output for a step (unified across extension and webview)
 * May have multiple outputs for retries (stored in array by attemptIndex)
 * Single source of truth for all CLI response data
 */
export interface CliOutput {
  /** The prompt text that was sent; omitted for script execution output. */
  prompt?: string;
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
  /**
   * When true, `cliCommand` is the exact prompt text injected into a running
   * terminal session rather than a spawned harness command line.
   */
  cliCommandWasInjected?: boolean;
  /** The working directory where the command was executed */
  workingDirectory?: string;
  /** Timestamp when the output was created (milliseconds since epoch) */
  timestampMs?: number;
  /** Explicit attempt index: 0 = initial attempt, 1+ = retry
   * @default 0
   */
  attemptIndex?: number;
  /**
   * Manual re-run index for this execution target. 0 = first run ever; increments
   * when a previously-run step or finalStep loop is executed again.
   * @default 0
   */
  runIndex?: number;
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
  source?: ScriptOutputSource;
  /**
   * Exit code from the script step (source: "script" only).
   * 0 = success, non-zero = failure.
   */
  exitCode?: number;
  /** Structured comparison/action details for script and condition output. */
  scriptVerdict?: ScriptVerdict;
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
  CompactionData,
  UserSteerData,
  FollowUpResumedData,
  ContextWindowSyncData,
  UniversalCliOutput,
  UnifiedDiffHunk,
  AskUserQuestionData,
  AskUserQuestionEntry,
  AskUserQuestionOption,
  AskUserQuestionDeclined,
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
  passRetryPrompt?: string;
}

/**
 * Prompt item shape (used in workflowStore and throughout webview)
 * Matches CtrlYokeTypes.PromptStep
 */
export interface PromptStep {
  /** Step type discriminant — defaults to "prompt" when absent */
  type?: typeof STEP_TYPES.PROMPT;
  name?: string;
  enabled?: boolean;
  prompt: string;
  harness?: string;
  model?: string;
  executionMode?: ExecutionMode;
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
  errorBehavior?: ErrorBehavior | null;
  _runtime?: {
    harness?: string;
    model?: string;
    sessionId?: string;
    startedAt?: number;
    completedAt?: number;
    retryCount?: number;
    isRetry?: boolean;
    responseText?: string;
    elapsed?: number;
    contextWindowUsed?: number;
    contextWindowSize?: number;
    failureMessage?: string;
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
    autoFocusOutputOnExecution?: boolean;
    respectGitignore?: boolean;
    autoExpandEditorWhenTyping?: boolean;
    atomicContextReferences?: boolean;
    outputVirtualizationRowThreshold?: number;
    collapsedToolOutputLineCount?: number;
    confirmDeleteOperations?: boolean;
    confirmResetOperations?: boolean;
    hideGitIgnoredFiles?: boolean;
    /** Whether standalone prompt paths use folder-qualified multi-root syntax. */
    isMultiRoot: boolean;
    terminal?: TerminalSettings;
  };
  workflowProperties: Record<string, any>;
  modelOptions: Record<HarnessId, Array<{ value: string; label: string }>>;
  harnessStatus: Record<
    string,
    {
      available: boolean;
      status: string;
      message?: string;
      installHint?: string;
    }
  >;
  availableAgents: Array<{
    name: string;
    displayName?: string;
    path: string;
    description?: string;
  }>;
  dev?: DevStatus;
}

export interface DevStatus {
  enabled: boolean;
  buildDate: string;
  commands: {
    reloadWindow: boolean;
    restartExtensionHost: boolean;
  };
}

export type DevDashboardAction =
  | "buildExtension"
  | "buildWebview"
  | "buildAll"
  | "reloadWindow"
  | "restartExtensionHost"
  | "buildExtensionAndReload"
  | "buildWebviewAndReload"
  | "buildAllAndReload"
  | "runTests"
  | "sendTestNotification";

export interface DevStatusMessage {
  type: typeof MESSAGE_TYPES.DEV_STATUS;
  dev: DevStatus;
}

export interface DevBuildStartedMessage {
  type: typeof MESSAGE_TYPES.DEV_BUILD_STARTED;
  script: "compile:extension" | "compile:webview" | "compile" | "test";
  command: string;
}

export interface DevBuildOutputMessage {
  type: typeof MESSAGE_TYPES.DEV_BUILD_OUTPUT;
  stream: "stdout" | "stderr";
  chunk: string;
}

export interface DevBuildCompletedMessage {
  type: typeof MESSAGE_TYPES.DEV_BUILD_COMPLETED;
  success: boolean;
  exitCode: number | null;
  signal?: string | null;
  durationMs: number;
  errorSummary?: string;
}

export interface DevRestartingMessage {
  type: typeof MESSAGE_TYPES.DEV_RESTARTING;
  command:
    | "workbench.action.reloadWindow"
    | "workbench.action.restartExtensionHost";
}

export interface DevCommandUnavailableMessage {
  type: typeof MESSAGE_TYPES.DEV_COMMAND_UNAVAILABLE;
  command: string;
  reason?: string;
}

/**
 * Webview → Extension: a captured UX snapshot to persist under
 * .ctrlyoke/snapshots/. `markdown` is the self-describing text dump
 * (HTML + computed styles + matched author rules); `png` is reserved for a
 * future visual companion (not written in v1).
 */
export interface UxSnapshotCaptureMessage {
  type: typeof MESSAGE_TYPES.UX_SNAPSHOT_CAPTURE;
  markdown: string;
  png?: string;
}

/**
 * Extension → Webview: result of persisting a UX snapshot. On success `path`
 * is the workspace-relative file path; on failure `error` describes why.
 */
export interface UxSnapshotSavedMessage {
  type: typeof MESSAGE_TYPES.UX_SNAPSHOT_SAVED;
  path?: string;
  error?: string;
}

export interface CommitMessageGenerationRecord {
  source: "scm" | "workspace-viewer";
  workingDirectory: string;
  commands: string[];
  output: string;
  staged: boolean;
  truncated: boolean;
  includesUntrackedFiles: boolean;
  generatedAt: number;
  prompt?: string;
  generatedMessage?: string;
  cliCommand?: string;
}

export interface CommitMessageGenerationUpdatedMessage {
  type: typeof MESSAGE_TYPES.COMMIT_MESSAGE_GENERATION_UPDATED;
  record: CommitMessageGenerationRecord | null;
}

/**
 * File selected message (extension -> webview)
 */
export interface FileSelectedMessage {
  type: typeof MESSAGE_TYPES.FILE_SELECTED;
  fileName: string;
  steps: WorkflowStep[];
  workflowName?: string;
  workingFilePath?: string | null;
  finalStep?: WorkflowStep | null;
  finalStepStatus?: StepStatus | null;
  finalStepLoopCount?: number;
  finalStepPhase?: FinalStepPhase | null;
  workflowProperties?: Record<string, any>;
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
  workingFilePath?: string | null;
  finalStep?: WorkflowStep | null;
  finalStepStatus?: StepStatus | null;
  finalStepLoopCount?: number;
  finalStepPhase?: FinalStepPhase | null;
  workflowProperties?: Record<string, any>;
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
  /**
   * When true, this run reuses the existing PTY via inject mode.
   * The webview must NOT clear the existing ai-cli terminal session — it should
   * unfreeze and resume it instead so the same xterm instance shows the new output.
   */
  isInjectMode?: boolean;
  /** Resolved execution mode for the step that started this execution. */
  executionMode?: ExecutionMode;
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
  phase?: ExecutionPhase;
}

/**
 * CLI streaming events message (extension -> webview)
 */
export interface CliStreamingEventsMessage {
  type: typeof MESSAGE_TYPES.CLI_STREAMING_EVENTS;
  stepIndex: number;
  events: CliEvent[];
  attemptIndex?: number;
  runIndex?: number;
}

/**
 * Live context window update message (extension → webview).
 * Fired per-event during prompt execution; used to animate the context bar.
 */
export interface ContextWindowUpdateMessage {
  type: typeof MESSAGE_TYPES.CONTEXT_WINDOW_UPDATE;
  stepIndex: number;
  used: number;
  size: number;
}

/**
 * Status message (extension -> webview)
 */
export interface StatusMessageMessage {
  type: typeof MESSAGE_TYPES.STATUS_MESSAGE;
  stepIndex: number;
  message: string;
  severity: StatusSeverity;
  workflowId?: string;
  /** Origination time on the extension-host clock. The webview must sort by
   *  this value rather than its own receipt-time Date.now() — a receive-time
   *  stamp races the CLI/script row this status message is ordered against. */
  timestampMs?: number;
}

/**
 * Steps extended message (extension -> webview)
 */
export interface StepsExtendedMessage {
  type: typeof MESSAGE_TYPES.STEPS_EXTENDED;
  steps: WorkflowStep[];
  finalStep?: WorkflowStep | null;
  /** The definition head that produced `steps`. Lets a following edit target
   *  the append immediately, without waiting for long-running execution to end. */
  definitionRevision?: number;
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
  phase?: ExecutionPhase;
}

/**
 * finalStep streaming events message (extension -> webview)
 */
export interface FinalStepStreamingEventsMessage {
  type: typeof MESSAGE_TYPES.FINAL_PROMPT_STREAMING_EVENTS;
  loopIndex: number;
  events: CliEvent[];
  attemptIndex?: number;
  runIndex?: number;
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
      {
        available: boolean;
        status: string;
        message?: string;
        installHint?: string;
      }
    >;
  };
}

/** Normalized provider quota and workspace-local observed usage. */
export interface HarnessUsageUpdatedMessage {
  type: typeof MESSAGE_TYPES.HARNESS_USAGE_UPDATED;
  snapshots: HarnessUsageSnapshot[];
}

/** Workspace-local lifetime totals and backfill progress. */
export interface WorkspaceStatsUpdatedMessage {
  type: typeof MESSAGE_TYPES.WORKSPACE_STATS_UPDATED;
  snapshot?: WorkspaceStatsSnapshot;
}

/** Installed-version-aware harness capability facts (extension -> webview). */
export interface HarnessCapabilitySnapshotMessage {
  type: typeof MESSAGE_TYPES.HARNESS_CAPABILITY_SNAPSHOT;
  data: {
    snapshot: HarnessCapabilityRegistrySnapshot;
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
      displayName?: string;
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
  defaultTemplateId?: string;
  /** Open the inline custom-template form when the modal is first shown. */
  openCreateTemplateForm?: boolean;
}

/** Webview → Extension: clone the selected base into a custom template. */
export interface CreateCustomTemplateMessage {
  type: typeof MESSAGE_TYPES.CREATE_CUSTOM_TEMPLATE;
  name: string;
  scope: "user" | "workspace";
  format: WorkflowFileFormat;
  baseTemplateId: string;
}

/**
 * Recent workflows message (extension -> webview)
 */
export interface RecentWorkflowsMessage {
  type: typeof MESSAGE_TYPES.RECENT_WORKFLOWS;
  workflows: Array<{
    address: WorkflowViewAddress;
    runDirectory?: string;
    workflowName: string;
    executionState: string;
    lastModifiedAt?: number;
    startedAt?: number;
    isFavorite?: boolean;
    totalSteps?: number;
    harness?: HarnessId;
    runNav?: WorkflowRunNavigationSummary;
    tokenTotals?: WorkflowTokenTotals;
  }>;
}

/**
 * Reference to a workflow that currently has at least one running PTY session.
 * Broadcast globally so every client (panel + browser tabs) can render the
 * dropdown terminal icon for any workflow, not just the one it is viewing.
 * The stable execution address lets recent-list rows match without relying on
 * a mutable working-file path or a client having hydrated the workflow.
 */
export interface ActiveTerminalWorkflowRef {
  /** In-memory identity used only to attach to an existing PTY session. */
  workflowId: string;
  workflowKey: WorkflowKey;
  runRef: RunRef;
}

/**
 * Active terminal workflows broadcast (extension -> all clients).
 * Replaces the previous per-client terminal-store inference, which left
 * non-viewed workflows without an icon on hosted/browser clients.
 */
export interface ActiveTerminalWorkflowsMessage {
  type: typeof MESSAGE_TYPES.ACTIVE_TERMINAL_WORKFLOWS;
  workflows: ActiveTerminalWorkflowRef[];
}

/**
 * Save workflow dialog data message (extension -> webview)
 * Sent when the user clicks the Save button; provides the default path / format.
 */
export interface SaveWorkflowDialogDataMessage {
  type: typeof MESSAGE_TYPES.SAVE_WORKFLOW_DIALOG_DATA;
  /** Correlates this dialog with its request and all later save responses. */
  requestId: string;
  /** The exact viewed definition this export is allowed to snapshot. */
  address: WorkflowViewAddress;
  /** User-facing framing for the addressed draft/run. */
  title: string;
  defaultPath: string;
  defaultFormat: WorkflowFileFormat;
}

/** Webview → Extension: non-mutating overwrite/security preflight for an export path. */
export interface CheckSavePathMessage {
  type: typeof MESSAGE_TYPES.CHECK_SAVE_PATH;
  requestId: string;
  path: string;
  address: WorkflowViewAddress;
}

export interface SaveBundleDiagnostic {
  code: string;
  message: string;
  fieldPath?: string;
  token?: string;
}

export interface SaveWorkflowBundlePreview {
  copyCount: number;
  inlineCount: number;
  pruneCount: number;
  assetsDirectoryName?: string;
  warnings: SaveBundleDiagnostic[];
  blockers: SaveBundleDiagnostic[];
  planFingerprint: string;
}

/** Extension → Webview: addressed result of a save-path preflight. */
export interface SavePathCheckedMessage {
  type: typeof MESSAGE_TYPES.SAVE_PATH_CHECKED;
  requestId: string;
  path: string;
  address: WorkflowViewAddress;
  exists: boolean;
  bundlePreview?: SaveWorkflowBundlePreview;
  planChanged?: boolean;
  error?: string;
}

/** Webview → Extension: open an addressed Save workflow dialog. */
export interface SaveWorkflowRequestMessage {
  type: typeof MESSAGE_TYPES.SAVE_WORKFLOW_REQUEST;
  requestId: string;
  address: WorkflowViewAddress;
}

/** Webview → Extension: write an addressed workflow export. */
export interface SaveWorkflowMessage {
  type: typeof MESSAGE_TYPES.SAVE_WORKFLOW;
  requestId: string;
  address: WorkflowViewAddress;
  filePath: string;
  format: WorkflowFileFormat;
  planFingerprint?: string;
  pathCheckRequestId?: string;
}

/**
 * Workflow saved message (extension -> webview)
 */
export interface WorkflowSavedMessage {
  type: typeof MESSAGE_TYPES.WORKFLOW_SAVED;
  requestId: string;
  filePath: string;
  warnings?: string[];
}

/**
 * Workflow save failed message (extension -> webview)
 */
export interface WorkflowSaveFailedMessage {
  type: typeof MESSAGE_TYPES.WORKFLOW_SAVE_FAILED;
  requestId?: string;
  error: string;
}

/**
 * Save workflow as template message (webview -> extension)
 */
export interface SaveWorkflowAsTemplateMessage {
  type: typeof MESSAGE_TYPES.SAVE_WORKFLOW_AS_TEMPLATE;
  requestId: string;
  address: WorkflowViewAddress;
  name: string;
  scope: "user" | "workspace";
  format: WorkflowFileFormat;
}

/**
 * Workflow saved as template message (extension -> webview).
 * Failure reuses WorkflowSaveFailedMessage rather than a dedicated failure message.
 */
export interface WorkflowSavedAsTemplateMessage {
  type: typeof MESSAGE_TYPES.WORKFLOW_SAVED_AS_TEMPLATE;
  requestId: string;
  templates: Array<{
    id: string;
    name: string;
    description: string;
    variables?: Record<string, any>;
    isBuiltIn: boolean;
  }>;
  templateId?: string;
}

/** Webview → Extension: create a new lineage from an explicitly addressed definition. */
export interface CreateWorkflowVariantRequest {
  type: typeof MESSAGE_TYPES.CREATE_WORKFLOW_VARIANT;
  requestId: string;
  source: WorkflowViewAddress;
  workflowName: string;
  overrides?: {
    harness?: HarnessId;
    model?: string;
  };
}

/** Extension → Webview: addressed workflow variant creation succeeded. */
export interface WorkflowVariantCreatedMessage {
  type: typeof MESSAGE_TYPES.WORKFLOW_VARIANT_CREATED;
  requestId: string;
  address: Extract<WorkflowViewAddress, { kind: "draft" }>;
}

/** Extension → Webview: addressed workflow variant creation failed. */
export interface WorkflowVariantFailedMessage {
  type: typeof MESSAGE_TYPES.WORKFLOW_VARIANT_FAILED;
  requestId: string;
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
  workingFilePath?: string | null;
  /**
   * Present when this announcement is part of answering a client's own
   * LOAD_RUN_VIEW request. The client must not treat it as a backend-initiated
   * switch that cancels the in-flight request — the addressed RUN_VIEW_LOADED
   * carrying this same requestId follows immediately.
   */
  requestId?: string;
}

export interface PromptEditorInsertRequest {
  requestId: string;
  references: string[];
  mode: PromptEditorInsertMode;
  surroundWithNewlines?: boolean;
}

export interface PromptEditorInsertMessage {
  type: typeof MESSAGE_TYPES.INSERT_PROMPT_REFERENCES;
  data: PromptEditorInsertRequest;
}

/** Webview -> Extension: request completions for a script command field. */
export interface ScriptCompletionsRequestMessage {
  type: typeof MESSAGE_TYPES.SCRIPT_COMPLETIONS_REQUEST;
  text: string;
  position: number;
  seq: number;
}

/** Extension -> Webview: script command field completion results. */
export interface ScriptCompletionsResponseMessage {
  type: typeof MESSAGE_TYPES.SCRIPT_COMPLETIONS_RESPONSE;
  items: ScriptCompletionItem[];
  from: number;
  seq: number;
}

/** Webview → Extension: validate a lone prompt-file reference. */
export interface ValidateFileRefMessage {
  type: typeof MESSAGE_TYPES.VALIDATE_FILE_REF;
  filePath: string;
  seq?: number;
  address?: WorkflowViewAddress;
}

/** Extension → Webview: addressed validation result for a prompt-file reference. */
export interface FileRefValidationMessage {
  type: typeof MESSAGE_TYPES.FILE_REF_VALIDATION;
  filePath: string;
  exists: boolean;
  isEmpty: boolean;
  resolvedPath?: string;
  seq?: number;
}

/** Webview → Extension: write the current prompt text to a prompt file. */
export interface ConvertPromptToFileMessage {
  type: typeof MESSAGE_TYPES.CONVERT_PROMPT_TO_FILE;
  text: string;
  suggestedName?: string;
  seq?: number;
}

/** Extension → Webview: result of a prompt-file conversion. */
export interface PromptFileCreatedMessage {
  type: typeof MESSAGE_TYPES.PROMPT_FILE_CREATED;
  reference?: string;
  resolvedPath?: string;
  error?: string;
  seq?: number;
}

/** Webview → Extension: create a starter end-condition script. */
export interface CreateEndConditionScriptMessage {
  type: typeof MESSAGE_TYPES.CREATE_END_CONDITION_SCRIPT;
  requestId: string;
  scriptType: EndConditionScriptType;
}

/** Webview → Extension: retry detection of the installed harness CLIs. */
export interface RetryHarnessDetectionMessage {
  type: typeof MESSAGE_TYPES.RETRY_HARNESS_DETECTION;
  requestId: string;
}

/** Extension → Webview: result of a client-scoped harness detection retry. */
export interface HarnessDetectionRetryResultMessage {
  type: typeof MESSAGE_TYPES.HARNESS_DETECTION_RETRY_RESULT;
  requestId: string;
  success: boolean;
  error?: string;
}

/** Extension → Webview: starter end-condition script creation succeeded. */
export interface EndConditionScriptCreatedMessage {
  type: typeof MESSAGE_TYPES.END_CONDITION_SCRIPT_CREATED;
  requestId: string;
  scriptPath: string;
}

/** Extension → Webview: starter end-condition script creation failed. */
export interface EndConditionScriptCreationFailedMessage {
  type: typeof MESSAGE_TYPES.END_CONDITION_SCRIPT_CREATION_FAILED;
  requestId: string;
  error: string;
}

/** Webview → Extension: open a prompt-file reference in the editor. */
export interface OpenPromptFileMessage {
  type: typeof MESSAGE_TYPES.OPEN_PROMPT_FILE;
  path: string;
}

/** Webview → Extension: open the recorded worktree checkout in a new window. */
export interface OpenWorktreeMessage {
  type: typeof MESSAGE_TYPES.OPEN_WORKTREE;
  worktreePath: string;
}

/** Webview → Extension: view the recorded branch against its recorded base. */
export interface ViewWorktreeDiffMessage {
  type: typeof MESSAGE_TYPES.VIEW_WORKTREE_DIFF;
  sourceCheckoutRoot: string;
  baseCommit: string;
  branchName: string;
}

/** Webview → Extension: merge a persisted managed run into its source checkout. */
export interface MergeWorktreeMessage {
  type: typeof MESSAGE_TYPES.MERGE_WORKTREE;
  address: Extract<WorkflowViewAddress, { kind: "run" }>;
}

/** Extension → Webview: the persisted result of a managed-worktree merge. */
export interface WorktreeMergeResultMessage {
  type: typeof MESSAGE_TYPES.WORKTREE_MERGE_RESULT;
  address: Extract<WorkflowViewAddress, { kind: "run" }>;
  worktree: import("./CtrlYokeTypes").WorktreeRunProjection;
}

export interface WorktreeManagementStateMessage {
  type: typeof MESSAGE_TYPES.WORKTREE_MANAGEMENT_STATE;
  state: WorktreeManagementState;
  /** Echoed back when this state was sent in reply to a specific request, so the requester can resolve its own pending/spinner UI. */
  requestId?: string;
}

export interface WorktreeManagementLeaseOwner {
  lease: { workflowKey: string; runRef: string; stateRoot: string };
  ageMs: number;
}

export interface WorktreeManagementEntry {
  worktreePath: string;
  headCommit: string;
  branchName?: string;
  ownership: "managed" | "user";
  lifecycleState?: string;
  directoryState?: string;
  branchState: "present" | "missing" | "deleted";
  createdAt?: number;
  ageMs?: number;
  inUse: boolean;
  leaseOwners: WorktreeManagementLeaseOwner[];
  stale: boolean;
  prunableReason?: string;
  targetBranch?: string;
  branchCleanupEligible: boolean;
  branchCleanupReason?: string;
  divergence?: {
    comparisonLabel: string;
    comparisonCommit: string;
    ahead: number;
    behind: number;
    calculatedAt: number;
  };
}

export interface WorktreeManagementState {
  resolvedRoot: string;
  sourceCheckoutRoot: string;
  sourceCheckoutBranch: string | null;
  entries: WorktreeManagementEntry[];
  staleManagedRecords: unknown[];
  generatedAt: number;
}

export interface RequestWorktreeManagementStateMessage {
  type: typeof MESSAGE_TYPES.REQUEST_WORKTREE_MANAGEMENT_STATE;
  refresh?: boolean;
  /** Present when a UI control wants to correlate the reply for its own pending/spinner state. */
  requestId?: string;
}

export interface OpenWorktreeOwnerMessage {
  type: typeof MESSAGE_TYPES.OPEN_WORKTREE_OWNER;
  stateRoot: string;
}

export interface WorktreeManagementActionMessage {
  type: typeof MESSAGE_TYPES.WORKTREE_MANAGEMENT_ACTION;
  action: WorktreeManagementAction;
  worktreePath?: string;
  branchName?: string;
  confirmed?: boolean;
  /** Echoed back on WorktreeManagementActionResultMessage so the requesting button can resolve its pending state. */
  requestId?: string;
}

export interface SyncNamedWorktreeMessage {
  type: typeof MESSAGE_TYPES.SYNC_NAMED_WORKTREE;
  worktreePath: string;
  /** Echoed back on WorktreeManagementActionResultMessage so the requesting button can resolve its pending state. */
  requestId?: string;
}

/** Extension -> Webview: round-trip result for a worktree management action, sync, or refresh request. */
export interface WorktreeManagementActionResultMessage {
  type: typeof MESSAGE_TYPES.WORKTREE_MANAGEMENT_ACTION_RESULT;
  requestId: string;
  success: boolean;
  message: string;
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
    autoFocusOutputOnExecution?: boolean;
    respectGitignore?: boolean;
    autoExpandEditorWhenTyping?: boolean;
    atomicContextReferences?: boolean;
    outputVirtualizationRowThreshold?: number;
    collapsedToolOutputLineCount?: number;
    confirmDeleteOperations?: boolean;
    confirmResetOperations?: boolean;
    hideGitIgnoredFiles?: boolean;
    worktree?: CtrlYokeGlobalSettings["defaults"]["worktree"];
    worktrees?: CtrlYokeGlobalSettings["worktrees"];
    terminal?: TerminalSettings;
  };
}

// ============================================================================
// GLOBAL SETTINGS DRAWER TYPES
// ============================================================================

export type SettingSource = SettingScope;

export interface FullGlobalSettings {
  settings: CtrlYokeGlobalSettings;
  sources: Record<string, SettingSource>;
  /** Canonical absolute `.runs` directory for the current workspace. */
  runHistoryPath?: string | null;
  /**
   * Whether the current VS Code window has more than one workspace folder
   * open. When true, `ui.useAbsolutePathReferences` is forced on regardless
   * of its stored value — the settings UI shows the toggle as forced-on.
   */
  isMultiRoot: boolean;
}

export type { TerminalSettings } from "./CtrlYokeSettings";

/** Webview → Extension: request full settings payload */
export interface GlobalSettingsLoadRequestMessage {
  type: typeof MESSAGE_TYPES.GLOBAL_SETTINGS_LOAD_REQUEST;
}

/** Extension → Webview: full settings payload + sources */
export interface GlobalSettingsLoadedMessage {
  type: typeof MESSAGE_TYPES.GLOBAL_SETTINGS_LOADED;
  settings: FullGlobalSettings;
  commitMessageGeneration?: CommitMessageGenerationRecord | null;
}

/** Webview → Extension: update a single setting */
export interface UpdateGlobalSettingMessage {
  type: typeof MESSAGE_TYPES.UPDATE_GLOBAL_SETTING;
  path: string;
  value: unknown;
  scope: SettingWriteScope;
}

/** Webview → Extension: generate a self-signed server cert for the active scope */
export interface GenerateServerCertMessage {
  type: typeof MESSAGE_TYPES.GENERATE_SERVER_CERT;
  scope: SettingWriteScope;
}

/** Extension → Webview: self-signed cert was written and settings updated */
export interface ServerCertGeneratedMessage {
  type: typeof MESSAGE_TYPES.SERVER_CERT_GENERATED;
  generatedAt: string;
  expiresAt: string;
  sans: string[];
}

/**
 * Webview → Extension: save the configured TLS cert via a native VS Code
 * Save dialog (panel only — the webview has no way to download an HTTP
 * response through the VS Code webview host).
 */
export interface DownloadServerCertMessage {
  type: typeof MESSAGE_TYPES.DOWNLOAD_SERVER_CERT;
}

/** Extension → Webview: save dialog flow finished; `saved` is false if the user cancelled or the write failed */
export interface ServerCertDownloadedMessage {
  type: typeof MESSAGE_TYPES.SERVER_CERT_DOWNLOADED;
  saved: boolean;
  error?: string;
}

/** Extension → Webview: acknowledge a setting update */
export interface GlobalSettingUpdatedMessage {
  type: typeof MESSAGE_TYPES.GLOBAL_SETTING_UPDATED;
  path: string;
  value: unknown;
  source: string;
}

export interface CompletionNotificationEventPayload {
  id: string;
  kind: NotificationKind;
  severity: CompletionNotificationSeverity;
  workflowId: string;
  stepIndex?: number;
  title: string;
  body: string;
  tag: string;
  url?: string;
  hookEvent?: HookEvent;
  harnessId?: string;
  toolName?: string;
}

export interface NotificationEventMessage {
  type: typeof MESSAGE_TYPES.NOTIFICATION_EVENT;
  event: CompletionNotificationEventPayload;
}

/** Webview -> Extension: display operational feedback through the native host. */
export interface ShowNativeFeedbackMessage {
  type: typeof MESSAGE_TYPES.SHOW_NATIVE_FEEDBACK;
  severity: UserFeedbackSeverity;
  message: string;
  detail?: string;
}

/** Extension/hosted server -> Webview: transient operational feedback. */
export interface UserFeedbackMessage {
  type: typeof MESSAGE_TYPES.USER_FEEDBACK;
  id: string;
  severity: UserFeedbackSeverity;
  message: string;
  detail?: string;
  dedupeKey?: string;
}

export interface SearchHistoryMessage extends Partial<HistorySearchQuery> {
  type: typeof MESSAGE_TYPES.SEARCH_HISTORY;
  query: string;
}

export interface SearchHistoryResultsMessage extends HistorySearchResponse {
  type: typeof MESSAGE_TYPES.SEARCH_HISTORY_RESULTS;
  cursor?: string;
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
  workflowId?: string;
}

/** One coherent, client-local view of either a lineage draft or a promoted run. */
export interface RunViewLoadedMessage {
  type: typeof MESSAGE_TYPES.RUN_VIEW_LOADED;
  requestId?: string;
  address: WorkflowViewAddress;
  runDirectory?: string;
  workingFile: WorkingFile;
  history: WorkflowOutputHistory | null;
  runSummaries: RunSummary[];
  workflowProperties: Record<string, unknown>;
  /** The exact run currently bound to execution, if the lineage is active. */
  executionRunRef?: import("./CtrlYokeTypes").RunRef;
  /** Durable continuation marker for the addressed run, if it is being rewound. */
  pendingRewind?: {
    fromStepIndex: number;
    baseDefinitionRevision: number;
  };
  /** Descriptor revision paired with this snapshot for optimistic mutations. */
  descriptorRevision: number;
  /**
   * Identifies an intentional definition rollback, such as discarding a
   * pending continuation. Requestless snapshots normally may not replace a
   * newer definition revision; this marker authorizes only the exact
   * fromRevision -> restored revision transition.
   */
  definitionRollback?: {
    fromRevision: number;
  };
}

/**
 * Authoritative address and revisions for the client's own editing target,
 * published after every definition write. `RUN_VIEW_LOADED` also carries these,
 * but it is a full snapshot; this message exists so the cheap paths that only
 * advance `definitionRevision` (queueing a step, renaming, creating a lineage's
 * first draft) still leave the client able to address its next mutation.
 */
export interface WorkflowViewIdentityMessage {
  type: typeof MESSAGE_TYPES.WORKFLOW_VIEW_IDENTITY;
  address: WorkflowViewAddress;
  runDirectory?: string;
  definitionRevision: number;
  descriptorRevision: number;
}

/**
 * An addressed view load, definition mutation, or run action was rejected.
 *
 * Failures used to be reported only through `vscode.window.showErrorMessage`,
 * which a hosted browser client never sees — a rejected Run looked like a dead
 * button. Worse, a rejected `LOAD_RUN_VIEW` left that client's in-flight
 * run-view request pending forever, and a pending request suppresses both
 * `RUN_VIEW_LOADED` replays and `WORKFLOW_VIEW_IDENTITY`, so the client stayed
 * wedged on a superseded `definitionRevision`. Carrying `requestId` back lets
 * the client retire the request it actually issued.
 */
export interface WorkflowActionFailedMessage {
  type: typeof MESSAGE_TYPES.WORKFLOW_ACTION_FAILED;
  /** Human-readable action name, e.g. "run draft" or "load run". */
  action: string;
  error: string;
  /** Present when the failed action was a client-issued run-view request. */
  requestId?: string;
}

export type ExecutionPreviewScope =
  | { kind: typeof PREVIEW_SCOPES.WORKFLOW }
  | { kind: typeof PREVIEW_SCOPES.STEP; stepIndex: number };

/**
 * Unsaved editor state to overlay on the addressed working definition for a
 * single preview request. The dashboard owns this snapshot; it is never
 * persisted or reused after the request is answered.
 */
export interface ExecutionPreviewEditorSnapshot {
  step: WorkflowStep;
  /** Queue index when the editor is showing a queue step or new queue draft. */
  stepIndex?: number;
  /** True when the editor is showing the workflow's final step. */
  isFinalStep?: boolean;
}

/** Webview → Extension: compute one side-effect-free execution snapshot. */
export interface RequestExecutionPreviewMessage {
  type: typeof MESSAGE_TYPES.REQUEST_EXECUTION_PREVIEW;
  scope: ExecutionPreviewScope;
  editorSnapshot?: ExecutionPreviewEditorSnapshot;
  /** Monotonic only within the webview; used to discard late modal responses. */
  requestToken: number;
}

/** Extension/hosted server → Webview: the redacted snapshot for one request. */
export interface ExecutionPreviewResultMessage {
  type: typeof MESSAGE_TYPES.EXECUTION_PREVIEW_RESULT;
  scope: ExecutionPreviewScope;
  requestToken: number;
  address: WorkflowViewAddress;
  displayedDefinitionRevision: number;
  preview: WorkflowExecutionPreview;
}

/** Stable target and optimistic revisions required for a definition mutation. */
export interface WorkflowDefinitionMutation {
  address: WorkflowViewAddress;
  expectedDefinitionRevision: number;
  expectedDescriptorRevision: number;
}

export interface LoadRunViewMessage {
  type: typeof MESSAGE_TYPES.LOAD_RUN_VIEW;
  address: WorkflowViewAddress;
  requestId?: string;
}

/**
 * Webview → Extension: fetch another lineage's run list for the run-navigation
 * dropdown's drill-in panel. Summary-only — unlike `LoadRunViewMessage`, this never
 * registers a client view, switches the active instance, or loads a working file.
 */
export interface LoadRunSummariesMessage {
  type: typeof MESSAGE_TYPES.LOAD_RUN_SUMMARIES;
  requestId: string;
  workflowKey: WorkflowKey;
}

/** Extension → Webview: manifest-only run listing for one lineage, request-correlated. */
export interface RunSummariesLoadedMessage {
  type: typeof MESSAGE_TYPES.RUN_SUMMARIES_LOADED;
  requestId: string;
  workflowKey: WorkflowKey;
  descriptorRevision: number;
  lastModifiedAt: number;
  runSummaries: RunSummary[];
  /** The exact run currently bound to execution, if the lineage is active. */
  executionRunRef?: RunRef;
}

/**
 * Webview → Extension: delete every non-executing run of an explicit lineage —
 * the run-navigation panel's "Delete all runs" footer action. Targets
 * `workflowKey` directly rather than the client's own active queue, and has no
 * native confirm dialog (the client gates confirmation itself, per
 * `confirmDeleteOperations`).
 */
export interface DeleteAllRunsForLineageMessage {
  type: typeof MESSAGE_TYPES.DELETE_ALL_RUNS_FOR_LINEAGE;
  workflowKey: WorkflowKey;
}

/** Start the currently viewed draft through its explicit address. */
export interface ExecuteDraftMessage {
  type: typeof MESSAGE_TYPES.EXECUTE_DRAFT;
  address: Extract<WorkflowViewAddress, { kind: "draft" }>;
  expectedDefinitionRevision: number;
  expectedDescriptorRevision: number;
}

/** Seed and execute a fresh RunRef from the addressed promoted run. */
export interface SeedNewRunMessage {
  type: typeof MESSAGE_TYPES.SEED_NEW_RUN;
  address: Extract<WorkflowViewAddress, { kind: "run" }>;
  expectedDefinitionRevision: number;
  expectedDescriptorRevision: number;
}

/** Discard a pending rewind and seed a new RunRef without exposing an intermediate state. */
export interface StartNewRunInsteadMessage {
  type: typeof MESSAGE_TYPES.START_NEW_RUN_INSTEAD;
  address: Extract<WorkflowViewAddress, { kind: "run" }>;
  expectedDefinitionRevision: number;
  expectedDescriptorRevision: number;
  /** Set only after the caller has confirmed suffix edits will be lost. */
  confirmEditedSuffix?: boolean;
}

/** Continue the exact addressed promoted run without inferring the latest run. */
export interface ContinueRunMessage {
  type: typeof MESSAGE_TYPES.CONTINUE_RUN;
  address: Extract<WorkflowViewAddress, { kind: "run" }>;
  expectedDefinitionRevision: number;
  expectedDescriptorRevision: number;
}

/** Append runtime-free tail steps and continue the exact addressed promoted run. */
export interface AppendAndContinueRunMessage {
  type: typeof MESSAGE_TYPES.APPEND_AND_CONTINUE_RUN;
  address: Extract<WorkflowViewAddress, { kind: "run" }>;
  tail: WorkflowStep[];
  expectedDefinitionRevision: number;
  expectedDescriptorRevision: number;
}

/** Runtime controls always identify the executing promoted run. */
export interface RunExecutionControlMessage {
  type:
    | typeof MESSAGE_TYPES.PAUSE_RUN
    | typeof MESSAGE_TYPES.CANCEL_PAUSE_RUN
    | typeof MESSAGE_TYPES.RESUME_RUN
    | typeof MESSAGE_TYPES.STOP_RUN;
  address: Extract<WorkflowViewAddress, { kind: "run" }>;
}

/**
 * Set start position message (webview -> extension)
 */
export interface SetStartPositionMessage {
  type: typeof MESSAGE_TYPES.SET_START_POSITION;
  toIndex: number;
  /** Start-position is always an explicit promoted-run operation. */
  address: Extract<WorkflowViewAddress, { kind: "run" }>;
  expectedDefinitionRevision: number;
  expectedDescriptorRevision: number;
}

/** Restore a run from its durable pending-rewind base snapshot. */
export interface DiscardContinuationMessage {
  type: typeof MESSAGE_TYPES.DISCARD_CONTINUATION;
  address: Extract<WorkflowViewAddress, { kind: "run" }>;
  expectedDefinitionRevision: number;
  expectedDescriptorRevision: number;
  /** Set only after the caller has confirmed suffix edits will be lost. */
  confirmEditedSuffix?: boolean;
}

/**
 * Sent when a `DiscardContinuationMessage`/`StartNewRunInsteadMessage` request
 * hit unsaved edits to the rewound suffix. Rendered as an in-app confirmation
 * modal — never a native OS/VS Code dialog — so hosted browser clients (which
 * never see VS Code's own UI) can see and act on it too. Confirming resends
 * the original message with `confirmEditedSuffix: true`.
 */
export interface SuffixEditConfirmationRequiredMessage {
  type: typeof MESSAGE_TYPES.SUFFIX_EDIT_CONFIRMATION_REQUIRED;
  action: "discardContinuation" | "startNewRunInstead";
  address: Extract<WorkflowViewAddress, { kind: "run" }>;
  expectedDefinitionRevision: number;
  expectedDescriptorRevision: number;
}

/**
 * Append a prompt file's steps to the queue (webview -> extension). A `"run"`-kind
 * `mutation` re-addresses this through the append-and-continue contract instead of
 * the legacy instance-bound queue append; a draft/ephemeral target keeps the
 * original queue-only behavior.
 */
export interface AppendFileMessage {
  type: typeof MESSAGE_TYPES.APPEND_FILE;
  filePath?: string;
  mutation?: WorkflowDefinitionMutation;
}

/**
 * Update an existing queue step. When a completed nonzero step is edited,
 * `rewindCompletedStep` asks the backend to begin the same durable pending
 * continuation as Set Start Position before applying the edit. The backend
 * coordinates both writes so the edit uses the rewind's advanced revisions.
 */
export interface UpdatePromptMessage {
  type: typeof MESSAGE_TYPES.UPDATE_PROMPT;
  index: number;
  text: string;
  properties: unknown;
  clearProperties?: string[];
  promptName?: string;
  rewindCompletedStep?: boolean;
  mutation?: WorkflowDefinitionMutation;
}

/**
 * Insert workflow step message (webview -> extension)
 * `afterIndex` is the existing queue index after which the pasted step should be inserted.
 */
export interface InsertWorkflowStepMessage {
  type: typeof MESSAGE_TYPES.INSERT_WORKFLOW_STEP;
  afterIndex: number;
  step: WorkflowStep;
  mutation?: WorkflowDefinitionMutation;
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
  mutation?: WorkflowDefinitionMutation;
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

export type { UndoFileAction } from "./DashboardConstants";

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
    workflowKey: WorkflowKey;
    runRef: RunRef;
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
    workflowKey: WorkflowKey;
    runRef: RunRef;
    files: UndoFileInstruction[];
  };
}

/** Webview → Extension: undo changes across multiple workflow steps */
export interface UndoWorkflowChangesMessage {
  type: typeof MESSAGE_TYPES.UNDO_WORKFLOW_CHANGES;
  data: {
    requestId: string;
    workflowKey: WorkflowKey;
    runRef: RunRef;
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
    workflowKey: WorkflowKey;
    runRef: RunRef;
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
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  transport?: "streamable-http" | "sse";
  headers?: Record<string, string>;
  /** Absolute path to the config file where this entry was discovered */
  path: string;
  /** Where this entry was discovered from */
  source:
    | "vscode-workspace"
    | "vscode-user"
    | "claude-workspace"
    | "claude-user"
    | "copilot-workspace"
    | "copilot-user"
    | "codex-workspace"
    | "codex-user"
    | "opencode-workspace"
    | "opencode-user"
    | "qwen-workspace"
    | "qwen-user"
    | "antigravity-workspace"
    | "antigravity-user";
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

export interface ManagedMcpServerLocation {
  targetId: AnyTargetId;
  scope: SettingWriteScope;
  path: string;
}

export interface ManagedMcpServer {
  id: string;
  displayName: string;
  config: McpServerConfig;
  locations: ManagedMcpServerLocation[];
}

export interface RequestMcpRegistryServersMessage {
  type: typeof MESSAGE_TYPES.REQUEST_MCP_REGISTRY_SERVERS;
}

export interface SaveMcpRegistryServerMessage {
  type: typeof MESSAGE_TYPES.SAVE_MCP_REGISTRY_SERVER;
  server: McpServerConfig;
  scope: SettingWriteScope;
  previousId?: string;
}

export interface DeleteMcpRegistryServerMessage {
  type: typeof MESSAGE_TYPES.DELETE_MCP_REGISTRY_SERVER;
  id: string;
  scope: SettingWriteScope;
}

export interface RequestMcpLocalScanMessage {
  type: typeof MESSAGE_TYPES.REQUEST_MCP_LOCAL_SCAN;
}

export interface RequestMcpRegistrySearchMessage {
  type: typeof MESSAGE_TYPES.REQUEST_MCP_REGISTRY_SEARCH;
  query: string;
  cursor?: string;
  updatedSince?: string;
}

export interface ExportMcpToHarnessMessage {
  type: typeof MESSAGE_TYPES.EXPORT_MCP_TO_HARNESS;
  servers: McpServerConfig[];
  targetId: AnyTargetId;
  scope: SettingWriteScope;
}

export interface DeleteMcpFromHarnessMessage {
  type: typeof MESSAGE_TYPES.DELETE_MCP_FROM_HARNESS;
  ids: string[];
  targetId: AnyTargetId;
  scope: SettingWriteScope;
  filePath?: string;
}

export interface McpRegistryServersUpdateMessage {
  type: typeof MESSAGE_TYPES.MCP_REGISTRY_SERVERS_UPDATE;
  servers: ManagedMcpServer[];
}

export interface McpLocalScanResultMessage {
  type: typeof MESSAGE_TYPES.MCP_LOCAL_SCAN_RESULT;
  servers: LocalMcpServerEntry[];
  error?: string;
}

export interface McpRegistrySearchResultMessage {
  type: typeof MESSAGE_TYPES.MCP_REGISTRY_SEARCH_RESULT;
  servers: RegistryMcpEntry[];
  nextCursor?: string;
  error?: string;
}

export interface RequestMcpConfigPreviewMessage {
  type: typeof MESSAGE_TYPES.REQUEST_MCP_CONFIG_PREVIEW;
  mcpServerName: string;
}

export interface McpConfigPreviewResultMessage {
  type: typeof MESSAGE_TYPES.MCP_CONFIG_PREVIEW_RESULT;
  mcpServerName: string;
  content: string;
  found: boolean;
}

// ============================================================================
// HARNESS FILE MANAGER TYPES
// ============================================================================

/** A single location where an agent or skill file exists on disk */
export interface ManagedFileLocation {
  /** The target ID for this location (harness ID or special dir like "ctrlyoke", "agents", "vscode") */
  harnessId: AnyTargetId;
  /** Whether this copy lives in a workspace dir or a user-level (~/) dir */
  scope: SettingWriteScope;
  /** Absolute path to the file (agent) or directory (skill) on disk */
  path: string;
}

/** A discovered agent or skill, with all known on-disk locations */
export interface ManagedFile {
  /** Agent/skill name without extension or dir suffix */
  name: string;
  /** Formatted display name for the UI */
  displayName: string;
  type: "agent" | "skill";
  locations: ManagedFileLocation[];
  /** Immutable bundled source available for export when no editable copy exists. */
  builtInSourcePath?: string;
  /** Description parsed from the file's frontmatter, if present. */
  description?: string;
}

/** A target directory shown in the Agent/Skills manager UI */
export interface ManagedTargetDirectory {
  harnessId: AnyTargetId;
  scope: SettingWriteScope;
  path: string;
}

/** Webview → Extension: enumerate all agents or skills */
export interface RequestHarnessFilesMessage {
  type: typeof MESSAGE_TYPES.REQUEST_HARNESS_FILES;
  fileType: "agent" | "skill";
}

/** Extension → Webview: result of enumeration */
export interface HarnessFilesResultMessage {
  type: typeof MESSAGE_TYPES.HARNESS_FILES_RESULT;
  files: ManagedFile[];
  targetDirectories?: ManagedTargetDirectory[];
}

/** Webview → Extension: copy a file to a target dir */
export interface ExportToHarnessMessage {
  type: typeof MESSAGE_TYPES.EXPORT_TO_HARNESS;
  sourcePath: string;
  harnessId: AnyTargetId;
  fileType: "agent" | "skill";
  overwrite?: boolean;
  scope: SettingWriteScope;
}

/** Webview → Extension: copy a file into .ctrlyoke/agents or .ctrlyoke/skills */
export interface ImportToCtrlYokeMessage {
  type: typeof MESSAGE_TYPES.IMPORT_TO_CTRLYOKE;
  sourcePath: string;
  fileType: "agent" | "skill";
  overwrite?: boolean;
}

/** Webview → Extension: delete a file from a specific target dir */
export interface DeleteFromHarnessMessage {
  type: typeof MESSAGE_TYPES.DELETE_FROM_HARNESS;
  name: string;
  harnessId: AnyTargetId;
  fileType: "agent" | "skill";
  scope: SettingWriteScope;
}

/** Webview → Extension: copy all files to a single target dir */
export interface SyncAllToHarnessMessage {
  type: typeof MESSAGE_TYPES.SYNC_ALL_TO_HARNESS;
  /** List of { sourcePath, name } for each file to sync */
  files: Array<{ sourcePath: string; name: string }>;
  targetHarnessId: AnyTargetId;
  fileType: "agent" | "skill";
  scope: SettingWriteScope;
}

/** Webview → Extension: delete all discovered files from a specific target dir */
export interface DeleteAllFromHarnessMessage {
  type: typeof MESSAGE_TYPES.DELETE_ALL_FROM_HARNESS;
  harnessId: AnyTargetId;
  fileType: "agent" | "skill";
  scope: SettingWriteScope;
}

/** Extension → Webview: result of a file operation (export/import/delete/sync) */
export interface HarnessFileOpResultMessage {
  type: typeof MESSAGE_TYPES.HARNESS_FILE_OP_RESULT;
  success: boolean;
  error?: string;
  /** Updated file list after the operation (re-broadcast for convenience) */
  files?: ManagedFile[];
  targetDirectories?: ManagedTargetDirectory[];
}

/** Webview → Extension: open target directory in Explorer/Finder */
export interface OpenHarnessDirMessage {
  type: typeof MESSAGE_TYPES.OPEN_HARNESS_DIR;
  harnessId: AnyTargetId;
  fileType: "agent" | "skill";
  scope: SettingWriteScope;
}

/** Extension → Webview: result of an open-folder request */
export interface OpenHarnessDirResultMessage {
  type: typeof MESSAGE_TYPES.OPEN_HARNESS_DIR_RESULT;
  success: boolean;
  error?: string;
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
  | ContextWindowUpdateMessage
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
  | HarnessUsageUpdatedMessage
  | WorkspaceStatsUpdatedMessage
  | HarnessCapabilitySnapshotMessage
  | AgentsUpdateMessage
  | SkillsUpdateMessage
  | WorkflowPropertiesUpdateMessage
  | { type: typeof MESSAGE_TYPES.WORKFLOW_LOADED }
  | { type: typeof MESSAGE_TYPES.WORKFLOW_UNLOADED }
  | OpenNewWorkflowModalMessage
  | { type: typeof MESSAGE_TYPES.WORKFLOW_NAME_UPDATED; workflowName: string }
  | RecentWorkflowsMessage
  | RunSummariesLoadedMessage
  | { type: typeof MESSAGE_TYPES.TEMPLATE_INFO; template: any }
  | { type: typeof MESSAGE_TYPES.DEFAULT_TEMPLATE_SET; templateId: string }
  | { type: typeof MESSAGE_TYPES.WORKFLOW_CREATED; filePath: string }
  | EndConditionScriptCreatedMessage
  | EndConditionScriptCreationFailedMessage
  | HarnessDetectionRetryResultMessage
  | {
      type: typeof MESSAGE_TYPES.COMPLETIONS_RESPONSE;
      completions: any[];
      trigger: string;
    }
  | ScriptCompletionsResponseMessage
  | {
      type: typeof MESSAGE_TYPES.CONTEXT_REFS_VALIDATION;
      results: Array<{
        id: string;
        exists: boolean;
        message?: string;
        /** CompletionItemKind, resolved live for #sym: refs so the dashboard chip can show the real symbol-kind icon. */
        symbolKind?: number;
      }>;
      seq?: number;
    }
  | {
      type: typeof MESSAGE_TYPES.ATTACHMENT_TOKEN_COUNTS_RESPONSE;
      /** Map from reference key (e.g. "file:src/foo.ts") to token count */
      counts: Record<string, number>;
    }
  | SaveWorkflowDialogDataMessage
  | SavePathCheckedMessage
  | WorkflowSavedMessage
  | WorkflowSaveFailedMessage
  | WorkflowSavedAsTemplateMessage
  | WorkflowVariantCreatedMessage
  | WorkflowVariantFailedMessage
  | WorkflowsListMessage
  | WorkflowAddedMessage
  | WorkflowDismissedMessage
  | WorkflowSummaryUpdatedMessage
  | ActiveWorkflowChangedMessage
  | ExecutionPreviewResultMessage
  | PromptEditorInsertMessage
  | FileRefValidationMessage
  | PromptFileCreatedMessage
  | GlobalSettingsUpdatedMessage
  | SearchHistoryResultsMessage
  | OutputHistoryLoadedMessage
  | StepUndoDataUpdatedMessage
  | UndoPromptResultMessage
  | UndoRecordUpdatedMessage
  | McpRegistryServersUpdateMessage
  | McpLocalScanResultMessage
  | McpRegistrySearchResultMessage
  | GlobalSettingsLoadedMessage
  | WorktreeManagementStateMessage
  | WorktreeManagementActionResultMessage
  | GlobalSettingUpdatedMessage
  | NotificationEventMessage
  | UserFeedbackMessage
  | DevStatusMessage
  | DevBuildStartedMessage
  | DevBuildOutputMessage
  | DevBuildCompletedMessage
  | DevRestartingMessage
  | DevCommandUnavailableMessage
  | UxSnapshotSavedMessage
  | CommitMessageGenerationUpdatedMessage
  | HarnessFilesResultMessage
  | HarnessFileOpResultMessage
  | OpenHarnessDirResultMessage
  | { type: typeof MESSAGE_TYPES.STARTUP_COMPLETE }
  | { type: typeof MESSAGE_TYPES.WORKSPACE_INIT_REQUIRED }
  | { type: typeof MESSAGE_TYPES.INITIALIZE_WORKSPACE }
  | { type: typeof MESSAGE_TYPES.SHOW_LAYOUT_TIP }
  | { type: typeof MESSAGE_TYPES.LAYOUT_TIP_DISMISSED };
