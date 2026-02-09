import { CliResult } from "../../../types/CopilotTypes";
import {
  IResponseParser,
  ResponseParserBase,
} from "../shared/interfaces/IResponseParser";
import {
  UniversalCliOutput,
  CliEvent,
  CLI_EVENT_TYPES,
} from "../../../types/CliOutputTypes";

/**
 * Copilot CLI Response Parser
 *
 * Parses Copilot CLI plain text output format:
 * - Response: Written to stdout
 * - Statistics: Written to stderr (format: "Total usage est: ...")
 * - Token counts: "Usage by model: 25.7k input, 223 output" (supports k suffix)
 *
 * Example stderr statistics (as of 2025-12):
 * ```
 * Total usage est: 1 Premium request
 * Usage by model:
 *     capi-...-gpt-5-mini-... 25.7k input, 223 output, 6.1k cache read (Est. 1 Premium request)
 * ```
 */
export class CopilotResponseParser
  extends ResponseParserBase
  implements IResponseParser
{
  /**
   * Parse Copilot CLI text output into structured events
   *
   * @param stdout CLI stdout (response only)
   * @param stderr CLI stderr (statistics + errors)
   * @param exitCode Process exit code
   * @returns Structured output with events array and metadata
   */
  parse(
    stdout: string,
    stderr: string,
    exitCode: number
  ): UniversalCliOutput {
    const events: CliEvent[] = [];

    // Copilot outputs plain text (no structured events)
    // Create a single TEXT event for the response
    if (stdout.trim()) {
      events.push({
        type: CLI_EVENT_TYPES.TEXT,
        timestamp: Date.now(),
        data: { text: stdout.trim() },
      });
    }

    // If error, add error event
    if (exitCode !== 0 && stderr.trim()) {
      events.push({
        type: CLI_EVENT_TYPES.TEXT,
        timestamp: Date.now(),
        data: { text: `Error: ${stderr.trim()}` },
      });
    }

    // Parse token usage from stderr statistics
    const tokenCounts = this.parseTokenCounts(stderr);

    return {
      events,
      metadata: {
        // Note: Session ID is extracted from log files, not CLI output
        sessionId: undefined,
        usage: tokenCounts
          ? {
              inputTokens: tokenCounts.prompt,
              outputTokens: tokenCounts.completion,
              totalTokens: tokenCounts.prompt + tokenCounts.completion,
            }
          : undefined,
        harness: "copilot-cli",
      },
    };
  }

  /**
   * Parse token counts from Copilot CLI statistics string
   *
   * Format (as of 2025-12):
   * "Usage by model:
   *     capi-...-gpt-5-mini-... 25.7k input, 223 output, 6.1k cache read (Est. 1 Premium request)"
   *
   * @param statistics Statistics string from stderr
   * @returns Token counts if found, undefined otherwise
   */
  parseTokenCounts(
    statistics: string
  ): { prompt: number; completion: number } | undefined {
    // Parse format: "25.7k input, 223 output"
    // The regex captures number (with optional decimal) and checks for k suffix separately
    const match = statistics.match(
      /([\d.]+)(k)?\s+input,\s+([\d.]+)(k)?\s+output/i
    );
    if (!match) {
      return undefined;
    }

    const parseValue = (
      numStr: string,
      hasSuffix: string | undefined
    ): number => {
      const num = parseFloat(numStr);
      // If suffix exists (captured as 'k'), multiply by 1000
      return hasSuffix ? Math.round(num * 1000) : num;
    };

    return {
      prompt: parseValue(match[1], match[2]),
      completion: parseValue(match[3], match[4]),
    };
  }
}
