import { CliResult } from "../../../types/CopilotTypes";
import {
  IResponseParser,
  ResponseParserBase,
} from "../shared/interfaces/IResponseParser";
import { Log } from "../../../utils/Log";

/**
 * Claude CLI Response Parser
 *
 * Parses Claude CLI stream-json output format:
 * - stream-json outputs 3 concatenated JSON objects:
 *   1. {"type":"system","subtype":"init",...} - Session metadata
 *   2. {"type":"assistant","message":{...}} - Response at message.content[0].text
 *   3. {"type":"result",...} - Usage stats, session_id, costs
 * - Tool calls: Formatted with tool name and input parameters
 * - Anthropic token format: input_tokens + output_tokens
 *
 * Provides real-time streaming extraction via processStreamingChunk.
 */
export class ClaudeResponseParser
  extends ResponseParserBase
  implements IResponseParser
{
  /**
   * Parse Claude CLI stream-json output
   *
   * @param stdout CLI stdout (concatenated JSON objects)
   * @param stderr CLI stderr (errors)
   * @param exitCode Process exit code
   * @returns Parsed CLI result with session ID
   */
  parse(
    stdout: string,
    stderr: string,
    exitCode: number
  ): CliResult & { sessionId?: string } {
    let fullResponse = "";
    let sessionId: string | undefined;
    let usage:
      | { input_tokens: number; output_tokens: number; total_tokens?: number }
      | undefined;
    let model: string | undefined;
    let isError = false;
    let errorMessage: string | undefined;

    const { objects } = this.extractJsonObjectsFromStream(stdout);

    // Extract data from parsed objects
    for (const json of objects) {
      // Extract response from assistant message
      if (json.type === "assistant" && json.message?.content) {
        const textContent = json.message.content.find(
          (item: any) => item.type === "text"
        );
        if (textContent?.text) {
          fullResponse += textContent.text;
        }

        // Check for tool use
        const toolUse = json.message.content.find(
          (item: any) => item.type === "tool_use"
        );
        if (toolUse) {
          fullResponse += this.formatClaudeToolCall(
            toolUse.name,
            toolUse.input
          );
        }
      }

      // Extract metadata from result object
      if (json.type === "result") {
        sessionId = json.session_id;
        usage = this.extractUsageStats(json);
        model = json.model;
        if (json.is_error) {
          isError = true;
          errorMessage = json.result || "Unknown error";
        }
      }
    }

    const statistics = this.formatStatistics(usage, model);

    if (isError) {
      return {
        success: false,
        response: "",
        statistics,
        error: errorMessage || stderr || "Stream contained error",
        exitCode: exitCode !== 0 ? exitCode : 1,
        sessionId,
      };
    }

    return {
      success: exitCode === 0,
      response: fullResponse.trim(),
      statistics,
      error: exitCode !== 0 ? stderr : undefined,
      exitCode,
      sessionId,
    };
  }

  /**
   * Process streaming chunk for real-time display
   *
   * Extracts content from stream-json format as it arrives.
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

    const { objects, remainder } =
      this.extractJsonObjectsFromStream(streamBuffer);
    streamState.set("streamBuffer", remainder);

    let contentToEmit = "";

    for (const json of objects) {
      if (json.type === "assistant" && json.message?.content) {
        const textContent = json.message.content.find(
          (item: any) => item.type === "text"
        );
        if (textContent?.text) {
          contentToEmit += textContent.text;
        }

        const toolUse = json.message.content.find(
          (item: any) => item.type === "tool_use"
        );
        if (toolUse) {
          const toolSummary = this.formatClaudeToolCall(
            toolUse.name,
            toolUse.input
          );
          contentToEmit += toolSummary;
        }
      }
    }

    return contentToEmit || undefined;
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

  // parseInteractiveResponse() inherited from ResponseParserBase

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
   * Format Claude tool call for display
   *
   * @param toolName Tool name (e.g., "Bash", "Write")
   * @param input Tool input object
   * @returns Formatted summary string
   */
  private formatClaudeToolCall(toolName: string, input: any): string {
    let summary = `\n\n[Tool: ${toolName}`;

    if (toolName === "Bash" && input?.command) {
      summary += ` → ${input.command}`;
    } else if (toolName === "Write" && input?.file_path) {
      summary += ` → ${input.file_path}`;
    } else if (toolName === "Edit" && input?.file_path) {
      summary += ` → ${input.file_path}`;
    } else if (toolName === "Read" && input?.file_path) {
      summary += ` → ${input.file_path}`;
    } else if (toolName === "WebFetch" && input?.url) {
      summary += ` → ${input.url}`;
    }

    summary += "]\n\n";
    return summary;
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
