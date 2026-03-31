import {
  IResponseParser,
  ResponseParserBase,
} from "../shared/interfaces/IResponseParser";
import {
  UniversalCliOutput,
  CliEvent,
  TokenUsage,
} from "../../../types/CliOutputTypes";
import { CLI_EVENT_TYPES } from "../../../types/DashboardConstants";
import { Log } from "../../../utils/Log";
import {
  mapOpenCodeToolPartToCliEvent,
  accumulateOpenCodeStepTokens,
} from "./OpenCodeEventMapper";

/**
 * OpenCode CLI Response Parser
 *
 * Parses JSONL output from `opencode run --format json`.
 *
 * Event format (one JSON object per line):
 * - step_start: Step begins
 * - text: AI text response (part.text)
 * - tool_use: Tool call with input AND output (part.tool, part.state.input, part.state.output)
 * - step_finish: Step ends (part.reason "stop" = complete, "tool-calls" = more steps follow)
 *
 * Session ID: extracted from top-level `sessionID` field on any event.
 * Session ID format: ses_<alphanumeric> (e.g., ses_34106de37ffeG7oh0Bvq9cmRki)
 *
 * Context window: size is supplied via contextWindowSizeFn (injected from OpenCodeCliProvider,
 * which discovers it via `opencode models --verbose`). The `tokens.total` field in the last
 * step_finish event represents the full context occupancy for that turn.
 */
export class OpenCodeResponseParser
  extends ResponseParserBase
  implements IResponseParser
{
  /**
   * Returns the context window size (in tokens) for the current model.
   * Injected from OpenCodeCliProvider so parsers don't call the CLI themselves.
   */
  private readonly contextWindowSizeFn: () => number | undefined;

  constructor(contextWindowSizeFn: () => number | undefined = () => undefined) {
    super();
    this.contextWindowSizeFn = contextWindowSizeFn;
  }

  /**
   * Parse complete JSONL output into structured result
   */
  parse(
    stdout: string,
    _stderr: string,
    _exitCode: number
  ): UniversalCliOutput {
    const events: CliEvent[] = [];
    let sessionId: string | undefined;
    const tokenUsage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    let lastStepTotal: number | undefined;

    const lines = stdout.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const event = JSON.parse(line);

        // Extract session ID from any event
        if (event.sessionID && !sessionId) {
          sessionId = event.sessionID;
        }

        const cliEvent = this.mapEventToCliEvent(event);
        if (cliEvent) {
          events.push(cliEvent);
        }

        if (event.type === "step_finish" && event.part?.tokens) {
          const stepTotal = accumulateOpenCodeStepTokens(
            event.part.tokens,
            tokenUsage
          );
          if (stepTotal !== undefined) lastStepTotal = stepTotal;
        }
      } catch {
        Log.debug(
          `OpenCode: skipping non-JSON line: ${line.substring(0, 100)}`
        );
      }
    }

    if (lastStepTotal !== undefined) {
      tokenUsage.contextWindowUsedTokens = lastStepTotal;
    }
    const contextWindowSize = this.contextWindowSizeFn();
    if (contextWindowSize !== undefined) {
      tokenUsage.contextWindowSize = contextWindowSize;
    }

    return {
      events,
      metadata: {
        sessionId,
        usage: tokenUsage,
      },
    };
  }

  /**
   * Process a streaming chunk for real-time display.
   * Buffers partial lines across chunks and emits CliEvent[] when complete lines are available.
   */
  processStreamingChunk(
    chunk: string,
    streamState: Map<string, any>
  ): string | CliEvent[] | undefined {
    // Buffer partial lines across chunks
    const buffer: string = (streamState.get("buffer") ?? "") + chunk;
    const lines = buffer.split("\n");

    // Keep the last (possibly partial) line in the buffer
    streamState.set("buffer", lines[lines.length - 1]);

    const events: CliEvent[] = [];
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        const event = JSON.parse(line);

        // Track session ID in stream state
        if (event.sessionID && !streamState.has("sessionId")) {
          streamState.set("sessionId", event.sessionID);
        }

        const cliEvent = this.mapEventToCliEvent(event);
        if (cliEvent) {
          events.push(cliEvent);
        }
      } catch {
        Log.debug(
          `OpenCode stream: skipping non-JSON line: ${line.substring(0, 100)}`
        );
      }
    }

    return events.length > 0 ? events : undefined;
  }

  /**
   * Extract session ID by scanning output for any line with sessionID field.
   */
  extractSessionId(output: string): string | undefined {
    const lines = output.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.sessionID) {
          return event.sessionID as string;
        }
      } catch {
        // Skip non-JSON lines
      }
    }
    return undefined;
  }

  /**
   * Parse token counts from output (compatibility method)
   */
  parseTokenCounts(
    output: string
  ): { prompt: number; completion: number } | undefined {
    let inputTokens = 0;
    let outputTokens = 0;
    let found = false;

    const lines = output.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === "step_finish" && event.part?.tokens) {
          inputTokens += event.part.tokens.input ?? 0;
          outputTokens += event.part.tokens.output ?? 0;
          found = true;
        }
      } catch {
        // Skip
      }
    }

    return found
      ? { prompt: inputTokens, completion: outputTokens }
      : undefined;
  }

  /**
   * Map an opencode JSONL event to a CliEvent for display.
   * Returns undefined for events that don't need to be displayed.
   */
  private mapEventToCliEvent(event: any): CliEvent | undefined {
    if (!event.type) return undefined;

    switch (event.type) {
      case "text": {
        const text = event.part?.text;
        if (!text) return undefined;
        return {
          type: CLI_EVENT_TYPES.TEXT,
          timestamp: event.timestamp,
          data: { text },
        };
      }
      case "tool_use": {
        const part = event.part;
        if (!part) return undefined;
        return mapOpenCodeToolPartToCliEvent(event.timestamp, part);
      }
      // step_start, step_finish are structural — not displayed as events
      default:
        return undefined;
    }
  }
}
