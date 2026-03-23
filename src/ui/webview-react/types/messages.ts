/**
 * Message type definitions for extension <-> webview communication
 * SINGLE SOURCE OF TRUTH: src/types/DashboardConstants.ts and src/types/WebviewMessageTypes.ts
 *
 * This file re-exports all message types and constants from the extension-side definitions.
 * This ensures the React webview uses the same types as the extension without duplication.
 */

// Re-export all constants from DashboardConstants
export {
  MESSAGE_TYPES,
  LOG_LEVELS,
  EXECUTION_STATES,
  STEP_STATUS,
  STATUS_MESSAGE_SEVERITY,
  ACTION_TYPES,
  HARNESS_IDS,
  HARNESS_INFO,
  HARNESS_STATUS_STRINGS,
  CLI_EVENT_TYPES,
  OPERATION_STATUS,
  FINAL_PROMPT_PHASES,
  PROMPT_PROPERTIES,
  END_CONDITION_PROPERTIES,
  EXECUTION_MODES,
  SESSION_ID_SENTINELS,
  RUNNER_IDS,
  type MessageType,
  type WebviewLogLevel,
  type ExecutionState,
  type StepStatus,
  type FinalPromptPhase,
  type StatusMessageSeverity,
  type ActionType,
  type HarnessId,
  type HarnessStatusString,
  type RunnerId,
} from "@root/types/DashboardConstants";

// Re-export all message and data types from WebviewMessageTypes
export {
  // Message payload interfaces
  type InitMessageData,
  type FileSelectedMessage,
  type SessionRestoredMessage,
  type ExecutionStartedMessage,
  type ExecutionStateChangedMessage,
  type ProgressUpdateMessage,
  type StepStatusChangedMessage,
  type RetryAttemptChangedMessage,
  type CliOutputMessage,
  type CliStreamingChunkMessage,
  type CliStreamingEventsMessage,
  type StatusMessageMessage,
  type PromptsExtendedMessage,
  type PromptDeletedMessage,
  type UpdateFinalPromptMessage,
  type FinalPromptStatusChangedMessage,
  type FinalPromptOutputMessage,
  type ModelOptionsUpdateMessage,
  type HarnessStatusUpdateMessage,
  type AgentsUpdateMessage,
  type SkillsUpdateMessage,
  type WorkflowPropertiesUpdateMessage,
  type OpenNewWorkflowModalMessage,
  type RecentWorkflowsMessage,
  type IncomingMessage,

  // Prompt and workflow types
  type PromptItem,
  type EndConditionConfig,
  type RetryState,
  type StatusMessage,

  // CLI output types
  type CliOutput,
  type TokenStats,

  // CLI event types
  type CliEvent,
  type StructuredOutput,
  type OutputStatusMessage,
  type CliEventData,
  type TextData,
  type ThinkingBlock,
  type BashCommandData,
  type FileReadData,
  type FileWriteData,
  type FileEditData,
  type FileDeleteData,
  type ToolCall,
  type ToolResultData,
  type McpToolCallData,
  type WebSearchData,
  type ToolResult,
  type UnifiedDiffHunk,
  type UndoResult,
  type UndoFileAction,
  type UndoFileInstruction,
  type UndoCandidateTier,
  type UndoFileCandidate,
  type UndoRecord,
  type UndoRecordUpdatedMessage,
  type RedoPromptChangesMessage,
} from "@root/types/WebviewMessageTypes";

// Re-export WorkflowSummary, PriorContext, and helpers from FlightPathTypes
export type { WorkflowSummary, PriorContext } from "@root/types/FlightPathTypes";
export { workflowDisplayStep } from "@root/types/FlightPathTypes";
