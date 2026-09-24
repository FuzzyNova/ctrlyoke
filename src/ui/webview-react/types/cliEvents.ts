/**
 * CLI Event Types for structured output rendering
 * SINGLE SOURCE OF TRUTH: src/types/CliOutputTypes.ts
 *
 * This file re-exports CLI event types from the extension-side definitions.
 * This ensures the React webview uses the same event type definitions as the extension without duplication.
 *
 * For webview-specific message types, see messages.ts
 */

// Re-export CLI event constants and types
export {
  CLI_EVENT_TYPES,
  OPERATION_STATUS,
  COMPACTION_TRIGGERS,
  CALLER_TYPES,
  type CliEventType,
  type FileOperationStatus,
  type CompactionTrigger,
  type CallerType,
} from "@root/types/DashboardConstants";

// Re-export all CLI event data interfaces and structures
export {
  // Event types (from CliOutputTypes)
  type CliEvent,
  type CliEventData,
  type TextData,
  type ThinkingBlock,
  type BashCommandData,
  type FileReadData,
  type FileWriteData,
  type FileEditData,
  type FileDeleteData,
  type ToolCall,
  type ToolResult,
  type ToolResultData,
  type McpToolCallData,
  type WebSearchData,
  type CompactionData,
  type UserSteerData,
  type FollowUpResumedData,
  type BackgroundWorkHoldData,
  type BackgroundTaskSummary,
  type ContextWindowSyncData,
  type UnifiedDiffHunk,
  type UniversalCliOutput,
  type AskUserQuestionData,
  type AskUserQuestionEntry,
  type AskUserQuestionOption,
  type AskUserQuestionDeclined,

  // Structured output and display types
  type StructuredOutput,
  type TokenStats,
  type CliOutput,
  type OutputStatusMessage,
} from "@root/types/WebviewMessageTypes";
