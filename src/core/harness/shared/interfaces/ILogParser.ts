import * as fs from "fs";
import { CliEvent, UniversalCliOutput } from "../../../../types/CliOutputTypes";

/**
 * Minimal base type for CLI log events across all harnesses.
 *
 * Provides compile-time safety for the shared event pipeline while
 * allowing provider-specific event properties via the index signature.
 *
 * All CLI events must have at least a `type` string. Providers can
 * extend this with additional fields specific to their log formats.
 */
export interface BaseCliEvent {
  type: string;
  timestamp?: number;
  [key: string]: unknown;
}

/**
 * How a single `user`-role log event should be treated when tailing a session.
 *
 * Most harnesses' resume/completion markers are never `user`-typed events (Copilot's
 * `system.notification`, Antigravity's `SYSTEM` `SYSTEM_MESSAGE`), so this classification
 * only matters for harnesses whose log uses a `user` role for multiple distinct purposes
 * (Claude: tool results, injected prompts, resume signals, and genuine human follow-ups
 * all arrive as `user` events).
 *
 * - `"tool-result"` — not a prompt at all (tool_result content block).
 * - `"injected-prompt"` — ctrlyoke's own dispatched prompt echoed back in the log.
 * - `"resume-signal"` — a harness-internal wake-up message (e.g. Claude's
 *   `<task-notification>`), not something a human typed.
 * - `"human-steer"` — genuine human text typed directly into the live TUI.
 * - `"other"` — none of the above (default for harnesses with no ambiguity).
 */
export type UserEventClassification =
  | "tool-result"
  | "injected-prompt"
  | "resume-signal"
  | "human-steer"
  | "other";

/**
 * Interface for CLI harness log parsers
 *
 * Defines the contract for parsing harness-specific log files to extract
 * responses, session IDs, and track completion status. Each CLI harness
 * (Copilot, Claude, Codex) implements this interface to handle its unique
 * log format (JSONL, stream-json, etc.).
 *
 * @remarks
 * Log parsers serve two main purposes:
 * 1. **Session Discovery** - Find session IDs from log files when CLI doesn't return them
 * 2. **Response Extraction** - Parse streaming responses from log entries
 *
 * Implementation responsibilities:
 * - Parse harness-specific log formats (JSONL, JSON streams, etc.)
 * - Extract session IDs from log entries
 * - Detect completion events
 * - Build complete responses from streaming events
 */
export interface ILogParser {
  /**
   * Extract complete response from parsed log events
   *
   * Combines multiple streaming events into a single response object.
   * Handles harness-specific event formats and assembles text, tool calls,
   * thinkingBlocks, and metadata into a unified UniversalCliOutput structure.
   *
   * @param events - Array of parsed log events (harness-specific format)
   * @returns UniversalCliOutput - Standardized response object
   *
   * @example
   * ```typescript
   * const events = [
   *   { type: "text", content: "Here's the solution..." },
   *   { type: "tool_call", name: "write_file", args: {...} }
   * ];
   * const response = parser.extractResponse(events);
   * // { text: "Here's the solution...", toolCalls: [...], thinkingBlocks: [], metadata: {...} }
   * ```
   */
  extractResponse(events: BaseCliEvent[]): UniversalCliOutput;

  /**
   * Check if a log event indicates completion
   *
   * Detects harness-specific completion signals (e.g., "turn.completed",
   * "session.ended", etc.) to determine when response streaming has finished.
   *
   * @param event - Single parsed log event
   * @returns True if event signals completion
   *
   * @example
   * ```typescript
   * const event = { type: "turn.completed", session_id: "abc-123" };
   * if (parser.isComplete(event)) {
   *   // Response is complete, stop watching
   * }
   * ```
   */
  isComplete(event: BaseCliEvent): boolean;

  /**
   * Watch log file for new entries
   *
   * Sets up file watcher using fs.watch to monitor log file for changes.
   * Reads new lines as they're written and invokes callback with parsed entries.
   *
   * @param filePath - Absolute path to log file
   * @param callback - Function called with each new parsed log entry
   * @param startTime - Only process entries after this timestamp
   * @returns File watcher instance (call .close() to stop watching)
   *
   * @remarks
   * - Uses incremental reading (tracks file position to avoid re-reading)
   * - Handles file rotation and truncation gracefully
   * - Invokes callback for each complete log entry (JSONL line)
   * - Filters entries by timestamp to avoid processing old logs
   *
   * @example
   * ```typescript
   * const watcher = parser.watchLogFile(
   *   "/tmp/copilot.log",
   *   (entry) => console.log("New entry:", entry),
   *   new Date()
   * );
   * // Later: watcher.close();
   * ```
   */
  watchLogFile(
    filePath: string,
    callback: (entry: BaseCliEvent) => void,
    startTime: Date
  ): fs.FSWatcher;

  /**
   * Read new lines from log file
   *
   * Incrementally reads only new content from log file (since last read position).
   * Parses JSONL format (one JSON object per line) and returns parsed entries.
   *
   * @param filePath - Absolute path to log file
   * @returns Array of parsed log entries (harness-specific format)
   *
   * @remarks
   * - Tracks read position internally (lastReadPosition) to avoid re-reading
   * - Handles partial lines gracefully (waits for complete line)
   * - Returns empty array if no new content
   * - Throws on file read errors
   *
   * @example
   * ```typescript
   * const newEntries = await parser.readNewLines("/tmp/copilot.log");
   * // [{ type: "text", content: "..." }, { type: "tool_call", ... }]
   * ```
   */
  readNewLines(filePath: string): Promise<BaseCliEvent[]>;

  /**
   * Discover session log file for a prompt
   *
   * Searches harness's log directory for the session log file corresponding
   * to a specific prompt execution. Uses session ID (if available) or prompt
   * text and timestamp to identify the correct log file.
   *
   * @param promptText - The prompt text sent to the CLI (used for matching if no sessionId)
   * @param startTime - Execution start timestamp (used to filter candidates)
   * @param sessionId - Optional session ID from SessionStart hook (faster, more reliable)
   * @returns Absolute path to session log file, or null if not found
   *
   * @remarks
   * - **Fast path**: If sessionId provided, searches for log file with matching session ID
   * - **Fallback**: If no sessionId, matches prompt text against log entries (slower)
   * - Checks recently modified files in log directory
   * - Validates timestamps to ensure log is for current execution
   * - Returns null if no matching session found (e.g., too early, no logs)
   *
   * Strategy:
   * 1. If sessionId provided, search for log file containing that session ID
   * 2. Otherwise, list files modified after startTime and match by prompt text
   * 3. Read first few lines of each file
   * 4. Return first matching file path
   *
   * @example
   * ```typescript
   * // Fast path (with session ID from hook)
   * const logFile = await parser.discoverSessionLog(
   *   "Explain this code",
   *   new Date(),
   *   "abc-123-session-id"
   * );
   *
   * // Fallback (no session ID, match by prompt)
   * const logFile = await parser.discoverSessionLog(
   *   "Explain this code",
   *   new Date()
   * );
   * ```
   *
   * @param signal Optional cancellation signal for discovery retries
   */
  discoverSessionLog(
    promptText: string,
    startTime: Date,
    sessionId?: string,
    signal?: AbortSignal
  ): Promise<string | null>;

  /**
   * Extract session ID from log events
   *
   * Parses log events to find session/conversation ID. Different harnesses
   * store session IDs in different event fields and formats.
   *
   * @param events - Array of parsed log events
   * @returns Session ID string, or null if not found
   *
   * @remarks
   * - Copilot: Session UUID in "session.created" or "turn.completed" events
   * - Claude: Conversation ID in metadata fields
   * - Codex: Thread ID in "session_id" field
   *
   * Harness-specific examples:
   * - Copilot: `550e8400-e29b-41d4-a716-446655440000`
   * - Claude: `a1b2c3d4-e5f6-7890-abcd-ef1234567890`
   * - Codex: `thread_abc123xyz789`
   *
   * @example
   * ```typescript
   * const events = [
   *   { type: "session.created", session_id: "abc-123" },
   *   { type: "text", content: "Hello" }
   * ];
   * const sessionId = parser.extractSessionId(events);
   * // "abc-123"
   * ```
   */
  extractSessionId(events: BaseCliEvent[]): string | null;

  /**
   * Extract structured CliEvents from a single log event for streaming
   *
   * The primary streaming method. Parses harness-specific event format and
   * returns typed CliEvent objects for real-time display during interactive mode.
   * Replaces the plain-text `extractContentFromEvent` path in CliLogMonitor so
   * that tool calls, tool results, thinking blocks, and text all stream with
   * proper structure — identical to the final `extractResponse()` output.
   *
   * @param event - Single parsed log event (harness-specific format)
   * @returns Array of CliEvents to emit; empty array if event produces no output
   *
   * @remarks
   * The base class provides a default implementation that delegates to
   * `extractContentFromEvent` and wraps any returned string in a TEXT CliEvent.
   * Harnesses that want richer streaming (tool cards, thinking blocks, etc.)
   * should override this method directly.
   *
   * **Copilot** overrides this with stateful tool tracking so that
   * `tool.execution_start` / `tool.execution_complete` pairs produce the same
   * semantic events (BASH_COMMAND, FILE_READ, TOOL_RESULT, …) as `extractResponse()`.
   *
   * @example
   * ```typescript
   * const event = { type: "assistant.message", data: { content: "Hello", reasoningText: "thinking..." } };
   * const events = parser.extractStructuredEventsFromEvent(event);
   * // [{ type: "text", data: { text: "Hello" } }, { type: "thinking", data: { text: "thinking..." } }]
   * ```
   */
  extractStructuredEventsFromEvent(event: BaseCliEvent): CliEvent[];

  /**
   * Extract text content from a single log event for streaming
   *
   * @deprecated Use `extractStructuredEventsFromEvent` for structured streaming.
   * This method remains for the default BaseLogParser implementation of
   * `extractStructuredEventsFromEvent`.
   *
   * @param event - Single parsed log event (harness-specific format)
   * @returns Text content to display, or undefined if event has no displayable content
   */
  extractContentFromEvent(event: BaseCliEvent): string | undefined;

  /**
   * Format metadata into human-readable statistics string
   *
   * Converts harness-specific metadata (model, tokens, session info) into
   * a formatted display string for the output panel.
   *
   * @param metadata - Metadata object from extractResponse()
   * @returns Formatted statistics string (e.g., "Model: gpt-4 | Tokens: 100 in / 50 out")
   *
   * @remarks
   * Harness-specific metadata:
   * - **Copilot**: `{ sessionId, model }` from session.start event
   * - **Claude**: `{ sessionId, model, usage: { input_tokens, output_tokens } }`
   * - **Codex**: Similar to Claude with token usage
   *
   * @example
   * ```typescript
   * const metadata = {
   *   sessionId: "abc-123",
   *   model: "gpt-4",
   *   usage: { input_tokens: 100, output_tokens: 50 }
   * };
   * const stats = parser.formatStatistics(metadata);
   * // "Session: abc-123 | Model: gpt-4 | Tokens: 100 in / 50 out"
   * ```
   */
  formatStatistics(metadata: BaseCliEvent): string;

  /**
   * Fetch any additional events that become available only after completion.
   *
   * Most harnesses stream their final events through the normal watch/read path,
   * so the default behavior is to return no additional events. Harnesses with
   * deferred export semantics can override this to do one final fetch after the
   * completion signal arrives.
   *
   * @param logPath - Absolute log path, or harness-specific monitor identifier
   * @returns Additional completion-time events to append before final extraction
   */
  getFinalEventsOnCompletion(logPath: string): Promise<BaseCliEvent[]>;

  /**
   * Seek the internal read position to the current end of the file.
   *
   * Called before monitoring a **resumed** session's log file to skip all
   * existing historical events (from prior prompts in the same session).
   * Without this, `readNewLines()` starts at position 0 and re-reads the
   * full history, including old `stop_reason:"end_turn"` events that would
   * trigger immediate false completion. Events without a `timestamp` field
   * bypass the timestamp filter entirely, making this seek essential.
   *
   * Safe to call even when the file does not yet exist.
   *
   * @param filePath Absolute path to the log file
   */
  seekToEnd?(filePath: string): void;

  /**
   * Extract live context window utilization from a single log event.
   *
   * Called by CliLogMonitor on every event as they stream in, so harnesses
   * can surface context usage incrementally without waiting for completion.
   * Returns null for events that carry no context window information.
   *
   * @param event - Single parsed log event
   * @returns { used, size } token counts, or null if event has no context info
   */
  extractLiveContextWindow?(
    event: BaseCliEvent,
    modelId: string
  ): { used: number; size: number } | null;

  /**
   * Set the resolved model ID for the current execution.
   *
   * Called by CliLogMonitor before starting to monitor a session.
   * Stored as the fallback model when log events do not embed the model name.
   */
  setCurrentModel?(model: string): void;

  /**
   * Extract a log entry's timestamp, for filtering entries older than a run's start time.
   *
   * @param entry - Parsed log entry
   * @returns Entry timestamp, or null if not found
   */
  extractTimestamp?(entry: BaseCliEvent): Date | null;

  /**
   * Classify a single log event to decide whether it represents genuine human input
   * typed into the live TUI (a "user steer"), as opposed to a tool result, ctrlyoke's
   * own injected prompt being echoed back, or a harness-internal resume signal.
   *
   * Called by `CliLogEventPump` for every event as it streams in. The default
   * (`BaseLogParser`) always returns `"other"` — safe for harnesses whose resume/
   * completion signal is never a `user`-typed event.
   *
   * @param event - Single parsed log event
   * @param ctx.dispatchedPromptText - The prompt text ctrlyoke just sent, when a
   *   prompt is actively being dispatched (undefined when tailing outside an active
   *   dispatch, e.g. `SessionActivityWatcher` after a step has already completed).
   * @returns The event's classification
   */
  classifyUserEvent?(
    event: BaseCliEvent,
    ctx: { dispatchedPromptText?: string }
  ): UserEventClassification;

  /**
   * Extract the display text for a log event already classified as
   * `"human-steer"` by `classifyUserEvent`. Each harness owns its own event
   * shape (Claude's `message.content` blocks, Copilot's `data.content`
   * string, Qwen's `message.parts[].text`, etc.), so text extraction is
   * parser-owned rather than assumed generically by the caller.
   *
   * Called by `CliLogEventPump` only after `classifyUserEvent` has already
   * returned `"human-steer"` for the same event.
   *
   * @param event - Single parsed log event
   * @returns The text the human typed, or undefined if it can't be extracted
   */
  extractUserSteerText?(event: BaseCliEvent): string | undefined;

  /**
   * Incrementally update background-task tracking state from a single log event.
   * Called by `CliLogEventPump` for every event as it streams in (both the
   * per-prompt `CliLogMonitor` and the longer-lived `SessionActivityWatcher`
   * call through the same pump), so state is current by the time either asks
   * `hasPendingBackgroundWork()`.
   *
   * Default (`BaseLogParser`) is a no-op. Harnesses confirmed to background a
   * task and auto-resume the same session (Claude, Copilot, Antigravity)
   * override this to track their own launch/completion markers — see each
   * harness's implementation for its specific rule.
   *
   * @param event - Single parsed log event
   */
  trackBackgroundWorkState?(event: BaseCliEvent): void;

  /**
   * Is a background task still pending as of the most recently tracked event?
   *
   * Used to gate `WorkflowExecutor` control-flow commitment (end-condition
   * eval / advance / finalize) at a Stop: when true, the harness is expected
   * to auto-resume the same session, so committing now would prematurely
   * treat an in-progress step as done. Default (`BaseLogParser`) always
   * returns false — harnesses with no confirmed background-resume signal
   * stay gate-free (today's zero-latency behavior, unchanged).
   */
  hasPendingBackgroundWork?(): boolean;
}
