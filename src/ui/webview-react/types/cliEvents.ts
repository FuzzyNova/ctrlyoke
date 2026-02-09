/**
 * CLI Event Types for structured output rendering
 * Mirrors CLI_EVENT_TYPES from DashboardConstants.ts
 */

export const CLI_EVENT_TYPES = {
  TEXT: "text",
  THINKING: "thinking",
  BASH_COMMAND: "bashCommand",
  FILE_READ: "fileRead",
  FILE_WRITE: "fileWrite",
  FILE_EDIT: "fileEdit",
  FILE_DELETE: "fileDelete",
  MCP_TOOL_CALL: "mcpToolCall",
  WEB_SEARCH: "webSearch",
  TOOL_CALL: "toolCall",
  TOOL_RESULT: "toolResult",
} as const;

export type CliEventType =
  (typeof CLI_EVENT_TYPES)[keyof typeof CLI_EVENT_TYPES];

/**
 * Operation status for file operations
 */
export const OPERATION_STATUS = {
  INITIATED: "initiated",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

export type OperationStatus =
  (typeof OPERATION_STATUS)[keyof typeof OPERATION_STATUS];

/**
 * Unified diff hunk structure
 */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/**
 * Base CLI event data
 */
export interface BaseEventData {
  status?: OperationStatus;
  error?: string;
}

/**
 * Text event data
 */
export interface TextEventData extends BaseEventData {
  text: string;
}

/**
 * Thinking event data
 */
export interface ThinkingEventData extends BaseEventData {
  text: string;
  label?: string;
}

/**
 * Bash command event data
 */
export interface BashCommandEventData extends BaseEventData {
  command: string;
  output?: string;
  error?: string;
  exitCode?: number;
}

/**
 * File read event data
 */
export interface FileReadEventData extends BaseEventData {
  path: string;
  content?: string;
}

/**
 * File write event data
 */
export interface FileWriteEventData extends BaseEventData {
  path: string;
  content?: string;
}

/**
 * File edit event data
 */
export interface FileEditEventData extends BaseEventData {
  path: string;
  oldContent?: string;
  newContent?: string;
  structuredPatch?: DiffHunk[];
}

/**
 * File delete event data
 */
export interface FileDeleteEventData extends BaseEventData {
  path: string;
}

/**
 * MCP tool call event data
 */
export interface McpToolCallEventData extends BaseEventData {
  server: string;
  tool: string;
  parameters?: Record<string, unknown>;
  result?: ToolResult;
}

/**
 * Web search event data
 */
export interface WebSearchEventData extends BaseEventData {
  query: string;
  results?: string[];
}

/**
 * Tool result structure
 */
export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
}

/**
 * Generic tool call event data
 */
export interface ToolCallEventData extends BaseEventData {
  name: string;
  parameters?: Record<string, unknown>;
  result?: ToolResult;
}

/**
 * Tool result event data
 */
export interface ToolResultEventData extends BaseEventData {
  result: ToolResult;
}

/**
 * Union type for all event data
 */
export type CliEventData =
  | TextEventData
  | ThinkingEventData
  | BashCommandEventData
  | FileReadEventData
  | FileWriteEventData
  | FileEditEventData
  | FileDeleteEventData
  | McpToolCallEventData
  | WebSearchEventData
  | ToolCallEventData
  | ToolResultEventData;

/**
 * CLI Event structure
 */
export interface CliEvent {
  type: CliEventType;
  data: CliEventData;
}

/**
 * Structured output with events
 */
export interface StructuredOutput {
  events: CliEvent[];
}

/**
 * Token statistics
 */
export interface TokenStats {
  prompt: number;
  completion: number;
}

/**
 * Full CLI output object (matches workflowStore.CliOutput)
 */
export interface CliOutputItem {
  prompt: string;
  response: string;
  structured?: StructuredOutput;
  elapsed: number;
  tokens?: TokenStats;
  isStreaming: boolean;
  cliCommand?: string;
  workingDirectory?: string;
  timestampMs?: number;
  attemptIndex?: number;
}

/**
 * Status message for output display
 */
export interface OutputStatusMessage {
  message: string;
  severity: "info" | "warning" | "error";
  timestamp: string;
  timestampMs: number;
}
