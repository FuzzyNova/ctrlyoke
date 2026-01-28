import { CliResult } from "../../../types/CopilotTypes";
import {
  IResponseParser,
  ResponseParserBase,
} from "../shared/interfaces/IResponseParser";
import {
  UniversalCliOutput,
  CliEvent,
  CLI_EVENT_TYPES,
  ToolCall,
} from "../../../types/CliOutputTypes";
import { Log } from "../../../utils/Log";

/**
 * Codex CLI JSON event structure (JSONL events format)
 */
interface CodexCliJsonEvent {
  type?: string;
  subtype?: string;
  item?: {
    id?: string;
    type?: string; // "agent_message" or "command_execution"
    role?: string;
    text?: string;
    command?: string; // For command_execution type
    aggregated_output?: string; // For command_execution type
    exit_code?: number | null; // For command_execution type
    status?: string; // "in_progress", "completed", "failed"
    tool_calls?: Array<{
      type: string;
      function?: {
        name: string;
        arguments?: string;
      };
    }>;
  };
  turn?: {
    id?: string;
    status?: string;
  };
  thread?: {
    id?: string;
  };
  thread_id?: string; // Actual field name in Codex output
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens?: number;
  };
  session_id?: string;
  error?: string;
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
  parse(
    stdout: string,
    stderr: string,
    exitCode: number
  ): UniversalCliOutput {
    const events: CliEvent[] = [];
    let sessionId: string | undefined;
    let usage:
      | { input_tokens: number; output_tokens: number; total_tokens?: number }
      | undefined;
    let isError = false;
    let errorMessage: string | undefined;

    const objects = this.parseJsonLines(stdout);

    for (const json of objects) {
      // Extract response from item.completed events
      if (json.type === "item.completed" && json.item) {
        // Agent message (text response)
        if (json.item.type === "agent_message" && json.item.text) {
          events.push({
            type: CLI_EVENT_TYPES.TEXT,
            timestamp: Date.now(),
            data: { text: json.item.text },
          });
        }

        // Command execution (tool call)
        if (json.item.type === "command_execution") {
          const cmd = json.item.command || "unknown";
          const status = json.item.status || "unknown";
          const toolExitCode = json.item.exit_code;
          const output = json.item.aggregated_output || "";

          // Create TOOL_CALL event
          events.push({
            type: CLI_EVENT_TYPES.TOOL_CALL,
            timestamp: Date.now(),
            data: {
              name: "command_execution",
              parameters: {
                command: cmd,
                status,
                exit_code: toolExitCode,
                output,
              },
              id: json.item.id,
            },
          });
        }
      }

      // Extract session ID from thread.started
      if (json.type === "thread.started" && json.thread_id) {
        sessionId = json.thread_id;
      }

      // Extract usage from turn.completed
      if (json.type === "turn.completed") {
        usage = this.extractUsageStats(json);
      }

      // Check for error
      if (json.error) {
        isError = true;
        errorMessage = json.error;
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
            }
          : undefined,
        provider: "codex-cli",
      },
    };
  }

  /**
   * Process streaming chunk for real-time display
   *
   * Extracts content from JSONL format as it arrives.
   * Maintains stream buffer in streamState.
   *
   * @param chunk Raw stdout chunk
   * @param streamState Accumulated state (persists across chunks)
   * @returns Processed content to emit, or undefined to skip
   */
  processStreamingChunk(
    chunk: string,
    streamState: Map<string, any>
  ): string | undefined {
    // Get or initialize stream buffer
    let streamBuffer = streamState.get("streamBuffer") || "";
    streamBuffer += chunk;

    const lines = streamBuffer.split("\n");
    // Keep incomplete last line in buffer
    streamState.set("streamBuffer", lines[lines.length - 1]);

    let contentToEmit = "";

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

      if (json.type === "item.completed" && json.item) {
        if (json.item.type === "agent_message" && json.item.text) {
          contentToEmit += json.item.text;
        }

        if (json.item.type === "command_execution") {
          const cmd = json.item.command || "unknown";
          const status = json.item.status || "unknown";
          const exitCode = json.item.exit_code;
          const output = json.item.aggregated_output || "";
          contentToEmit += this.formatCommandExecution(
            cmd,
            status,
            exitCode,
            output
          );
        }
      }
    }

    return contentToEmit || undefined;
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
   * @param json Event object
   * @returns Usage object if found
   */
  private extractUsageStats(
    json: CodexCliJsonEvent
  ):
    | { input_tokens: number; output_tokens: number; total_tokens?: number }
    | undefined {
    if (json.usage) {
      return {
        input_tokens: json.usage.input_tokens,
        output_tokens: json.usage.output_tokens,
        total_tokens: json.usage.total_tokens,
      };
    }
    return undefined;
  }

  /**
   * Format command execution for display
   */
  private formatCommandExecution(
    cmd: string,
    status: string,
    exitCode: number | null | undefined,
    output: string
  ): string {
    let formatted = `\n\n🔧 Tool: ${cmd}\n`;
    formatted += `   Status: ${status}`;
    if (exitCode !== null && exitCode !== undefined) {
      formatted += ` (exit code: ${exitCode})`;
    }
    if (output.trim()) {
      const firstLine = output.split("\n")[0].substring(0, 100);
      formatted += `\n   Output: ${firstLine}${output.length > 100 ? "..." : ""}`;
    }
    formatted += `\n\n`;
    return formatted;
  }
}
