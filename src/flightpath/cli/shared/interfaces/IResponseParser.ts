import { CliResult } from "../../../../types/CopilotTypes";

/**
 * Response parsing interface
 *
 * Each CLI provider implements this to parse their specific output format
 * (e.g., plain text for Copilot, JSON for Claude, JSONL for Codex)
 */
export interface IResponseParser {
  /**
   * Parse CLI output into structured result
   * @param stdout CLI stdout
   * @param stderr CLI stderr
   * @param exitCode Process exit code
   * @returns Parsed result with optional session ID
   */
  parse(
    stdout: string,
    stderr: string,
    exitCode: number
  ): CliResult & { sessionId?: string };

  /**
   * Process streaming chunk for real-time display
   * @param chunk Raw stdout chunk
   * @param streamState Accumulated state (persists across chunks)
   * @returns Processed content to emit, or undefined to skip
   */
  processStreamingChunk?(
    chunk: string,
    streamState: Map<string, any>
  ): string | undefined;

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
   * Check if an error is a recoverable session error that should trigger retry without resume flag
   *
   * Some providers (e.g., Claude CLI) reject invalid session IDs with specific error messages.
   * When detected, FlightPath can retry the same prompt without the --resume flag to start a new session.
   *
   * @param error The error to check (Error object or string)
   * @returns True if this is a recoverable session error (retry without resume), false otherwise
   */
  isRecoverableSessionError?(error: unknown): boolean;
}

/**
 * Shared utilities for response parsers (optional base class)
 *
 * Provides common utility methods that most response parsers need.
 * Providers can extend this class to avoid duplicating common logic.
 */
export abstract class ResponseParserBase implements IResponseParser {
  abstract parse(
    stdout: string,
    stderr: string,
    exitCode: number
  ): CliResult & { sessionId?: string };

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
    return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
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

  /**
   * Default implementation: No recoverable session errors
   *
   * Most providers don't have special error recovery logic.
   * Override this method in provider-specific parsers to implement custom recovery.
   *
   * @param error The error to check
   * @returns False by default (no recovery)
   */
  isRecoverableSessionError(error: unknown): boolean {
    return false;
  }
}
