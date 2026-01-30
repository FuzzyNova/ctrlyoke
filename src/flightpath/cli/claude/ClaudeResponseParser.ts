import {
  IResponseParser,
  ResponseParserBase,
} from "../shared/interfaces/IResponseParser";
import {
  UniversalCliOutput,
  CliEvent,
  CLI_EVENT_TYPES,
  TokenUsage,
} from "../../../types/CliOutputTypes";
import { Log } from "../../../utils/Log";

/**
 * Extended usage statistics from Claude CLI.
 * Includes cache-related tokens and service tier information.
 */
export interface ExtendedUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  service_tier?: string;
}

/**
 * Claude CLI Response Parser
 *
 * Parses Claude CLI stream-json output format (NDJSON - one JSON object per line):
 *
 * **Message Types Supported:**
 * 1. `system` (subtype: "init") - Session initialization with metadata
 * 2. `system` (subtype: "compact_boundary") - Conversation compaction marker
 * 3. `stream_event` - Real-time streaming (6 subtypes: message_start, content_block_start,
 *    content_block_delta, content_block_stop, message_delta, message_stop)
 * 4. `assistant` - Complete assistant response with content blocks (text, tool_use, thinking)
 * 5. `user` - User messages and tool results
 * 6. `result` - Final statistics with session_id, usage, costs
 *
 * **Content Block Types:**
 * - `text` - Response text
 * - `tool_use` - Tool call with name, id, and input parameters
 * - `thinking` - Claude's extended thinking/reasoning with signature
 *
 * Provides real-time streaming extraction via processStreamingChunk.
 */
export class ClaudeResponseParser
  extends ResponseParserBase
  implements IResponseParser
{
  /**
   * Parse Claude CLI stream-json output into structured events
   *
   * Processes all message types and content blocks:
   * - Extracts thinking blocks → THINKING events
   * - Extracts ALL tool_use blocks → multiple TOOL_CALL events
   * - Extracts text blocks → TEXT events
   * - Extracts extended usage stats (cache tokens, service tier)
   *
   * @param stdout CLI stdout (NDJSON - one JSON object per line)
   * @param stderr CLI stderr (errors)
   * @param exitCode Process exit code
   * @returns Structured output with events array and metadata
   */
  parse(stdout: string, stderr: string, exitCode: number): UniversalCliOutput {
    const events: CliEvent[] = [];
    let sessionId: string | undefined;
    let usage: ExtendedUsage | undefined;
    let model: string | undefined;
    let isError = false;
    let errorMessage: string | undefined;
    let cliVersion: string | undefined;

    const { objects } = this.extractJsonObjectsFromStream(stdout);

    // Extract data from parsed objects and create structured events
    for (const json of objects) {
      // Handle system messages
      if (json.type === "system") {
        if (json.subtype === "init") {
          // Extract session metadata from init message
          sessionId = json.session_id;
          model = json.model;
          cliVersion = json.claude_code_version;
        } else if (json.subtype === "compact_boundary") {
          // Log compact boundary for debugging (conversation was compacted)
          Log.debug(
            `[ClaudeParser] Compact boundary: trigger=${json.compact_metadata?.trigger}, pre_tokens=${json.compact_metadata?.pre_tokens}`
          );
        }
      }

      // Handle stream_event messages (real-time streaming with --include-partial-messages)
      if (json.type === "stream_event" && json.event) {
        this.processStreamEvent(json.event, events);
      }

      // Extract response from assistant message - process ALL content blocks
      if (json.type === "assistant" && json.message?.content) {
        this.processAssistantContent(json.message.content, events);

        // Extract usage from assistant message if available
        if (json.message.usage) {
          usage = this.extractExtendedUsageStats(json.message.usage);
        }
      }

      // Handle user messages (tool results)
      if (json.type === "user" && json.message?.content) {
        this.processUserContent(
          json.message.content,
          json.tool_use_result,
          events
        );
      }

      // Extract metadata from result object
      if (json.type === "result") {
        // Session ID from result takes precedence (always present)
        sessionId = json.session_id;
        // Extract comprehensive usage stats
        if (json.usage) {
          usage = this.extractExtendedUsageStats(json.usage);
        }
        // Model from result if not already set
        if (!model) {
          model = json.model;
        }
        // Check for errors
        if (json.is_error) {
          isError = true;
          errorMessage =
            json.errors?.join("; ") || json.result || "Unknown error";
        }
      }
    }

    // If error occurred, add error event
    if (isError || exitCode !== 0) {
      const errorText = errorMessage || stderr || "Unknown error";
      events.push({
        type: CLI_EVENT_TYPES.TEXT,
        timestamp: Date.now(),
        data: { text: `Error: ${errorText}` },
      });
    }

    // Build normalized token usage with extended cache info
    let tokenUsage: TokenUsage | undefined;
    if (usage) {
      tokenUsage = {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        totalTokens:
          usage.total_tokens || usage.input_tokens + usage.output_tokens,
      };
    }

    return {
      events,
      metadata: {
        sessionId,
        model,
        usage: tokenUsage,
        cliVersion,
        provider: "claude-cli",
      },
    };
  }

  /**
   * Process stream_event for real-time streaming
   *
   * Handles 6 stream event subtypes:
   * - message_start: Initialize message context with usage stats
   * - content_block_start: Start of text or tool_use block
   * - content_block_delta: Incremental text/JSON updates
   * - content_block_stop: End of content block
   * - message_delta: Stop reason and final usage
   * - message_stop: End of streaming
   *
   * @param event The stream event payload
   * @param events Array to append events to
   */
  private processStreamEvent(event: any, events: CliEvent[]): void {
    if (!event.type) return;

    switch (event.type) {
      case "content_block_delta":
        // Handle incremental content updates
        if (event.delta) {
          if (event.delta.type === "text_delta" && event.delta.text) {
            // Real-time text streaming - append to existing or create new
            events.push({
              type: CLI_EVENT_TYPES.TEXT,
              timestamp: Date.now(),
              data: { text: event.delta.text },
            });
          }
          // Note: input_json_delta is handled by accumulating in streamState during streaming
        }
        break;

      case "message_start":
        // Log initial usage stats for debugging
        if (event.message?.usage) {
          Log.debug(
            `[ClaudeParser] Message start: model=${event.message.model}, input_tokens=${event.message.usage.input_tokens}`
          );
        }
        break;

      case "content_block_start":
        // Log block start for debugging
        if (event.content_block) {
          Log.debug(
            `[ClaudeParser] Content block start: index=${event.index}, type=${event.content_block.type}`
          );
        }
        break;

      case "message_delta":
        // Log stop reason
        if (event.delta?.stop_reason) {
          Log.debug(
            `[ClaudeParser] Message delta: stop_reason=${event.delta.stop_reason}`
          );
        }
        break;

      // content_block_stop and message_stop don't generate events
    }
  }

  /**
   * Process assistant message content blocks
   *
   * Extracts ALL content blocks in order:
   * - thinking blocks → THINKING events
   * - text blocks → TEXT events
   * - tool_use blocks → Semantic event types (BASH_COMMAND, FILE_WRITE, etc.)
   *
   * @param content Array of content blocks from assistant message
   * @param events Array to append events to
   */
  private processAssistantContent(content: any[], events: CliEvent[]): void {
    for (const contentBlock of content) {
      // Handle thinking blocks (Claude's extended thinking)
      if (contentBlock.type === "thinking" && contentBlock.thinking) {
        events.push({
          type: CLI_EVENT_TYPES.THINKING,
          timestamp: Date.now(),
          data: {
            text: contentBlock.thinking,
            label: "Extended Thinking",
            // Note: signature field is available but not included (cryptographic, not user-facing)
          },
        });
      }

      // Handle text blocks
      if (contentBlock.type === "text" && contentBlock.text) {
        events.push({
          type: CLI_EVENT_TYPES.TEXT,
          timestamp: Date.now(),
          data: { text: contentBlock.text },
        });
      }

      // Handle tool_use blocks - map to semantic event types
      if (contentBlock.type === "tool_use") {
        this.mapToolToSemanticEvent(contentBlock, events);
      }
    }
  }

  /**
   * Map Claude tool_use block to semantic event type
   *
   * Maps Claude-specific tool names to semantic event types:
   * - "bash" or "shell" → BASH_COMMAND
   * - "write" → FILE_WRITE
   * - "edit" or "apply_patch" → FILE_EDIT
   * - "read" → FILE_READ
   * - Unknown tools → TOOL_CALL (fallback)
   *
   * @param toolUse Tool use content block
   * @param events Array to append events to
   */
  private mapToolToSemanticEvent(toolUse: any, events: CliEvent[]): void {
    const toolName = toolUse.name;
    const input = toolUse.input || {};

    // Bash/shell command execution
    if (toolName === "bash" || toolName === "shell") {
      events.push({
        type: CLI_EVENT_TYPES.BASH_COMMAND,
        timestamp: Date.now(),
        data: {
          command: input.command || input.cmd || "unknown",
          workingDir: input.cwd || input.workingDir,
          exitCode: input.exitCode,
          output: input.output,
          error: input.error,
          status: input.status as
            | "in_progress"
            | "completed"
            | "failed"
            | undefined,
        },
      });
      return;
    }

    // File write (create new file)
    if (toolName === "write") {
      events.push({
        type: CLI_EVENT_TYPES.FILE_WRITE,
        timestamp: Date.now(),
        data: {
          path: input.path || input.file_path || "unknown",
          content: input.content || input.file_text || "",
          success: input.success,
          error: input.error,
        },
      });
      return;
    }

    // File edit (modify existing file)
    if (toolName === "edit" || toolName === "apply_patch") {
      const oldContent = input.oldString || input.old_string || input.oldContent;
      const newContent = input.newString || input.new_string || input.newContent;

      Log.debug(
        `[ClaudeParser] Edit operation - old_string=${oldContent ? "present" : "missing"}, new_string=${newContent ? "present" : "missing"}, input keys=${Object.keys(input).join(", ")}`
      );

      events.push({
        type: CLI_EVENT_TYPES.FILE_EDIT,
        timestamp: Date.now(),
        data: {
          path: input.path || input.file_path || "unknown",
          oldContent,
          newContent,
          success: input.success,
          error: input.error,
        },
      });
      return;
    }

    // File read
    if (toolName === "read") {
      events.push({
        type: CLI_EVENT_TYPES.FILE_READ,
        timestamp: Date.now(),
        data: {
          path: input.path || input.file_path || "unknown",
          content: input.content,
          success: input.success,
          error: input.error,
        },
      });
      return;
    }

    // File delete
    if (toolName === "delete" || toolName === "rm") {
      events.push({
        type: CLI_EVENT_TYPES.FILE_DELETE,
        timestamp: Date.now(),
        data: {
          path: input.path || input.file_path || "unknown",
          success: input.success,
          error: input.error,
        },
      });
      return;
    }

    // Web search
    if (toolName === "web_search" || toolName === "search") {
      events.push({
        type: CLI_EVENT_TYPES.WEB_SEARCH,
        timestamp: Date.now(),
        data: {
          query: input.query || "",
          results: input.results,
          success: input.success,
          error: input.error,
        },
      });
      return;
    }

    // MCP tool call (if tool name contains MCP server prefix)
    // Format: "server_name.tool_name" or explicit MCP tools
    if (toolName.includes(".") || toolName.startsWith("mcp_")) {
      const [server, tool] = toolName.includes(".")
        ? toolName.split(".", 2)
        : ["unknown", toolName];

      events.push({
        type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
        timestamp: Date.now(),
        data: {
          server,
          tool,
          parameters: input,
        },
      });
      return;
    }

    // Unknown tool - fallback to generic TOOL_CALL
    events.push({
      type: CLI_EVENT_TYPES.TOOL_CALL,
      timestamp: Date.now(),
      data: {
        name: toolName,
        parameters: input,
        id: toolUse.id,
      },
    });
  }

  /**
   * Process user message content (tool results)
   *
   * Extracts tool_result blocks and creates TOOL_RESULT events.
   * Also processes structured tool_use_result metadata to create semantic events
   * (FILE_EDIT, FILE_WRITE, FILE_READ, etc.)
   *
   * @param content Array of content blocks from user message
   * @param toolUseResult Optional structured metadata about tool execution
   * @param events Array to append events to
   */
  private processUserContent(
    content: any[],
    toolUseResult: any | undefined,
    events: CliEvent[]
  ): void {
    for (const contentBlock of content) {
      if (contentBlock.type === "tool_result") {
        events.push({
          type: CLI_EVENT_TYPES.TOOL_RESULT,
          timestamp: Date.now(),
          data: {
            toolCallId: contentBlock.tool_use_id,
            result: {
              success: true, // Assume success if we got a result
              output: contentBlock.content,
            },
          },
        });
      }
    }

    // Process structured tool_use_result metadata to create semantic events
    if (toolUseResult) {
      Log.debug(
        `[ClaudeParser] Tool result metadata: type=${toolUseResult.type}, filePath=${toolUseResult.filePath}`
      );

      // File edit result (Edit tool)
      if (toolUseResult.oldString && toolUseResult.newString) {
        events.push({
          type: CLI_EVENT_TYPES.FILE_EDIT,
          timestamp: Date.now(),
          data: {
            path: toolUseResult.filePath || "unknown",
            oldContent: toolUseResult.oldString,
            newContent: toolUseResult.newString,
            success: true,
          },
        });
        return;
      }

      // File write result (Write tool)
      if (toolUseResult.type === "write" || toolUseResult.content) {
        events.push({
          type: CLI_EVENT_TYPES.FILE_WRITE,
          timestamp: Date.now(),
          data: {
            path: toolUseResult.filePath || toolUseResult.path || "unknown",
            content: toolUseResult.content || "",
            success: true,
          },
        });
        return;
      }

      // File read result (Read tool)
      if (toolUseResult.type === "text" && toolUseResult.file) {
        events.push({
          type: CLI_EVENT_TYPES.FILE_READ,
          timestamp: Date.now(),
          data: {
            path: toolUseResult.file.filePath || "unknown",
            content: toolUseResult.file.content || "",
            success: true,
          },
        });
        return;
      }
    }
  }

  /**
   * Process streaming chunk for real-time display
   *
   * Extracts content from stream-json format as it arrives and converts to structured events.
   * Maintains stream buffer in streamState for accumulating partial JSON objects.
   *
   * **Handles stream_event subtypes:**
   * - message_start: Initialize message context
   * - content_block_start: Track block type and index
   * - content_block_delta: Stream text or accumulate tool JSON
   * - content_block_stop: Emit accumulated tool call
   * - message_delta: Extract stop reason
   * - message_stop: End of streaming
   *
   * **Also handles complete messages:**
   * - assistant: Full response with all content blocks
   * - user: Tool results
   *
   * **Returns CliEvent[] for terminal-style rendering with tool call visualization**
   *
   * @param chunk Raw stdout chunk
   * @param streamState Accumulated state (persists across chunks)
   * @returns Structured events to emit, or undefined to skip
   */
  processStreamingChunk(
    chunk: string,
    streamState: Map<string, any>
  ): CliEvent[] | undefined {
    // Get or initialize stream buffer
    let streamBuffer = streamState.get("streamBuffer") || "";
    streamBuffer += chunk;

    const { objects, remainder } =
      this.extractJsonObjectsFromStream(streamBuffer);
    streamState.set("streamBuffer", remainder);

    const events: CliEvent[] = [];

    // Initialize block tracking state
    if (!streamState.has("blocks")) {
      streamState.set("blocks", new Map<number, any>());
    }
    const blocks = streamState.get("blocks") as Map<number, any>;

    for (const json of objects) {
      // Handle stream_event messages
      if (json.type === "stream_event" && json.event) {
        const event = json.event;

        switch (event.type) {
          case "content_block_start":
            // Initialize block tracking
            if (event.content_block) {
              blocks.set(event.index, {
                type: event.content_block.type,
                id: event.content_block.id,
                name: event.content_block.name,
                accumulatedJson: "",
                accumulatedText: "",
              });
            }
            break;

          case "content_block_delta":
            if (event.delta) {
              if (event.delta.type === "text_delta" && event.delta.text) {
                // Stream text in real-time
                events.push({
                  type: CLI_EVENT_TYPES.TEXT,
                  timestamp: Date.now(),
                  data: { text: event.delta.text },
                });
              } else if (
                event.delta.type === "input_json_delta" &&
                event.delta.partial_json
              ) {
                // Accumulate tool input JSON for later emission
                const block = blocks.get(event.index);
                if (block) {
                  block.accumulatedJson += event.delta.partial_json;
                }
              } else if (
                event.delta.type === "thinking_delta" &&
                event.delta.thinking
              ) {
                // Stream thinking text in real-time
                events.push({
                  type: CLI_EVENT_TYPES.THINKING,
                  timestamp: Date.now(),
                  data: {
                    text: event.delta.thinking,
                    label: "Extended Thinking",
                  },
                });
              }
            }
            break;

          case "content_block_stop":
            // Emit accumulated tool call when block ends
            const block = blocks.get(event.index);
            if (block && block.type === "tool_use" && block.accumulatedJson) {
              try {
                const input = JSON.parse(block.accumulatedJson);
                // Map to semantic event type
                this.mapToolToSemanticEvent(
                  {
                    name: block.name,
                    input,
                    id: block.id,
                  },
                  events
                );
              } catch (e) {
                Log.debug(
                  `[ClaudeParser] Failed to parse accumulated tool JSON: ${block.accumulatedJson.substring(0, 100)}`
                );
              }
            }
            blocks.delete(event.index);
            break;
        }
      }

      // Handle complete assistant messages (non-streaming or end of stream)
      if (json.type === "assistant" && json.message?.content) {
        this.processAssistantContent(json.message.content, events);
      }

      // Handle user messages (tool results)
      if (json.type === "user" && json.message?.content) {
        this.processUserContent(
          json.message.content,
          json.tool_use_result,
          events
        );
      }
    }

    return events.length > 0 ? events : undefined;
  }

  /**
   * Extract session ID from Claude CLI output
   *
   * @param output Raw CLI output
   * @returns Session ID if found
   */
  extractSessionId(output: string): string | undefined {
    const { objects } = this.extractJsonObjectsFromStream(output);

    for (const json of objects) {
      if (json.type === "result" && json.session_id) {
        return json.session_id;
      }
    }

    return undefined;
  }

  /**
   * Parse token counts from Claude CLI statistics string
   *
   * Format: "Usage: 1234 input + 5678 output = 6912 tokens"
   *
   * @param statistics Statistics string
   * @returns Token counts if found
   */
  parseTokenCounts(
    statistics: string
  ): { prompt: number; completion: number } | undefined {
    const match = statistics.match(/(\d+)\s+input\s+\+\s+(\d+)\s+output/);
    if (match) {
      return {
        prompt: parseInt(match[1], 10),
        completion: parseInt(match[2], 10),
      };
    }
    return undefined;
  }

  // ============================================================
  // PRIVATE HELPER METHODS
  // ============================================================

  /**
   * Extract JSON objects from concatenated stream format
   *
   * Claude CLI outputs multiple JSON objects concatenated without separators.
   * We parse them by finding balanced braces.
   *
   * @param data Raw stream data
   * @returns Parsed objects and remaining unparsed data
   */
  private extractJsonObjectsFromStream(data: string): {
    objects: any[];
    remainder: string;
  } {
    const objects: any[] = [];
    let cursor = 0;

    while (cursor < data.length) {
      // Skip whitespace
      while (cursor < data.length && /\s/.test(data[cursor])) {
        cursor++;
      }

      if (cursor >= data.length) break;

      // Find the start of the next JSON object
      const objStart = cursor;
      if (data[cursor] !== "{") {
        // Not a JSON object, skip this character
        cursor++;
        continue;
      }

      // Track brace depth to find the end of the object
      let depth = 0;
      let inString = false;
      let escaped = false;

      while (cursor < data.length) {
        const char = data[cursor];

        if (escaped) {
          escaped = false;
          cursor++;
          continue;
        }

        if (char === "\\") {
          escaped = true;
          cursor++;
          continue;
        }

        if (char === '"') {
          inString = !inString;
          cursor++;
          continue;
        }

        if (!inString) {
          if (char === "{") {
            depth++;
          } else if (char === "}") {
            depth--;
            if (depth === 0) {
              cursor++; // Include closing brace
              break;
            }
          }
        }

        cursor++;
      }

      // Try to parse if we found a complete object
      if (depth === 0) {
        const jsonStr = data.substring(objStart, cursor);
        try {
          const json = JSON.parse(jsonStr);
          objects.push(json);
        } catch (parseError) {
          Log.debug(
            `Failed to parse JSON object: ${jsonStr.substring(0, 100)}`
          );
          // Continue to next potential object
        }
        continue;
      }

      // Incomplete object - return what we have so far
      cursor = objStart;
      break;
    }

    return {
      objects,
      remainder: data.substring(cursor),
    };
  }

  /**
   * Extract usage statistics from Claude result JSON
   *
   * @param json Result object with usage field
   * @returns Normalized usage statistics
   */
  private extractUsageStats(json: any):
    | {
        input_tokens: number;
        output_tokens: number;
        total_tokens?: number;
      }
    | undefined {
    if (!json.usage) {
      return undefined;
    }

    const { input_tokens, output_tokens } = json.usage;
    return {
      input_tokens,
      output_tokens,
      total_tokens: json.usage.total_tokens || input_tokens + output_tokens,
    };
  }

  /**
   * Extract extended usage statistics with cache tokens and service tier
   *
   * Extracts additional fields:
   * - cache_creation_input_tokens: Tokens used to create cache
   * - cache_read_input_tokens: Tokens read from cache
   * - service_tier: Service tier (e.g., "standard")
   *
   * @param usage Usage object from Claude response
   * @returns Extended usage statistics
   */
  private extractExtendedUsageStats(usage: any): ExtendedUsage {
    return {
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      total_tokens:
        usage.total_tokens ||
        (usage.input_tokens || 0) + (usage.output_tokens || 0),
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      service_tier: usage.service_tier,
    };
  }

  /**
   * Check if error is a Claude CLI invalid session error
   *
   * Claude CLI validates UUIDs strictly and rejects invalid formats with specific error messages:
   * - "--resume requires a valid session ID"
   * - "Session IDs must be in UUID format"
   * - "No conversation found with session ID"
   *
   * When detected, FlightPath can retry without the resume flag to start a new session.
   *
   * @param error The error to check (Error object or string)
   * @returns True if this is a recoverable Claude CLI session error
   */
  isRecoverableSessionError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes("--resume requires a valid session ID") ||
      message.includes("Session IDs must be in UUID format") ||
      message.includes("No conversation found with session ID")
    );
  }
}
