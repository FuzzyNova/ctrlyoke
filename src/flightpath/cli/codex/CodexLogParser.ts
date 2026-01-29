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
  CLI_EVENT_TYPES,
  TokenUsage,
} from "../../../types/CliOutputTypes";

// ============================================================================
// Codex Log Event Payload Types
// ============================================================================

/**
 * Base structure for all Codex log events
 */
interface CodexLogEvent {
  timestamp: string;
  type: "session_meta" | "turn_context" | "event_msg" | "response_item";
  payload: CodexEventPayload;
}

type CodexEventPayload =
  | CodexSessionMetaPayload
  | CodexTurnContextPayload
  | CodexEventMsgPayload
  | CodexResponseItemPayload;

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
  model_provider: string;
  model?: string;
  git?: {
    commit_hash: string;
    branch: string;
    repository_url: string;
  };
}

/**
 * Turn context (turn_context event)
 */
interface CodexTurnContextPayload {
  cwd: string;
  approval_policy: string;
  sandbox_policy: {
    type: string;
    writable_roots: string[];
    network_access: boolean;
    exclude_tmpdir_env_var: boolean;
    exclude_slash_tmp: boolean;
  };
  model: string;
  effort: string;
  summary: string;
  user_instructions: string;
  truncation_policy: {
    mode: string;
    limit: number;
  };
}

/**
 * Event message payloads (event_msg event)
 */
type CodexEventMsgPayload =
  | CodexUserMessagePayload
  | CodexAgentMessagePayload
  | CodexTokenCountPayload
  | CodexTurnCompletedPayload;

interface CodexUserMessagePayload {
  type: "user_message";
  message: string;
  images?: unknown[];
  local_images?: unknown[];
  text_elements?: unknown[];
}

interface CodexAgentMessagePayload {
  type: "agent_message";
  message: string;
}

interface CodexTokenCountPayload {
  type: "token_count";
  info: {
    total_token_usage: CodexTokenUsage;
    last_token_usage: CodexTokenUsage;
    model_context_window: number;
  } | null;
  rate_limits: {
    primary: unknown | null;
    secondary: unknown | null;
    credits: unknown | null;
    plan_type: unknown | null;
  };
}

interface CodexTokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

interface CodexTurnCompletedPayload {
  type: "turn.completed";
}

/**
 * Response item payloads (response_item event)
 */
type CodexResponseItemPayload =
  | CodexMessagePayload
  | CodexReasoningPayload
  | CodexFunctionCallPayload
  | CodexFunctionCallOutputPayload
  | CodexCustomToolCallPayload
  | CodexCustomToolCallOutputPayload
  | CodexAssistantContentPayload;

interface CodexMessagePayload {
  type: "message";
  role: "developer" | "assistant";
  content: Array<{
    type: "input_text" | "output_text";
    text: string;
  }>;
}

interface CodexReasoningPayload {
  type: "reasoning";
  summary: unknown[];
  content: string | null;
  encrypted_content: string;
}

interface CodexFunctionCallPayload {
  type: "function_call";
  name: string;
  arguments: string; // JSON string
  call_id: string;
}

interface CodexFunctionCallOutputPayload {
  type: "function_call_output";
  call_id: string;
  output: string;
}

interface CodexCustomToolCallPayload {
  type: "custom_tool_call";
  name: string;
  input: string;
  call_id: string;
  status: "completed" | "in_progress" | "failed";
}

interface CodexCustomToolCallOutputPayload {
  type: "custom_tool_call_output";
  call_id: string;
  output: string; // JSON-encoded
}

/**
 * Assistant content (response_item with role="assistant")
 */
interface CodexAssistantContentPayload {
  role: "assistant";
  content: Array<{
    type: "input_text" | "output_text" | "tool_use" | "thinking";
    text?: string;
    name?: string;
    input?: Record<string, unknown>;
    id?: string;
  }>;
}

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
  extractResponse(events: any[]): UniversalCliOutput {
    const outputEvents: CliEvent[] = [];
    let sessionId: string | undefined;
    let model: string | undefined;
    let cliVersion: string | undefined;

    // Token statistics tracking
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let cachedInputTokens = 0;
    let reasoningOutputTokens = 0;

    for (const event of events) {
      const timestamp = event.timestamp
        ? new Date(event.timestamp).getTime()
        : Date.now();

      // Track session metadata (session_meta)
      if (event.type === "session_meta" && event.payload) {
        this.sessionMeta = event.payload;
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
        if (event.payload.info?.total_token_usage) {
          const usage = event.payload.info.total_token_usage;
          totalInputTokens = usage.input_tokens || 0;
          totalOutputTokens = usage.output_tokens || 0;
          cachedInputTokens = usage.cached_input_tokens || 0;
          reasoningOutputTokens = usage.reasoning_output_tokens || 0;
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

            // Tool calls - normalize 'input' to 'parameters'
            if (item.type === "tool_use") {
              outputEvents.push({
                type: CLI_EVENT_TYPES.TOOL_CALL,
                timestamp,
                data: {
                  name: item.name,
                  parameters: item.input || {},
                  id: item.id,
                } as ToolCall,
              });
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
        outputEvents.push({
          type: CLI_EVENT_TYPES.TOOL_CALL,
          timestamp,
          data: {
            name: event.payload.name,
            parameters: params,
            id: event.payload.call_id ?? event.payload.id,
          } as ToolCall,
        });
      }

      // response_item:function_call_output - Function result
      if (
        event.type === "response_item" &&
        event.payload?.type === "function_call_output"
      ) {
        outputEvents.push({
          type: CLI_EVENT_TYPES.TOOL_RESULT,
          timestamp,
          data: {
            toolCallId: event.payload.call_id,
            result: {
              success: true, // Default success, exit code parsing would require output analysis
              output: event.payload.output,
            },
          } as ToolResultData,
        });
      }

      // response_item:custom_tool_call - Custom tool call request
      if (
        event.type === "response_item" &&
        event.payload?.type === "custom_tool_call"
      ) {
        outputEvents.push({
          type: CLI_EVENT_TYPES.TOOL_CALL,
          timestamp,
          data: {
            name: event.payload.name,
            parameters:
              typeof event.payload.input === "string"
                ? { input: event.payload.input }
                : event.payload.input || {},
            id: event.payload.call_id,
          } as ToolCall,
        });
      }

      // response_item:custom_tool_call_output - Custom tool result
      if (
        event.type === "response_item" &&
        event.payload?.type === "custom_tool_call_output"
      ) {
        // Parse JSON output if possible to extract success status
        let success = true;
        let output = event.payload.output;
        try {
          const parsed = JSON.parse(event.payload.output);
          output = parsed.output || event.payload.output;
          success =
            parsed.metadata?.exit_code === 0 ||
            parsed.metadata?.exit_code === undefined;
        } catch {
          // Use raw output if not JSON
        }

        outputEvents.push({
          type: CLI_EVENT_TYPES.TOOL_RESULT,
          timestamp,
          data: {
            toolCallId: event.payload.call_id,
            result: {
              success,
              output,
            },
          } as ToolResultData,
        });
      }
    }

    // Fallback to cached session meta if not found in current events
    if (!sessionId && this.sessionMeta) {
      sessionId = this.sessionMeta.id;
      model = this.sessionMeta.model;
      cliVersion = this.sessionMeta.cli_version;
    }

    // Build token usage object if we have any token data
    let usage: TokenUsage | undefined;
    if (totalInputTokens > 0 || totalOutputTokens > 0) {
      usage = {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        cachedInputTokens,
        reasoningOutputTokens,
      };
    }

    return {
      events: outputEvents,
      metadata: {
        sessionId,
        model,
        cliVersion,
        provider: "codex-cli",
        usage,
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
    // Check for nested payload type (standard format)
    if (
      event.type === "event_msg" &&
      event.payload?.type === "turn.completed"
    ) {
      return true;
    }
    // Legacy format check (payload.type at top level)
    if (event.payload?.type === "turn.completed") {
      return true;
    }
    return false;
  }

  /**
   * Discover session log file for a prompt
   *
   * Searches `~/.codex/sessions/YYYY/MM/DD/` for the log file corresponding
   * to a specific prompt execution. Uses session ID (if provided) or prompt text matching.
   *
   * @param promptText - The prompt text sent to Codex CLI (not used when sessionId provided)
   * @param startTime - Execution start timestamp
   * @param sessionId - Optional session ID for direct file matching (bypasses prompt matching)
   * @returns Absolute path to session log file, or null if not found
   *
   * @remarks
   * **Discovery Algorithm:**
   * 1. If sessionId provided: Search for file matching `rollout-*-{sessionId}.jsonl`
   * 2. Otherwise: Calculate today's date directory (YYYY/MM/DD)
   * 3. Find all `.jsonl` files modified after startTime
   * 4. Sort by modification time (newest first)
   * 5. Read first 10 events from each candidate
   * 6. Look for user message in response_items or event_msg
   * 7. Return first matching log file path
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
    startTime: Date,
    sessionId?: string
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

      // FAST PATH: If session ID provided, search for matching file directly
      if (sessionId) {
        Log.debug(
          `[CodexLogParser] Using session ID ${sessionId} to find log file`
        );

        // Retry with backoff: Codex writes log file asynchronously after session start
        // When resuming, the file may exist but not be updated yet
        const result = await retryWithBackoff(
          async () => {
            // Codex file pattern: rollout-<timestamp>-<session-id>.jsonl
            if (!fs.existsSync(datePath)) {
              return null; // Date directory doesn't exist yet, retry
            }

            const files = fs.readdirSync(datePath);
            const matchingFile = files.find((file) =>
              file.endsWith(`-${sessionId}.jsonl`)
            );

            if (matchingFile) {
              const logPath = path.join(datePath, matchingFile);
              const stats = fs.statSync(logPath);

              // Verify file is recent (handles resume case where file exists but isn't updated yet)
              if (stats.mtime >= startTime) {
                return logPath; // Success - file exists and is recent
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
          Log.debug(
            `[CodexLogParser] No log file found for session ${sessionId} in ${datePath}`
          );
          return null;
        }
      }

      // FALLBACK: Find all .jsonl files modified after startTime
      // Retry with backoff: Codex may take a moment to create the log file
      // Normalize for path escaping: Codex may double backslashes in file paths
      const promptPrefix = this.normalizePromptForMatching(
        promptText.slice(0, 100)
      );

      const result = await retryWithBackoff(
        async () => {
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
            return null; // No candidates yet, will retry
          }

          // Sort by modification time (newest first)
          candidates.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

          // Check each candidate
          for (const candidate of candidates) {
            try {
              // Read first 10 events
              const events = await this.readFirstEvents(candidate.path, 10);

              // Look for user message in turn_context or response_item events
              for (const event of events) {
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
   * - Nested payload: `{ payload: { type: "input_text" | "output_text", text: "..." } }`
   * - Response items: `{ type: "response_item", payload: { content: [...] } }`
   */
  extractContentFromEvent(event: any): string | undefined {
    // Direct content field
    if (event.type === "text" && event.content) {
      return event.content;
    }

    // Nested payload with text
    if (
      (event.payload?.type === "input_text" ||
        event.payload?.type === "output_text") &&
      event.payload.text
    ) {
      return event.payload.text;
    }

    // response_item with assistant role and content array
    if (
      event.type === "response_item" &&
      event.payload?.role === "assistant" &&
      event.payload?.content
    ) {
      const textParts = event.payload.content
        .filter(
          (c: any) =>
            (c.type === "input_text" || c.type === "output_text") && c.text
        )
        .map((c: any) => c.text);
      return textParts.length > 0 ? textParts.join("") : undefined;
    }

    // response_item with content array (no role check - for backwards compatibility)
    if (
      event.type === "response_item" &&
      event.payload?.content &&
      Array.isArray(event.payload.content)
    ) {
      const textParts = event.payload.content
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
      event.type === "event_msg" &&
      event.payload?.type === "agent_message" &&
      event.payload.message
    ) {
      return event.payload.message;
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
   *   usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }
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
      if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
        parts.push(
          `Tokens: ${usage.inputTokens} in / ${usage.outputTokens} out`
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
