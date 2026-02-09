/**
 * Shared webview message types and data structures
 * SINGLE SOURCE OF TRUTH for all types shared between extension and React webview
 *
 * This file consolidates:
 * - CLI output data types (CliOutputData, CliOutput, CliOutputItem)
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

import { ExecutionState, StepStatus, HarnessId, MESSAGE_TYPES, STATUS_MESSAGE_SEVERITY, EXECUTION_MODES } from "./DashboardConstants";
import type {
  CliEvent as CliOutputEvent,
  UniversalCliOutput,
  ToolResult,
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
  UnifiedDiffHunk,
} from "./CliOutputTypes";

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

// ============================================================================
// MESSAGE TYPE HELPERS - Extract literal types from MESSAGE_TYPES constants
// ============================================================================

/** Severity level type (single source from STATUS_MESSAGE_SEVERITY) */
type StatusSeverity = typeof STATUS_MESSAGE_SEVERITY[keyof typeof STATUS_MESSAGE_SEVERITY];

/** Execution mode type (single source from EXECUTION_MODES) */
type ExecutionMode = typeof EXECUTION_MODES[keyof typeof EXECUTION_MODES];

// ============================================================================
// CLI OUTPUT DATA TYPES
// ============================================================================

/**
 * Token statistics for a CLI response
 */
export interface TokenStats {
  prompt: number;
  completion: number;
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
}

/**
 * Alias for backward compatibility
 * Use CliOutput instead in new code
 */
export type CliOutputData = CliOutput;

/**
 * Alias for backward compatibility
 * Use CliOutput instead in new code
 */
export type CliOutputItem = CliOutput;

// ============================================================================
// CLI EVENT DATA TYPES (Re-exported from CliOutputTypes for consistency)
// ============================================================================

/**
 * Re-export CLI event types from CliOutputTypes (single source of truth for CLI structures)
 * These types are used throughout the codebase for structured CLI output handling.
 */

// Re-export event data types
export type { TextData, BashCommandData, FileReadData, FileWriteData, FileEditData, FileDeleteData, McpToolCallData, WebSearchData, ThinkingBlock, ToolCall, ToolResultData, UniversalCliOutput, UnifiedDiffHunk } from "./CliOutputTypes";

// Alias for the detailed CliEvent type from CliOutputTypes
export type CliEvent = CliOutputEvent;

// Alias for unified diff hunk (from CliOutputTypes)
export type DiffHunk = UnifiedDiffHunk;

// Alias for tool result (from CliOutputTypes)
export type { ToolResult };

/**
 * Union type for all event data (same as CliOutputTypes.CliEventData)
 */
export type CliEventData =
  | TextData
  | ThinkingBlock
  | ToolCall
  | ToolResultData
  | BashCommandData
  | FileReadData
  | FileWriteData
  | FileEditData
  | FileDeleteData
  | McpToolCallData
  | WebSearchData;

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

// For backward compatibility with older event type definitions
export type BaseEventData = Record<string, unknown>;
export type TextEventData = TextData;
export type ThinkingEventData = ThinkingBlock;
export type BashCommandEventData = BashCommandData;
export type FileReadEventData = FileReadData;
export type FileWriteEventData = FileWriteData;
export type FileEditEventData = FileEditData;
export type FileDeleteEventData = FileDeleteData;
export type McpToolCallEventData = McpToolCallData;
export type WebSearchEventData = WebSearchData;
export type ToolCallEventData = ToolCall;
export type ToolResultEventData = ToolResultData;

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
  id?: string;
  prompt: string;
  harness?: string;
  model?: string;
  agent?: string;
  resumeSession?: boolean;
  sessionId?: string | number;
  allowDynamicExtension?: boolean;
  endCondition?: EndConditionConfig | null;
  _runtime?: {
    harness?: string;
    model?: string;
    sessionId?: string;
    startedAt?: number;
    completedAt?: number;
    retryCount?: number;
    isRetry?: boolean;
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
}

/**
 * Execution started message (extension -> webview)
 */
export interface ExecutionStartedMessage {
  type: typeof MESSAGE_TYPES.EXECUTION_STARTED;
  fileName: string;
  totalSteps: number;
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
}

/**
 * Prompt deleted message (extension -> webview)
 */
export interface PromptDeletedMessage {
  type: typeof MESSAGE_TYPES.PROMPT_DELETED;
  fileName: string;
  prompts: PromptItem[];
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
    isAction: boolean;
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
  | { type: typeof MESSAGE_TYPES.EXECUTION_COMPLETED }
  | PromptsExtendedMessage
  | PromptDeletedMessage
  | ModelOptionsUpdateMessage
  | HarnessStatusUpdateMessage
  | AgentsUpdateMessage
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
    };
