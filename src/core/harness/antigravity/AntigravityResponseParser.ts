import {
  IResponseParser,
  ResponseParserBase,
} from "../shared/interfaces/IResponseParser";
import {
  CliEvent,
  UniversalCliOutput,
} from "../../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  HARNESS_IDS,
} from "../../../types/DashboardConstants";

export class AntigravityResponseParser
  extends ResponseParserBase
  implements IResponseParser
{
  parse(stdout: string, stderr: string, exitCode: number): UniversalCliOutput {
    const text = stdout.trim() || stderr.trim();
    const events: CliEvent[] = text
      ? [
          {
            type: CLI_EVENT_TYPES.TEXT,
            timestamp: Date.now(),
            data: { text },
          },
        ]
      : [];

    if (exitCode !== 0 && events.length === 0) {
      events.push({
        type: CLI_EVENT_TYPES.TEXT,
        timestamp: Date.now(),
        data: { text: "Antigravity CLI exited without output" },
      });
    }

    return {
      events,
      metadata: {
        harness: HARNESS_IDS.ANTIGRAVITY_CLI,
      },
    };
  }

  processStreamingChunk(
    chunk: string,
    _streamState: Map<string, any>
  ): string | CliEvent[] | undefined {
    return chunk.length > 0 ? chunk : undefined;
  }

  extractSessionId(_output: string): string | undefined {
    return undefined;
  }

  parseTokenCounts(
    _output: string
  ): { prompt: number; completion: number } | undefined {
    return undefined;
  }
}
