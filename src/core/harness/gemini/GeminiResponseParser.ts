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
import { getGeminiContextWindowSize } from "../../../utils/ModelConstants";
import { CliResponseParser } from "../shared/CliResponseParser";
import { BaseToolBuilder } from "../shared/BaseToolBuilder";

/**
 * Gemini CLI Response Parser
 *
 * Parses Gemini CLI `--output-format stream-json` output. Each line is a JSON object.
 *
 * **Stream-JSON Event Types:**
 * | Type          | Key fields                                              |
 * |---------------|---------------------------------------------------------|
 * | `init`        | `session_id`, `model`, `timestamp`                      |
 * | `message`     | `role` ("user"/"assistant"), `content`, `delta?: true`  |
 * | `tool_use`    | `tool_name`, `tool_id`, `parameters`                   |
 * | `tool_result` | `tool_id`, `status`, `output`                           |
 * | `result`      | `status`, `stats.{input_tokens, output_tokens, cached}` |
 *
 * **Token Stats (in `result.stats`):**
 * - `input_tokens` — total prompt tokens (includes cache hits)
 * - `output_tokens` — generated tokens
 * - `cached` — cache hit tokens (subset of input_tokens)
 * - `total_tokens`, `duration_ms`, `tool_calls`, `models`
 *
 * **Streaming notes:**
 * - Multiple `message/assistant` objects with `delta: true` arrive as chunks
 * - Each is a partial text chunk; the full text is accumulated across them
 */
export class GeminiResponseParser
  extends ResponseParserBase
  implements IResponseParser
{
  parse(stdout: string, stderr: string, exitCode: number): UniversalCliOutput {
    const events: CliEvent[] = [];
    let sessionId: string | undefined;
    let usage: Record<string, number> | undefined;
    let model: string | undefined;
    let cliVersion: string | undefined;

    const { objects } = CliResponseParser.extractJsonObjectsFromStream(stdout);

    for (const json of objects) {
      if (json.type === "init") {
        sessionId = json.session_id;
        model = json.model;
        cliVersion = json.version;
      }

      if (
        json.type === "message" &&
        json.role === "assistant" &&
        json.content
      ) {
        events.push({
          type: CLI_EVENT_TYPES.TEXT,
          timestamp: Date.now(),
          data: { text: json.content as string },
        });
      }

      if (json.type === "tool_use") {
        events.push(
          ...BaseToolBuilder.buildInitiatedEvents(
            json.tool_name as string,
            (json.parameters as Record<string, unknown>) || {},
            json.tool_id as string | undefined,
            Date.now()
          )
        );
      }

      if (json.type === "tool_result") {
        const isError = json.status === "error";
        events.push({
          type: CLI_EVENT_TYPES.TOOL_RESULT,
          timestamp: Date.now(),
          data: {
            toolCallId: (json.tool_id as string) || "",
            result: {
              // Gemini uses `output` field (not `result`) for tool result content
              success: !isError,
              output: json.output as string | undefined,
              error: isError ? (json.output as string | undefined) : undefined,
            },
          },
        });
      }

      if (json.type === "result") {
        if (json.stats) {
          usage = json.stats as Record<string, number>;
        }
        if (json.session_id) {
          sessionId = json.session_id as string;
        }
      }
    }

    if (exitCode !== 0 && events.length === 0) {
      events.push({
        type: CLI_EVENT_TYPES.TEXT,
        timestamp: Date.now(),
        data: { text: stderr || "Unknown error" },
      });
    }

    let tokenUsage: TokenUsage | undefined;
    if (usage) {
      const inputTokens = (usage.input_tokens as number) || 0;
      const outputTokens = (usage.output_tokens as number) || 0;
      const cachedTokens = (usage.cached as number) || 0;
      tokenUsage = {
        inputTokens,
        outputTokens,
        totalTokens:
          (usage.total_tokens as number) || inputTokens + outputTokens,
        cachedInputTokens: cachedTokens > 0 ? cachedTokens : undefined,
        contextWindowUsedTokens: inputTokens + outputTokens,
        contextWindowSize: getGeminiContextWindowSize(
          model ?? this.resolvedModel
        ),
      };
    }

    return {
      events,
      metadata: {
        sessionId,
        model,
        usage: tokenUsage,
        cliVersion,
        harness: HARNESS_IDS.GEMINI_CLI,
      },
    };
  }

  processStreamingChunk(
    chunk: string,
    streamState: Map<string, any>
  ): CliEvent[] | undefined {
    let streamBuffer = streamState.get("streamBuffer") || "";
    streamBuffer += chunk;

    const { objects, remainder } =
      CliResponseParser.extractJsonObjectsFromStream(streamBuffer);
    streamState.set("streamBuffer", remainder);

    const events: CliEvent[] = [];

    for (const json of objects) {
      if (
        json.type === "message" &&
        json.role === "assistant" &&
        json.content
      ) {
        events.push({
          type: CLI_EVENT_TYPES.TEXT,
          timestamp: Date.now(),
          data: { text: json.content as string },
        });
      }

      if (json.type === "tool_use") {
        events.push(
          ...BaseToolBuilder.buildInitiatedEvents(
            json.tool_name as string,
            (json.parameters as Record<string, unknown>) || {},
            json.tool_id as string | undefined,
            Date.now()
          )
        );
      }

      if (json.type === "tool_result") {
        const isError = json.status === "error";
        events.push({
          type: CLI_EVENT_TYPES.TOOL_RESULT,
          timestamp: Date.now(),
          data: {
            toolCallId: (json.tool_id as string) || "",
            result: {
              success: !isError,
              output: json.output as string | undefined,
              error: isError ? (json.output as string | undefined) : undefined,
            },
          },
        });
      }
    }

    return events.length > 0 ? events : undefined;
  }

  extractSessionId(output: string): string | undefined {
    const { objects } = CliResponseParser.extractJsonObjectsFromStream(output);
    for (const json of objects) {
      if (json.type === "init" && json.session_id) {
        return json.session_id as string;
      }
      // Also present in result event
      if (json.type === "result" && json.session_id) {
        return json.session_id as string;
      }
    }
    return undefined;
  }

  parseTokenCounts(
    output: string
  ): { prompt: number; completion: number } | undefined {
    const { objects } = CliResponseParser.extractJsonObjectsFromStream(output);
    for (const json of objects) {
      if (json.type === "result" && json.stats) {
        const stats = json.stats as Record<string, number>;
        return {
          prompt: stats.input_tokens || 0,
          completion: stats.output_tokens || 0,
        };
      }
    }
    return undefined;
  }
}
