import {
  IResponseParser,
  ResponseParserBase,
} from "../shared/interfaces/IResponseParser";
import {
  UniversalCliOutput,
  CliEvent,
  CLI_EVENT_TYPES,
} from "../../../types/CliOutputTypes";
import { Log } from "../../../utils/Log";

// ============================================================
// CODEX CLI JSON EVENT TYPE DEFINITIONS
// Based on docs/schemas/CODEX_JSON_RESPONSE_SCHEMA.md
// ============================================================

/**
 * File change entry within a file_change item
 */
interface FileUpdateChange {
  path: string;
  kind: "add" | "update" | "delete";
}

/**
 * Todo item within a todo_list item
 */
interface TodoItem {
  text: string;
  completed: boolean;
}

/**
 * Codex CLI JSON event structure (JSONL events format)
 *
 * Supports all 8 event types and 8 item types from Codex CLI schema:
 * - Event types: thread.started, turn.started, turn.completed, turn.failed,
 *                item.started, item.updated, item.completed, error
 * - Item types: agent_message, reasoning, command_execution, file_change,
 *               mcp_tool_call, web_search, todo_list, error
 */
interface CodexCliJsonEvent {
  type?: string;
  subtype?: string;

  // Item data (for item.started, item.updated, item.completed events)
  item?: {
    id?: string;
    type?: string;
    role?: string;

    // agent_message item fields
    text?: string;

    // command_execution item fields
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string; // "in_progress", "completed", "failed"

    // file_change item fields
    changes?: FileUpdateChange[];

    // mcp_tool_call item fields
    server?: string;
    tool?: string;

    // web_search item fields
    query?: string;

    // todo_list item fields
    items?: TodoItem[];

    // error item fields
    message?: string;

    // Legacy tool_calls format (for backwards compatibility)
    tool_calls?: Array<{
      type: string;
      function?: {
        name: string;
        arguments?: string;
      };
    }>;
  };

  // turn.failed event error
  error?: {
    message: string;
  };

  // Top-level error event message
  message?: string;

  // Thread/session identification
  turn?: {
    id?: string;
    status?: string;
  };
  thread?: {
    id?: string;
  };
  thread_id?: string;
  session_id?: string;

  // turn.completed usage statistics
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * Codex CLI Response Parser
 *
 * Parses Codex CLI JSONL output format:
 * - JSONL outputs newline-delimited JSON events
 * - Event types:
 *   - thread.started: Contains thread_id for session tracking
 *   - item.completed: Contains agent_message (text) or command_execution (tool call)
 *   - turn.completed: Contains usage statistics
 * - Tool calls: Formatted with command name, status, exit code, and output
 * - OpenAI token format: input_tokens + output_tokens
 *
 * Provides real-time streaming extraction via processStreamingChunk.
 */
export class CodexResponseParser
  extends ResponseParserBase
  implements IResponseParser
{
  /**
   * Parse Codex CLI JSONL output into structured events
   *
   * @param stdout CLI stdout (newline-delimited JSON events)
   * @param stderr CLI stderr (errors)
   * @param exitCode Process exit code
   * @returns Structured output with events array and metadata
   */
  parse(stdout: string, stderr: string, exitCode: number): UniversalCliOutput {
    const events: CliEvent[] = [];
    let sessionId: string | undefined;
    let usage:
      | {
          input_tokens: number;
          output_tokens: number;
          cached_input_tokens?: number;
          total_tokens?: number;
        }
      | undefined;
    let isError = false;
    let errorMessage: string | undefined;

    const objects = this.parseJsonLines(stdout);

    for (const json of objects) {
      // Extract session ID from thread.started
      if (json.type === "thread.started" && json.thread_id) {
        sessionId = json.thread_id;
      }

      // Handle turn.failed events
      if (json.type === "turn.failed" && json.error) {
        isError = true;
        errorMessage = json.error.message || "Turn failed";
      }

      // Handle top-level error events
      if (json.type === "error" && json.message) {
        isError = true;
        errorMessage = json.message;
      }

      // Extract usage from turn.completed (with cached_input_tokens support)
      if (json.type === "turn.completed") {
        usage = this.extractUsageStats(json);
      }

      // Process item.completed events - extract all item types
      if (json.type === "item.completed" && json.item) {
        this.parseItemToEvents(json.item, events);
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

    return {
      events,
      metadata: {
        sessionId,
        usage: usage
          ? {
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              totalTokens:
                usage.total_tokens || usage.input_tokens + usage.output_tokens,
              // Note: cached_input_tokens available in usage object for cost calculation
            }
          : undefined,
        provider: "codex-cli",
      },
    };
  }

  /**
   * Parse an item into CLI events
   *
   * Handles all 8 item types from Codex schema:
   * - agent_message: Text response → TEXT event
   * - reasoning: Internal thinking/chain-of-thought → THINKING event
   * - command_execution: Shell command with output → BASH_COMMAND event
   * - file_change: File modifications (add/update/delete) → FILE_EDIT event
   * - mcp_tool_call: MCP tool invocation → MCP_TOOL_CALL event
   * - web_search: Web search query → WEB_SEARCH event
   * - todo_list: Task list tracking → TEXT event (formatted)
   * - error: Item-level error → TEXT event (error message)
   *
   * @param item Item data from event
   * @param events Events array to push to
   */
  private parseItemToEvents(
    item: NonNullable<CodexCliJsonEvent["item"]>,
    events: CliEvent[]
  ): void {
    // Agent message (text response)
    if (item.type === "agent_message" && item.text) {
      events.push({
        type: CLI_EVENT_TYPES.TEXT,
        timestamp: Date.now(),
        data: { text: item.text },
      });
    }

    // Reasoning (thinking/chain-of-thought)
    if (item.type === "reasoning" && item.text) {
      events.push({
        type: CLI_EVENT_TYPES.THINKING,
        timestamp: Date.now(),
        data: {
          text: item.text,
          label: "Reasoning",
        },
      });
    }

    // Command execution (shell command) → BASH_COMMAND event
    if (item.type === "command_execution") {
      events.push({
        type: CLI_EVENT_TYPES.BASH_COMMAND,
        timestamp: Date.now(),
        data: {
          command: item.command || "unknown",
          exitCode: item.exit_code ?? undefined,
          output: item.aggregated_output || "",
          status: item.status as
            | "in_progress"
            | "completed"
            | "failed"
            | undefined,
        },
      });
    }

    // File change → FILE_EDIT event (with changes array)
    if (item.type === "file_change" && item.changes) {
      events.push({
        type: CLI_EVENT_TYPES.FILE_EDIT,
        timestamp: Date.now(),
        data: {
          path: item.changes[0]?.path || "unknown", // Primary file
          changes: item.changes.map((change) => ({
            path: change.path,
            kind: change.kind,
          })),
          success: item.status === "completed",
        },
      });
    }

    // MCP tool call → MCP_TOOL_CALL event
    if (item.type === "mcp_tool_call") {
      events.push({
        type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
        timestamp: Date.now(),
        data: {
          server: item.server || "unknown",
          tool: item.tool || "unknown",
        },
      });
    }

    // Web search → WEB_SEARCH event
    if (item.type === "web_search") {
      events.push({
        type: CLI_EVENT_TYPES.WEB_SEARCH,
        timestamp: Date.now(),
        data: {
          query: item.query || "",
          success: item.status === "completed",
        },
      });
    }

    // Todo list → TEXT event (formatted)
    if (item.type === "todo_list" && item.items) {
      const todoText = item.items
        .map(
          (todo, i) => `${i + 1}. [${todo.completed ? "x" : " "}] ${todo.text}`
        )
        .join("\n");
      events.push({
        type: CLI_EVENT_TYPES.TEXT,
        timestamp: Date.now(),
        data: { text: `Todo List:\n${todoText}` },
      });
    }

    // Error item (item-level error, non-fatal)
    if (item.type === "error" && item.message) {
      events.push({
        type: CLI_EVENT_TYPES.TEXT,
        timestamp: Date.now(),
        data: { text: `Error: ${item.message}` },
      });
    }
  }

  /**
   * Process streaming chunk for real-time display
   *
   * Extracts content from JSONL format as it arrives and converts to structured events.
   * Maintains stream buffer in streamState.
   *
   * **Returns CliEvent[] for terminal-style rendering with tool call visualization**
   *
   * Handles:
   * - item.completed: Final item data for all 8 item types
   * - item.updated: Progressive updates (e.g., streaming command output)
   * - turn.failed: Error handling
   * - error: Top-level errors
   *
   * @param chunk Raw stdout chunk
   * @param streamState Accumulated state (persists across chunks)
   * @returns Structured events to emit, or undefined to skip
   */
  processStreamingChunk(
    chunk: string,
    streamState: Map<string, unknown>
  ): CliEvent[] | undefined {
    // Get or initialize stream buffer
    let streamBuffer = (streamState.get("streamBuffer") as string) || "";
    streamBuffer += chunk;

    const lines = streamBuffer.split("\n");
    // Keep incomplete last line in buffer
    streamState.set("streamBuffer", lines[lines.length - 1]);

    const events: CliEvent[] = [];

    // Process complete lines (all except last)
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i].trim();
      if (!line) {
        continue;
      }

      let json: CodexCliJsonEvent;
      try {
        json = JSON.parse(line);
      } catch (e) {
        Log.debug(`Failed to parse JSONL event: ${e}`);
        continue;
      }

      // Handle item.completed events - final item data
      if (json.type === "item.completed" && json.item) {
        this.parseItemToEvents(json.item, events);
      }

      // Handle item.updated events - progressive updates for streaming output
      if (json.type === "item.updated" && json.item) {
        // Command execution streaming output
        if (json.item.type === "command_execution" && json.item.id) {
          const outputKey = `output_${json.item.id}`;
          const prevOutput = (streamState.get(outputKey) as string) || "";
          const newOutput = json.item.aggregated_output || "";

          // Calculate delta (new content since last update)
          if (newOutput.length > prevOutput.length) {
            const delta = newOutput.substring(prevOutput.length);
            streamState.set(outputKey, newOutput);

            // Emit delta as text for real-time display
            if (delta) {
              events.push({
                type: CLI_EVENT_TYPES.TEXT,
                timestamp: Date.now(),
                data: { text: delta },
              });
            }
          }
        }

        // Todo list updates (track progress)
        if (json.item.type === "todo_list" && json.item.items) {
          events.push({
            type: CLI_EVENT_TYPES.TOOL_CALL,
            timestamp: Date.now(),
            data: {
              name: "todo_list",
              parameters: {
                items: json.item.items,
              },
              id: json.item.id,
            },
          });
        }
      }

      // Handle item.started events - show item beginning (for UX feedback)
      if (json.type === "item.started" && json.item) {
        // Reasoning started - show thinking indicator
        if (json.item.type === "reasoning" && json.item.text) {
          events.push({
            type: CLI_EVENT_TYPES.THINKING,
            timestamp: Date.now(),
            data: {
              text: json.item.text,
              label: "Reasoning",
            },
          });
        }

        // Command started - show command being executed
        if (json.item.type === "command_execution" && json.item.command) {
          events.push({
            type: CLI_EVENT_TYPES.TOOL_CALL,
            timestamp: Date.now(),
            data: {
              name: "Command",
              parameters: {
                command: json.item.command,
                status: json.item.status || "in_progress",
              },
              id: json.item.id,
            },
          });
        }
      }

      // Handle turn.failed events
      if (json.type === "turn.failed" && json.error) {
        events.push({
          type: CLI_EVENT_TYPES.TEXT,
          timestamp: Date.now(),
          data: { text: `Error: ${json.error.message || "Turn failed"}` },
        });
      }

      // Handle top-level error events
      if (json.type === "error" && json.message) {
        events.push({
          type: CLI_EVENT_TYPES.TEXT,
          timestamp: Date.now(),
          data: { text: `Error: ${json.message}` },
        });
      }
    }

    return events.length > 0 ? events : undefined;
  }

  /**
   * Extract session ID from Codex CLI output
   *
   * @param output Raw CLI output
   * @returns Session ID if found
   */
  extractSessionId(output: string): string | undefined {
    const objects = this.parseJsonLines(output);

    for (const json of objects) {
      if (json.type === "thread.started" && json.thread_id) {
        return json.thread_id;
      }
    }

    return undefined;
  }

  /**
   * Parse token counts from Codex CLI statistics string
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
   * Parse JSONL (newline-delimited JSON) into array of objects
   *
   * @param jsonlText JSONL string
   * @returns Array of parsed JSON objects
   */
  private parseJsonLines(jsonlText: string): CodexCliJsonEvent[] {
    const objects: CodexCliJsonEvent[] = [];
    const lines = jsonlText.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const json = JSON.parse(trimmed);
        objects.push(json);
      } catch (e) {
        Log.debug(`Failed to parse JSONL line: ${e}`);
      }
    }

    return objects;
  }

  /**
   * Extract usage statistics from JSON event
   *
   * Includes cached_input_tokens for cost calculation:
   * - input_tokens: Total input tokens (includes cached)
   * - cached_input_tokens: Tokens served from cache (lower cost)
   * - output_tokens: Generated output tokens
   *
   * @param json Event object
   * @returns Usage object if found
   */
  private extractUsageStats(json: CodexCliJsonEvent):
    | {
        input_tokens: number;
        output_tokens: number;
        cached_input_tokens?: number;
        total_tokens?: number;
      }
    | undefined {
    if (json.usage) {
      return {
        input_tokens: json.usage.input_tokens,
        output_tokens: json.usage.output_tokens,
        cached_input_tokens: json.usage.cached_input_tokens,
        total_tokens: json.usage.total_tokens,
      };
    }
    return undefined;
  }

  /**
   * Format command execution for display
   */
}
