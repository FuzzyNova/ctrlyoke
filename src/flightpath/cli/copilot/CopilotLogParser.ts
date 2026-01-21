import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { BaseLogParser } from "../shared/BaseLogParser";
import { Log } from "../../../utils/Log";
import { retryWithBackoff } from "../../../utils/RetryUtils";

/**
 * Copilot CLI log parser
 *
 * Parses Copilot CLI session logs to extract responses, session IDs, and
 * detect completion. Supports both old (pre-v0.0.384) and new (v0.0.384+)
 * log formats.
 *
 * @remarks
 * **Log Location:** `~/.copilot/session-state/`
 *
 * **Format Evolution:**
 * - **Old format (pre-v0.0.384):** `<session-id>.jsonl` (flat file)
 * - **New format (v0.0.384+):** `<session-id>/events.jsonl` (subdirectory)
 *
 * **Event Types:**
 * - `session.start` - Session initialization (contains session ID)
 * - `user.message` - User prompt sent to Copilot
 * - `assistant.message` - Copilot response content (may be multiple events)
 * - `assistant.turn_end` - Response completion (new format only)
 *
 * **Completion Detection:**
 * - New format: Look for `{"type": "assistant.turn_end"}` event
 * - Old format: Heuristic (last assistant.message after 2s timeout)
 *
 * @example
 * ```typescript
 * const parser = new CopilotLogParser();
 * const logPath = await parser.discoverSessionLog("Analyze this code", new Date());
 * if (logPath) {
 *   const events = await parser.readNewLines(logPath);
 *   const response = parser.extractResponse(events);
 *   const sessionId = parser.extractSessionId(events);
 * }
 * ```
 */
export class CopilotLogParser extends BaseLogParser {
  /**
   * Event buffer for multi-event responses
   *
   * Copilot may send multiple assistant.message events for a single response.
   * This buffer accumulates events until turn_end or timeout.
   */
  private eventBuffer: any[] = [];

  /**
   * Extract complete response from Copilot log events
   *
   * Combines multiple assistant.message events into a single response object.
   * Extracts tool requests, metadata, and session information.
   *
   * @param events - Array of parsed Copilot log events
   * @returns Structured response object
   *
   * @remarks
   * **Response Assembly:**
   * - Concatenates content from all assistant.message events
   * - Extracts toolRequests from event.data.toolRequests arrays
   * - Captures model, session ID, and token usage from metadata
   *
   * **Event Structure:**
   * ```json
   * {
   *   "type": "assistant.message",
   *   "data": {
   *     "content": "Response text...",
   *     "toolRequests": [...]
   *   },
   *   "timestamp": "ISO8601"
   * }
   * ```
   */
  extractResponse(events: any[]): {
    text: string;
    toolCalls: any[];
    metadata: any;
    sessionInfo?: any;
  } {
    const textParts: string[] = [];
    const toolCalls: any[] = [];
    let metadata: any = {};
    let sessionInfo: any = {};

    for (const event of events) {
      // Extract text content from assistant messages
      if (event.type === "assistant.message" && event.data?.content) {
        textParts.push(event.data.content);
      }

      // Extract tool calls
      if (event.data?.toolRequests && Array.isArray(event.data.toolRequests)) {
        toolCalls.push(...event.data.toolRequests);
      }

      // Extract session metadata from session.start event
      if (event.type === "session.start" && event.data) {
        sessionInfo = {
          sessionId: event.data.sessionId,
          model: event.data.model,
          timestamp: event.timestamp,
        };
      }

      // Extract metadata from any event with metadata field
      if (event.data?.metadata) {
        metadata = { ...metadata, ...event.data.metadata };
      }
    }

    return {
      text: textParts.join(""),
      toolCalls,
      metadata: { ...metadata, ...sessionInfo },
      sessionInfo,
    };
  }

  /**
   * Check if log event indicates completion
   *
   * Detects response completion based on event type.
   *
   * @param event - Single parsed log event
   * @returns True if event signals completion
   *
   * @remarks
   * **New Format (v0.0.384+):**
   * - Looks for `event.type === "assistant.turn_end"`
   * - Reliable completion signal
   *
   * **Old Format (pre-v0.0.384):**
   * - No explicit completion event
   * - Use heuristic: timeout after last assistant.message
   * - Handled by calling code (not in this method)
   */
  isComplete(event: any): boolean {
    return event.type === "assistant.turn_end";
  }

  /**
   * Discover session log file for a prompt
   *
   * Searches `~/.copilot/session-state/` for the log file corresponding to
   * a specific prompt execution. Uses session ID (if provided) or prompt text matching.
   *
   * @param promptText - The prompt text sent to Copilot CLI (not used when sessionId provided)
   * @param startTime - Execution start timestamp
   * @param sessionId - Optional session ID for direct path construction (bypasses prompt matching)
   * @returns Absolute path to session log file, or null if not found
   *
   * @remarks
   * **Discovery Algorithm:**
   * 1. If sessionId provided: Construct path directly (`~/.copilot/session-state/{sessionId}/events.jsonl`)
   * 2. Otherwise: Find `~/.copilot/session-state/` directory
   * 3. Use inherited `findModifiedSessionLogs()` to get recently modified files/dirs
   * 4. For each candidate, resolve to actual log path using `getLogPath()`
   * 5. Read first 10 events from each log
   * 6. Look for user.message event containing prompt text (first 100 chars)
   * 7. Return first matching log file path
   *
   * **Prompt Matching:**
   * - Uses first 100 chars of prompt for fuzzy matching
   * - Copilot may transform prompts (whitespace, formatting)
   * - Case-insensitive substring match
   *
   * **Format Handling:**
   * - Supports both old (`.jsonl`) and new (`/events.jsonl`) formats
   * - `getLogPath()` handles format detection automatically
   */
  async discoverSessionLog(
    promptText: string,
    startTime: Date,
    sessionId?: string
  ): Promise<string | null> {
    try {
      const logDir = path.join(os.homedir(), ".copilot", "session-state");
      if (!fs.existsSync(logDir)) {
        Log.debug("[CopilotLogParser] Session state directory not found");
        return null;
      }

      // If session ID provided, construct path directly (resumed sessions)
      if (sessionId) {
        Log.debug(
          `[CopilotLogParser] Using session ID ${sessionId} for direct path construction`
        );

        // Try directory format first: ~/.copilot/session-state/{sessionId}/events.jsonl
        const sessionDir = path.join(logDir, sessionId);
        const eventsPath = path.join(sessionDir, "events.jsonl");

        if (fs.existsSync(eventsPath)) {
          Log.debug(
            `[CopilotLogParser] Found session log at ${eventsPath} (directory format)`
          );
          return eventsPath;
        }

        // Try flat file format: ~/.copilot/session-state/{sessionId}.jsonl
        const flatPath = path.join(logDir, `${sessionId}.jsonl`);
        if (fs.existsSync(flatPath)) {
          Log.debug(
            `[CopilotLogParser] Found session log at ${flatPath} (flat file format)`
          );
          return flatPath;
        }

        // Session ID provided but file not found - this is unexpected for resumed sessions
        Log.warn(
          `[CopilotLogParser] Session ${sessionId} not found in either format. Tried:\n` +
            `  - ${eventsPath}\n` +
            `  - ${flatPath}`
        );
        return null;
      }

      // Prepare prompt matcher (first 100 chars, normalized)
      const promptPrefix = promptText.slice(0, 100).toLowerCase().trim();

      // Retry with backoff: Copilot may take a moment to create the log file after SessionStart hook
      const result = await retryWithBackoff(
        async () => {
          // Get recently modified files/directories
          const candidates = this.findModifiedSessionLogs(logDir, startTime);
          if (candidates.length === 0) {
            return null; // Will retry
          }

          // Check each candidate
          for (const candidate of candidates) {
            try {
              // Resolve to actual log file path
              const logPath = await this.resolveLogPath(candidate);
              if (!logPath) {
                continue;
              }

              // Read first 10 events
              const events = await this.readFirstEvents(logPath, 10);

              // Look for user.message event containing prompt text
              for (const event of events) {
                if (event.type === "user.message" && event.data?.content) {
                  const content = event.data.content.toLowerCase().trim();
                  if (content.includes(promptPrefix)) {
                    return logPath; // Success - found matching log
                  }
                }
              }
            } catch (error) {
              // Skip candidates that can't be read
              Log.debug(
                `[CopilotLogParser] Error reading candidate ${candidate}:`,
                error
              );
              continue;
            }
          }

          return null; // No match found, will retry
        },
        {
          // Uses default: 10s
          onRetry: (attempt, max, delay) => {
            if (attempt > 1) {
              Log.debug(
                `[CopilotLogParser] Session log file not found (attempt ${attempt}/${max}), retrying in ${delay}ms...`
              );
            }
          },
        }
      );

      if (result) {
        Log.debug(`[CopilotLogParser] Found matching session log: ${result}`);
        return result;
      }

      Log.debug("[CopilotLogParser] No matching session log found");
      return null;
    } catch (error) {
      Log.warn("[CopilotLogParser] Error discovering session log:", error);
      return null;
    }
  }

  /**
   * Extract session ID from log events
   *
   * Searches for session.start event containing session ID.
   *
   * @param events - Array of parsed log events
   * @returns Session ID (UUID v4), or null if not found
   *
   * @remarks
   * **Session ID Format:** UUID v4 (e.g., `550e8400-e29b-41d4-a716-446655440000`)
   *
   * **Extraction Logic:**
   * - Find first `session.start` event
   * - Return `event.data.sessionId`
   * - Returns null if no session.start event found
   */
  extractSessionId(events: any[]): string | null {
    for (const event of events) {
      if (event.type === "session.start" && event.data?.sessionId) {
        return event.data.sessionId;
      }
    }
    return null;
  }

  /**
   * Extract text content from a single Copilot log event for streaming
   *
   * @param event - Single parsed Copilot log event
   * @returns Text content to display, or undefined if no displayable content
   *
   * @remarks
   * **Copilot Event Formats:**
   * - `assistant.message`: `{ type: "assistant.message", data: { content: "..." } }`
   * - `assistant.reasoning`: `{ type: "assistant.reasoning", data: { content: "..." } }`
   */
  extractContentFromEvent(event: any): string | undefined {
    // Assistant message content
    if (event.type === "assistant.message" && event.data?.content) {
      return event.data.content;
    }

    // Assistant reasoning content (prefixed for visibility)
    if (event.type === "assistant.reasoning" && event.data?.content) {
      return `[Reasoning] ${event.data.content}`;
    }

    return undefined;
  }

  /**
   * Format Copilot metadata into statistics string
   *
   * @param metadata - Metadata from extractResponse() (sessionId, model from session.start event)
   * @returns Formatted statistics string
   *
   * @example
   * ```typescript
   * const metadata = { sessionId: "abc-123", model: "gpt-5-mini" };
   * const stats = parser.formatStatistics(metadata);
   * // "Session: abc-123 | Model: gpt-5-mini"
   * ```
   */
  formatStatistics(metadata: any): string {
    const parts: string[] = [];

    // Session ID (truncated for readability)
    if (metadata.sessionId) {
      parts.push(`Session: ${metadata.sessionId.substring(0, 8)}`);
    }

    // Model name
    if (metadata.model) {
      parts.push(`Model: ${metadata.model}`);
    }

    // Token usage (if available - Copilot doesn't typically provide this in logs)
    if (metadata.usage) {
      const usage = metadata.usage;
      if (
        usage.input_tokens !== undefined &&
        usage.output_tokens !== undefined
      ) {
        parts.push(
          `Tokens: ${usage.input_tokens} in / ${usage.output_tokens} out`
        );
      }
    }

    return parts.join(" | ");
  }

  /**
   * Get log file path for a session ID
   *
   * Resolves session ID to actual log file path, handling both old and new formats.
   *
   * @param sessionId - Session ID (UUID v4)
   * @returns Absolute path to log file, or null if not found
   *
   * @remarks
   * **Format Detection:**
   * 1. Try new format first: `~/.copilot/session-state/<session-id>/events.jsonl`
   * 2. Fall back to old format: `~/.copilot/session-state/<session-id>.jsonl`
   * 3. Return null if neither exists
   *
   * **Example Paths:**
   * - New: `/home/user/.copilot/session-state/abc-123/events.jsonl`
   * - Old: `/home/user/.copilot/session-state/abc-123.jsonl`
   */
  static async getLogPath(sessionId: string): Promise<string | null> {
    const logDir = path.join(os.homedir(), ".copilot", "session-state");

    // Try new format first (v0.0.384+)
    const newFormatPath = path.join(logDir, sessionId, "events.jsonl");
    if (fs.existsSync(newFormatPath)) {
      return newFormatPath;
    }

    // Fall back to old format (pre-v0.0.384)
    const oldFormatPath = path.join(logDir, `${sessionId}.jsonl`);
    if (fs.existsSync(oldFormatPath)) {
      return oldFormatPath;
    }

    return null;
  }

  // ========================================================================
  // Private Helper Methods
  // ========================================================================

  /**
   * Resolve log path from candidate file/directory
   *
   * Handles both flat files (old format) and directories (new format).
   *
   * @param candidate - Path to candidate file or directory
   * @returns Actual log file path, or null if invalid
   */
  private async resolveLogPath(candidate: string): Promise<string | null> {
    try {
      const stats = fs.statSync(candidate);

      // Old format: Direct file (e.g., abc-123.jsonl)
      if (stats.isFile() && candidate.endsWith(".jsonl")) {
        return candidate;
      }

      // New format: Directory containing events.jsonl
      if (stats.isDirectory()) {
        const eventsPath = path.join(candidate, "events.jsonl");
        if (fs.existsSync(eventsPath)) {
          return eventsPath;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Read first N events from log file
   *
   * Optimized for quick sampling without reading entire file.
   *
   * @param filePath - Absolute path to log file
   * @param count - Maximum number of events to read
   * @returns Array of parsed events (up to count)
   */
  private async readFirstEvents(
    filePath: string,
    count: number
  ): Promise<any[]> {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n").filter((line) => line.trim());
      const events: any[] = [];

      for (let i = 0; i < Math.min(lines.length, count); i++) {
        try {
          const event = JSON.parse(lines[i]);
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
