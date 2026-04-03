import {
  IResponseParser,
  ResponseParserBase,
} from "../shared/interfaces/IResponseParser";
import {
  UniversalCliOutput,
  CliEvent,
  TokenUsage,
} from "../../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  HARNESS_IDS,
} from "../../../types/DashboardConstants";
import { Log } from "../../../utils/Log";
import { getErrorMessage } from "../../../utils/ErrorUtils";
import { CliResponseParser } from "../shared/CliResponseParser";
import { getQwenContextWindowSize } from "../../../utils/ModelConstants";
import { QwenToolBuilder } from "./QwenToolBuilder";

/**
 * Extended usage statistics from Qwen Code CLI.
 * Includes token counts from result event.
 */
export interface ExtendedUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
  [key: string]: any;
}

/**
 * Qwen Code CLI Response Parser
 *
 * Parses Qwen Code CLI stream-json output format (NDJSON - one JSON object per line):
 *
 * **Message Types Supported:**
 * 1. `system` (subtype: "init") - Session initialization with session_id
 * 2. `assistant` - Assistant messages with content blocks (thinking, text, tool_use)
 * 3. `user` - User messages and tool results
 * 4. `result` - Final statistics with session_id, usage, costs, permission_denials
 *
 * **Content Block Types (assistant.message.content):**
 * - `thinking` - Qwen's extended thinking/reasoning
 * - `text` - Response text
 * - `tool_use` - Tool call with name, id, and input parameters
 *
 * Provides real-time streaming extraction via processStreamingChunk.
 */
export class QwenResponseParser
  extends ResponseParserBase
  implements IResponseParser
{
  /**
   * Parse Qwen Code CLI stream-json output into structured events
   *
   * Processes all message types and content blocks:
   * - Extracts thinking blocks → THINKING events
   * - Extracts ALL tool_use blocks → multiple TOOL_CALL events
   * - Extracts text blocks → TEXT events
   * - Extracts usage stats from result event
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

    const { objects } = CliResponseParser.extractJsonObjectsFromStream(stdout);

    // Extract data from parsed objects and create structured events
    for (const json of objects) {
      // Handle system messages
      if (json.type === "system") {
        if (json.subtype === "init") {
          // Extract session metadata from init message
          sessionId = json.session_id;
          model = json.model;
          Log.debug(
            `[QwenParser] Session init: session_id=${sessionId}, model=${model}`
          );
        }
      }

      // Extract response from assistant message - process ALL content blocks
      if (json.type === "assistant" && json.message?.content) {
        this.processAssistantContent(json.message.content, events);

        // Track usage if present
        if (json.message.usage) {
          usage = this.extractExtendedUsageStats(json.message.usage);
        }
      }

      // Handle user messages (tool results)
      if (json.type === "user" && json.message?.content) {
        this.processUserContent(json.message.content, events);
      }

      // Extract metadata from result object
      if (json.type === "result") {
        // Session ID from result takes precedence
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
        // Check for permission denials
        if (json.permission_denials && json.permission_denials.length > 0) {
          Log.warn(
            `[QwenParser] Permission denials: ${JSON.stringify(json.permission_denials)}`
          );
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

    // Build normalized token usage
    let tokenUsage: TokenUsage | undefined;
    if (usage) {
      const inputTokens = usage.input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      tokenUsage = {
        inputTokens,
        outputTokens,
        totalTokens: usage.total_tokens || inputTokens + outputTokens,
        contextWindowUsedTokens: inputTokens + outputTokens,
        contextWindowSize: getQwenContextWindowSize(model ?? ""),
      };
    }

    return {
      events,
      metadata: {
        sessionId,
        model,
        usage: tokenUsage,
        harness: HARNESS_IDS.QWEN_CLI,
      },
    };
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
      // Handle thinking blocks (Qwen's extended thinking)
      if (contentBlock.type === "thinking" && contentBlock.thinking) {
        events.push({
          type: CLI_EVENT_TYPES.THINKING,
          timestamp: Date.now(),
          data: {
            text: contentBlock.thinking,
            label: "Extended Thinking",
          },
        });
        Log.trace(
          `🔍 [QwenParser] Extracted THINKING event: ${contentBlock.thinking.substring(0, 50)}...`
        );
      }

      // Handle text blocks
      if (contentBlock.type === "text" && contentBlock.text) {
        events.push({
          type: CLI_EVENT_TYPES.TEXT,
          timestamp: Date.now(),
          data: { text: contentBlock.text },
        });
        Log.trace(
          `🔍 [QwenParser] Extracted TEXT event: ${contentBlock.text.substring(0, 100)}...`
        );
      }

      // Handle tool_use blocks - map to semantic event types
      if (contentBlock.type === "tool_use") {
        events.push(
          QwenToolBuilder.buildInitiatedEvent(
            contentBlock.name,
            contentBlock.input || {},
            contentBlock.id,
            Date.now()
          )
        );
      }
    }
  }

  /**
   * Process user message content (tool results)
   *
   * Extracts tool_result blocks and creates TOOL_RESULT events.
   *
   * @param content Array of content blocks from user message
   * @param events Array to append events to
   */
  private processUserContent(content: any[], events: CliEvent[]): void {
    for (const contentBlock of content) {
      if (contentBlock.type === "tool_result") {
        events.push({
          type: CLI_EVENT_TYPES.TOOL_RESULT,
          timestamp: Date.now(),
          data: {
            toolCallId: contentBlock.tool_use_id,
            result: {
              success: !contentBlock.is_error,
              output: contentBlock.content,
              error: contentBlock.is_error ? contentBlock.content : undefined,
            },
          },
        });
        Log.trace(
          `🔍 [QwenParser] Extracted TOOL_RESULT event: tool_call_id=${contentBlock.tool_call_id}`
        );
      }
    }
  }

  /**
   * Process streaming chunk for real-time display
   *
   * Extracts content from stream-json format as it arrives and converts to structured events.
   * Maintains stream buffer in streamState for accumulating partial JSON objects.
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
      CliResponseParser.extractJsonObjectsFromStream(streamBuffer);
    streamState.set("streamBuffer", remainder);

    const events: CliEvent[] = [];

    for (const json of objects) {
      // Handle assistant messages
      if (json.type === "assistant" && json.message?.content) {
        const beforeCount = events.length;
        this.processAssistantContent(json.message.content, events);
        const afterCount = events.length;
        Log.trace(
          `🔍 [QwenParser] Processed assistant message during streaming: extracted ${afterCount - beforeCount} events (total: ${afterCount})`
        );
      }

      // Handle user messages (tool results)
      if (json.type === "user" && json.message?.content) {
        this.processUserContent(json.message.content, events);
      }

      // Handle result event
      if (json.type === "result") {
        Log.debug(
          `[QwenParser] Result event received: session_id=${json.session_id}`
        );
      }
    }

    return events.length > 0 ? events : undefined;
  }

  /**
   * Extract session ID from Qwen Code CLI output
   *
   * @param output Raw CLI output
   * @returns Session ID if found
   */
  extractSessionId(output: string): string | undefined {
    const { objects } = CliResponseParser.extractJsonObjectsFromStream(output);

    for (const json of objects) {
      // Session ID can be in system init or result event
      if (
        (json.type === "system" &&
          json.subtype === "init" &&
          json.session_id) ||
        (json.type === "result" && json.session_id)
      ) {
        return json.session_id;
      }
    }

    return undefined;
  }

  /**
   * Parse token counts from Qwen CLI statistics string
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

  /**
   * Extract extended usage statistics
   *
   * @param usage Usage object from Qwen response
   * @returns Extended usage statistics
   */
  private extractExtendedUsageStats(usage: any): ExtendedUsage {
    return {
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      total_tokens:
        usage.total_tokens ||
        (usage.input_tokens || 0) + (usage.output_tokens || 0),
      ...usage, // Include any additional fields
    };
  }

  /**
   * Check if error is a Qwen Code CLI invalid session error
   *
   * Qwen Code CLI may reject invalid session IDs with specific error messages.
   * When detected, FlightPath can retry without the resume flag to start a new session.
   *
   * @param error The error to check (Error object or string)
   * @returns True if this is a recoverable session error
   */
  isRecoverableSessionError(error: unknown): boolean {
    const message = getErrorMessage(error);
    return (
      message.includes("invalid session") ||
      message.includes("session not found") ||
      message.includes("--resume requires a valid session")
    );
  }
}
