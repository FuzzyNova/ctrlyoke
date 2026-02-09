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
  EXECUTION_STATES,
  STEP_STATUS,
  STATUS_MESSAGE_SEVERITY,
  ACTION_TYPES,
  HARNESS_IDS,
  CLI_EVENT_TYPES,
  OPERATION_STATUS,
  type MessageType,
  type ExecutionState,
  type StepStatus,
  type StatusMessageSeverity,
  type ActionType,
  type HarnessId,
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
  type ModelOptionsUpdateMessage,
  type HarnessStatusUpdateMessage,
  type AgentsUpdateMessage,
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
  type CliOutputData,
  type CliOutputItem,
  type TokenStats,

  // CLI event types
  type CliEvent,
  type StructuredOutput,
  type OutputStatusMessage,
  type CliEventData,
  type BaseEventData,
  type TextEventData,
  type ThinkingEventData,
  type BashCommandEventData,
  type FileReadEventData,
  type FileWriteEventData,
  type FileEditEventData,
  type FileDeleteEventData,
  type ToolCallEventData,
  type ToolResultEventData,
  type McpToolCallEventData,
  type WebSearchEventData,
  type ToolResult,
  type DiffHunk,
} from "@root/types/WebviewMessageTypes";
