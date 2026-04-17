import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { BaseLogParser } from "../shared/BaseLogParser";
import { BaseCliEvent } from "../shared/interfaces/ILogParser";
import { Log } from "../../../utils/Log";
import { retryWithBackoff } from "../../../utils/RetryUtils";
import { CodexToolBuilder } from "./CodexToolBuilder";
import {
  UniversalCliOutput,
  ThinkingBlock,
  CliEvent,
  TextData,
  ToolResultData,
} from "../../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  HARNESS_IDS,
} from "../../../types/DashboardConstants";
import { CODEX_CLI_CONTEXT_WINDOW_SIZE } from "../../../utils/ModelConstants";

// ============================================================================
// Codex Log Event Payload Types
// ============================================================================

/**
 * Token usage data extracted from a Codex session log file.
 * Returned by CodexLogParser.extractTokenUsageFromLogFile() and consumed
 * by CodexCliProvider.augmentParsedOutput() to supply accurate per-session
 * context window data (headless mode only shows cumulative totals via stdout).
 */
export interface CodexLogTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  /** Tokens used in the last turn's context window (undefined if not reported) */
  contextWindowUsedTokens?: number;
  /** Model context window size */
  contextWindowSize?: number;
}

/**
 * Session metadata (session_meta event)
 */
interface CodexSessionMetaPayload {
  id: string;
  timestamp: string;
  cwd: string;
  originator: string;
  cli_version: string;
  instructions: string;
  source: string;
  model_harness: string;
  model?: string;
  git?: {
    commit_hash: string;
    branch: string;
    repository_url: string;
  };
}

/**
 * Codex CLI log parser
 *
 * Parses Codex CLI session logs to extract responses, session IDs, and
 * detect completion. Handles nested payload structure and date-based
 * directory hierarchy with recursive search.
 *
 * @remarks
 * **Log Location:** `~/.codex/sessions/` (searched recursively)
 *
 * **File Naming:** `rollout-<timestamp>-<session-id>.jsonl`
 *
 * **Directory Structure:**
 * - Date-based hierarchy (YYYY/MM/DD) created by Codex as needed
 * - No index file (unlike Copilot)
 * - Multiple sessions per day in same directory
 * - Recursive search handles missing date directories gracefully
 *
 * **Event Structure (Nested Payloads):**
 * ```json
 * {
 *   "type": "response_item" | "event_msg" | "session_meta" | "turn_context",
 *   "payload": {
 *     "type": "message" | "turn.completed" | "function_call",
 *     "role": "assistant",
 *     "content": [{ "type": "output_text", "text": "Response..." }]
 *   },
 *   "timestamp": "ISO8601"
 * }
 * ```
 *
 * **Event Types:**
 * - `session_meta` - Session initialization (contains session ID)
 * - `response_item` - Assistant response chunks (nested payload)
 * - `turn_context` - User message context
 * - `event_msg` - Control events (completion, errors)
 *
 * **Completion Signal:** `{"type": "event_msg", "payload": {"type": "turn.completed"}}`
 *
 * **Session Discovery:**
 * - Fast path: Direct session ID lookup (recursive search)
 * - Fallback: Prompt text matching across all recent log files
 * - Robust: Works even when date directory doesn't exist yet (first session of the day)
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

/**
 * Provider-specific event type for internal loop bodies.
 *
 * Extends BaseCliEvent with a typed `payload` property for Codex's nested event structure.
 * This avoids `as any[]` casts while preserving flexible access to provider-specific data fields.
 * Top-level fields (`type`, `timestamp`) remain properly typed from BaseCliEvent.
 */
interface CodexProviderEvent extends BaseCliEvent {
  payload?: Record<string, any>;
}

export class CodexLogParser extends BaseLogParser {
  /**
   * Session metadata cache
   *
   * Stores session_meta event data for later reference.
   * Used to extract session ID and model information.
   */
  private sessionMeta: CodexSessionMetaPayload | null = null;

  /**
   * Tool call tracking map
   *
   * Maps call_id to tool metadata for correlating INITIATED and COMPLETED events.
   * Key: call_id, Value: tool metadata plus the initiated event so completion
   * events can preserve path and diff data that Codex omits from tool output.
   */
  private toolCallMap: Map<
    string,
    { type: string; toolName: string; initiatedEvent?: CliEvent }
  > = new Map();

  /**
   * Streaming-path tool call tracking map
   *
   * Parallel to toolCallMap but exclusively used by extractStructuredEventsFromEvent
   * so that streaming state never contaminates extractResponse()'s toolCallMap.
   */
  private pendingStreamingCalls: Map<
    string,
    { type: string; toolName: string; initiatedEvent?: CliEvent }
  > = new Map();

  /**
   * Extract complete response from Codex log events
   *
   * Combines multiple response_item events with nested payloads into a single
   * response object. Extracts tool calls, thinking blocks, and metadata.
   *
   * @param events - Array of parsed Codex log events
   * @returns UniversalCliOutput - Standardized response object
   *
   * @remarks
   * **Response Assembly:**
   * - Processes response_item events with role="assistant"
   * - Extracts text from nested payload.content[].text fields
   * - Identifies tool calls from payload.content[].tool_use items or function_call payloads
   * - Normalizes tool call parameters (input/arguments → parameters)
   * - Captures thinking blocks from content[{type: "thinking"}]
   * - Retrieves session ID from session_meta event
   *
   * **Payload Structure:**
   * ```json
   * {
   *   "type": "response_item",
   *   "payload": {
   *     "role": "assistant",
   *     "content": [
   *       { "type": "output_text", "text": "Response..." },
   *       { "type": "tool_use", "name": "write_file", "input": {...} }
   *     ]
   *   }
   * }
   * ```
   */
  extractResponse(events: BaseCliEvent[]): UniversalCliOutput {
    // Reset per-invocation state to prevent cross-run contamination
    // Note: sessionMeta is intentionally NOT reset — it caches session ID
    // across multiple extractResponse calls for the same session
    this.toolCallMap.clear();

    const outputEvents: CliEvent[] = [];
    let sessionId: string | undefined;
    let model: string | undefined;
    let cliVersion: string | undefined;

    // Token statistics tracking
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let cachedInputTokens = 0;
    let reasoningOutputTokens = 0;
    // Per-turn (last) usage — used for context window (not cumulative billing total)
    let lastTurnContextWindowUsed: number | undefined;
    let modelContextWindow: number | undefined;

    for (const event of events as CodexProviderEvent[]) {
      const timestamp = event.timestamp
        ? new Date(event.timestamp).getTime()
        : Date.now();

      // Track session metadata (session_meta)
      if (event.type === "session_meta" && event.payload) {
        this.sessionMeta = event.payload as CodexSessionMetaPayload;
        sessionId = event.payload.id;
        model = event.payload.model;
        cliVersion = event.payload.cli_version;
      }

      // Extract model from turn_context (if not already set)
      if (event.type === "turn_context" && event.payload?.model) {
        if (!model) {
          model = event.payload.model;
        }
      }

      // event_msg:agent_message - Complete agent response text
      if (
        event.type === "event_msg" &&
        event.payload?.type === "agent_message"
      ) {
        outputEvents.push({
          type: CLI_EVENT_TYPES.TEXT,
          timestamp,
          data: {
            text: event.payload.message,
          } as TextData,
        });
      }

      // event_msg:token_count - Token usage statistics
      if (event.type === "event_msg" && event.payload?.type === "token_count") {
        const info = event.payload.info;
        if (info?.total_token_usage) {
          // Cumulative billing totals (used for inputTokens/outputTokens)
          const total = info.total_token_usage;
          totalInputTokens = total.input_tokens || 0;
          totalOutputTokens = total.output_tokens || 0;
          cachedInputTokens = total.cached_input_tokens || 0;
          reasoningOutputTokens = total.reasoning_output_tokens || 0;
        }
        if (info?.last_token_usage) {
          // Per-turn usage — Codex reports cached tokens as a subset of input,
          // so use total_tokens rather than adding cached input again.
          const last = info.last_token_usage;
          lastTurnContextWindowUsed =
            typeof last.total_tokens === "number"
              ? last.total_tokens
              : (last.input_tokens || 0) + (last.output_tokens || 0);
        }
        if (info?.model_context_window) {
          modelContextWindow = info.model_context_window;
        }
      }

      // response_item with role="assistant" - Assistant content
      if (
        event.type === "response_item" &&
        event.payload?.role === "assistant"
      ) {
        const content = event.payload.content;
        if (Array.isArray(content)) {
          // Process content items in order they appear
          for (const item of content) {
            // Text content
            if (
              (item.type === "input_text" || item.type === "output_text") &&
              item.text
            ) {
              outputEvents.push({
                type: CLI_EVENT_TYPES.TEXT,
                timestamp,
                data: {
                  text: item.text,
                } as TextData,
              });
            }

            // Tool calls - map to semantic event types based on tool name
            if (item.type === "tool_use") {
              const toolName = item.name?.toLowerCase() || "";
              const params = (item.input || {}) as Record<string, unknown>;
              const callId = item.id as string | undefined;
              const event = CodexToolBuilder.buildLogToolInitiatedEvent(
                toolName,
                params,
                callId,
                timestamp
              );
              if (
                callId &&
                CodexToolBuilder.needsCompletionTracking(event.type)
              ) {
                this.toolCallMap.set(callId, {
                  type: event.type,
                  toolName,
                  initiatedEvent: event,
                });
              }
              outputEvents.push(event);
            }

            // Thinking blocks
            if (item.type === "thinking" && item.text) {
              outputEvents.push({
                type: CLI_EVENT_TYPES.THINKING,
                timestamp,
                data: {
                  text: item.text,
                  label: "Thinking",
                } as ThinkingBlock,
              });
            }
          }
        }
      }

      // response_item:reasoning - AI reasoning process (may be encrypted)
      if (
        event.type === "response_item" &&
        event.payload?.type === "reasoning"
      ) {
        const reasoningText =
          event.payload.content ||
          (event.payload.encrypted_content ? "[Encrypted reasoning]" : null);
        if (reasoningText) {
          outputEvents.push({
            type: CLI_EVENT_TYPES.THINKING,
            timestamp,
            data: {
              text: reasoningText,
              label: "Reasoning",
            } as ThinkingBlock,
          });
        }
      }

      // response_item:function_call - Function call request
      if (
        event.type === "response_item" &&
        event.payload?.type === "function_call"
      ) {
        let params: Record<string, unknown> =
          event.payload.arguments || event.payload.input || {};
        // Arguments may be a JSON string!
        if (typeof params === "string") {
          try {
            params = JSON.parse(params);
          } catch {
            params = { raw: params };
          }
        }

        const functionName = event.payload.name?.toLowerCase() || "";
        const callId = (event.payload.call_id ?? event.payload.id) as
          | string
          | undefined;
        const event2 = CodexToolBuilder.buildLogToolInitiatedEvent(
          functionName,
          params,
          callId,
          timestamp
        );
        if (callId && CodexToolBuilder.needsCompletionTracking(event2.type)) {
          this.toolCallMap.set(callId, {
            type: event2.type,
            toolName: functionName,
            initiatedEvent: event2,
          });
        }
        outputEvents.push(event2);
      }

      // response_item:function_call_output - Function result (COMPLETED event)
      if (
        event.type === "response_item" &&
        event.payload?.type === "function_call_output"
      ) {
        const callId = event.payload.call_id as string | undefined;
        const toolInfo = callId ? this.toolCallMap.get(callId) : undefined;
        const isBash = toolInfo?.type === CLI_EVENT_TYPES.BASH_COMMAND;
        outputEvents.push(
          CodexToolBuilder.buildFunctionCallOutputCompletedEvent(
            isBash,
            event.payload.output || "",
            callId,
            timestamp
          )
        );
        if (callId) {
          this.toolCallMap.delete(callId);
        }
      }

      // response_item:custom_tool_call - Custom tool call request
      if (
        event.type === "response_item" &&
        event.payload?.type === "custom_tool_call"
      ) {
        const toolName = event.payload.name?.toLowerCase() || "";
        const input = event.payload.input;
        let params: Record<string, unknown> =
          typeof input === "string"
            ? { input }
            : (input as Record<string, unknown>) || {};

        // Parse JSON input if it's a string
        if (typeof input === "string") {
          try {
            params = JSON.parse(input) as Record<string, unknown>;
          } catch {
            params = { input };
          }
        }

        const callId = event.payload.call_id as string | undefined;
        const event3 = CodexToolBuilder.buildLogToolInitiatedEvent(
          toolName,
          params,
          callId,
          timestamp
        );
        if (callId && CodexToolBuilder.needsCompletionTracking(event3.type)) {
          this.toolCallMap.set(callId, {
            type: event3.type,
            toolName,
            initiatedEvent: event3,
          });
        }
        outputEvents.push(event3);
      }

      // response_item:custom_tool_call_output - Custom tool result (COMPLETED event)
      if (
        event.type === "response_item" &&
        event.payload?.type === "custom_tool_call_output"
      ) {
        const callId = event.payload.call_id as string | undefined;
        const toolInfo = callId ? this.toolCallMap.get(callId) : undefined;

        // Parse JSON output to extract metadata
        let parsedOutput: Record<string, any> = {};
        let outputText: string = event.payload.output as string;
        try {
          parsedOutput = JSON.parse(event.payload.output as string) as Record<
            string,
            any
          >;
          outputText =
            (parsedOutput.output as string) || (event.payload.output as string);
        } catch {
          // Use raw output if not JSON
        }

        const exitCode = parsedOutput.metadata?.exit_code as number | undefined;
        const success = exitCode === 0 || exitCode === undefined;

        if (toolInfo) {
          outputEvents.push(
            CodexToolBuilder.buildCustomToolCallCompletedEvent(
              toolInfo,
              exitCode,
              success,
              outputText,
              callId,
              timestamp,
              toolInfo.initiatedEvent
            )
          );
          this.toolCallMap.delete(callId!);
        } else {
          // No tracking info — emit generic TOOL_RESULT
          outputEvents.push({
            type: CLI_EVENT_TYPES.TOOL_RESULT,
            timestamp,
            data: {
              toolCallId: callId,
              result: { success, output: outputText },
            } as ToolResultData,
          });
        }
      }
    }

    // Fallback to cached session meta if not found in current events
    if (!sessionId && this.sessionMeta) {
      sessionId = this.sessionMeta.id;
      model = this.sessionMeta.model;
      cliVersion = this.sessionMeta.cli_version;
    }

    // Fallback: if model_context_window wasn't in the token_count event, use known size
    if (modelContextWindow === undefined) {
      modelContextWindow = CODEX_CLI_CONTEXT_WINDOW_SIZE;
    }

    // Build token usage object if we have any token data
    const metadata: Record<string, any> = {
      sessionId,
      model,
      cliVersion,
      harness: HARNESS_IDS.CODEX_CLI,
    };

    if (totalInputTokens > 0 || totalOutputTokens > 0) {
      metadata.usage = {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        cachedInputTokens,
        reasoningOutputTokens,
        contextWindowUsedTokens: lastTurnContextWindowUsed,
        contextWindowSize: modelContextWindow,
      };
    }

    return {
      events: outputEvents,
      metadata,
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
  isComplete(event: BaseCliEvent): boolean {
    // Check for nested payload type (standard format)
    const payload = (event as CodexProviderEvent).payload;
    if (event.type === "event_msg" && payload?.type === "turn.completed") {
      return true;
    }
    // Alternate format check (payload.type at top level)
    if (payload?.type === "turn.completed") {
      return true;
    }
    return false;
  }

  override extractLiveContextWindow(
    event: BaseCliEvent
  ): { used: number; size: number } | null {
    const e = event as any;
    if (e.type === "event_msg" && e.payload?.type === "token_count") {
      const last = e.payload.info?.last_token_usage;
      if (!last) return null;
      const used =
        typeof last.total_tokens === "number"
          ? last.total_tokens
          : (last.input_tokens ?? 0) + (last.output_tokens ?? 0);
      const size =
        e.payload.info?.model_context_window ?? CODEX_CLI_CONTEXT_WINDOW_SIZE;
      return used > 0 && size ? { used, size } : null;
    }
    return null;
  }

  /**
   * Discover session log file for a prompt
   *
   * Searches `~/.codex/sessions/` recursively for the log file corresponding
   * to a specific prompt execution. Uses session ID (if provided) or prompt text matching.
   *
   * @param promptText - The prompt text sent to Codex CLI (not used when sessionId provided)
   * @param startTime - Execution start timestamp
   * @param sessionId - Optional session ID for direct file matching (bypasses prompt matching)
   * @returns Absolute path to session log file, or null if not found
   *
   * @remarks
   * **Discovery Algorithm:**
   * 1. If sessionId provided: Search recursively for file matching `rollout-*-{sessionId}.jsonl`
   * 2. Otherwise: Find all `rollout-*.jsonl` files recursively, modified after startTime
   * 3. Sort by modification time (newest first)
   * 4. Read first 10 events from each candidate
   * 5. Look for user message in response_items or event_msg
   * 6. Return first matching log file path
   *
   * **Directory Structure:**
   * - Base: `~/.codex/sessions/`
   * - Date hierarchy: `YYYY/MM/DD/` (created as needed by Codex)
   * - Recursive search handles missing date directories gracefully
   *
   * **Prompt Matching:**
   * - Uses first 100 chars of prompt for fuzzy matching
   * - Case-insensitive substring match
   * - Searches in turn_context and response_item events
   *
   * **File Naming:** `rollout-<timestamp>-<session-id>.jsonl`
   *
   * **Robustness:**
   * - No longer requires date directory to exist (handles first session of the day)
   * - Works with session resume (searches all dates, not just today)
   * - Retry logic handles async file creation
   */
  async discoverSessionLog(
    promptText: string,
    startTime: Date,
    sessionId?: string
  ): Promise<string | null> {
    try {
      const basePath = path.join(os.homedir(), ".codex", "sessions");

      // FAST PATH: If session ID provided, search for matching file recursively
      if (sessionId) {
        Log.debug(
          `[CodexLogParser] Using session ID ${sessionId} to find log file in ${basePath}`
        );

        // Retry with backoff: Codex writes log file asynchronously after session start
        // When resuming, the file may exist but not be updated yet
        const result = await retryWithBackoff(
          async () => {
            // Search recursively for rollout-*-<sessionId>.jsonl in base sessions directory
            const matchingFile = this.findSessionFileRecursive(
              basePath,
              sessionId
            );

            if (matchingFile) {
              const stats = fs.statSync(matchingFile);

              // Verify file is recent (handles resume case where file exists but isn't updated yet)
              if (stats.mtime >= startTime) {
                return matchingFile; // Success - file exists and is recent
              } else {
                Log.debug(
                  `[CodexLogParser] Session log exists but not yet updated (mtime: ${stats.mtime.toISOString()}, startTime: ${startTime.toISOString()}), will retry...`
                );
                return null; // Retry - file will be updated soon
              }
            }

            return null; // File doesn't exist yet, will retry
          },
          {
            // Uses default: 14 attempts, ~10s total (0, 100, 200, 300, 500, 1000ms repeating)
            onRetry: (attempt, max, delay) => {
              if (attempt > 1) {
                Log.debug(
                  `[CodexLogParser] Session log not ready (attempt ${attempt}/${max}), retrying in ${delay}ms...`
                );
              }
            },
          }
        );

        if (result) {
          Log.debug(
            `[CodexLogParser] Found session log via session ID: ${result}`
          );
          return result;
        } else {
          // Session ID provided but file not found - fall back to prompt-text matching
          // This handles: bad session ID from user, logs cleaned up, or format change
          Log.warn(
            `[CodexLogParser] No log file found for session ${sessionId} in ${basePath}. ` +
              `Falling back to prompt-text matching.`
          );
          // Fall through to prompt-text matching below
        }
      }

      // FALLBACK: Find all .jsonl files modified after startTime (search recursively)
      // Retry with backoff: Codex may take a moment to create the log file
      // Normalize for path escaping: Codex may double backslashes in file paths
      const promptPrefix = this.normalizePromptForMatching(
        promptText.slice(0, 100)
      );

      const result = await retryWithBackoff(
        async () => {
          // Get all rollout-*.jsonl files recursively
          const candidates = this.findModifiedRolloutFiles(basePath, startTime);

          if (candidates.length === 0) {
            return null; // No candidates yet, will retry
          }

          // Sort by modification time (newest first)
          candidates.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

          // Check each candidate
          for (const candidate of candidates) {
            try {
              // Read first 10 events
              const events = await this.readFirstNJsonlEvents(
                candidate.path,
                10
              );

              // Look for user message in turn_context or response_item events
              for (const event of events as CodexProviderEvent[]) {
                let userMessage: string | null = null;

                // Check turn_context for user message (if present)
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
                      .filter(
                        (c: any) =>
                          (c.type === "input_text" ||
                            c.type === "output_text") &&
                          c.text
                      )
                      .map((c: any) => c.text)
                      .join("");
                  }
                }

                // Check event_msg for user_message (prompt echo)
                if (
                  event.type === "event_msg" &&
                  event.payload?.type === "user_message" &&
                  event.payload?.message
                ) {
                  userMessage = event.payload.message;
                }

                // Match prompt text
                if (
                  userMessage &&
                  this.normalizePromptForMatching(userMessage).includes(
                    promptPrefix
                  )
                ) {
                  return candidate.path; // Success - found matching log
                }
              }
            } catch (error) {
              Log.debug(
                `[CodexLogParser] Failed to read candidate log: ${error}`
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
                `[CodexLogParser] Session log file not found (attempt ${attempt}/${max}), retrying in ${delay}ms...`
              );
            }
          },
        }
      );

      if (result) {
        Log.debug(`[CodexLogParser] Found matching log: ${result}`);
        return result;
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
   * **Session ID Format:** `thread_abc123xyz789` or UUID
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
  extractSessionId(events: BaseCliEvent[]): string | null {
    for (const event of events as CodexProviderEvent[]) {
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
   * - Nested payload: `{ payload: { type: "input_text" | "output_text", text: "..." } }`
   * - Response items: `{ type: "response_item", payload: { content: [...] } }`
   */
  extractContentFromEvent(event: BaseCliEvent): string | undefined {
    // Provider-specific nested property access
    const e = event as CodexProviderEvent;

    // Direct content field
    if (e.type === "text" && e.content) {
      return e.content as string;
    }

    // Nested payload with text
    if (
      (e.payload?.type === "input_text" || e.payload?.type === "output_text") &&
      e.payload.text
    ) {
      return e.payload.text;
    }

    // response_item with assistant role and content array
    if (
      e.type === "response_item" &&
      e.payload?.role === "assistant" &&
      e.payload?.content
    ) {
      const textParts = e.payload.content
        .filter(
          (c: any) =>
            (c.type === "input_text" || c.type === "output_text") && c.text
        )
        .map((c: any) => c.text);
      return textParts.length > 0 ? textParts.join("") : undefined;
    }

    // response_item with content array (no role check - alternate format variant)
    if (
      e.type === "response_item" &&
      e.payload?.content &&
      Array.isArray(e.payload.content)
    ) {
      const textParts = e.payload.content
        .filter(
          (c: any) =>
            (c.type === "input_text" || c.type === "output_text") && c.text
        )
        .map((c: any) => c.text);
      if (textParts.length > 0) {
        return textParts.join("");
      }
    }

    // event_msg:agent_message - Complete agent response
    if (
      e.type === "event_msg" &&
      e.payload?.type === "agent_message" &&
      e.payload.message
    ) {
      return e.payload.message;
    }

    return undefined;
  }

  /**
   * Extract structured CliEvents from a single Codex log event for streaming
   *
   * Overrides the base class default to emit richer events: tool call initiation
   * and completion pairs, thinking blocks, and text — mirroring extractResponse()
   * event-by-event.  Uses pendingStreamingCalls (not toolCallMap) so this path
   * never interferes with extractResponse().
   *
   * @param event - Single parsed Codex log event
   * @returns Array of CliEvents to emit; empty if event produces no output
   */
  extractStructuredEventsFromEvent(event: BaseCliEvent): CliEvent[] {
    const e = event as CodexProviderEvent;
    const timestamp = e.timestamp
      ? new Date(e.timestamp).getTime()
      : Date.now();
    const results: CliEvent[] = [];

    // event_msg:agent_message → TEXT
    if (e.type === "event_msg" && e.payload?.type === "agent_message") {
      results.push({
        type: CLI_EVENT_TYPES.TEXT,
        timestamp,
        data: { text: e.payload.message } as TextData,
      });
      return results;
    }

    // response_item with role="assistant" content array
    if (e.type === "response_item" && e.payload?.role === "assistant") {
      const content = e.payload.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (
            (item.type === "input_text" || item.type === "output_text") &&
            item.text
          ) {
            results.push({
              type: CLI_EVENT_TYPES.TEXT,
              timestamp,
              data: { text: item.text } as TextData,
            });
          }

          if (item.type === "tool_use") {
            const toolName = item.name?.toLowerCase() || "";
            const params = (item.input || {}) as Record<string, unknown>;
            const callId = item.id as string | undefined;
            const toolEvent = CodexToolBuilder.buildLogToolInitiatedEvent(
              toolName,
              params,
              callId,
              timestamp
            );
            if (
              callId &&
              CodexToolBuilder.needsCompletionTracking(toolEvent.type)
            ) {
              this.pendingStreamingCalls.set(callId, {
                type: toolEvent.type,
                toolName,
                initiatedEvent: toolEvent,
              });
            }
            results.push(toolEvent);
          }

          if (item.type === "thinking" && item.text) {
            results.push({
              type: CLI_EVENT_TYPES.THINKING,
              timestamp,
              data: { text: item.text, label: "Thinking" } as ThinkingBlock,
            });
          }
        }
      }
      return results;
    }

    // response_item:reasoning → THINKING
    if (e.type === "response_item" && e.payload?.type === "reasoning") {
      const reasoningText =
        e.payload.content ||
        (e.payload.encrypted_content ? "[Encrypted reasoning]" : null);
      if (reasoningText) {
        results.push({
          type: CLI_EVENT_TYPES.THINKING,
          timestamp,
          data: { text: reasoningText, label: "Reasoning" } as ThinkingBlock,
        });
      }
      return results;
    }

    // response_item:function_call → INITIATED
    if (e.type === "response_item" && e.payload?.type === "function_call") {
      let params: Record<string, unknown> =
        e.payload.arguments || e.payload.input || {};
      if (typeof params === "string") {
        try {
          params = JSON.parse(params);
        } catch {
          params = { raw: params };
        }
      }
      const functionName = e.payload.name?.toLowerCase() || "";
      const callId = (e.payload.call_id ?? e.payload.id) as string | undefined;
      const toolEvent = CodexToolBuilder.buildLogToolInitiatedEvent(
        functionName,
        params,
        callId,
        timestamp
      );
      if (callId && CodexToolBuilder.needsCompletionTracking(toolEvent.type)) {
        this.pendingStreamingCalls.set(callId, {
          type: toolEvent.type,
          toolName: functionName,
          initiatedEvent: toolEvent,
        });
      }
      results.push(toolEvent);
      return results;
    }

    // response_item:function_call_output → TOOL_RESULT COMPLETED
    if (
      e.type === "response_item" &&
      e.payload?.type === "function_call_output"
    ) {
      const callId = e.payload.call_id as string | undefined;
      const toolInfo = callId
        ? this.pendingStreamingCalls.get(callId)
        : undefined;
      const isBash = toolInfo?.type === CLI_EVENT_TYPES.BASH_COMMAND;
      results.push(
        CodexToolBuilder.buildFunctionCallOutputCompletedEvent(
          isBash,
          e.payload.output || "",
          callId,
          timestamp
        )
      );
      if (callId) {
        this.pendingStreamingCalls.delete(callId);
      }
      return results;
    }

    // response_item:custom_tool_call → INITIATED
    if (e.type === "response_item" && e.payload?.type === "custom_tool_call") {
      const toolName = e.payload.name?.toLowerCase() || "";
      const input = e.payload.input;
      let params: Record<string, unknown> =
        typeof input === "string"
          ? { input }
          : (input as Record<string, unknown>) || {};
      if (typeof input === "string") {
        try {
          params = JSON.parse(input) as Record<string, unknown>;
        } catch {
          params = { input };
        }
      }
      const callId = e.payload.call_id as string | undefined;
      const toolEvent = CodexToolBuilder.buildLogToolInitiatedEvent(
        toolName,
        params,
        callId,
        timestamp
      );
      if (callId && CodexToolBuilder.needsCompletionTracking(toolEvent.type)) {
        this.pendingStreamingCalls.set(callId, {
          type: toolEvent.type,
          toolName,
          initiatedEvent: toolEvent,
        });
      }
      results.push(toolEvent);
      return results;
    }

    // response_item:custom_tool_call_output → TOOL_RESULT COMPLETED
    if (
      e.type === "response_item" &&
      e.payload?.type === "custom_tool_call_output"
    ) {
      const callId = e.payload.call_id as string | undefined;
      const toolInfo = callId
        ? this.pendingStreamingCalls.get(callId)
        : undefined;
      let parsedOutput: Record<string, any> = {};
      let outputText: string = e.payload.output as string;
      try {
        parsedOutput = JSON.parse(e.payload.output as string) as Record<
          string,
          any
        >;
        outputText =
          (parsedOutput.output as string) || (e.payload.output as string);
      } catch {
        // Use raw output if not JSON
      }
      const exitCode = parsedOutput.metadata?.exit_code as number | undefined;
      const success = exitCode === 0 || exitCode === undefined;
      if (toolInfo) {
        results.push(
          CodexToolBuilder.buildCustomToolCallCompletedEvent(
            toolInfo,
            exitCode,
            success,
            outputText,
            callId,
            timestamp,
            toolInfo.initiatedEvent
          )
        );
        this.pendingStreamingCalls.delete(callId!);
      } else {
        results.push({
          type: CLI_EVENT_TYPES.TOOL_RESULT,
          timestamp,
          data: {
            toolCallId: callId,
            result: { success, output: outputText },
          } as ToolResultData,
        });
      }
      return results;
    }

    return results;
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
   *   usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }
   * };
   * const stats = parser.formatStatistics(metadata);
   * // "Session: thread_abc | Model: gpt-5.1-codex | Tokens: 100 in / 50 out"
   * ```
   */
  formatStatistics(metadata: BaseCliEvent): string {
    return this.buildCommonStatisticsParts(metadata, 12).join(" | ");
  }

  /**
   * Find the Codex session log file for the given session ID.
   *
   * Public entry point for external callers (e.g. CodexCliProvider.augmentParsedOutput)
   * that need to locate the log without a start-time constraint. Delegates to the
   * recursive search which scans the full `~/.codex/sessions/` tree.
   *
   * @param sessionId - Session ID (used as filename suffix: `rollout-*-<sessionId>.jsonl`)
   * @returns Absolute path to log file, or null if not found
   */
  findLogFileBySessionId(sessionId: string): string | null {
    const basePath = path.join(os.homedir(), ".codex", "sessions");
    return this.findSessionFileRecursive(basePath, sessionId);
  }

  /**
   * Extract token usage from a Codex session log file.
   *
   * Reads the complete log file and returns token stats from the most recent
   * `event_msg:token_count` event. Intended for use in
   * `CodexCliProvider.augmentParsedOutput()` to supply accurate per-session
   * context window data when running in headless mode — the JSONL stdout only
   * reports cumulative usage totals (see openai/codex#5276), whereas the log
   * file contains per-turn `last_token_usage` which reflects the actual context
   * window consumed by the current session.
   *
   * @param logPath - Absolute path to the Codex session log file
   * @returns Structured token usage, or undefined if no token event found
   */
  static extractTokenUsageFromLogFile(
    logPath: string
  ): CodexLogTokenUsage | undefined {
    try {
      if (!fs.existsSync(logPath)) {
        return undefined;
      }

      const content = fs.readFileSync(logPath, "utf-8");
      const lines = content.split("\n");

      let result: CodexLogTokenUsage | undefined;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        try {
          const event = JSON.parse(trimmed) as CodexProviderEvent;
          if (
            event.type === "event_msg" &&
            event.payload?.type === "token_count"
          ) {
            const info = event.payload.info;
            if (!info) {
              continue;
            }

            let inputTokens = 0;
            let outputTokens = 0;
            let cachedInputTokens = 0;
            let reasoningOutputTokens = 0;
            let contextWindowUsedTokens: number | undefined;

            if (info.total_token_usage) {
              const total = info.total_token_usage;
              inputTokens = total.input_tokens || 0;
              outputTokens = total.output_tokens || 0;
              cachedInputTokens = total.cached_input_tokens || 0;
              reasoningOutputTokens = total.reasoning_output_tokens || 0;
            }

            if (info.last_token_usage) {
              // Codex reports cached tokens as a subset of input, so use
              // total_tokens rather than adding cached input again.
              const last = info.last_token_usage;
              contextWindowUsedTokens =
                typeof last.total_tokens === "number"
                  ? last.total_tokens
                  : (last.input_tokens || 0) + (last.output_tokens || 0);
            }

            // Keep processing — later events overwrite with cumulative totals
            result = {
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
              cachedInputTokens,
              reasoningOutputTokens,
              contextWindowUsedTokens,
              contextWindowSize:
                info.model_context_window ?? CODEX_CLI_CONTEXT_WINDOW_SIZE,
            };
          }
        } catch {
          // Skip invalid JSON lines
        }
      }

      return result;
    } catch (error) {
      Log.debug(
        `[CodexLogParser] Failed to extract token usage from log: ${error}`
      );
      return undefined;
    }
  }

  /**
   * Find session file recursively by session ID
   *
   * Searches base sessions directory recursively for rollout-*-<sessionId>.jsonl file.
   * Handles date-based directory structure (YYYY/MM/DD) without requiring specific date.
   *
   * @param basePath - Base sessions directory (~/.codex/sessions)
   * @param sessionId - Session ID to search for
   * @returns Absolute path to log file, or null if not found
   *
   * @remarks
   * **Search Strategy:**
   * - Recursively traverses all subdirectories
   * - Matches files ending with `-${sessionId}.jsonl`
   * - Returns first match found (should be unique)
   *
   * **Use Case:**
   * Fast path for session resume when we know the session ID.
   * Avoids needing to know or check if date directory exists.
   */
  private findSessionFileRecursive(
    basePath: string,
    sessionId: string
  ): string | null {
    try {
      if (!fs.existsSync(basePath)) {
        return null;
      }

      const searchDir = (dir: string): string | null => {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });

          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
              // Recurse into subdirectories
              const found = searchDir(fullPath);
              if (found) {
                return found;
              }
            } else if (
              entry.isFile() &&
              entry.name.endsWith(`-${sessionId}.jsonl`)
            ) {
              // Found matching file
              return fullPath;
            }
          }

          return null;
        } catch (error) {
          // Skip directories we can't read
          return null;
        }
      };

      return searchDir(basePath);
    } catch (error) {
      Log.debug(`[CodexLogParser] Error searching for session file: ${error}`);
      return null;
    }
  }

  /**
   * Find all rollout-*.jsonl files modified after startTime
   *
   * Recursively searches base sessions directory for recently modified log files.
   *
   * @param basePath - Base sessions directory (~/.codex/sessions)
   * @param startTime - Only include files modified after this time
   * @returns Array of candidate files with paths and modification times
   *
   * @remarks
   * **Search Strategy:**
   * - Recursively traverses all subdirectories
   * - Filters for rollout-*.jsonl files
   * - Checks modification time (with 10s buffer before startTime)
   * - Returns unsorted list (caller sorts by mtime)
   *
   * **Use Case:**
   * Fallback for prompt text matching when no session ID available.
   */
  private findModifiedRolloutFiles(
    basePath: string,
    startTime: Date
  ): Array<{ path: string; mtime: Date }> {
    const candidates: Array<{ path: string; mtime: Date }> = [];

    // Allow 10 second buffer before startTime (CLI may write logs slightly before)
    const bufferTime = new Date(startTime.getTime() - 10000);

    const searchDir = (dir: string): void => {
      try {
        if (!fs.existsSync(dir)) {
          return;
        }

        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            // Recurse into subdirectories
            searchDir(fullPath);
          } else if (
            entry.isFile() &&
            entry.name.startsWith("rollout-") &&
            entry.name.endsWith(".jsonl")
          ) {
            // Check modification time
            try {
              const stats = fs.statSync(fullPath);
              if (stats.mtime >= bufferTime) {
                candidates.push({ path: fullPath, mtime: stats.mtime });
              }
            } catch (error) {
              // Skip files we can't stat
              continue;
            }
          }
        }
      } catch (error) {
        // Skip directories we can't read
        return;
      }
    };

    searchDir(basePath);
    return candidates;
  }
}
