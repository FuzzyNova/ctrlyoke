/**
 * Universal CLI output types for standardizing output across all CLI harnesses.
 * These types provide a harness-agnostic format that can be used by Copilot CLI,
 * Claude CLI, Codex CLI, and any future CLI integrations.
 */

import type {
  FileOperationStatus,
  CliEventType,
  CompactionTrigger,
  CallerType,
} from "./DashboardConstants";

export type { CliEventType };

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
  /**
   * Who invoked this event: 'direct' for top-level Claude, 'subagent' when
   * produced inside a spawned sub-agent (Task tool). Omitted for non-tool events.
   */
  callerType?: CallerType | string;
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
  | WebSearchData
  | CompactionData;

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
 * Universal CLI output structure (harness-agnostic).
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
 * Normalized from harness-specific formats (e.g., 'input' vs 'arguments').
 */
export interface ToolCall {
  /** Tool name (e.g., 'read_file', 'write_file', 'bash') */
  name: string;
  /** Tool parameters - normalized from 'input' or 'arguments' depending on harness */
  parameters: Record<string, unknown>;
  /** Optional tool call ID for tracking */
  id?: string;
  /** Result of the tool execution, if available */
  result?: ToolResult;
  /**
   * Caller context — 'direct' for top-level calls, 'subagent' when invoked
   * within a spawned sub-agent (Claude task tool). undefined = unknown.
   */
  callerType?: CallerType | string;
}

/**
 * Data for a conversation compaction event.
 * Emitted when Claude auto-compacts the context window to free up token capacity.
 */
export interface CompactionData {
  /** What triggered the compaction: automatic threshold or user-initiated */
  trigger: CompactionTrigger;
  /** Token count before compaction */
  preTokens?: number;
  /** Token count after compaction */
  postTokens?: number;
  /** How long the compaction took (ms) */
  durationMs?: number;
  /** Human-readable summary written by Claude about the compacted content */
  summary?: string;
  /** Whether compaction was triggered by context overflow (OpenCode-specific) */
  overflow?: boolean;
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
  /** Harness identifier (e.g., 'copilot-cli', 'claude-cli', 'codex-cli') */
  harness?: string;
  /**
   * When true, text events contain pre-formatted output that should NOT be
   * processed by markdown renderers (e.g., Streamdown). The harness already
   * emits fully-rendered text (tables, headings, chrome), so running a
   * markdown pipeline on it again causes double-rendering artifacts.
   *
   * Set this in the harness response parser when the CLI has no --json mode
   * and pre-formats its own output (currently: copilot-cli).
   */
  rawTextOutput?: boolean;
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
  status?: FileOperationStatus;
}

/**
 * Data for a file read operation.
 */
export interface FileReadData {
  /** File path */
  path: string;
  /** File content (if available) */
  content?: string;
  /** Read lifecycle stage */
  status?: FileOperationStatus;
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
  /** Write lifecycle stage */
  status?: FileOperationStatus;
  /** Success status */
  success?: boolean;
  /** Error message (if failed) */
  error?: string;
}

/**
 * Unified diff hunk with line numbers (git diff format).
 * Used by Claude CLI to provide accurate line positions.
 */
export interface UnifiedDiffHunk {
  /** Starting line number in old file */
  oldStart: number;
  /** Number of lines in old file */
  oldLines: number;
  /** Starting line number in new file */
  newStart: number;
  /** Number of lines in new file */
  newLines: number;
  /** Diff lines with prefixes: " " (context), "-" (removed), "+" (added) */
  lines: string[];
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
  /** Edit lifecycle stage */
  status?: FileOperationStatus;
  /** Structured diff hunks with accurate line numbers (Claude CLI) */
  structuredPatch?: UnifiedDiffHunk[];
  /** Whether user manually modified the edit (Claude CLI) */
  userModified?: boolean;
  /** Whether replace_all flag was used (Claude CLI) */
  replaceAll?: boolean;
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
 * Generic CLI result returned after prompt execution.
 * Used by ALL CLI harnesses (Copilot, Claude, Codex, etc.)
 */
export interface CliResult {
  success: boolean;
  response: string;
  statistics: string;
  error?: string;
  exitCode?: number;
  sessionId?: string;
  codeChanges?: string;
  modelUsage?: string;
}

/**
 * Token usage statistics for the response.
 */
export interface TokenUsage {
  /** Number of input tokens consumed (non-cached portion) */
  inputTokens: number;
  /** Number of output tokens generated */
  outputTokens: number;
  /** Billing total: inputTokens + outputTokens */
  totalTokens: number;
  /** Number of cache-read input tokens (billed at reduced rate) */
  cachedInputTokens?: number;
  /** Number of cache-creation input tokens — Claude only */
  cacheCreatedTokens?: number;
  /** Number of reasoning output tokens — Codex only */
  reasoningOutputTokens?: number;
  /**
   * Total input tokens in the context window for the last API turn.
   * = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
   * Use this (with contextWindowSize) to show how full the context window is.
   */
  contextWindowUsedTokens?: number;
  /** Model's total context window capacity in tokens (e.g. 200000 or 128000). */
  contextWindowSize?: number;
}
