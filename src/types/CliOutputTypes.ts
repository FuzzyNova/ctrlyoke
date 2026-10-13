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
  HarnessId,
  McpCallVia,
  TokenTotalConfidence,
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
  /** Excluded from prior-context transcripts while retained in dashboard output. */
  priorContextExcluded?: boolean;
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
  | CompactionData
  | UserSteerData
  | FollowUpResumedData
  | BackgroundWorkHoldData
  | ContextWindowSyncData
  | AskUserQuestionData
  | TerminalOutputData;

/** The sanitized tail retained when a harness process exits unexpectedly. */
export interface TerminalOutputData {
  text: string;
  reason: string;
}

/**
 * Data for a text event (AI response text).
 */
export interface TextData {
  /** The text content */
  text: string;
}

/**
 * Data for a user-steer event — genuine human text typed directly into a live TUI,
 * mid-step or after a step/workflow has already completed. Display-only.
 */
export interface UserSteerData {
  /** The text the human typed */
  text: string;
}

/**
 * Data for a follow-up-resumed event — a divider marking where post-completion
 * follow-up activity (a harness auto-resume or a human TUI steer) begins within
 * an already-completed step's output. Display-only; inserted at most once per
 * step/attempt/run by the merge logic that appends resumed activity.
 */
export interface FollowUpResumedData {
  /** When the follow-up activity was first observed (ms since epoch) */
  resumedAt: number;
}

/**
 * A background task a harness launched that has not yet reported completion.
 * Every field is optional because what each harness exposes differs; renderers
 * fall back from `description` to `command` to `toolName` to `taskId`.
 */
export interface BackgroundTaskSummary {
  /** The harness's own task identity (Claude task id, Copilot shell id, agy task id) */
  taskId?: string;
  /** Human-readable purpose — the launching tool call's description */
  description?: string;
  /** Command line, for shell launches */
  command?: string;
  /** Tool that launched it (e.g. Bash, PowerShell, Agent, Monitor) */
  toolName?: string;
}

/**
 * Data for a background-work-hold event — a Stop hook arrived but the step was
 * kept running because the harness still had background work pending.
 * Display-only.
 */
export interface BackgroundWorkHoldData {
  /** When the absorbed Stop was received (ms since epoch) */
  heldAt: number;
  /** Background tasks still running at that Stop */
  pendingTasks: BackgroundTaskSummary[];
  /**
   * Every task has reported, but the turn its notification resumed has not
   * ended yet — the step is waiting on that turn rather than on a task.
   */
  awaitingResumedTurn: boolean;
}

/** What a log parser reports about its pending background work at a Stop. */
export type BackgroundWorkHoldSnapshot = Omit<BackgroundWorkHoldData, "heldAt">;

/**
 * Data for a context-window-sync event — an invisible marker carrying updated
 * context-window usage discovered during post-completion follow-up activity.
 * Never rendered as a visible row; consumed by the merge logic that refreshes
 * an already-completed step's stats footer.
 */
export interface ContextWindowSyncData {
  /** Tokens currently occupying the context window */
  used: number;
  /** Model's total context window capacity in tokens */
  size: number;
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
 * One selectable option offered for an AskUserQuestion entry.
 */
export interface AskUserQuestionOption {
  /** Option label — this is the exact string that shows up verbatim as `answer`
   *  on AskUserQuestionEntry when the user picks it. */
  label: string;
  /** Short rationale for the option, when the harness supports it. */
  description?: string;
  /** ASCII/plain-text preview art attached to the option, when the harness supports it. */
  preview?: string;
}

/**
 * A single question asked via AskUserQuestion, plus its resolution once answered.
 */
export interface AskUserQuestionEntry {
  /** Provider-defined identifier used to correlate an answer to this question. */
  id?: string;
  /** The question text. */
  question: string;
  /** Short category label shown alongside the question (Claude calls this "header"). */
  header?: string;
  /** Whether the user could pick more than one option. */
  multiSelect?: boolean;
  options: AskUserQuestionOption[];
  /**
   * The resolved answer, once available: either one of `options[].label` verbatim
   * (selected option), or freeform text the user typed instead of picking an
   * option. Undefined while the question is still pending.
   */
  answer?: string;
  /** Freeform notes the user attached alongside (or instead of) a selected option. */
  notes?: string;
  /** The selected option's `preview`, carried over so it survives even if `options` is later trimmed. */
  answerPreview?: string;
}

/**
 * Present on a resolved AskUserQuestionData when the user declined to answer
 * rather than picking an option or typing a reply.
 */
export interface AskUserQuestionDeclined {
  /** "clarify" — user asked to discuss/reformulate instead of answering.
   *  "rejected" — user declined with no further explanation. */
  reason: "clarify" | "rejected";
  /** Full guidance text captured for the "clarify" case. */
  feedback?: string;
}

/**
 * Data for an interactive question the AI asked the user mid-turn (Claude's
 * AskUserQuestion tool; harness-agnostic so other providers can populate it too).
 */
export interface AskUserQuestionData {
  /** Correlates the INITIATED (asked) and COMPLETED/FAILED (resolved) halves of this call. */
  toolCallId?: string;
  questions: AskUserQuestionEntry[];
  /** Lifecycle stage: initiated (pending), completed (answered), failed (declined). */
  status?: FileOperationStatus;
  declined?: AskUserQuestionDeclined;
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
  /**
   * The thinking/reasoning text. For a `redacted` block this is only the
   * provider's reasoning summary, and may be empty.
   */
  text: string;
  /** Timestamp when this thinking block was generated */
  timestamp?: number;
  /** Label for the thinking block (e.g., "Reasoning", "Planning", "Analysis") */
  label?: string;
  /**
   * The provider withheld the reasoning itself (e.g. Codex returns it
   * encrypted). Renderers show the block's metadata even with no `text`, and
   * prior-context extraction includes only the summary `text`, if any.
   */
  redacted?: boolean;
  /** Reasoning output tokens the provider reported for this block. */
  reasoningTokens?: number;
  /**
   * `reasoningTokens` is this block's estimated share of a total the provider
   * reported for several blocks together, not an exact count.
   */
  reasoningTokensEstimated?: boolean;
  /**
   * How many provider reasoning items were merged into this block, when more
   * than one (one model response can emit several).
   */
  segmentCount?: number;
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
  /** Harness-reported response error, when the CLI provides one. */
  error?: string;
  /** Elapsed time in milliseconds */
  elapsed?: number;
  /** Harness identifier from the canonical HARNESS_IDS set. */
  harness?: HarnessId;
  /** Raw USD total reported by a harness (never inferred from tokens). */
  harnessReportedCostUsd?: number;
  /** Typed per-provider-model cost breakdown when the harness supplies one. */
  modelUsage?: Record<string, ProviderModelUsage>;
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

/** Provider-reported per-model usage/cost details (currently Claude stream-json). */
export interface ProviderModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  webSearchRequests?: number;
  costUSD?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
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
  /** Tool call ID used to correlate this command with its result */
  toolCallId?: string;
}

/**
 * Data for a file read operation.
 */
export interface FileReadData {
  /** File path */
  path: string;
  /** File content (if available) */
  content?: string;
  /** Copilot tool call ID used to correlate concurrent reads */
  toolCallId?: string;
  /** First requested line, when the harness supplied a line range */
  lineStart?: number;
  /** Last requested line, when the harness supplied a line range */
  lineEnd?: number;
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
  /** Tool call ID used to correlate this write with its result */
  toolCallId?: string;
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
  /** Tool call ID used to correlate this edit with its result */
  toolCallId?: string;
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
  /** Tool call ID used to correlate this delete with its result */
  toolCallId?: string;
}

/**
 * Data for an MCP (Model Context Protocol) tool call.
 */
export interface McpToolCallData {
  /** MCP server name */
  server: string;
  /** Tool name */
  tool: string;
  /** How the tool call was issued, when known */
  via?: McpCallVia;
  /** Tool call ID used to correlate this call with its result */
  toolCallId?: string;
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
  /** Number of input tokens consumed; cache inclusion is harness-specific. */
  inputTokens: number;
  /** Number of output tokens generated */
  outputTokens: number;
  /** Total token count; its relationship to input/output is harness-specific. */
  totalTokens?: number;
  /** Number of cache-read input tokens (billed at reduced rate) */
  cachedInputTokens?: number;
  /** Number of cache-creation input tokens — Claude only */
  cacheCreatedTokens?: number;
  /** Number of reasoning output tokens — Codex and Antigravity */
  reasoningOutputTokens?: number;
  /** Provenance of totalTokens as declared by the parser. */
  totalConfidence?: TokenTotalConfidence;
  /**
   * Total input tokens in the context window for the last API turn.
   * = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
   * Use this (with contextWindowSize) to show how full the context window is.
   */
  contextWindowUsedTokens?: number;
  /** Model's total context window capacity in tokens (e.g. 200000 or 128000). */
  contextWindowSize?: number;
}
