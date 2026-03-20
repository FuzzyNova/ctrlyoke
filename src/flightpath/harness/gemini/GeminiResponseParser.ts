import {
  IResponseParser,
  ResponseParserBase,
} from "../shared/interfaces/IResponseParser";
import {
  UniversalCliOutput,
  CliEvent,
  TokenUsage,
} from "../../../types/CliOutputTypes";
import { CLI_EVENT_TYPES, HARNESS_IDS } from "../../../types/DashboardConstants";
import { Log } from "../../../utils/Log";
import { getGeminiContextWindowSize } from "../../../utils/ModelConstants";
import { CliResponseParser } from "../shared/CliResponseParser";
import { GeminiToolBuilder } from "./GeminiToolBuilder";

/**
 * Gemini CLI Response Parser
 *
 * Parses Gemini CLI stream-json output format.
 */
export class GeminiResponseParser
  extends ResponseParserBase
  implements IResponseParser
{
  parse(stdout: string, stderr: string, exitCode: number): UniversalCliOutput {
    const events: CliEvent[] = [];
    let sessionId: string | undefined;
    let usage: any | undefined;
    let model: string | undefined;
    let cliVersion: string | undefined;

    const { objects } = CliResponseParser.extractJsonObjectsFromStream(stdout);

    for (const json of objects) {
      if (json.type === "init") {
        sessionId = json.session_id;
        model = json.model;
        cliVersion = json.version;
      }

      if (json.type === "message" && json.role === "assistant") {
        if (json.content) {
          events.push({
            type: CLI_EVENT_TYPES.TEXT,
            timestamp: Date.now(),
            data: { text: json.content },
          });
        }
      }

      if (json.type === "tool_use") {
        events.push(
          GeminiToolBuilder.buildInitiatedEvent(
            json.tool_name,
            json.parameters || {},
            json.tool_id,
            Date.now()
          )
        );
      }

      if (json.type === "tool_result") {
        events.push({
          type: CLI_EVENT_TYPES.TOOL_RESULT,
          timestamp: Date.now(),
          data: {
            toolCallId: json.tool_id,
            result: {
              success: json.status === "success",
              output: json.result,
              error: json.status === "error" ? json.result : undefined,
            },
          },
        });
      }

      if (json.type === "result") {
        if (json.stats) {
          usage = json.stats;
        }
        if (json.session_id) {
          sessionId = json.session_id;
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
      tokenUsage = {
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        totalTokens: usage.total_tokens || (usage.input_tokens || 0) + (usage.output_tokens || 0),
        contextWindowSize: getGeminiContextWindowSize(model ?? ""),
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
      if (json.type === "message" && json.role === "assistant" && json.content) {
        events.push({
          type: CLI_EVENT_TYPES.TEXT,
          timestamp: Date.now(),
          data: { text: json.content },
        });
      }

      if (json.type === "tool_use") {
        events.push(
          GeminiToolBuilder.buildInitiatedEvent(
            json.tool_name,
            json.parameters || {},
            json.tool_id,
            Date.now()
          )
        );
      }

      if (json.type === "tool_result") {
        events.push({
          type: CLI_EVENT_TYPES.TOOL_RESULT,
          timestamp: Date.now(),
          data: {
            toolCallId: json.tool_id,
            result: {
              success: json.status === "success",
              output: json.result,
              error: json.status === "error" ? json.result : undefined,
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
      if (json.session_id) return json.session_id;
    }
    return undefined;
  }

  parseTokenCounts(
    output: string
  ): { prompt: number; completion: number } | undefined {
    const { objects } = CliResponseParser.extractJsonObjectsFromStream(output);
    for (const json of objects) {
      if (json.type === "result" && json.stats) {
        return {
          prompt: json.stats.input_tokens || 0,
          completion: json.stats.output_tokens || 0,
        };
      }
    }
    return undefined;
  }
}
