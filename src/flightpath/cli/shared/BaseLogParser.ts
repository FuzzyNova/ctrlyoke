import * as fs from "fs";
import * as path from "path";
import { ILogParser } from "./interfaces/ILogParser";
import { UniversalCliOutput } from "../../../types/CliOutputTypes";

/**
 * Abstract base class for CLI provider log parsers
 *
 * Provides shared log file reading, watching, and session discovery logic.
 * Provider-specific parsers (Copilot, Claude, Codex) extend this class and
 * implement abstract methods for their unique log formats.
 *
 * @remarks
 * **Shared Responsibilities:**
 * - Incremental file reading (tracks position to avoid re-reading)
 * - File watching with fs.watch (monitors for new content)
 * - Session log discovery (finds log file for prompt execution)
 * - JSONL parsing (one JSON object per line)
 *
 * **Provider-Specific Responsibilities (abstract):**
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
 *   extractResponse(events: any[]) {
 *     // Combine Copilot-specific events into response
 *   }
 *   isComplete(event: any) {
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
  // Abstract Methods (Provider-Specific Implementation Required)
  // ========================================================================

  /**
   * Extract complete response from parsed log events
   *
   * Provider-specific implementation must:
   * - Identify response content events (text, tool calls, etc.)
   * - Combine streaming events into complete response
   * - Extract metadata (model, session ID, timestamps, etc.)
   * - Return UniversalCliOutput with normalized field names
   *
   * @param events - Array of parsed log events
   * @returns UniversalCliOutput - Standardized response object
   */
  abstract extractResponse(events: any[]): UniversalCliOutput;

  /**
   * Check if log event indicates completion
   *
   * Provider-specific implementation must:
   * - Detect completion event type (e.g., "turn.completed")
   * - Return true only for definitive completion signals
   *
   * @param event - Single parsed log event
   * @returns True if event signals completion
   */
  abstract isComplete(event: any): boolean;

  /**
   * Discover session log file for a prompt
   *
   * Provider-specific implementation must:
   * - If sessionId provided: Search for log file containing that session ID (fast path)
   * - Otherwise: Use findModifiedSessionLogs() to get candidate files and match by prompt text
   * - Get log directory path for provider
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
   * Provider-specific implementation must:
   * - Search events for session/conversation ID
   * - Return ID in provider's expected format (UUID, thread_xxx, etc.)
   * - Return null if no session ID found
   *
   * @param events - Array of parsed log events
   * @returns Session ID string, or null if not found
   */
  abstract extractSessionId(events: any[]): string | null;
  /**
   * Extract text content from a single log event for streaming
   *
   * Provider-specific implementation must:
   * - Parse event format specific to this provider
   * - Extract displayable text content
   * - Return undefined if event has no displayable content
   *
   * @param event - Single parsed log event
   * @returns Text content to display, or undefined if no content
   */
  abstract extractContentFromEvent(event: any): string | undefined;

  /**
   * Format metadata into human-readable statistics string
   *
   * Provider-specific implementation must:
   * - Parse metadata fields specific to this provider
   * - Format into consistent display string
   * - Include session ID, model, token usage as available
   *
   * @param metadata - Metadata object from extractResponse()
   * @returns Formatted statistics string
   */
  abstract formatStatistics(metadata: any): string;
  // ========================================================================
  // Shared Implementation (Used by All Providers)
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
  async readNewLines(filePath: string): Promise<any[]> {
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

      const entries: any[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue; // Skip empty lines
        }

        try {
          const entry = JSON.parse(trimmed);
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
    callback: (entry: any) => void,
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
          // Check if entry has timestamp field (provider-specific)
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
   * Provider parsers use this to get candidate files/directories, then resolve
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
   * Helper to get timestamp from provider-specific log entry.
   * Override in provider parser if timestamp field differs.
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
   * Providers can override to handle their specific format.
   */
  protected extractTimestamp(entry: any): Date | null {
    // Check common timestamp fields
    if (entry.timestamp) {
      return new Date(entry.timestamp);
    }
    if (entry.time) {
      return new Date(entry.time);
    }
    if (entry.created_at) {
      return new Date(entry.created_at);
    }

    return null;
  }
}
