import { CopilotCliResult } from "../../../types/CopilotTypes";
import { Log } from "../../../utils/Log";

/**
 * Generic CLI response structure (normalized across all CLIs)
 */
export interface CliJsonResponse {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  response?: string;
  content?: string;
  usage?: CliUsage;
  session_id?: string;
  thread_id?: string;
  model?: string;
  error?: string;
  duration_ms?: number;
}

/**
 * Generic usage statistics structure
 */
export interface CliUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
}

/**
 * Shared response parsing utilities for CLI integrations
 *
 * Supports:
 * - Stream-json format (Claude CLI - concatenated JSON objects)
 * - JSONL format (Codex CLI - newline-delimited JSON)
 * - Text format (Copilot CLI - plain text with statistics)
 */
export class CliResponseParser {
  /**
   * Extract JSON objects from a concatenated stream (stream-json format)
   *
   * Claude CLI outputs concatenated JSON objects without newlines:
   * {"type":"system",...}{"type":"assistant",...}{"type":"result",...}
   *
   * @param data Stream data containing JSON objects
   * @returns Parsed objects and remainder for next chunk
   */
  static extractJsonObjectsFromStream(data: string): {
    objects: any[];
    remainder: string;
  } {
    const objects: any[] = [];
    let cursor = 0;

    while (cursor < data.length) {
      const objStart = data.indexOf("{", cursor);
      if (objStart === -1) {
        cursor = data.length;
        break;
      }

      let depth = 0;
      let inString = false;
      let escape = false;
      let objEnd = -1;

      for (let i = objStart; i < data.length; i++) {
        const char = data[i];

        if (escape) {
          escape = false;
          continue;
        }

        if (char === "\\") {
          escape = true;
          continue;
        }

        if (char === '"') {
          inString = !inString;
          continue;
        }

        if (!inString) {
          if (char === "{") {
            depth++;
          } else if (char === "}") {
            depth--;
            if (depth === 0) {
              objEnd = i + 1;
              break;
            }
          }
        }
      }

      if (objEnd !== -1) {
        const objStr = data.substring(objStart, objEnd);
        try {
          const json = JSON.parse(objStr);
          objects.push(json);
        } catch (parseError) {
          Log.debug(
            `Failed to parse stream-json object: ${objStr.substring(0, 100)}`
          );
        }
        cursor = objEnd;
        continue;
      }

      cursor = objStart;
      break;
    }

    return {
      objects,
      remainder: data.substring(cursor),
    };
  }

  /**
   * Parse JSONL (newline-delimited JSON) format
   *
   * Codex CLI outputs JSONL events:
   * {"type":"thread.started",...}
   * {"type":"item.completed",...}
   * {"type":"turn.completed",...}
   *
   * @param data JSONL data with newline-delimited JSON objects
   * @returns Parsed objects array
   */
  static parseJsonLines(data: string): any[] {
    const objects: any[] = [];
    const lines = data.split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const json = JSON.parse(line);
        objects.push(json);
      } catch (parseError) {
        Log.debug(`Skipping non-JSON line: ${line.substring(0, 100)}`);
      }
    }

    return objects;
  }

  /**
   * Extract usage statistics from various JSON formats
   *
   * @param json JSON object with usage field
   * @returns Normalized usage statistics
   */
  static extractUsageStats(json: any): CliUsage | undefined {
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
   * Extract session ID from various JSON formats
   *
   * Different CLIs use different field names:
   * - Claude: session_id
   * - Codex: thread_id
   * - Copilot: session (from logs, not JSON)
   *
   * @param json JSON object or text output
   * @returns Session ID if found
   */
  static extractSessionId(json: any): string | undefined {
    return json.session_id || json.thread_id;
  }

  /**
   * Format usage statistics as a human-readable string
   *
   * @param usage Usage statistics object
   * @param model Optional model name to include
   * @returns Formatted string like "Usage: 1234 input + 5678 output = 6912 tokens | Model: claude-sonnet-4.5"
   */
  static formatStatistics(usage: CliUsage | undefined, model?: string): string {
    if (!usage) {
      return "";
    }

    const { input_tokens, output_tokens, total_tokens } = usage;
    const total = total_tokens || input_tokens + output_tokens;
    let stats = `Usage: ${input_tokens} input + ${output_tokens} output = ${total} tokens`;

    if (model) {
      stats += ` | Model: ${model}`;
    }

    return stats;
  }

  /**
   * Parse Claude CLI stream-json output
   *
   * Stream-json format outputs 3 concatenated JSON objects:
   * 1. {"type":"system","subtype":"init",...} - Session metadata
   * 2. {"type":"assistant","message":{...}} - Response at message.content[0].text
   * 3. {"type":"result",...} - Usage stats, session_id, costs
   *
   * @param stdout CLI stdout
   * @param stderr CLI stderr
   * @param exitCode Process exit code
   * @returns Parsed CLI result with session ID
   */
  static parseClaudeStreamJson(
    stdout: string,
    stderr: string,
    exitCode: number
  ): CopilotCliResult & { sessionId?: string } {
    let fullResponse = "";
    let sessionId: string | undefined;
    let usage: CliUsage | undefined;
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
          fullResponse += this.formatClaudeToolCall(toolUse.name, toolUse.input);
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
   * Parse Codex CLI JSONL output
   *
   * JSONL format outputs events:
   * 1. {"type":"thread.started","thread_id":"..."}
   * 2. {"type":"turn.started"}
   * 3. {"type":"item.completed","item":{"text":"...","role":"assistant"}}
   * 4. {"type":"turn.completed","usage":{"input_tokens":X,"output_tokens":Y}}
   *
   * @param stdout CLI stdout
   * @param stderr CLI stderr
   * @param exitCode Process exit code
   * @returns Parsed CLI result with session ID
   */
  static parseCodexJsonLines(
    stdout: string,
    stderr: string,
    exitCode: number
  ): CopilotCliResult & { sessionId?: string } {
    let fullResponse = "";
    let sessionId: string | undefined;
    let usage: CliUsage | undefined;
    let isError = false;
    let errorMessage: string | undefined;

    const objects = this.parseJsonLines(stdout);

    for (const json of objects) {
      // Extract response from item.completed events
      if (json.type === "item.completed" && json.item) {
        // Agent message (text response)
        if (json.item.type === "agent_message" && json.item.text) {
          fullResponse += json.item.text;
        }

        // Command execution (tool call)
        if (json.item.type === "command_execution") {
          const cmd = json.item.command || "unknown";
          const status = json.item.status || "unknown";
          const exitCode = json.item.exit_code;
          const output = json.item.aggregated_output || "";
          fullResponse += this.formatCodexCommandExecution(
            cmd,
            status,
            exitCode,
            output
          );
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

    const statistics = this.formatStatistics(usage);

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
   * Parse Copilot CLI text output
   *
   * Copilot outputs plain text with statistics appended:
   * "Response text here
   *
   * Total usage est: 1234 prompt + 5678 completion"
   *
   * @param stdout CLI stdout
   * @param stderr CLI stderr
   * @param exitCode Process exit code
   * @returns Parsed CLI result
   */
  static parseCopilotText(
    stdout: string,
    stderr: string,
    exitCode: number
  ): CopilotCliResult {
    // Split on statistics section (starts with "Total usage est:")
    const parts = stdout.split(/\n\n(?=Total usage est:)/);

    return {
      success: exitCode === 0,
      response: parts[0]?.trim() || "",
      statistics: parts[1]?.trim() || "",
      error: exitCode !== 0 ? stderr : undefined,
      exitCode,
    };
  }

  /**
   * Format Claude tool call for display
   */
  private static formatClaudeToolCall(toolName: string, input: any): string {
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
   * Format Codex command execution for display
   */
  private static formatCodexCommandExecution(
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
