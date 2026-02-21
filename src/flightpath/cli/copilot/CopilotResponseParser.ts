import { CliResult } from "../../../types/CliOutputTypes";
import {
  IResponseParser,
  ResponseParserBase,
} from "../shared/interfaces/IResponseParser";
import {
  UniversalCliOutput,
  CliEvent,
  CLI_EVENT_TYPES,
} from "../../../types/CliOutputTypes";
import { COPILOT_CLI_CONTEXT_WINDOW_SIZE } from "../../../utils/ModelConstants";

/**
 * Copilot CLI Response Parser
 *
 * Parses Copilot CLI plain text output format:
 * - Response: Written to stdout
 * - Statistics: Written to stderr (format: "Total usage est: ...")
 * - Token counts: supports two formats (supports k suffix on all values):
 *   - New: "59.0k in, 207 out, 0 cached"
 *   - Old: "25.7k input, 223 output, 6.1k cache read"
 *
 * Example stderr statistics (as of 2026-02):
 * ```
 * Total usage est: 0 Premium requests
 * Usage by model:
 *     capi-...-claude-sonnet-4.5-... 59.0k in, 207 out, 0 cached (Est. 0 Premium requests)
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
              cachedInputTokens: tokenCounts.cached,
              // For Copilot, "in" is the full context window input for this invocation
              contextWindowUsedTokens: tokenCounts.prompt,
              contextWindowSize: COPILOT_CLI_CONTEXT_WINDOW_SIZE,
            }
          : undefined,
        harness: "copilot-cli",
      },
    };
  }

  /**
   * Parse token counts from Copilot CLI statistics string
   *
   * Handles two formats (supports optional k suffix on all values):
   * - New: "59.0k in, 207 out, 0 cached"
   * - Old: "25.7k input, 223 output, 6.1k cache read"
   *
   * @param statistics Statistics string from stderr
   * @returns Token counts if found, undefined otherwise
   */
  parseTokenCounts(
    statistics: string
  ): { prompt: number; completion: number; cached?: number } | undefined {
    // Match both "in/out" and "input/output" labels, with optional cached/cache read suffix
    const match = statistics.match(
      /([\d.]+)(k)?\s+in(?:put)?,\s+([\d.]+)(k)?\s+out(?:put)?(?:,\s+([\d.]+)(k)?\s+(?:cached?|cache\s+read))?/i
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
      cached: match[5] !== undefined ? parseValue(match[5], match[6]) : undefined,
    };
  }
}
