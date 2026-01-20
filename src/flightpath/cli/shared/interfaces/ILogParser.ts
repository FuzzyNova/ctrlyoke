import * as fs from "fs";

/**
 * Interface for CLI provider log parsers
 *
 * Defines the contract for parsing provider-specific log files to extract
 * responses, session IDs, and track completion status. Each CLI provider
 * (Copilot, Claude, Codex) implements this interface to handle its unique
 * log format (JSONL, stream-json, etc.).
 *
 * @remarks
 * Log parsers serve two main purposes:
 * 1. **Session Discovery** - Find session IDs from log files when CLI doesn't return them
 * 2. **Response Extraction** - Parse streaming responses from log entries
 *
 * Implementation responsibilities:
 * - Parse provider-specific log formats (JSONL, JSON streams, etc.)
 * - Extract session IDs from log entries
 * - Detect completion events
 * - Build complete responses from streaming events
 */
export interface ILogParser {
  /**
   * Extract complete response from parsed log events
   *
   * Combines multiple streaming events into a single response object.
   * Handles provider-specific event formats and assembles text, tool calls,
   * and metadata into a unified structure.
   *
   * @param events - Array of parsed log events (provider-specific format)
   * @returns Structured response object
   *
   * @example
   * ```typescript
   * const events = [
   *   { type: "text", content: "Here's the solution..." },
   *   { type: "tool_call", name: "write_file", args: {...} }
   * ];
   * const response = parser.extractResponse(events);
   * // { text: "Here's the solution...", toolCalls: [...], metadata: {...} }
   * ```
   */
  extractResponse(events: any[]): {
    text: string;
    toolCalls: any[];
    metadata: any;
  };

  /**
   * Check if a log event indicates completion
   *
   * Detects provider-specific completion signals (e.g., "turn.completed",
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
  isComplete(event: any): boolean;

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
    callback: (entry: any) => void,
    startTime: Date
  ): fs.FSWatcher;

  /**
   * Read new lines from log file
   *
   * Incrementally reads only new content from log file (since last read position).
   * Parses JSONL format (one JSON object per line) and returns parsed entries.
   *
   * @param filePath - Absolute path to log file
   * @returns Array of parsed log entries (provider-specific format)
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
  readNewLines(filePath: string): Promise<any[]>;

  /**
   * Discover session log file for a prompt
   *
   * Searches provider's log directory for the session log file corresponding
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
   */
  discoverSessionLog(
    promptText: string,
    startTime: Date,
    sessionId?: string
  ): Promise<string | null>;

  /**
   * Extract session ID from log events
   *
   * Parses log events to find session/conversation ID. Different providers
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
   * Provider-specific examples:
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
  extractSessionId(events: any[]): string | null;
}
