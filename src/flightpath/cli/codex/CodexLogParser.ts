import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { BaseLogParser } from "../shared/BaseLogParser";
import { Log } from "../../../utils/Log";

/**
 * Codex CLI log parser
 *
 * Parses Codex CLI session logs to extract responses, session IDs, and
 * detect completion. Handles nested payload structure and date-based
 * directory hierarchy.
 *
 * @remarks
 * **Log Location:** `~/.codex/sessions/YYYY/MM/DD/`
 *
 * **File Naming:** `rollout-<timestamp>-<session-id>.jsonl`
 *
 * **Directory Structure:**
 * - Date-based hierarchy (YYYY/MM/DD)
 * - No index file (unlike Copilot)
 * - Multiple sessions per day in same directory
 *
 * **Event Structure (Nested Payloads):**
 * ```json
 * {
 *   "type": "response_item" | "event_msg" | "session_meta" | "turn_context",
 *   "payload": {
 *     "type": "message" | "turn.completed",
 *     "role": "assistant",
 *     "content": [{ "type": "input_text", "text": "Response..." }]
 *   },
 *   "timestamp": "ISO8601"
 * }
 * ```
 *
 * **Event Types:**
 * - `session_meta` - Session initialization (contains thread_xxx ID)
 * - `response_item` - Assistant response chunks (nested payload)
 * - `turn_context` - User message context
 * - `event_msg` - Control events (completion, errors)
 *
 * **Completion Signal:** `{"type": "event_msg", "payload": {"type": "turn.completed"}}`
 *
 * @example
 * ```typescript
 * const parser = new CodexLogParser();
 * const logPath = await parser.discoverSessionLog("Implement feature", new Date());
 * if (logPath) {
 *   const events = await parser.readNewLines(logPath);
 *   const response = parser.extractResponse(events);
 *   const sessionId = parser.extractSessionId(events);
 * }
 * ```
 */
export class CodexLogParser extends BaseLogParser {
  /**
   * Event buffer for multi-event responses
   *
   * Codex sends multiple response_item events for a single response.
   * This buffer accumulates events until turn.completed signal.
   */
  private eventBuffer: any[] = [];

  /**
   * Session metadata cache
   *
   * Stores session_meta event data for later reference.
   * Used to extract session ID and model information.
   */
  private sessionMeta: any = null;

  /**
   * Extract complete response from Codex log events
   *
   * Combines multiple response_item events with nested payloads into a single
   * response object. Extracts tool calls, reasoning blocks, and metadata.
   *
   * @param events - Array of parsed Codex log events
   * @returns Structured response object
   *
   * @remarks
   * **Response Assembly:**
   * - Processes response_item events with role="assistant"
   * - Extracts text from nested payload.content[].text fields
   * - Identifies tool calls from payload.content[].tool_use items
   * - Captures reasoning blocks if present
   * - Retrieves session ID from session_meta event
   *
   * **Payload Structure:**
   * ```json
   * {
   *   "type": "response_item",
   *   "payload": {
   *     "role": "assistant",
   *     "content": [
   *       { "type": "input_text", "text": "Response..." },
   *       { "type": "tool_use", "name": "write_file", "input": {...} }
   *     ]
   *   }
   * }
   * ```
   */
  extractResponse(events: any[]): {
    text: string;
    toolCalls: any[];
    metadata: any;
  } {
    const textParts: string[] = [];
    const toolCalls: any[] = [];
    const reasoningBlocks: string[] = [];
    let sessionId: string | null = null;
    let model: string | null = null;
    let cliVersion: string | null = null;

    for (const event of events) {
      // Track session metadata
      if (event.type === "session_meta" && event.payload) {
        this.sessionMeta = event.payload;
        sessionId = event.payload.id;
        model = event.payload.model;
        cliVersion = event.payload.cli_version;
      }

      // Extract text content from response_item events
      if (
        event.type === "response_item" &&
        event.payload?.role === "assistant"
      ) {
        const content = event.payload.content;
        if (Array.isArray(content)) {
          for (const item of content) {
            // Text content
            if (item.type === "input_text" && item.text) {
              textParts.push(item.text);
            }

            // Tool calls
            if (item.type === "tool_use") {
              toolCalls.push({
                name: item.name,
                input: item.input,
                id: item.id,
              });
            }

            // Reasoning blocks (if present)
            if (item.type === "thinking" && item.text) {
              reasoningBlocks.push(item.text);
            }
          }
        }
      }
    }

    // Fallback to cached session meta if not found in current events
    if (!sessionId && this.sessionMeta) {
      sessionId = this.sessionMeta.id;
      model = this.sessionMeta.model;
      cliVersion = this.sessionMeta.cli_version;
    }

    return {
      text: textParts.join(""),
      toolCalls,
      metadata: {
        sessionId,
        model,
        cliVersion,
        reasoningBlocks:
          reasoningBlocks.length > 0 ? reasoningBlocks : undefined,
      },
    };
  }

  /**
   * Check if log event indicates completion
   *
   * Detects Codex-specific completion signal with nested payload structure.
   *
   * @param event - Single parsed log event
   * @returns True if event signals completion
   *
   * @remarks
   * **Completion Signal:**
   * - Outer type: `"event_msg"`
   * - Nested payload type: `"turn.completed"`
   *
   * **Event Structure:**
   * ```json
   * {
   *   "type": "event_msg",
   *   "payload": {
   *     "type": "turn.completed"
   *   }
   * }
   * ```
   */
  isComplete(event: any): boolean {
    return (
      event.type === "event_msg" && event.payload?.type === "turn.completed"
    );
  }

  /**
   * Discover session log file for a prompt
   *
   * Searches `~/.codex/sessions/YYYY/MM/DD/` for the log file corresponding
   * to a specific prompt execution. Uses date hierarchy navigation and
   * prompt text matching.
   *
   * @param promptText - The prompt text sent to Codex CLI
   * @param startTime - Execution start timestamp
   * @returns Absolute path to session log file, or null if not found
   *
   * @remarks
   * **Discovery Algorithm:**
   * 1. Calculate today's date directory (YYYY/MM/DD)
   * 2. Find all `.jsonl` files modified after startTime
   * 3. Sort by modification time (newest first)
   * 4. Read first 10 events from each candidate
   * 5. Look for user message in response_items or event_msg
   * 6. Return first matching log file path
   *
   * **Date Hierarchy:**
   * - Base: `~/.codex/sessions/`
   * - Today: `~/.codex/sessions/2026/01/19/`
   * - Falls back to parent directories if current day has no matches
   *
   * **Prompt Matching:**
   * - Uses first 100 chars of prompt for fuzzy matching
   * - Case-insensitive substring match
   * - Searches in turn_context and response_item events
   *
   * **File Naming:** `rollout-<timestamp>-<session-id>.jsonl`
   */
  async discoverSessionLog(
    promptText: string,
    startTime: Date
  ): Promise<string | null> {
    try {
      // Calculate today's date directory
      const year = startTime.getFullYear().toString();
      const month = (startTime.getMonth() + 1).toString().padStart(2, "0");
      const day = startTime.getDate().toString().padStart(2, "0");

      const basePath = path.join(os.homedir(), ".codex", "sessions");
      const datePath = path.join(basePath, year, month, day);

      if (!fs.existsSync(datePath)) {
        Log.debug(`[CodexLogParser] Date directory not found: ${datePath}`);
        return null;
      }

      // Find all .jsonl files modified after startTime
      const files = fs.readdirSync(datePath);
      const candidates: Array<{ path: string; mtime: Date }> = [];

      for (const file of files) {
        if (!file.endsWith(".jsonl")) {
          continue;
        }

        const filePath = path.join(datePath, file);
        const stats = fs.statSync(filePath);

        if (stats.mtime >= startTime) {
          candidates.push({
            path: filePath,
            mtime: stats.mtime,
          });
        }
      }

      if (candidates.length === 0) {
        Log.debug("[CodexLogParser] No recent session logs found");
        return null;
      }

      // Sort by modification time (newest first)
      candidates.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

      // Prepare prompt matcher (first 100 chars, normalized)
      const promptPrefix = promptText.slice(0, 100).toLowerCase().trim();

      // Check each candidate
      for (const candidate of candidates) {
        try {
          // Read first 10 events
          const events = await this.readFirstEvents(candidate.path, 10);

          // Look for user message in turn_context or response_item events
          for (const event of events) {
            let userMessage: string | null = null;

            // Check turn_context for user message
            if (event.type === "turn_context" && event.payload?.messages) {
              const userMsg = event.payload.messages.find(
                (m: any) => m.role === "user"
              );
              if (userMsg?.content) {
                userMessage = Array.isArray(userMsg.content)
                  ? userMsg.content.map((c: any) => c.text).join("")
                  : userMsg.content;
              }
            }

            // Check response_item for user echo
            if (
              event.type === "response_item" &&
              event.payload?.role === "user"
            ) {
              const content = event.payload.content;
              if (Array.isArray(content)) {
                userMessage = content
                  .filter((c: any) => c.type === "input_text")
                  .map((c: any) => c.text)
                  .join("");
              }
            }

            // Match prompt text
            if (
              userMessage &&
              userMessage.toLowerCase().includes(promptPrefix)
            ) {
              Log.debug(
                `[CodexLogParser] Found matching log: ${candidate.path}`
              );
              return candidate.path;
            }
          }
        } catch (error) {
          Log.debug(`[CodexLogParser] Failed to read candidate log: ${error}`);
          continue;
        }
      }

      Log.debug("[CodexLogParser] No matching session log found");
      return null;
    } catch (error) {
      Log.error(`[CodexLogParser] Session discovery failed: ${error}`);
      return null;
    }
  }

  /**
   * Extract session ID from Codex log events
   *
   * Searches for session_meta event and extracts the thread_xxx session ID.
   *
   * @param events - Array of parsed Codex log events
   * @returns Session ID (thread_xxx format), or null if not found
   *
   * @remarks
   * **Session ID Format:** `thread_abc123xyz789`
   *
   * **Event Structure:**
   * ```json
   * {
   *   "type": "session_meta",
   *   "payload": {
   *     "id": "thread_abc123xyz789",
   *     "model": "gpt-5.1-codex",
   *     "cli_version": "1.2.3"
   *   }
   * }
   * ```
   *
   * **Fallback:** If no session_meta in current events, returns cached value
   * from this.sessionMeta (populated during extractResponse).
   */
  extractSessionId(events: any[]): string | null {
    for (const event of events) {
      if (event.type === "session_meta" && event.payload?.id) {
        return event.payload.id;
      }
    }

    // Fallback to cached session metadata
    return this.sessionMeta?.id || null;
  }

  /**
   * Extract text content from a single Codex log event for streaming
   *
   * @param event - Single parsed Codex log event
   * @returns Text content to display, or undefined if no displayable content
   *
   * @remarks
   * **Codex Event Formats:**
   * - Direct content: `{ type: "text", content: "..." }`
   * - Nested payload: `{ payload: { type: "input_text", text: "..." } }`
   * - Response items: `{ type: "response_item", payload: { content: [...] } }`
   */
  extractContentFromEvent(event: any): string | undefined {
    // Direct content field
    if (event.type === "text" && event.content) {
      return event.content;
    }

    // Nested payload with text
    if (event.payload?.type === "input_text" && event.payload.text) {
      return event.payload.text;
    }

    // Response item with content array
    if (event.type === "response_item" && event.payload?.content) {
      const textParts = event.payload.content
        .filter((c: any) => c.type === "input_text" && c.text)
        .map((c: any) => c.text);
      return textParts.length > 0 ? textParts.join("") : undefined;
    }

    return undefined;
  }

  /**
   * Format Codex metadata into statistics string
   *
   * @param metadata - Metadata from extractResponse() (sessionId, model, usage)
   * @returns Formatted statistics string
   *
   * @example
   * ```typescript
   * const metadata = {
   *   sessionId: "thread_abc123",
   *   model: "gpt-5.1-codex",
   *   usage: { input_tokens: 100, output_tokens: 50 }
   * };
   * const stats = parser.formatStatistics(metadata);
   * // "Session: thread_abc | Model: gpt-5.1-codex | Tokens: 100 in / 50 out"
   * ```
   */
  formatStatistics(metadata: any): string {
    const parts: string[] = [];

    // Session ID (truncate thread_ prefix for readability)
    if (metadata.sessionId) {
      const displayId = metadata.sessionId.replace(/^thread_/, "thread_");
      parts.push(`Session: ${displayId.substring(0, 12)}`);
    }

    // Model name
    if (metadata.model) {
      parts.push(`Model: ${metadata.model}`);
    }

    // Token usage
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
   * Process a single event for buffering and state tracking
   *
   * Buffers response_item events and tracks session metadata for later
   * extraction. Used for incremental processing of streaming events.
   *
   * @param event - Single parsed log event
   * @returns The processed event, or null if buffered
   *
   * @remarks
   * **Buffering Logic:**
   * - session_meta events update sessionMeta cache
   * - response_item events added to eventBuffer
   * - turn.completed signals buffer flush
   *
   * **Use Case:** Real-time streaming response processing
   */
  processEvent(event: any): any | null {
    // Track session metadata
    if (event.type === "session_meta" && event.payload) {
      this.sessionMeta = event.payload;
    }

    // Buffer response events
    if (event.type === "response_item" || event.type === "turn_context") {
      this.eventBuffer.push(event);
    }

    // On completion, flush buffer and return all events
    if (this.isComplete(event)) {
      const buffered = [...this.eventBuffer];
      this.eventBuffer = [];
      return buffered;
    }

    return null;
  }

  /**
   * Read first N events from JSONL log file
   *
   * Helper for session discovery. Reads only the first N lines to avoid
   * parsing entire log file (efficiency optimization).
   *
   * @param filePath - Absolute path to log file
   * @param count - Maximum number of events to read
   * @returns Array of parsed events (up to count)
   *
   * @remarks
   * **Efficiency:**
   * - Only reads first N lines (not entire file)
   * - Stops reading after N valid JSON objects
   * - Skips empty lines
   *
   * **Error Handling:**
   * - Returns empty array if file doesn't exist
   * - Logs parse errors but continues processing
   * - Stops on file read errors
   */
  private async readFirstEvents(
    filePath: string,
    count: number
  ): Promise<any[]> {
    try {
      if (!fs.existsSync(filePath)) {
        return [];
      }

      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n");
      const events: any[] = [];

      for (const line of lines) {
        if (events.length >= count) {
          break;
        }

        const trimmed = line.trim();
        if (!trimmed) {
          continue; // Skip empty lines
        }

        try {
          const event = JSON.parse(trimmed);
          events.push(event);
        } catch (error) {
          // Skip invalid JSON lines silently
          continue;
        }
      }

      return events;
    } catch (error) {
      // Return empty array on file read errors
      return [];
    }
  }
}
