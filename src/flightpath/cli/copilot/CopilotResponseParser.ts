import { CliResult } from "../../../types/CopilotTypes";
import {
  IResponseParser,
  ResponseParserBase,
} from "../shared/interfaces/IResponseParser";

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
   * Parse Copilot CLI text output
   *
   * @param stdout CLI stdout (response only)
   * @param stderr CLI stderr (statistics + errors)
   * @param exitCode Process exit code
   * @returns Parsed CLI result
   */
  parse(
    stdout: string,
    stderr: string,
    exitCode: number
  ): CliResult & { sessionId?: string } {
    // Statistics are written to stderr (not stdout!)
    // Response is in stdout, statistics in stderr
    return {
      success: exitCode === 0,
      response: stdout.trim(),
      statistics: stderr.trim(), // Statistics are in stderr!
      error: exitCode !== 0 ? stderr : undefined,
      exitCode,
      // Note: Session ID is extracted from log files, not CLI output
      sessionId: undefined,
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
