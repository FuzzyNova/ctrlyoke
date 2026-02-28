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
  TokenUsage,
  UnifiedDiffHunk,
} from "../../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  OPERATION_STATUS,
} from "../../../types/DashboardConstants";
import { CODEX_CLI_CONTEXT_WINDOW_SIZE } from "../../../utils/ModelConstants";
import { CliEventMapper } from "../shared/CliEventMapper";

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
  model_harness: string;
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
export class CodexLogParser extends BaseLogParser {
  /**
   * Session metadata cache
   *
   * Stores session_meta event data for later reference.
   * Used to extract session ID and model information.
   */
  private sessionMeta: any = null;

  /**
   * Tool call tracking map
   *
   * Maps call_id to tool metadata for correlating INITIATED and COMPLETED events.
   * Key: call_id, Value: { type: CLI_EVENT_TYPES, toolName: string }
   */
  private toolCallMap: Map<string, { type: string; toolName: string }> =
    new Map();

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
          // Per-turn usage — this is what actually occupies the context window
          const last = info.last_token_usage;
          lastTurnContextWindowUsed =
            (last.input_tokens || 0) + (last.cached_input_tokens || 0);
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
              const params = item.input || {};
              const callId = item.id;
              const classification = CliEventMapper.classifyTool(toolName);

              switch (classification.type) {
                case CLI_EVENT_TYPES.BASH_COMMAND:
                  if (callId) {
                    this.toolCallMap.set(callId, {
                      type: CLI_EVENT_TYPES.BASH_COMMAND,
                      toolName: "bash",
                    });
                  }
                  outputEvents.push({
                    type: CLI_EVENT_TYPES.BASH_COMMAND,
                    timestamp,
                    data: {
                      command: (params as any).command || "",
                      workingDir: (params as any).workingDir,
                      status: OPERATION_STATUS.INITIATED,
                    } as BashCommandData,
                  });
                  break;

                case CLI_EVENT_TYPES.FILE_READ:
                  if (callId) {
                    this.toolCallMap.set(callId, {
                      type: CLI_EVENT_TYPES.FILE_READ,
                      toolName: "read_file",
                    });
                  }
                  outputEvents.push({
                    type: CLI_EVENT_TYPES.FILE_READ,
                    timestamp,
                    data: {
                      path: (params as any).path || (params as any).file || "",
                      status: OPERATION_STATUS.INITIATED,
                    } as FileReadData,
                  });
                  break;

                case CLI_EVENT_TYPES.FILE_WRITE:
                  if (callId) {
                    this.toolCallMap.set(callId, {
                      type: CLI_EVENT_TYPES.FILE_WRITE,
                      toolName: "write_file",
                    });
                  }
                  outputEvents.push({
                    type: CLI_EVENT_TYPES.FILE_WRITE,
                    timestamp,
                    data: {
                      path: (params as any).path || (params as any).file || "",
                      content: (params as any).content || "",
                      status: OPERATION_STATUS.INITIATED,
                    } as FileWriteData,
                  });
                  break;

                case CLI_EVENT_TYPES.FILE_EDIT:
                  if (callId) {
                    this.toolCallMap.set(callId, {
                      type: CLI_EVENT_TYPES.FILE_EDIT,
                      toolName:
                        toolName === "apply_patch"
                          ? "apply_patch"
                          : "edit_file",
                    });
                  }
                  // apply_patch has special structured diff parsing
                  if (toolName === "apply_patch") {
                    const patchInput = (params as any).input || "";
                    let filePath = "unknown";
                    const fileMatch = patchInput.match(
                      /\*\*\* (?:Add|Update) File: (.+)/
                    );
                    if (fileMatch) {
                      filePath = fileMatch[1].trim();
                    }
                    const structuredPatch = this.parseApplyPatch(patchInput);
                    Log.debug(
                      `[CodexLogParser] apply_patch (tool_use) - file=${filePath}, structuredPatch=${structuredPatch ? `${structuredPatch.length} hunks` : "none"}`
                    );
                    outputEvents.push({
                      type: CLI_EVENT_TYPES.FILE_EDIT,
                      timestamp,
                      data: {
                        path: filePath,
                        structuredPatch,
                        status: OPERATION_STATUS.INITIATED,
                      } as FileEditData,
                    });
                  } else {
                    outputEvents.push({
                      type: CLI_EVENT_TYPES.FILE_EDIT,
                      timestamp,
                      data: {
                        path:
                          (params as any).path || (params as any).file || "",
                        oldContent: (params as any).oldContent,
                        newContent:
                          (params as any).newContent || (params as any).content,
                        status: OPERATION_STATUS.INITIATED,
                      } as FileEditData,
                    });
                  }
                  break;

                case CLI_EVENT_TYPES.FILE_DELETE:
                  if (callId) {
                    this.toolCallMap.set(callId, {
                      type: CLI_EVENT_TYPES.FILE_DELETE,
                      toolName: "delete_file",
                    });
                  }
                  outputEvents.push({
                    type: CLI_EVENT_TYPES.FILE_DELETE,
                    timestamp,
                    data: {
                      path: (params as any).path || (params as any).file || "",
                      status: OPERATION_STATUS.INITIATED,
                    } as FileDeleteData,
                  });
                  break;

                case CLI_EVENT_TYPES.MCP_TOOL_CALL:
                  outputEvents.push({
                    type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
                    timestamp,
                    data: {
                      server: (classification as { server: string }).server,
                      tool: (classification as { tool: string }).tool,
                      parameters: params,
                    } as McpToolCallData,
                  });
                  break;

                case CLI_EVENT_TYPES.WEB_SEARCH:
                  outputEvents.push({
                    type: CLI_EVENT_TYPES.WEB_SEARCH,
                    timestamp,
                    data: {
                      query: (params as any).query || "",
                    } as WebSearchData,
                  });
                  break;

                default:
                  outputEvents.push({
                    type: CLI_EVENT_TYPES.TOOL_CALL,
                    timestamp,
                    data: {
                      name: item.name,
                      parameters: params,
                      id: item.id,
                    } as ToolCall,
                  });
              }
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
        const classification = CliEventMapper.classifyTool(functionName);

        if (classification.type === CLI_EVENT_TYPES.BASH_COMMAND) {
          const callId = event.payload.call_id ?? event.payload.id;

          // Track call for correlation with output
          if (callId) {
            this.toolCallMap.set(callId, {
              type: CLI_EVENT_TYPES.BASH_COMMAND,
              toolName: functionName,
            });
          }

          outputEvents.push({
            type: CLI_EVENT_TYPES.BASH_COMMAND,
            timestamp,
            data: {
              command: (params as any).command || (params as any).cmd || "",
              workingDir: (params as any).workingDir || (params as any).cwd,
              status: OPERATION_STATUS.INITIATED,
            } as BashCommandData,
          });
        }
        // Fallback to generic TOOL_CALL for other function calls
        else {
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
      }

      // response_item:function_call_output - Function result (COMPLETED event)
      if (
        event.type === "response_item" &&
        event.payload?.type === "function_call_output"
      ) {
        const callId = event.payload.call_id;
        const toolInfo = callId ? this.toolCallMap.get(callId) : undefined;

        // Check if this is a bash command result
        if (toolInfo?.type === CLI_EVENT_TYPES.BASH_COMMAND) {
          // Parse exit code from output (format: "Exit code: 0\n...")
          const output = event.payload.output || "";
          const exitCodeMatch = output.match(/Exit code: (\d+)/);
          const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : 0;
          const success = exitCode === 0;

          // Extract stdout/stderr from output
          // Format: "Exit code: X\nWall time: Y\nTotal output lines: Z\nOutput:\n<content>"
          const outputMatch = output.match(/Output:\n([\s\S]*)$/);
          const stdout = outputMatch ? outputMatch[1] : output;

          outputEvents.push({
            type: CLI_EVENT_TYPES.BASH_COMMAND,
            timestamp,
            data: {
              command: "", // Command not in output, was in INITIATED event
              exitCode,
              output: stdout,
              error: success ? undefined : stdout,
              status: success
                ? OPERATION_STATUS.COMPLETED
                : OPERATION_STATUS.FAILED,
            } as BashCommandData,
          });

          // Clean up tracking
          if (callId) {
            this.toolCallMap.delete(callId);
          }
        } else {
          // Generic tool result for non-bash commands
          outputEvents.push({
            type: CLI_EVENT_TYPES.TOOL_RESULT,
            timestamp,
            data: {
              toolCallId: callId,
              result: {
                success: true, // Default success for non-bash tools
                output: event.payload.output,
              },
            } as ToolResultData,
          });
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
          typeof input === "string" ? { input } : input || {};

        // Parse JSON input if it's a string
        if (typeof input === "string") {
          try {
            params = JSON.parse(input);
          } catch {
            params = { input };
          }
        }

        const classification = CliEventMapper.classifyTool(toolName);
        const callId = event.payload.call_id;

        switch (classification.type) {
          case CLI_EVENT_TYPES.BASH_COMMAND:
            if (callId) {
              this.toolCallMap.set(callId, {
                type: CLI_EVENT_TYPES.BASH_COMMAND,
                toolName,
              });
            }
            outputEvents.push({
              type: CLI_EVENT_TYPES.BASH_COMMAND,
              timestamp,
              data: {
                command: (params as any).command || (params as any).cmd || "",
                workingDir: (params as any).workingDir || (params as any).cwd,
                status: OPERATION_STATUS.INITIATED,
              } as BashCommandData,
            });
            break;

          case CLI_EVENT_TYPES.FILE_READ:
            if (callId) {
              this.toolCallMap.set(callId, {
                type: CLI_EVENT_TYPES.FILE_READ,
                toolName,
              });
            }
            outputEvents.push({
              type: CLI_EVENT_TYPES.FILE_READ,
              timestamp,
              data: {
                path: (params as any).path || (params as any).file || "",
                status: OPERATION_STATUS.INITIATED,
              } as FileReadData,
            });
            break;

          case CLI_EVENT_TYPES.FILE_WRITE:
            if (callId) {
              this.toolCallMap.set(callId, {
                type: CLI_EVENT_TYPES.FILE_WRITE,
                toolName,
              });
            }
            outputEvents.push({
              type: CLI_EVENT_TYPES.FILE_WRITE,
              timestamp,
              data: {
                path: (params as any).path || (params as any).file || "",
                content: (params as any).content || "",
                status: OPERATION_STATUS.INITIATED,
              } as FileWriteData,
            });
            break;

          case CLI_EVENT_TYPES.FILE_EDIT:
            if (callId) {
              this.toolCallMap.set(callId, {
                type: CLI_EVENT_TYPES.FILE_EDIT,
                toolName,
              });
            }
            // apply_patch has special structured diff parsing
            if (toolName === "apply_patch") {
              const patchInput =
                typeof input === "string" ? input : (params as any).input || "";
              let filePath = "unknown";
              const fileMatch = patchInput.match(
                /\*\*\* (?:Add|Update) File: (.+)/
              );
              if (fileMatch) {
                filePath = fileMatch[1].trim();
              }
              const structuredPatch = this.parseApplyPatch(patchInput);
              Log.debug(
                `[CodexLogParser] apply_patch - file=${filePath}, structuredPatch=${structuredPatch ? `${structuredPatch.length} hunks` : "none"}`
              );
              outputEvents.push({
                type: CLI_EVENT_TYPES.FILE_EDIT,
                timestamp,
                data: {
                  path: filePath,
                  structuredPatch,
                  status: OPERATION_STATUS.INITIATED,
                } as FileEditData,
              });
            } else {
              outputEvents.push({
                type: CLI_EVENT_TYPES.FILE_EDIT,
                timestamp,
                data: {
                  path: (params as any).path || (params as any).file || "",
                  oldContent: (params as any).oldContent,
                  newContent:
                    (params as any).newContent || (params as any).content,
                  status: OPERATION_STATUS.INITIATED,
                } as FileEditData,
              });
            }
            break;

          case CLI_EVENT_TYPES.FILE_DELETE:
            if (callId) {
              this.toolCallMap.set(callId, {
                type: CLI_EVENT_TYPES.FILE_DELETE,
                toolName,
              });
            }
            outputEvents.push({
              type: CLI_EVENT_TYPES.FILE_DELETE,
              timestamp,
              data: {
                path: (params as any).path || (params as any).file || "",
                status: OPERATION_STATUS.INITIATED,
              } as FileDeleteData,
            });
            break;

          case CLI_EVENT_TYPES.MCP_TOOL_CALL:
            outputEvents.push({
              type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
              timestamp,
              data: {
                server: (classification as { server: string }).server,
                tool: (classification as { tool: string }).tool,
                parameters: params,
              } as McpToolCallData,
            });
            break;

          case CLI_EVENT_TYPES.WEB_SEARCH:
            outputEvents.push({
              type: CLI_EVENT_TYPES.WEB_SEARCH,
              timestamp,
              data: {
                query: (params as any).query || "",
              } as WebSearchData,
            });
            break;

          default:
            outputEvents.push({
              type: CLI_EVENT_TYPES.TOOL_CALL,
              timestamp,
              data: {
                name: event.payload.name,
                parameters: params,
                id: event.payload.call_id,
              } as ToolCall,
            });
        }
      }

      // response_item:custom_tool_call_output - Custom tool result (COMPLETED event)
      if (
        event.type === "response_item" &&
        event.payload?.type === "custom_tool_call_output"
      ) {
        const callId = event.payload.call_id;
        const toolInfo = callId ? this.toolCallMap.get(callId) : undefined;

        // Parse JSON output to extract metadata
        let parsedOutput: any = {};
        let outputText = event.payload.output;
        try {
          parsedOutput = JSON.parse(event.payload.output);
          outputText = parsedOutput.output || event.payload.output;
        } catch {
          // Use raw output if not JSON
        }

        const exitCode = parsedOutput.metadata?.exit_code;
        const success = exitCode === 0 || exitCode === undefined;

        // Emit type-specific COMPLETED event based on original tool call
        if (toolInfo) {
          const status = success
            ? OPERATION_STATUS.COMPLETED
            : OPERATION_STATUS.FAILED;

          switch (toolInfo.type) {
            case CLI_EVENT_TYPES.BASH_COMMAND:
              outputEvents.push({
                type: CLI_EVENT_TYPES.BASH_COMMAND,
                timestamp,
                data: {
                  command: "", // Command not in output, was in INITIATED event
                  exitCode: exitCode ?? 0,
                  output: outputText,
                  error: success ? undefined : outputText,
                  status,
                } as BashCommandData,
              });
              break;

            case CLI_EVENT_TYPES.FILE_READ:
              outputEvents.push({
                type: CLI_EVENT_TYPES.FILE_READ,
                timestamp,
                data: {
                  path: "", // Path not in output, was in INITIATED event
                  content: outputText,
                  status,
                  success,
                } as FileReadData,
              });
              break;

            case CLI_EVENT_TYPES.FILE_WRITE:
              outputEvents.push({
                type: CLI_EVENT_TYPES.FILE_WRITE,
                timestamp,
                data: {
                  path: "", // Path not in output, was in INITIATED event
                  content: "", // Content not in output, was in INITIATED event
                  status,
                  success,
                } as FileWriteData,
              });
              break;

            case CLI_EVENT_TYPES.FILE_EDIT:
              outputEvents.push({
                type: CLI_EVENT_TYPES.FILE_EDIT,
                timestamp,
                data: {
                  path: "", // Path not in output, was in INITIATED event
                  status,
                  success,
                } as FileEditData,
              });
              break;

            case CLI_EVENT_TYPES.FILE_DELETE:
              outputEvents.push({
                type: CLI_EVENT_TYPES.FILE_DELETE,
                timestamp,
                data: {
                  path: "", // Path not in output, was in INITIATED event
                  status,
                  success,
                } as FileDeleteData,
              });
              break;

            default:
              // Fallback to generic TOOL_RESULT for unknown types
              outputEvents.push({
                type: CLI_EVENT_TYPES.TOOL_RESULT,
                timestamp,
                data: {
                  toolCallId: callId,
                  result: {
                    success,
                    output: outputText,
                  },
                } as ToolResultData,
              });
          }

          // Clean up tracking
          this.toolCallMap.delete(callId);
        } else {
          // No tracking info, emit generic TOOL_RESULT
          outputEvents.push({
            type: CLI_EVENT_TYPES.TOOL_RESULT,
            timestamp,
            data: {
              toolCallId: callId,
              result: {
                success,
                output: outputText,
              },
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
    let usage: TokenUsage | undefined;
    if (totalInputTokens > 0 || totalOutputTokens > 0) {
      usage = {
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
      metadata: {
        sessionId,
        model,
        cliVersion,
        harness: "codex-cli",
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
   * Parse Codex apply_patch format and convert to UnifiedDiffHunk
   *
   * Codex uses a custom patch format:
   * ```
   * *** Begin Patch
   * *** Update File: path/to/file.ext
   * @@
   * -removed line
   * +added line
   *  context line
   * *** End Patch
   * ```
   *
   * @param patchInput - The patch input string from apply_patch tool
   * @returns Array of UnifiedDiffHunk objects, or undefined if parse fails
   *
   * @remarks
   * **Patch Format:**
   * - `*** Begin Patch` - Start marker
   * - `*** Add File:` or `*** Update File:` - Operation type and file path
   * - `@@` - Hunk separator
   * - Lines prefixed with `-` are removed
   * - Lines prefixed with `+` are added
   * - Lines with space prefix (or no prefix) are context
   * - `*** End Patch` - End marker
   *
   * **Line Number Inference:**
   * Since Codex patches don't include explicit line numbers, we infer them:
   * - Start at line 1 for new files
   * - Track line numbers as we parse the diff
   * - Removed lines increment old line counter
   * - Added lines increment new line counter
   * - Context lines increment both counters
   */
  private parseApplyPatch(patchInput: string): UnifiedDiffHunk[] | undefined {
    try {
      const lines = patchInput.split("\n");
      const hunks: UnifiedDiffHunk[] = [];
      let currentHunk: UnifiedDiffHunk | null = null;
      let oldLineNum = 1;
      let newLineNum = 1;
      let inPatch = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Start of patch
        if (line.startsWith("*** Begin Patch")) {
          inPatch = true;
          continue;
        }

        // End of patch
        if (line.startsWith("*** End Patch")) {
          // Finalize current hunk if exists
          if (currentHunk && currentHunk.lines.length > 0) {
            hunks.push(currentHunk);
          }
          break;
        }

        if (!inPatch) {
          continue;
        }

        // File operation markers (skip, but could extract file path if needed)
        if (
          line.startsWith("*** Add File:") ||
          line.startsWith("*** Update File:")
        ) {
          // Reset line counters for new file
          oldLineNum = 1;
          newLineNum = 1;
          continue;
        }

        // Hunk separator
        if (line === "@@" || line.startsWith("@@")) {
          // Finalize previous hunk
          if (currentHunk && currentHunk.lines.length > 0) {
            hunks.push(currentHunk);
          }

          // Start new hunk
          currentHunk = {
            oldStart: oldLineNum,
            oldLines: 0,
            newStart: newLineNum,
            newLines: 0,
            lines: [],
          };
          continue;
        }

        // Parse diff lines
        if (currentHunk) {
          if (line.startsWith("+")) {
            // Added line
            currentHunk.lines.push(line); // Keep the + prefix
            currentHunk.newLines++;
            newLineNum++;
          } else if (line.startsWith("-")) {
            // Removed line
            currentHunk.lines.push(line); // Keep the - prefix
            currentHunk.oldLines++;
            oldLineNum++;
          } else if (line.startsWith(" ") || line.length === 0) {
            // Context line (space prefix or empty)
            currentHunk.lines.push(" " + line.substring(1)); // Ensure space prefix
            currentHunk.oldLines++;
            currentHunk.newLines++;
            oldLineNum++;
            newLineNum++;
          } else {
            // Treat unprefixed lines as context
            currentHunk.lines.push(" " + line);
            currentHunk.oldLines++;
            currentHunk.newLines++;
            oldLineNum++;
            newLineNum++;
          }
        }
      }

      // Finalize last hunk if exists
      if (currentHunk && currentHunk.lines.length > 0) {
        hunks.push(currentHunk);
      }

      return hunks.length > 0 ? hunks : undefined;
    } catch (error) {
      Log.debug(`[CodexLogParser] Failed to parse apply_patch input: ${error}`);
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
