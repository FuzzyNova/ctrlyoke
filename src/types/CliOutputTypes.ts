/**
 * Universal CLI output types for standardizing output across all CLI providers.
 * These types provide a provider-agnostic format that can be used by Copilot CLI,
 * Claude CLI, Codex CLI, and any future CLI integrations.
 */

/**
 * Universal CLI output structure (provider-agnostic).
 * Used by all CLI parsers to standardize output format before display.
 */
export interface UniversalCliOutput {
  /** The main text response from the AI */
  text: string;
  /** Tool calls made during the response */
  toolCalls: ToolCall[];
  /** Thinking/reasoning blocks (Claude extended thinking, etc.) */
  thinkingBlocks: ThinkingBlock[];
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
}
