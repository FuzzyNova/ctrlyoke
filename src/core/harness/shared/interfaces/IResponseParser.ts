import { UniversalCliOutput, CliEvent } from "../../../../types/CliOutputTypes";
import { stripAnsiCodes } from "../../../../utils/TerminalOutputSanitizer";

/**
 * Response parsing interface
 *
 * Each CLI harness implements this to parse their specific output format
 * (e.g., plain text for Copilot, JSON for Claude, JSONL for Codex)
 */
export interface IResponseParser {
  /**
   * Parse CLI output into structured result with events
   * @param stdout CLI stdout
   * @param stderr CLI stderr
   * @param exitCode Process exit code
   * @returns Structured output with events array and metadata
   */
  parse(stdout: string, stderr: string, exitCode: number): UniversalCliOutput;

  /**
   * Process streaming chunk for real-time display
   *
   * **Return types:**
   * - `string`: Plain text for plain-text harnesses (Copilot CLI) - rendered as fallback text
   * - `CliEvent[]`: Structured events for modern harnesses (Claude, Codex) - rendered with terminal styling
   * - `undefined`: Skip this chunk (incomplete data, waiting for more)
   *
   * @param chunk Raw stdout chunk
   * @param streamState Accumulated state (persists across chunks)
   * @returns Processed content (string or events) to emit, or undefined to skip
   */
  processStreamingChunk?(
    chunk: string,
    streamState: Map<string, any>
  ): string | CliEvent[] | undefined;

  /**
   * Extract session/thread ID from CLI output
   * @param output Raw CLI output
   * @returns Session ID if found
   */
  extractSessionId?(output: string): string | undefined;

  /**
   * Parse token counts from output
   * @param output CLI output or statistics string
   * @returns Token counts if found
   */
  parseTokenCounts(
    output: string
  ): { prompt: number; completion: number } | undefined;

  /**
   * Set the resolved model ID for the current execution.
   *
   * Called by CliResponseCollector before parsing headless output.
   * Stored as the fallback model when the output stream does not embed the model name.
   */
  setCurrentModel?(model: string): void;
}

/**
 * Shared utilities for response parsers (optional base class)
 *
 * Provides common utility methods that most response parsers need.
 * Providers can extend this class to avoid duplicating common logic.
 */
export abstract class ResponseParserBase implements IResponseParser {
  /**
   * Resolved model ID for the current execution.
   * Set by CliResponseCollector before parsing; used as the fallback model
   * in context-window lookups when the output stream does not embed the model name.
   */
  protected resolvedModel = "";

  setCurrentModel(model: string): void {
    this.resolvedModel = model;
  }

  abstract parse(
    stdout: string,
    stderr: string,
    exitCode: number
  ): UniversalCliOutput;

  abstract parseTokenCounts(
    output: string
  ): { prompt: number; completion: number } | undefined;

  /**
   * Format usage statistics for display
   * @param usage Token usage object with input/output tokens
   * @param model Optional model name to include in output
   * @returns Formatted statistics string
   */
  protected formatStatistics(
    usage:
      | {
          input_tokens: number;
          output_tokens: number;
          total_tokens?: number;
        }
      | undefined,
    model?: string
  ): string {
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
   * Clean ANSI escape codes from output
   * @param text Text with potential ANSI codes
   * @returns Cleaned text
   */
  protected stripAnsiCodes(text: string): string {
    return stripAnsiCodes(text);
  }

  /**
   * Extract JSON object from mixed text output
   * @param output Text that may contain JSON
   * @returns Parsed JSON object or null
   */
  protected extractJsonFromOutput(output: string): any | null {
    try {
      // Try to find JSON between curly braces
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      return null;
    } catch {
      return null;
    }
  }

}
