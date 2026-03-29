import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { BaseLogParser } from "../shared/BaseLogParser";
import { BaseCliEvent } from "../shared/interfaces/ILogParser";
import { CopilotToolBuilder } from "./CopilotToolBuilder";
import { Log } from "../../../utils/Log";
import { retryWithBackoff } from "../../../utils/RetryUtils";
import { COPILOT_CLI_CONTEXT_WINDOW_SIZE } from "../../../utils/ModelConstants";
import {
  UniversalCliOutput,
  ThinkingBlock,
  CliEvent,
  TextData,
  ToolResultData,
} from "../../../types/CliOutputTypes";
import { CLI_EVENT_TYPES, HARNESS_IDS } from "../../../types/DashboardConstants";

// ============================================================================
// Copilot Log Event Type Definitions
// ============================================================================

// ============================================================================
// CopilotLogParser Implementation
// ============================================================================

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
 * **Supported Event Types (9 types per COPILOT_LOG_SCHEMA.md):**
 * - `session.start` - Session initialization (sessionId, copilotVersion, selectedModel)
 * - `session.info` - Informational messages (authentication, MCP connections)
 * - `session.error` - Session-level errors (model call failures, API errors)
 * - `user.message` - User prompt with file attachments
 * - `assistant.turn_start` - Turn begins (sequential turnId)
 * - `assistant.message` - Response content and tool requests
 * - `assistant.reasoning` - Chain-of-thought reasoning blocks
 * - `tool.execution_start` - Tool call initiated (toolCallId, toolName, arguments)
 * - `tool.execution_complete` - Tool call finished (toolCallId, success, result)
 * - `assistant.turn_end` - Turn completes (fires after EACH tool, not at final completion!)
 *
 * **Completion Detection:**
 * - **IMPORTANT:** `assistant.turn_end` fires after EACH tool call, not at final completion
 * - Interactive mode: Use sessionEnd hook (CopilotNotificationMonitor)
 * - Headless mode: Process exit signals completion
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
 *
 * @see docs/schemas/COPILOT_LOG_SCHEMA.md for complete event type documentation
 */

/**
 * Provider-specific event type for internal loop bodies.
 *
 * Extends BaseCliEvent with a typed `data` property for Copilot's nested event structure.
 * This avoids `as any[]` casts while preserving flexible access to provider-specific data fields.
 * Top-level fields (`type`, `timestamp`) remain properly typed from BaseCliEvent.
 */
interface CopilotProviderEvent extends BaseCliEvent {
  data?: Record<string, any>;
}

export class CopilotLogParser extends BaseLogParser {
  /**
   * Event buffer for multi-event responses
   *
   * Copilot may send multiple assistant.message events for a single response.
   */

  /** Tracks in-flight tool calls across streaming events for extractStructuredEventsFromEvent. */
  private pendingStreamingTools = new Map<
    string,
    { toolName: string; args: Record<string, unknown>; timestamp: number }
  >();

  /**
   * Extract complete response from Copilot log events
   *
   * Combines multiple assistant.message events into a single response object.
   * Extracts tool requests, tool results, thinking blocks, metadata, and session information.
   *
   * @param events - Array of parsed Copilot log events
   * @returns UniversalCliOutput - Standardized response object
   *
   * @remarks
   * **Supported Event Types:**
   * - `session.start` - Session initialization (sessionId, model)
   * - `session.info` - Authentication/MCP connection info (logged, not output)
   * - `session.error` - Session errors (emitted as TEXT with error details)
   * - `assistant.message` - Response text and tool requests
   * - `assistant.reasoning` - Chain-of-thought thinking blocks
   * - `tool.execution_start` - Tool call initiation (emitted as semantic events: BASH_COMMAND, FILE_READ, etc.)
   * - `tool.execution_complete` - Tool results (emitted as TOOL_RESULT)
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
  extractResponse(events: BaseCliEvent[]): UniversalCliOutput {
    const outputEvents: CliEvent[] = [];
    let sessionId: string | undefined;
    let model: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    // Context window usage tracked via session.truncation events (fire every turn as a pre-call snapshot)
    let contextWindowUsedTokens = 0;
    let contextWindowSize: number | undefined;

    // Track pending tool calls to associate execution_start with execution_complete
    const pendingTools = new Map<
      string,
      { toolName: string; args: Record<string, unknown>; timestamp: number }
    >();

    for (const event of events as CopilotProviderEvent[]) {
      const timestamp = event.timestamp
        ? new Date(event.timestamp).getTime()
        : Date.now();

      // Extract session metadata from session.start event
      if (event.type === "session.start" && event.data) {
        sessionId = event.data.sessionId;
        model = event.data.selectedModel;
      }

      // Handle session.info events (log for debugging, not emitted as output)
      if (event.type === "session.info" && event.data) {
        if (event.data.infoType === "authentication") {
          Log.debug(`[CopilotLogParser] ${event.data.message}`);
        }
        if (event.data.infoType === "mcp") {
          Log.debug(`[CopilotLogParser] MCP: ${event.data.message}`);
        }
      }

      // session.truncation fires every turn as a pre-call context snapshot (not just during actual truncation).
      // postTruncationTokensInMessages = tokens actually sent to the model this turn (grows each turn).
      // Always take the latest value — use it to track context window fill across the session.
      if (event.type === "session.truncation" && event.data) {
        contextWindowUsedTokens = event.data.postTruncationTokensInMessages || 0;
        contextWindowSize = event.data.tokenLimit;

        // Also surface it as a visible event when messages were actually dropped
        const removed = event.data.tokensRemovedDuringTruncation;
        if (removed > 0) {
          const post = event.data.postTruncationTokensInMessages;
          const limit = event.data.tokenLimit;
          outputEvents.push({
            type: CLI_EVENT_TYPES.TEXT,
            timestamp,
            data: {
              text: `[Context truncated: ${removed.toLocaleString()} tokens removed, ${post.toLocaleString()}/${limit.toLocaleString()} tokens remaining]`,
            } as TextData,
          });
        }
      }

      // Handle session.error events (emit as error text)
      if (event.type === "session.error" && event.data) {
        const errorCode = event.data.errorType || "UNKNOWN";
        const errorMessage = event.data.message || "Unknown error";
        outputEvents.push({
          type: CLI_EVENT_TYPES.TEXT,
          timestamp,
          data: {
            text: `Error [${errorCode}]: ${errorMessage}`,
          } as TextData,
        });
      }

      // Extract text content from assistant messages
      if (event.type === "assistant.message" && event.data) {
        if (event.data.content) {
          outputEvents.push({
            type: CLI_EVENT_TYPES.TEXT,
            timestamp,
            data: {
              text: event.data.content,
            } as TextData,
          });
        }

        // Extract inline reasoning (new format: reasoningText embedded in assistant.message)
        // Newer Copilot versions embed reasoning here instead of a separate assistant.reasoning event
        if (event.data.reasoningText) {
          outputEvents.push({
            type: CLI_EVENT_TYPES.THINKING,
            timestamp,
            data: {
              text: event.data.reasoningText,
              label: "Reasoning",
              timestamp,
            } as ThinkingBlock,
          });
        }

        // Extract output token count (available in newer Copilot log format)
        if (typeof event.data.outputTokens === "number") {
          outputTokens += event.data.outputTokens;
        }

        // Note: tool calls are extracted from tool.execution_start (not toolRequests)
        // because tool.execution_start provides more accurate timestamps and allows
        // us to add structuredPatch from tool.execution_complete
      }

      // Extract thinking/reasoning blocks (old format: separate assistant.reasoning event)
      if (event.type === "assistant.reasoning" && event.data?.content) {
        outputEvents.push({
          type: CLI_EVENT_TYPES.THINKING,
          timestamp,
          data: {
            text: event.data.content,
            label: "Reasoning",
            timestamp,
          } as ThinkingBlock,
        });
      }

      // Store tool execution start data for later association with completion
      if (event.type === "tool.execution_start" && event.data) {
        pendingTools.set(event.data.toolCallId, {
          toolName: event.data.toolName,
          args: event.data.arguments || {},
          timestamp,
        });

        // Emit semantic events for all tools immediately (for real-time feedback)
        outputEvents.push(
          CopilotToolBuilder.buildInitiatedEvent(
            event.data.toolName,
            event.data.arguments || {},
            event.data.toolCallId,
            timestamp
          )
        );
      }

      // Emit COMPLETED events for all tool types from tool.execution_complete
      if (event.type === "tool.execution_complete" && event.data) {
        const pendingTool = pendingTools.get(event.data.toolCallId);

        if (pendingTool) {
          outputEvents.push(
            ...CopilotToolBuilder.buildCompletedEvents(
              pendingTool.toolName,
              pendingTool.args,
              event.data
            )
          );
          pendingTools.delete(event.data.toolCallId);
        }

        // Always emit TOOL_RESULT
        const toolResultRaw = event.data.result?.content;
        const toolResultStr =
          typeof toolResultRaw === "string"
            ? toolResultRaw
            : toolResultRaw
              ? JSON.stringify(toolResultRaw)
              : undefined;
        outputEvents.push({
          type: CLI_EVENT_TYPES.TOOL_RESULT,
          timestamp,
          data: {
            toolCallId: event.data.toolCallId,
            result: {
              success: event.data.success,
              output: toolResultStr,
              error: event.data.success ? undefined : toolResultStr,
            },
          } as ToolResultData,
        });
      }

    }

    // Prefer context window data from session.truncation (fires every turn, most accurate source).
    // Fall back to legacy metadata.usage accumulation (not seen in practice, kept for safety).
    const effectiveInputTokens = contextWindowUsedTokens > 0 ? contextWindowUsedTokens : inputTokens;
    const effectiveContextWindowSize = contextWindowSize ?? COPILOT_CLI_CONTEXT_WINDOW_SIZE;

    return {
      events: outputEvents,
      metadata: {
        sessionId,
        model,
        harness: HARNESS_IDS.COPILOT_CLI,
        usage:
          effectiveInputTokens > 0 || outputTokens > 0
            ? {
                inputTokens: effectiveInputTokens,
                outputTokens,
                totalTokens: effectiveInputTokens + outputTokens,
                // postTruncationTokensInMessages = full context sent to model on last turn
                contextWindowUsedTokens: effectiveInputTokens,
                contextWindowSize: effectiveContextWindowSize,
              }
            : undefined,
      },
    };
  }

  /**
   * Check if log event indicates completion
   *
   * **CRITICAL: Copilot's `assistant.turn_end` fires after EACH tool call, not at final completion!**
   *
   * This makes log-based completion detection fundamentally unreliable for Copilot CLI.
   *
   * **Event Sequence for Multi-Tool Response:**
   * ```
   * assistant.message (with toolRequests: [tool1])
   * tool.execution_start (tool 1)
   * tool.execution_complete (tool 1)
   * assistant.turn_end (turn 0) ← FIRES HERE but NOT done!
   * assistant.message (with toolRequests: [tool2])
   * tool.execution_start (tool 2)
   * tool.execution_complete (tool 2)
   * assistant.turn_end (turn 1) ← FIRES AGAIN
   * ... continues until no more tools needed
   * ```
   *
   * **Reliable Completion Detection:**
   * - **Interactive mode**: sessionEnd hook (via CopilotNotificationMonitor)
   * - **Headless mode**: Process exit
   *
   * @param _event - Single parsed log event (unused - always returns false)
   * @returns Always false - Use sessionEnd hook for reliable completion detection
   *
   * @see CopilotNotificationMonitor for interactive mode completion
   * @see CopilotCliProvider.executePrompt for headless mode completion
   */
  isComplete(_event: BaseCliEvent): boolean {
    // NEVER detect completion from log files for Copilot - use hooks instead!
    // Reason: assistant.turn_end fires after EACH tool call, not at final completion.
    //
    // For reliable completion detection:
    // - Interactive mode: sessionEnd hook configured in CopilotCliProvider
    // - Headless mode: Process exit signals completion
    return false;
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

        // Session ID provided but file not found - fall back to prompt-text matching
        // This handles: bad session ID from user, logs cleaned up, or format change
        Log.warn(
          `[CopilotLogParser] Session ${sessionId} not found in either format. Tried:\n` +
            `  - ${eventsPath}\n` +
            `  - ${flatPath}\n` +
            `  Falling back to prompt-text matching.`
        );
        // Fall through to prompt-text matching below
      }

      // Prepare prompt matcher (first 100 chars, normalized)
      // Normalize for path escaping: Copilot may double backslashes in file paths
      const promptPrefix = this.normalizePromptForMatching(
        promptText.slice(0, 100)
      );

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
              const events = await this.readFirstNJsonlEvents(logPath, 10);

              // Look for user.message event containing prompt text
              for (const event of events as CopilotProviderEvent[]) {
                if (event.type === "user.message" && event.data?.content) {
                  const content = this.normalizePromptForMatching(
                    event.data.content
                  );
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
   * **Session ID Format:** UUID v4 (e.g., `6e2ec013-11bd-4862-ab32-c5b4d5a71131`)
   *
   * **Extraction Logic:**
   * - Find first `session.start` event
   * - Return `event.data.sessionId`
   * - Returns null if no session.start event found
   */
  extractSessionId(events: BaseCliEvent[]): string | null {
    for (const event of events as CopilotProviderEvent[]) {
      if (event.type === "session.start" && event.data?.sessionId) {
        return event.data.sessionId;
      }
    }
    return null;
  }

  /**
   * Extract text content from a single Copilot log event for streaming
   *
   * Used during real-time log monitoring to extract displayable content
   * as events are written to the log file.
   *
   * @deprecated Superseded by `extractStructuredEventsFromEvent` in the streaming path,
   * which emits typed CliEvents (TEXT, THINKING, BASH_COMMAND, TOOL_RESULT, etc.) instead of
   * plain strings. This method is retained only for the BaseLogParser default fallback.
   *
   * @param event - Single parsed Copilot log event
   * @returns Text content to display, or undefined if no displayable content
   *
   * @remarks
   * **Supported Event Types:**
   * - `assistant.message` - Response text content
   * - `assistant.reasoning` - Chain-of-thought reasoning (prefixed with [Reasoning])
   * - `tool.execution_complete` - Tool execution result
   * - `session.error` - Error messages
   *
   * **Event Formats:**
   * ```json
   * { "type": "assistant.message", "data": { "content": "..." } }
   * { "type": "assistant.reasoning", "data": { "content": "..." } }
   * { "type": "tool.execution_complete", "data": { "result": { "content": "..." } } }
   * { "type": "session.error", "data": { "message": "..." } }
   * ```
   */
  extractContentFromEvent(event: BaseCliEvent): string | undefined {
    // Provider-specific nested property access
    const data = event.data as Record<string, any> | undefined;

    // Assistant message content (primary response text)
    if (event.type === "assistant.message" && data?.content) {
      return data.content;
    }

    // Inline reasoning (new format: reasoningText in assistant.message)
    // Streaming this gives users visible progress while Copilot thinks
    if (event.type === "assistant.message" && data?.reasoningText) {
      return `[Thinking] ${data.reasoningText}`;
    }

    // Assistant reasoning content (old format: separate assistant.reasoning event)
    if (event.type === "assistant.reasoning" && data?.content) {
      return `[Reasoning] ${data.content}`;
    }

    // NOTE: tool.execution_complete results are intentionally NOT streamed here.
    // Emitting raw tool result content (file contents, command output, etc.) as
    // plain text chunks produces garbled output — no ⎿ prefix, no structure, all
    // concatenated together. Tool results are properly rendered via extractResponse()
    // which builds typed CliEvents (BASH_COMMAND, FILE_READ, TOOL_RESULT, etc.)
    // at completion. During streaming, only assistant text/reasoning is surfaced.

    // Session error content
    if (event.type === "session.error" && data) {
      const errorCode = data.errorType || "UNKNOWN";
      const errorMessage = data.message || "Unknown error";
      return `Error [${errorCode}]: ${errorMessage}`;
    }

    return undefined;
  }

  /**
   * Extract structured CliEvents from a single Copilot log event for streaming.
   *
   * Full override of the BaseLogParser default. Produces typed CliEvents
   * (TEXT, THINKING, BASH_COMMAND, FILE_READ, FILE_WRITE, FILE_EDIT, TOOL_RESULT, etc.)
   * identical to the events emitted by `extractResponse()` — but processed one event at
   * a time. Uses `pendingStreamingTools` (instance state) to carry tool call context
   * across consecutive event calls, mirroring the local `pendingTools` map in
   * `extractResponse()`.
   *
   * @param event - Single parsed Copilot log event
   * @returns Array of CliEvents to emit; empty if the event produces no streamable output
   */
  override extractStructuredEventsFromEvent(event: BaseCliEvent): CliEvent[] {
    const ev = event as CopilotProviderEvent;
    const timestamp = ev.timestamp
      ? new Date(ev.timestamp as string | number).getTime()
      : Date.now();
    const data = ev.data;
    const results: CliEvent[] = [];

    if (!data) {
      return results;
    }

    // assistant.message: text content and inline reasoning (new format)
    if (ev.type === "assistant.message") {
      if (data.content) {
        results.push({
          type: CLI_EVENT_TYPES.TEXT,
          timestamp,
          data: { text: data.content } as TextData,
        });
      }
      if (data.reasoningText) {
        results.push({
          type: CLI_EVENT_TYPES.THINKING,
          timestamp,
          data: {
            text: data.reasoningText,
            label: "Reasoning",
            timestamp,
          } as ThinkingBlock,
        });
      }
      return results;
    }

    // assistant.reasoning: old-format chain-of-thought (separate event)
    if (ev.type === "assistant.reasoning" && data.content) {
      results.push({
        type: CLI_EVENT_TYPES.THINKING,
        timestamp,
        data: {
          text: data.content,
          label: "Reasoning",
          timestamp,
        } as ThinkingBlock,
      });
      return results;
    }

    // session.error: surface as TEXT
    if (ev.type === "session.error") {
      const errorCode = data.errorType || "UNKNOWN";
      const errorMessage = data.message || "Unknown error";
      results.push({
        type: CLI_EVENT_TYPES.TEXT,
        timestamp,
        data: { text: `Error [${errorCode}]: ${errorMessage}` } as TextData,
      });
      return results;
    }

    // tool.execution_start: store pending state AND emit the semantic initiated event
    if (ev.type === "tool.execution_start") {
      this.pendingStreamingTools.set(data.toolCallId, {
        toolName: data.toolName,
        args: data.arguments || {},
        timestamp,
      });
      results.push(
        CopilotToolBuilder.buildInitiatedEvent(
          data.toolName,
          data.arguments || {},
          data.toolCallId,
          timestamp
        )
      );
      return results;
    }

    // tool.execution_complete: emit completed events + TOOL_RESULT, then clean up
    if (ev.type === "tool.execution_complete") {
      const pending = this.pendingStreamingTools.get(data.toolCallId);
      if (pending) {
        results.push(
          ...CopilotToolBuilder.buildCompletedEvents(
            pending.toolName,
            pending.args,
            data
          )
        );
        this.pendingStreamingTools.delete(data.toolCallId);
      }

      const toolResultRaw = data.result?.content;
      const toolResultStr =
        typeof toolResultRaw === "string"
          ? toolResultRaw
          : toolResultRaw
            ? JSON.stringify(toolResultRaw)
            : undefined;
      results.push({
        type: CLI_EVENT_TYPES.TOOL_RESULT,
        timestamp,
        data: {
          toolCallId: data.toolCallId,
          result: {
            success: data.success,
            output: toolResultStr,
            error: data.success ? undefined : toolResultStr,
          },
        } as ToolResultData,
      });
      return results;
    }

    return results;
  }

  /**
   * Format Copilot metadata into statistics string for display
   *
   * Creates a human-readable summary of session metadata including
   * session ID, model name, and token usage statistics.
   *
   * @param metadata - Metadata from extractResponse() (sessionId, model, usage)
   * @returns Formatted statistics string with pipe-separated values
   *
   * @example
   * ```typescript
   * const metadata = {
   *   sessionId: "6e2ec013-11bd-4862-ab32-c5b4d5a71131",
   *   model: "gpt-5-mini",
   *   usage: { inputTokens: 1500, outputTokens: 500 }
   * };
   * const stats = parser.formatStatistics(metadata);
   * // "Session: 6e2ec013... | Model: gpt-5-mini | Tokens: 1500 in / 500 out"
   * ```
   */
  formatStatistics(metadata: BaseCliEvent): string {
    return this.buildCommonStatisticsParts(metadata, 8, "...").join(" | ");
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

  /**
   * Extract context window data from a session log by session ID.
   *
   * Reads the last `session.truncation` event from the session log, which fires
   * once per model call turn and contains the most accurate context fill data.
   * Returns the final (highest) values from a multi-turn session.
   *
   * Used by CopilotCliProvider.augmentParsedOutput() to patch missing input token
   * data in JSON-mode headless output.
   *
   * @param sessionId - Session UUID from the `result` event in JSONL stdout
   * @returns Truncation data if found, undefined if log unavailable or unreadable
   */
  static async extractTruncationDataFromLog(
    sessionId: string
  ): Promise<{ postTruncationTokensInMessages: number; tokenLimit: number } | undefined> {
    const logPath = await CopilotLogParser.getLogPath(sessionId);
    if (!logPath) {
      return undefined;
    }

    try {
      const content = fs.readFileSync(logPath, "utf-8");
      let last: { postTruncationTokensInMessages: number; tokenLimit: number } | undefined;

      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);
          if (
            event.type === "session.truncation" &&
            typeof event.data?.postTruncationTokensInMessages === "number" &&
            typeof event.data?.tokenLimit === "number"
          ) {
            last = {
              postTruncationTokensInMessages: event.data.postTruncationTokensInMessages,
              tokenLimit: event.data.tokenLimit,
            };
          }
        } catch {
          // Skip malformed lines
        }
      }

      return last;
    } catch {
      return undefined;
    }
  }

  /**
   * Extract session ID from a known log file path.
   *
   * Reads only the first event (session.start) to extract the session ID.
   * This is stateless - unlike readNewLines(), it always reads from the
   * beginning of the file, so it's safe to call regardless of prior monitoring state.
   *
   * @param logPath Absolute path to a session log file (events.jsonl or .jsonl)
   * @returns Session ID (UUID) if found, null otherwise
   *
   * @remarks
   * Used by CopilotCliProvider.extractSessionIdFromLogs() after discoverSessionLog()
   * has already identified the correct log file via prompt-text matching.
   */
  async extractSessionIdFromLogPath(logPath: string): Promise<string | null> {
    try {
      const events = await this.readFirstNJsonlEvents(logPath, 1);
      if (events.length === 0) {
        Log.debug(
          `[CopilotLogParser] No events found in ${path.basename(logPath)}`
        );
        return null;
      }

      const sessionId = this.extractSessionId(events);
      if (sessionId) {
        Log.debug(
          `[CopilotLogParser] Extracted session ID from ${path.basename(logPath)}: ${sessionId}`
        );
      }
      return sessionId;
    } catch (error) {
      Log.debug(
        `[CopilotLogParser] Error reading session ID from ${logPath}:`,
        error
      );
      return null;
    }
  }

  // ========================================================================
  // Process Log — Context Window Extraction
  // ========================================================================

  /**
   * Extract context window usage from the Copilot process log for a session.
   *
   * Copilot writes per-process log files to `~/.copilot/logs/process-*.log`.
   * Each file begins with `Workspace initialized: {sessionId}`, making session
   * matching straightforward. The `CompactionProcessor` lines report the current
   * context utilization every turn:
   *
   * ```
   * 2026-03-04T15:14:58.073Z [INFO] CompactionProcessor: Utilization 37.2% (47591/128000 tokens) below threshold 80%
   * ```
   *
   * We use the **last** such line (most recent turn) to get the final context
   * window state after the prompt completed.
   *
   * @param sessionId - Copilot session UUID (from session.start event / hook)
   * @returns Context window tokens `{ used, size }`, or undefined if unavailable
   */
  async extractContextFromProcessLog(
    sessionId: string
  ): Promise<{ used: number; size: number } | undefined> {
    try {
      const logsDir = path.join(os.homedir(), ".copilot", "logs");
      if (!fs.existsSync(logsDir)) {
        return undefined;
      }

      // Find the process-*.log file for this session
      const processLog = this.findProcessLogForSession(logsDir, sessionId);
      if (!processLog) {
        Log.debug(
          `[CopilotLogParser] No process log found for session ${sessionId}`
        );
        return undefined;
      }

      // Read file and scan for the last CompactionProcessor line
      const content = fs.readFileSync(processLog, "utf8");
      let used: number | undefined;
      let size: number | undefined;

      for (const line of content.split("\n")) {
        const match = line.match(
          /CompactionProcessor: Utilization [\d.]+% \((\d+)\/(\d+) tokens\)/
        );
        if (match) {
          used = parseInt(match[1], 10);
          size = parseInt(match[2], 10);
        }
      }

      if (used === undefined || size === undefined) {
        Log.debug(
          `[CopilotLogParser] No CompactionProcessor events in ${path.basename(processLog)}`
        );
        return undefined;
      }

      Log.debug(
        `[CopilotLogParser] Context from process log: ${used}/${size} tokens (${path.basename(processLog)})`
      );
      return { used, size };
    } catch (error) {
      Log.debug(
        `[CopilotLogParser] Failed to read process log for context: ${error}`
      );
      return undefined;
    }
  }

  /**
   * Find the process-*.log file whose first line identifies the given session.
   *
   * @param logsDir - `~/.copilot/logs/`
   * @param sessionId - Session UUID to search for
   * @returns Absolute path to the matching log file, or null
   */
  private findProcessLogForSession(
    logsDir: string,
    sessionId: string
  ): string | null {
    try {
      const files = fs
        .readdirSync(logsDir)
        .filter((f) => f.startsWith("process-") && f.endsWith(".log"));

      for (const file of files) {
        const filePath = path.join(logsDir, file);
        try {
          // Read the first ~1024 bytes to find the session ID.
          // "Workspace initialized: {UUID}" appears on line 4 of the file,
          // at approximately byte 310 — so 256 bytes is not enough. Using
          // 1024 provides headroom if Copilot adds more preamble lines later.
          const fd = fs.openSync(filePath, "r");
          const buf = Buffer.alloc(1024);
          const bytesRead = fs.readSync(fd, buf, 0, 1024, 0);
          fs.closeSync(fd);
          const firstChunk = buf.toString("utf8", 0, bytesRead);
          if (firstChunk.includes(`Workspace initialized: ${sessionId}`)) {
            return filePath;
          }
        } catch {
          continue;
        }
      }
      return null;
    } catch {
      return null;
    }
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
}
