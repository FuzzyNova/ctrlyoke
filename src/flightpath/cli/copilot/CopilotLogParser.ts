import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { BaseLogParser } from "../shared/BaseLogParser";
import { Log } from "../../../utils/Log";
import { retryWithBackoff } from "../../../utils/RetryUtils";
import {
  UniversalCliOutput,
  ToolCall,
  ThinkingBlock,
  CliEvent,
  TextData,
  ToolResultData,
  BashCommandData,
  FileReadData,
  FileWriteData,
  FileEditData,
  FileDeleteData,
  McpToolCallData,
  WebSearchData,
  UnifiedDiffHunk,
  CLI_EVENT_TYPES,
} from "../../../types/CliOutputTypes";
import { OPERATION_STATUS } from "../../../types/DashboardConstants";

// ============================================================================
// Copilot Log Event Type Definitions
// ============================================================================

/**
 * Base event structure - all Copilot log events extend this
 */
interface CopilotBaseEvent {
  type: string;
  data: Record<string, unknown>;
  id: string; // UUID
  timestamp: string; // ISO 8601
  parentId: string | null;
}

/**
 * Session initialization event (1 per session, always first)
 */
interface CopilotSessionStartEvent extends CopilotBaseEvent {
  type: "session.start";
  data: {
    sessionId: string;
    version: number;
    producer: string;
    copilotVersion: string;
    startTime: string;
    selectedModel: string;
  };
  parentId: null;
}

/**
 * Session information event (authentication, MCP connections)
 */
interface CopilotSessionInfoEvent extends CopilotBaseEvent {
  type: "session.info";
  data: {
    infoType: "authentication" | "mcp" | string;
    message: string;
  };
  parentId: string;
}

/**
 * Session error event (model call failures, API errors)
 */
interface CopilotSessionErrorEvent extends CopilotBaseEvent {
  type: "session.error";
  data: {
    errorType: "model_call" | string;
    message: string;
    stack?: string;
  };
  parentId: string;
}

/**
 * User message event (prompt with optional file attachments)
 */
interface CopilotUserMessageEvent extends CopilotBaseEvent {
  type: "user.message";
  data: {
    content: string;
    transformedContent: string;
    attachments: Array<{
      type: "file";
      path: string;
      displayName: string;
      mentionIndex: number;
    }>;
  };
  parentId: string;
}

/**
 * Assistant turn start event (marks beginning of response turn)
 */
interface CopilotAssistantTurnStartEvent extends CopilotBaseEvent {
  type: "assistant.turn_start";
  data: {
    turnId: string; // Sequential: "0", "1", "2", ...
  };
  parentId: string;
}

/**
 * Assistant message event (response content and/or tool requests)
 */
interface CopilotAssistantMessageEvent extends CopilotBaseEvent {
  type: "assistant.message";
  data: {
    messageId: string;
    content: string;
    toolRequests?: Array<{
      toolCallId: string;
      name: string;
      arguments: Record<string, unknown>;
    }>;
  };
  parentId: string;
}

/**
 * Assistant reasoning event (extended chain-of-thought)
 */
interface CopilotAssistantReasoningEvent extends CopilotBaseEvent {
  type: "assistant.reasoning";
  data: {
    reasoningId: string;
    content: string; // Markdown-formatted reasoning
  };
  parentId: string;
}

/**
 * Tool execution start event (pairs with tool.execution_complete)
 */
interface CopilotToolExecutionStartEvent extends CopilotBaseEvent {
  type: "tool.execution_start";
  data: {
    toolCallId: string;
    toolName: string;
    arguments: Record<string, unknown>;
  };
  parentId: string;
}

/**
 * Tool execution complete event (result of tool call)
 */
interface CopilotToolExecutionCompleteEvent extends CopilotBaseEvent {
  type: "tool.execution_complete";
  data: {
    toolCallId: string;
    success: boolean;
    result: {
      content: string;
      detailedContent?: string; // Unified diff for file edits
    };
    toolTelemetry: {
      properties?: Record<string, string>;
      metrics?: {
        resultLength?: number;
        resultForLlmLength?: number;
        responseTokenLimit?: number;
        linesAdded?: number; // Lines added in edit operations
        linesRemoved?: number; // Lines removed in edit operations
      };
      restrictedProperties?: Record<string, unknown>;
    };
  };
  parentId: string;
}

/**
 * Assistant turn end event (marks end of response turn)
 */
interface CopilotAssistantTurnEndEvent extends CopilotBaseEvent {
  type: "assistant.turn_end";
  data: {
    turnId: string;
  };
  parentId: string;
}

/**
 * Union type of all Copilot log event types
 */
type CopilotLogEvent =
  | CopilotSessionStartEvent
  | CopilotSessionInfoEvent
  | CopilotSessionErrorEvent
  | CopilotUserMessageEvent
  | CopilotAssistantTurnStartEvent
  | CopilotAssistantMessageEvent
  | CopilotAssistantReasoningEvent
  | CopilotToolExecutionStartEvent
  | CopilotToolExecutionCompleteEvent
  | CopilotAssistantTurnEndEvent;

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
  extractResponse(events: any[]): UniversalCliOutput {
    const outputEvents: CliEvent[] = [];
    let sessionId: string | undefined;
    let model: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;

    // Track pending tool calls to associate execution_start with execution_complete
    const pendingTools = new Map<
      string,
      { toolName: string; args: Record<string, unknown>; timestamp: number }
    >();

    for (const event of events) {
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

        // Note: tool calls are extracted from tool.execution_start (not toolRequests)
        // because tool.execution_start provides more accurate timestamps and allows
        // us to add structuredPatch from tool.execution_complete
      }

      // Extract thinking/reasoning blocks
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
        const toolEvent = this.mapToolToSemanticEvent(
          event.data.toolName,
          event.data.arguments || {},
          event.data.toolCallId,
          timestamp
        );
        outputEvents.push(toolEvent);
      }

      // Emit COMPLETED events for bash commands and file operations from tool.execution_complete
      if (event.type === "tool.execution_complete" && event.data) {
        const pendingTool = pendingTools.get(event.data.toolCallId);
        const success = event.data.success;
        const result = event.data.result?.content || "";

        if (pendingTool) {
          const lowerName = pendingTool.toolName.toLowerCase();

          // BASH COMMAND - Emit COMPLETED event with output/error
          if (
            lowerName === "powershell" ||
            lowerName === "bash" ||
            lowerName === "shell"
          ) {
            outputEvents.push({
              type: CLI_EVENT_TYPES.BASH_COMMAND,
              timestamp,
              data: {
                command:
                  (pendingTool.args.command as string) ||
                  (pendingTool.args.script as string) ||
                  "",
                workingDir: pendingTool.args.cwd as string | undefined,
                exitCode: success ? 0 : 1,
                output: success ? result : undefined,
                error: success ? undefined : result,
                status: success
                  ? OPERATION_STATUS.COMPLETED
                  : OPERATION_STATUS.FAILED,
              } as BashCommandData,
            });
            pendingTools.delete(event.data.toolCallId);
          }
          // FILE_READ - Emit COMPLETED event with content
          else if (
            lowerName === "view" ||
            lowerName === "read" ||
            lowerName === "read_file"
          ) {
            outputEvents.push({
              type: CLI_EVENT_TYPES.FILE_READ,
              timestamp,
              data: {
                path:
                  (pendingTool.args.path as string) ||
                  (pendingTool.args.file_path as string) ||
                  "",
                content: success ? result : undefined,
                status: success
                  ? OPERATION_STATUS.COMPLETED
                  : OPERATION_STATUS.FAILED,
                success,
              } as FileReadData,
            });
            pendingTools.delete(event.data.toolCallId);
          }
          // FILE_WRITE - Emit COMPLETED event
          else if (
            lowerName === "write" ||
            lowerName === "create_file" ||
            lowerName === "write_file"
          ) {
            outputEvents.push({
              type: CLI_EVENT_TYPES.FILE_WRITE,
              timestamp,
              data: {
                path:
                  (pendingTool.args.path as string) ||
                  (pendingTool.args.file_path as string) ||
                  "",
                content: (pendingTool.args.content as string) || "",
                status: success
                  ? OPERATION_STATUS.COMPLETED
                  : OPERATION_STATUS.FAILED,
                success,
              } as FileWriteData,
            });
            pendingTools.delete(event.data.toolCallId);
          }
          // FILE_EDIT - Emit COMPLETED event with diff data
          else if (
            lowerName === "edit" ||
            lowerName === "modify_file" ||
            lowerName === "replace_string_in_file" ||
            lowerName === "multiedit"
          ) {
            // Parse unified diff to get structured patch with line numbers
            const structuredPatch = event.data.result?.detailedContent
              ? this.parseUnifiedDiff(event.data.result.detailedContent)
              : undefined;

            // Debug: Log parsing results
            Log.debug(
              `[CopilotLogParser] Parsed structuredPatch:`,
              structuredPatch
                ? `${structuredPatch.length} hunks`
                : "undefined (parsing failed)"
            );

            // Emit FILE_EDIT COMPLETED event with full data (oldContent/newContent + structuredPatch)
            outputEvents.push({
              type: CLI_EVENT_TYPES.FILE_EDIT,
              timestamp,
              data: {
                path:
                  (pendingTool.args.path as string) ||
                  (pendingTool.args.file_path as string) ||
                  "",
                // Include old/new content as fallback if structuredPatch fails to parse
                oldContent: (pendingTool.args.old_str ||
                  pendingTool.args.old_string) as string | undefined,
                newContent: (pendingTool.args.new_str ||
                  pendingTool.args.new_string) as string | undefined,
                structuredPatch,
                status: success
                  ? OPERATION_STATUS.COMPLETED
                  : OPERATION_STATUS.FAILED,
                success,
              } as FileEditData,
            });
            pendingTools.delete(event.data.toolCallId);
          }
        }

        // Always emit TOOL_RESULT
        outputEvents.push({
          type: CLI_EVENT_TYPES.TOOL_RESULT,
          timestamp,
          data: {
            toolCallId: event.data.toolCallId,
            result: {
              success: event.data.success,
              output: event.data.result?.content,
              error: event.data.success
                ? undefined
                : event.data.result?.content,
            },
          } as ToolResultData,
        });
      }

      // Extract token usage from metadata (if available)
      if (event.data?.metadata?.usage) {
        const usage = event.data.metadata.usage;
        inputTokens += usage.input_tokens || usage.inputTokens || 0;
        outputTokens += usage.output_tokens || usage.outputTokens || 0;
      }
    }

    return {
      events: outputEvents,
      metadata: {
        sessionId,
        model,
        harness: "copilot-cli",
        usage:
          inputTokens > 0 || outputTokens > 0
            ? {
                inputTokens,
                outputTokens,
                totalTokens: inputTokens + outputTokens,
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
  isComplete(_event: any): boolean {
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

        // Session ID provided but file not found - this is unexpected for resumed sessions
        Log.warn(
          `[CopilotLogParser] Session ${sessionId} not found in either format. Tried:\n` +
            `  - ${eventsPath}\n` +
            `  - ${flatPath}`
        );
        return null;
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
              const events = await this.readFirstEvents(logPath, 10);

              // Look for user.message event containing prompt text
              for (const event of events) {
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
   * Used during real-time log monitoring to extract displayable content
   * as events are written to the log file.
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
  extractContentFromEvent(event: any): string | undefined {
    // Assistant message content (primary response text)
    if (event.type === "assistant.message" && event.data?.content) {
      return event.data.content;
    }

    // Assistant reasoning content (prefixed for visibility)
    if (event.type === "assistant.reasoning" && event.data?.content) {
      return `[Reasoning] ${event.data.content}`;
    }

    // Tool execution result content
    if (
      event.type === "tool.execution_complete" &&
      event.data?.result?.content
    ) {
      return event.data.result.content;
    }

    // Session error content
    if (event.type === "session.error" && event.data) {
      const errorCode = event.data.errorType || "UNKNOWN";
      const errorMessage = event.data.message || "Unknown error";
      return `Error [${errorCode}]: ${errorMessage}`;
    }

    return undefined;
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
  formatStatistics(metadata: {
    sessionId?: string;
    model?: string;
    usage?: { inputTokens?: number; outputTokens?: number };
  }): string {
    const parts: string[] = [];

    // Session ID (truncated with ellipsis for readability)
    if (metadata.sessionId) {
      parts.push(`Session: ${metadata.sessionId.substring(0, 8)}...`);
    }

    // Model name
    if (metadata.model) {
      parts.push(`Model: ${metadata.model}`);
    }

    // Token usage (if available - Copilot doesn't typically provide this in logs)
    if (metadata.usage) {
      const usage = metadata.usage;
      if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
        parts.push(
          `Tokens: ${usage.inputTokens} in / ${usage.outputTokens} out`
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

  /**
   * Map Copilot tool name to semantic event type
   *
   * Converts Copilot-specific tool names to provider-agnostic semantic events.
   *
   * **Tool Name Mapping:**
   * - Shell commands: `powershell`, `bash`, `shell` → BASH_COMMAND
   * - File operations:
   *   - `view`, `read` → FILE_READ
   *   - `write`, `create_file` → FILE_WRITE
   *   - `edit`, `modify_file`, `replace_string_in_file` → FILE_EDIT
   *   - `delete`, `delete_file` → FILE_DELETE
   * - MCP tools: Any tool with server prefix (e.g., `github(...)`) → MCP_TOOL_CALL
   * - Web search: `web_search`, `search` → WEB_SEARCH
   * - Unknown tools: Fallback to generic TOOL_CALL
   *
   * @param toolName - Copilot tool name
   * @param args - Tool arguments from Copilot
   * @param toolCallId - Unique tool call ID
   * @param timestamp - Event timestamp
   * @returns CliEvent with semantic type and properly structured data
   */
  private mapToolToSemanticEvent(
    toolName: string,
    args: Record<string, unknown>,
    toolCallId: string,
    timestamp: number
  ): CliEvent {
    const lowerName = toolName.toLowerCase();

    // Bash/shell commands
    if (
      lowerName === "powershell" ||
      lowerName === "bash" ||
      lowerName === "shell"
    ) {
      return {
        type: CLI_EVENT_TYPES.BASH_COMMAND,
        timestamp,
        data: {
          command: (args.command as string) || (args.script as string) || "",
          workingDir: args.cwd as string | undefined,
          status: OPERATION_STATUS.INITIATED,
        } as BashCommandData,
      };
    }

    // File read operations
    if (
      lowerName === "view" ||
      lowerName === "read" ||
      lowerName === "read_file"
    ) {
      return {
        type: CLI_EVENT_TYPES.FILE_READ,
        timestamp,
        data: {
          path: (args.path as string) || (args.file_path as string) || "",
          status: OPERATION_STATUS.INITIATED,
        } as FileReadData,
      };
    }

    // File write operations (create new file)
    if (
      lowerName === "write" ||
      lowerName === "create_file" ||
      lowerName === "write_file"
    ) {
      return {
        type: CLI_EVENT_TYPES.FILE_WRITE,
        timestamp,
        data: {
          path: (args.path as string) || (args.file_path as string) || "",
          content: (args.content as string) || "",
          status: OPERATION_STATUS.INITIATED,
        } as FileWriteData,
      };
    }

    // File edit operations (modify existing file)
    if (
      lowerName === "edit" ||
      lowerName === "modify_file" ||
      lowerName === "replace_string_in_file" ||
      lowerName === "multiedit"
    ) {
      return {
        type: CLI_EVENT_TYPES.FILE_EDIT,
        timestamp,
        data: {
          path: (args.path as string) || (args.file_path as string) || "",
          status: OPERATION_STATUS.INITIATED,
          // Don't include oldContent/newContent here - they'll be added via structuredPatch
          // from tool.execution_complete (prevents client-side diff generation with wrong line numbers)
        } as FileEditData,
      };
    }

    // File delete operations
    if (lowerName === "delete" || lowerName === "delete_file") {
      return {
        type: CLI_EVENT_TYPES.FILE_DELETE,
        timestamp,
        data: {
          path: (args.path as string) || (args.file_path as string) || "",
        } as FileDeleteData,
      };
    }

    // MCP tool calls (format: "server_name(tool_name)" or just MCP server tools)
    if (toolName.includes("(") && toolName.includes(")")) {
      // Format: "github(search_repositories)"
      const match = toolName.match(/^([^(]+)\(([^)]+)\)$/);
      if (match) {
        return {
          type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
          timestamp,
          data: {
            server: match[1],
            tool: match[2],
            parameters: args,
          } as McpToolCallData,
        };
      }
    }

    // Web search operations
    if (lowerName === "web_search" || lowerName === "search") {
      return {
        type: CLI_EVENT_TYPES.WEB_SEARCH,
        timestamp,
        data: {
          query: (args.query as string) || "",
        } as WebSearchData,
      };
    }

    // Fallback: Generic tool call for unknown tools
    return {
      type: CLI_EVENT_TYPES.TOOL_CALL,
      timestamp,
      data: {
        name: toolName,
        parameters: args,
        id: toolCallId,
      } as ToolCall,
    };
  }

  /**
   * Parse unified diff format into structured patch hunks
   *
   * Extracts line numbers and diff lines from Git-style unified diff format.
   *
   * @param diffText - Unified diff string (from tool.execution_complete detailedContent)
   * @returns Array of diff hunks with line numbers, or undefined if parsing fails
   *
   * @example
   * ```typescript
   * const diff = `
   * diff --git a/file.md b/file.md
   * @@ -1,4 +1,4 @@
   *  First line
   * -Second line
   * +Second line - edited
   *  Third line
   * `;
   * const hunks = parser.parseUnifiedDiff(diff);
   * // [{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, lines: [...] }]
   * ```
   *
   * @remarks
   * **Unified Diff Format:**
   * - `@@ -oldStart,oldCount +newStart,newCount @@` - Hunk header with line numbers
   * - Lines prefixed with " " (space) - Context (unchanged)
   * - Lines prefixed with "-" - Removed from old file
   * - Lines prefixed with "+" - Added to new file
   *
   * **Output Format:** Matches Claude CLI's structuredPatch format for compatibility
   */
  private parseUnifiedDiff(diffText: string): UnifiedDiffHunk[] | undefined {
    if (!diffText) {
      return undefined;
    }

    const hunks: UnifiedDiffHunk[] = [];
    const lines = diffText.split("\n");
    let currentHunk: UnifiedDiffHunk | null = null;

    for (const line of lines) {
      // Match hunk header: @@ -1,4 +1,4 @@
      const hunkMatch = line.match(
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
      );
      if (hunkMatch) {
        // Save previous hunk if exists
        if (currentHunk) {
          hunks.push(currentHunk);
        }

        // Parse line numbers from header
        const oldStart = parseInt(hunkMatch[1], 10);
        const oldLines = hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1;
        const newStart = parseInt(hunkMatch[3], 10);
        const newLines = hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1;

        currentHunk = {
          oldStart,
          oldLines,
          newStart,
          newLines,
          lines: [],
        };
        continue;
      }

      // Collect diff lines (must be inside a hunk)
      if (currentHunk) {
        // Only include lines with diff prefixes: " " (context), "-" (removed), "+" (added)
        if (
          line.startsWith(" ") ||
          line.startsWith("-") ||
          line.startsWith("+")
        ) {
          currentHunk.lines.push(line);
        }
        // Stop collecting if we hit a non-diff line (e.g., "diff --git")
        else if (line.startsWith("diff ") || line.startsWith("index ")) {
          // Save current hunk and reset
          if (currentHunk.lines.length > 0) {
            hunks.push(currentHunk);
          }
          currentHunk = null;
        }
      }
    }

    // Save last hunk
    if (currentHunk && currentHunk.lines.length > 0) {
      hunks.push(currentHunk);
    }

    return hunks.length > 0 ? hunks : undefined;
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
