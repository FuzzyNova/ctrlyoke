import type { CliEvent } from "../../../types/CliOutputTypes";
import { BaseToolBuilder } from "../shared/BaseToolBuilder";

/**
 * Builds CliEvents from Gemini CLI tool call payloads.
 */
export class GeminiToolBuilder {
  /**
   * Build initiated CliEvents for a Gemini tool call.
   *
   * Returns an array so callers can spread: `events.push(...buildInitiatedEvents(...))`.
   * Most tools produce a single-element array; future multi-file tools can fan out here.
   */
  static buildInitiatedEvents(
    toolName: string,
    input: Record<string, unknown>,
    toolId: string | undefined,
    timestamp: number
  ): CliEvent[] {
    return BaseToolBuilder.buildInitiatedEvents(
      toolName,
      input,
      toolId,
      timestamp
    );
  }
}
