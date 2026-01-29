/**
 * Universal CLI output types for standardizing output across all CLI providers.
 * These types provide a provider-agnostic format that can be used by Copilot CLI,
 * Claude CLI, Codex CLI, and any future CLI integrations.
 */

/**
 * CLI event type constants.
 * Use these constants instead of string literals to avoid typos and ensure consistency.
 */
export const CLI_EVENT_TYPES = {
  TEXT: "text",
  TOOL_CALL: "toolCall",
  THINKING: "thinking",
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
export type CliEventData = TextData | ToolCall | ThinkingBlock | ToolResultData;

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
