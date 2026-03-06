import * as fs from "fs";
import * as path from "path";
import { BaseCliEvent, ILogParser } from "./interfaces/ILogParser";
import { UniversalCliOutput } from "../../../types/CliOutputTypes";

/**
 * Abstract base class for CLI harness log parsers
 *
 * Provides shared log file reading, watching, and session discovery logic.
 * Harness-specific parsers (Copilot, Claude, Codex) extend this class and
 * implement abstract methods for their unique log formats.
 *
 * @remarks
 * **Shared Responsibilities:**
 * - Incremental file reading (tracks position to avoid re-reading)
 * - File watching with fs.watch (monitors for new content)
 * - Session log discovery (finds log file for prompt execution)
 * - JSONL parsing (one JSON object per line)
 *
 * **Harness-Specific Responsibilities (abstract):**
 * - Response extraction from events
 * - Completion detection
 * - Session ID extraction
 * - Session log matching logic
 *
 * **File Position Tracking:**
 * Uses `lastReadPosition` to track bytes read from file. This enables
 * incremental reading - only new content is parsed on each read.
 *
 * @example
 * ```typescript
 * class CopilotLogParser extends BaseLogParser {
 *   extractResponse(events: BaseCliEvent[]) {
 *     // Combine Copilot-specific events into response
 *   }
 *   isComplete(event: BaseCliEvent) {
 *     return event.type === "turn.completed";
 *   }
 *   // ... other abstract methods
 * }
 * ```
 */
export abstract class BaseLogParser implements ILogParser {
  /**
   * Current read position in log file (bytes)
   *
   * Tracks the byte offset of the last read to enable incremental reading.
   * Updated after each successful read in readNewLines().
   *
   * @remarks
   * - Initialized to 0 (start of file)
   * - Reset to 0 if file size decreases (truncation/rotation)
   * - Persists across multiple readNewLines() calls
   */
  protected lastReadPosition = 0;

  // ========================================================================
  // Abstract Methods (Harness-Specific Implementation Required)
  // ========================================================================

  /**
   * Extract complete response from parsed log events
   *
   * Harness-specific implementation must:
   * - Identify response content events (text, tool calls, etc.)
   * - Combine streaming events into complete response
   * - Extract metadata (model, session ID, timestamps, etc.)
   * - Return UniversalCliOutput with normalized field names
   *
   * @param events - Array of parsed log events
   * @returns UniversalCliOutput - Standardized response object
   */
  abstract extractResponse(events: BaseCliEvent[]): UniversalCliOutput;

  /**
   * Check if log event indicates completion
   *
   * Harness-specific implementation must:
   * - Detect completion event type (e.g., "turn.completed")
   * - Return true only for definitive completion signals
   *
   * @param event - Single parsed log event
   * @returns True if event signals completion
   */
  abstract isComplete(event: BaseCliEvent): boolean;

  /**
   * Discover session log file for a prompt
   *
   * Harness-specific implementation must:
   * - If sessionId provided: Search for log file containing that session ID (fast path)
   * - Otherwise: Use findModifiedSessionLogs() to get candidate files and match by prompt text
   * - Get log directory path for harness
   * - Read and parse log entries from each candidate
   * - Return first matching file path
   *
   * @param promptText - The prompt text sent to the CLI (used for matching if no sessionId)
   * @param startTime - Execution start timestamp (used to filter candidates)
   * @param sessionId - Optional session ID from SessionStart hook (faster, more reliable)
   * @returns Absolute path to session log file, or null if not found
   */
  abstract discoverSessionLog(
    promptText: string,
    startTime: Date,
    sessionId?: string
  ): Promise<string | null>;

  /**
   * Extract session ID from log events
   *
   * Harness-specific implementation must:
   * - Search events for session/conversation ID
   * - Return ID in harness's expected format (UUID, thread_xxx, etc.)
   * - Return null if no session ID found
   *
   * @param events - Array of parsed log events
   * @returns Session ID string, or null if not found
   */
  abstract extractSessionId(events: BaseCliEvent[]): string | null;
  /**
   * Extract text content from a single log event for streaming
   *
   * Harness-specific implementation must:
   * - Parse event format specific to this harness
   * - Extract displayable text content
   * - Return undefined if event has no displayable content
   *
   * @param event - Single parsed log event
   * @returns Text content to display, or undefined if no content
   */
  abstract extractContentFromEvent(event: BaseCliEvent): string | undefined;

  /**
   * Format metadata into human-readable statistics string
   *
   * Harness-specific implementation must:
   * - Parse metadata fields specific to this harness
   * - Format into consistent display string
   * - Include session ID, model, token usage as available
   *
   * @param metadata - Metadata object from extractResponse()
   * @returns Formatted statistics string
   */
  abstract formatStatistics(metadata: BaseCliEvent): string;

  /**
   * Fetch any additional events that become available only after completion.
   *
   * Default implementation is a no-op because file-backed harnesses already
   * surface their final events through normal watch/read flows.
   *
   * @param _logPath - Absolute log path, or harness-specific monitor identifier
   * @returns Empty array by default
   */
  async getFinalEventsOnCompletion(_logPath: string): Promise<BaseCliEvent[]> {
    return [];
  }

  /**
   * Build common statistics parts shared across all harnesses
   *
   * Extracts session ID, model, and token usage from metadata and returns
   * an array of formatted string parts. Subclasses call this from their
   * `formatStatistics()` implementation and can append provider-specific
   * parts (e.g., cache tokens, duration) before joining.
   *
   * @param metadata - Metadata object from extractResponse()
   * @param sessionIdLength - Characters to show from session ID (default: 8)
   * @param sessionIdSuffix - Suffix after truncated session ID (default: '')
   * @returns Array of formatted parts like ["Session: abc123", "Model: gpt-5", "Tokens: 100 in / 50 out"]
   *
   * @example
   * ```typescript
   * // In a subclass:
   * formatStatistics(metadata: BaseCliEvent): string {
   *   const parts = this.buildCommonStatisticsParts(metadata, 8, '...');
   *   // Append provider-specific parts if needed
   *   return parts.join(' | ');
   * }
   * ```
   */
  protected buildCommonStatisticsParts(
    metadata: BaseCliEvent,
    sessionIdLength = 8,
    sessionIdSuffix = ""
  ): string[] {
    const meta = metadata as Record<string, any>;
    const parts: string[] = [];

    // Session ID (truncated for readability)
    if (meta.sessionId) {
      parts.push(
        `Session: ${meta.sessionId.substring(0, sessionIdLength)}${sessionIdSuffix}`
      );
    }

    // Model name
    if (meta.model) {
      parts.push(`Model: ${meta.model}`);
    }

    // Token usage
    if (
      meta.usage?.inputTokens !== undefined &&
      meta.usage?.outputTokens !== undefined
    ) {
      parts.push(
        `Tokens: ${meta.usage.inputTokens} in / ${meta.usage.outputTokens} out`
      );
    }

    return parts;
  }

  // ========================================================================
  // Shared Implementation (Used by All Harnesses)
  // ========================================================================

  /**
   * Read new lines from log file
   *
   * Incrementally reads only new content from log file since last read.
   * Parses JSONL format (one JSON object per line) and returns parsed entries.
   *
   * @param filePath - Absolute path to log file
   * @returns Array of parsed log entries
   *
   * @remarks
   * **Incremental Reading:**
   * - Tracks lastReadPosition to avoid re-reading old content
   * - Resets position to 0 if file was truncated/rotated
   *
   * **Line Parsing:**
   * - Splits new content by newlines
   * - Parses each line as JSON
   * - Skips empty lines and invalid JSON (logs error)
   *
   * **Error Handling:**
   * - Returns empty array if file doesn't exist
   * - Throws on file read errors
   * - Logs JSON parse errors but continues processing
   *
   * @throws Error if file read fails (permissions, I/O error, etc.)
   */
  async readNewLines(filePath: string): Promise<BaseCliEvent[]> {
    try {
      // Check if file exists
      if (!fs.existsSync(filePath)) {
        return [];
      }

      // Get current file size
      const stats = fs.statSync(filePath);
      const currentSize = stats.size;

      // If file was truncated or rotated, reset position
      if (currentSize < this.lastReadPosition) {
        this.lastReadPosition = 0;
      }

      // If no new content, return empty array
      if (currentSize === this.lastReadPosition) {
        return [];
      }

      // Read only new content (from lastReadPosition to end)
      const buffer = Buffer.alloc(currentSize - this.lastReadPosition);
      const fd = fs.openSync(filePath, "r");
      try {
        fs.readSync(fd, buffer, 0, buffer.length, this.lastReadPosition);
      } finally {
        fs.closeSync(fd);
      }

      // Update read position
      this.lastReadPosition = currentSize;

      // Parse JSONL format (one JSON object per line)
      const content = buffer.toString("utf8");
      const lines = content.split("\n");

      const entries: BaseCliEvent[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue; // Skip empty lines
        }

        try {
          const entry = JSON.parse(trimmed) as BaseCliEvent;
          entries.push(entry);
        } catch (error) {
          // Log parse errors but continue processing
          console.error(
            `[BaseLogParser] Failed to parse JSON line: ${trimmed.substring(0, 100)}...`,
            error
          );
        }
      }

      return entries;
    } catch (error) {
      // File read errors are thrown (caller should handle)
      throw new Error(
        `Failed to read log file: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

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
   * **Watch Strategy:**
   * - Uses fs.watch for efficiency (native file system events)
   * - Handles 'change' events (new content written)
   * - Filters entries by timestamp to avoid processing old logs
   *
   * **Error Handling:**
   * - Logs watch errors but keeps watcher active
   * - Logs read errors but continues watching
   * - Catches callback errors to prevent watcher crash
   *
   * **Cleanup:**
   * Caller MUST call .close() on returned watcher to prevent file handle leaks
   *
   * @example
   * ```typescript
   * const watcher = parser.watchLogFile(
   *   "/tmp/copilot.log",
   *   (entry) => {
   *     if (parser.isComplete(entry)) {
   *       watcher.close();
   *     }
   *   },
   *   new Date()
   * );
   * ```
   */
  watchLogFile(
    filePath: string,
    callback: (entry: BaseCliEvent) => void,
    startTime: Date
  ): fs.FSWatcher {
    const watcher = fs.watch(filePath, async (eventType) => {
      if (eventType !== "change") {
        return; // Only process content changes
      }

      try {
        const newEntries = await this.readNewLines(filePath);

        // Filter entries by timestamp (only process new entries)
        for (const entry of newEntries) {
          // Check if entry has timestamp field (harness-specific)
          const entryTime = this.extractTimestamp(entry);
          if (entryTime && entryTime < startTime) {
            continue; // Skip old entries
          }

          try {
            callback(entry);
          } catch (error) {
            console.error("[BaseLogParser] Callback error:", error);
          }
        }
      } catch (error) {
        console.error("[BaseLogParser] Error reading new lines:", error);
      }
    });

    watcher.on("error", (error) => {
      console.error("[BaseLogParser] File watcher error:", error);
    });

    return watcher;
  }

  // ========================================================================
  // Protected Helper Methods
  // ========================================================================

  /**
   * Find recently modified session log files
   *
   * Helper for session discovery. Lists log files/directories in directory that were
   * modified after the specified start time (potential session logs).
   *
   * @param logDirectory - Absolute path to log directory
   * @param startTime - Only include files/directories modified after this time
   * @returns Array of absolute paths to candidate log files/directories
   *
   * @remarks
   * **File Selection:**
   * - Checks modification time (mtime) against startTime
   * - Returns files AND directories modified within reasonable window (startTime - 10s to now)
   * - Sorts by modification time (newest first)
   * - Handles both flat files (old format) and directories (new format)
   *
   * **Use Case:**
   * Harness parsers use this to get candidate files/directories, then resolve
   * to actual log file path and read/parse to find matching prompt text.
   *
   * @example
   * ```typescript
   * const candidates = this.findModifiedSessionLogs("/tmp/copilot-logs", new Date());
   * for (const candidate of candidates) {
   *   const logPath = await this.resolveLogPath(candidate);
   *   if (logPath) {
   *     const entries = await this.readNewLines(logPath);
   *     // Check if entries contain prompt text
   *   }
   * }
   * ```
   */
  protected findModifiedSessionLogs(
    logDirectory: string,
    startTime: Date
  ): string[] {
    try {
      if (!fs.existsSync(logDirectory)) {
        return [];
      }

      const files = fs.readdirSync(logDirectory);
      const candidates: { path: string; mtime: Date }[] = [];

      // Allow 10 second buffer before startTime (CLI may write logs slightly before)
      const bufferTime = new Date(startTime.getTime() - 10000);

      for (const file of files) {
        const filePath = path.join(logDirectory, file);

        try {
          const stats = fs.statSync(filePath);

          // Include both files (old format: session-id.jsonl)
          // and directories (new format: session-id/events.jsonl)
          if (!stats.isFile() && !stats.isDirectory()) {
            continue;
          }

          // Check modification time
          if (stats.mtime >= bufferTime) {
            candidates.push({ path: filePath, mtime: stats.mtime });
          }
        } catch (error) {
          // Skip files that can't be accessed
          continue;
        }
      }

      // Sort by modification time (newest first)
      candidates.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

      return candidates.map((c) => c.path);
    } catch (error) {
      console.error(
        `[BaseLogParser] Error finding session logs in ${logDirectory}:`,
        error
      );
      return [];
    }
  }

  /**
   * Extract timestamp from log entry
   *
   * Helper to get timestamp from harness-specific log entry.
   * Override in harness parser if timestamp field differs.
   *
   * @param entry - Parsed log entry
   * @returns Entry timestamp, or null if not found
   *
   * @remarks
   * Default implementation checks common timestamp fields:
   * - timestamp (ISO 8601 string)
   * - time (Unix timestamp)
   * - created_at (ISO 8601 string)
   *
   * Harnesses can override to handle their specific format.
   */
  protected extractTimestamp(entry: BaseCliEvent): Date | null {
    // Check common timestamp fields
    if (entry.timestamp) {
      return new Date(entry.timestamp);
    }
    if (entry.time) {
      return new Date(entry.time as number);
    }
    if (entry.created_at) {
      return new Date(entry.created_at as string);
    }

    return null;
  }

  /**
   * Normalize prompt text for matching
   *
   * Handles path escaping differences between what we send and what CLIs log:
   * - Converts all backslashes to forward slashes (CLIs may escape \\ to \\\\)
   * - Lowercases for case-insensitive matching
   * - Trims whitespace
   *
   * @param text Prompt text to normalize
   * @returns Normalized text for comparison
   *
   * @remarks
   * **Why this is needed:**
   * When FlightPath uses temp files for complex prompts, it sends something like:
   * - We send: `"Follow instructions in @.flightpath\temp\file.md"`
   * - CLI logs: `"Follow instructions in @.flightpath\\temp\\file.md"`
   *
   * After normalization, both become: `"follow instructions in @.flightpath/temp/file.md"`
   *
   * This ensures prompt discovery works reliably regardless of path separator
   * escaping differences across different CLIs.
   *
   * @example
   * ```typescript
   * const normalized = this.normalizePromptForMatching(promptText);
   * if (logContent.includes(normalized)) {
   *   // Found matching prompt in log
   * }
   * ```
   */
  protected normalizePromptForMatching(text: string): string {
    return text.toLowerCase().trim().replace(/\\/g, "/"); // Convert all backslashes to forward slashes
  }

  /**
   * Read the first N events from a JSONL log file
   *
   * Parses lines sequentially until reaching the requested count.
   * Skips empty lines and invalid JSON lines.
   *
   * @param filePath - Absolute path to log file
   * @param count - Maximum number of events to read
   * @returns Array of parsed events (up to count)
   *
   * @remarks
   * Previously duplicated across CopilotLogParser.readFirstEvents(),
   * ClaudeLogParser.readFirstNEvents(), and CodexLogParser.readFirstEvents().
   * All three implementations were functionally identical.
   */
  protected async readFirstNJsonlEvents(
    filePath: string,
    count: number
  ): Promise<BaseCliEvent[]> {
    try {
      if (!fs.existsSync(filePath)) {
        return [];
      }

      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      const events: BaseCliEvent[] = [];

      for (const line of lines) {
        if (events.length >= count) {
          break;
        }

        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        try {
          const event = JSON.parse(trimmed) as BaseCliEvent;
          events.push(event);
        } catch {
          // Skip invalid JSON lines
          continue;
        }
      }

      return events;
    } catch {
      return [];
    }
  }
}
