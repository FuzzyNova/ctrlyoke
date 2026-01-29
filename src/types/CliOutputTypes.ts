/**
 * Universal CLI output types for standardizing output across all CLI providers.
 * These types provide a provider-agnostic format that can be used by Copilot CLI,
 * Claude CLI, Codex CLI, and any future CLI integrations.
 */

/**
 * CLI event type constants.
 * Use these constants instead of string literals to avoid typos and ensure consistency.
 *
 * Operation-specific types (BASH_COMMAND, FILE_*, etc.) allow the dashboard to render
 * specialized views without knowing about provider-specific tool formats.
 */
export const CLI_EVENT_TYPES = {
  TEXT: "text",
  THINKING: "thinking",

  // Operation-specific tool events (normalized from provider formats)
  BASH_COMMAND: "bashCommand",
  FILE_READ: "fileRead",
  FILE_WRITE: "fileWrite",
  FILE_EDIT: "fileEdit",
  FILE_DELETE: "fileDelete",
  MCP_TOOL_CALL: "mcpToolCall",
  WEB_SEARCH: "webSearch",

  // Generic fallback for unrecognized tools
  TOOL_CALL: "toolCall",

  TOOL_RESULT: "toolResult",
} as const;

/**
 * Type of CLI event.
 * Events are rendered in the order they occurred during the CLI session.
 */
export type CliEventType =
  (typeof CLI_EVENT_TYPES)[keyof typeof CLI_EVENT_TYPES];

/**
 * A single event in the CLI output stream.
 * Events maintain chronological order to preserve the actual sequence of AI interactions.
 */
export interface CliEvent {
  /** Type of event (text, tool call, thinking block, tool result) */
  type: CliEventType;
  /** Timestamp when this event occurred (milliseconds since epoch) */
  timestamp?: number;
  /** Event-specific data based on type */
  data: CliEventData;
}

/**
 * Union type for event data.
 * The actual type depends on the CliEvent.type field.
 */
export type CliEventData =
  | TextData
  | ToolCall
  | ThinkingBlock
  | ToolResultData
  | BashCommandData
  | FileReadData
  | FileWriteData
  | FileEditData
  | FileDeleteData
  | McpToolCallData
  | WebSearchData;

/**
 * Data for a text event (AI response text).
 */
export interface TextData {
  /** The text content */
  text: string;
}

/**
 * Data for a tool result event.
 * Separate from ToolCall to maintain chronological order (result comes after call).
 */
export interface ToolResultData {
  /** ID of the tool call this result belongs to */
  toolCallId: string;
  /** Result of the tool execution */
  result: ToolResult;
}

/**
 * Universal CLI output structure (provider-agnostic).
 * Used by all CLI parsers to standardize output format before display.
 */
export interface UniversalCliOutput {
  /**
   * Chronologically ordered events from the CLI session.
   * This array preserves the exact order events occurred:
   * - Text responses from the AI
   * - Tool calls made by the AI
   * - Thinking/reasoning blocks
   * - Tool execution results
   */
  events: CliEvent[];

  /** Response metadata (tokens, session, model, etc.) */
  metadata: OutputMetadata;
}

/**
 * Represents a tool call made by the AI during response generation.
 * Normalized from provider-specific formats (e.g., 'input' vs 'arguments').
 */
export interface ToolCall {
  /** Tool name (e.g., 'read_file', 'write_file', 'bash') */
  name: string;
  /** Tool parameters - normalized from 'input' or 'arguments' depending on provider */
  parameters: Record<string, unknown>;
  /** Optional tool call ID for tracking */
  id?: string;
  /** Result of the tool execution, if available */
  result?: ToolResult;
}

/**
 * Result of a tool execution.
 */
export interface ToolResult {
  /** Whether the tool execution succeeded */
  success: boolean;
  /** Output from the tool (if successful) */
  output?: string;
  /** Error message (if failed) */
  error?: string;
}

/**
 * Represents a thinking/reasoning block from the AI.
 * Used for Claude's extended thinking feature and similar capabilities.
 */
export interface ThinkingBlock {
  /** The thinking/reasoning text */
  text: string;
  /** Timestamp when this thinking block was generated */
  timestamp?: number;
  /** Label for the thinking block (e.g., "Reasoning", "Planning", "Analysis") */
  label?: string;
}

/**
 * Metadata about the CLI response.
 * Contains session info, token usage, and other statistics.
 */
export interface OutputMetadata {
  /** Session ID for conversation continuity */
  sessionId?: string;
  /** Model used for the response */
  model?: string;
  /** Token usage statistics */
  usage?: TokenUsage;
  /** CLI version that generated the response */
  cliVersion?: string;
  /** Elapsed time in milliseconds */
  elapsed?: number;
  /** Provider identifier (e.g., 'copilot-cli', 'claude-cli', 'codex-cli') */
  provider?: string;
}

/**
 * Data for a bash/shell command execution event.
 */
export interface BashCommandData {
  /** Command executed */
  command: string;
  /** Working directory (optional) */
  workingDir?: string;
  /** Exit code (0 = success) */
  exitCode?: number;
  /** Command output (stdout) */
  output?: string;
  /** Error output (stderr) */
  error?: string;
  /** Execution status */
  status?: "in_progress" | "completed" | "failed";
}

/**
 * Data for a file read operation.
 */
export interface FileReadData {
  /** File path */
  path: string;
  /** File content (if available) */
  content?: string;
  /** Success status */
  success?: boolean;
  /** Error message (if failed) */
  error?: string;
}

/**
 * Data for a file write operation (create new file).
 */
export interface FileWriteData {
  /** File path */
  path: string;
  /** Content written */
  content: string;
  /** Success status */
  success?: boolean;
  /** Error message (if failed) */
  error?: string;
}

/**
 * Data for a file edit operation (modify existing file).
 * Supports both full-content and diff-based edits.
 */
export interface FileEditData {
  /** File path */
  path: string;
  /** Old content (before edit) */
  oldContent?: string;
  /** New content (after edit) */
  newContent?: string;
  /** For multi-file or patch-based edits */
  changes?: Array<{
    path: string;
    kind: "add" | "update" | "delete";
    oldContent?: string;
    newContent?: string;
  }>;
  /** Success status */
  success?: boolean;
  /** Error message (if failed) */
  error?: string;
}

/**
 * Data for a file delete operation.
 */
export interface FileDeleteData {
  /** File path */
  path: string;
  /** Success status */
  success?: boolean;
  /** Error message (if failed) */
  error?: string;
}

/**
 * Data for an MCP (Model Context Protocol) tool call.
 */
export interface McpToolCallData {
  /** MCP server name */
  server: string;
  /** Tool name */
  tool: string;
  /** Tool parameters */
  parameters?: Record<string, unknown>;
  /** Tool result (optional) */
  result?: ToolResult;
}

/**
 * Data for a web search operation.
 */
export interface WebSearchData {
  /** Search query */
  query: string;
  /** Search results (optional) */
  results?: Array<{
    title: string;
    url: string;
    snippet?: string;
  }>;
  /** Success status */
  success?: boolean;
  /** Error message (if failed) */
  error?: string;
}

/**
 * Token usage statistics for the response.
 */
export interface TokenUsage {
  /** Number of input tokens consumed */
  inputTokens: number;
  /** Number of output tokens generated */
  outputTokens: number;
  /** Total tokens (input + output) */
  totalTokens: number;
  /** Number of cached input tokens (Codex only) */
  cachedInputTokens?: number;
  /** Number of reasoning output tokens (Codex only) */
  reasoningOutputTokens?: number;
}
