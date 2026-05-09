import type { CliEvent } from "../../../types/CliOutputTypes";
import { BaseToolBuilder } from "../shared/BaseToolBuilder";

/**
 * Builds CliEvents from Qwen CLI tool call payloads.
 *
 * Shared by QwenLogParser (Gemini-style log format) and QwenResponseParser
 * (stream-json CLI output) so the tool-to-event mapping is never duplicated.
 *
 * Qwen tool parameter names (unified across both formats):
 * - `absolute_path` — read_file tool
 * - `file_path`     — edit, write_file tools
 * - `path`          — generic path tools
 * - `pattern`       — search/glob tools
 */
export class QwenToolBuilder {
  /**
   * Build INITIATED CliEvents for a Qwen tool call.
   *
   * Returns an array to support multi-file tool calls (e.g. a future bulk-edit
   * tool). All current Qwen tools are single-file, so the array always has one
   * element, but callers must spread the result: `events.push(...buildInitiatedEvents(...))`.   *
   * @param toolName  - Tool name (e.g. "read_file", "edit", "bash")
   * @param toolInput - Tool input parameters
   * @param toolCallId - Tool call ID (used in generic TOOL_CALL fallback)
   * @param timestamp - Event timestamp in milliseconds
   * @returns Array of CliEvents to push onto the event stream
   */
  static buildInitiatedEvents(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolCallId: string,
    timestamp: number
  ): CliEvent[] {
    return BaseToolBuilder.buildInitiatedEvents(
      toolName,
      toolInput,
      toolCallId,
      timestamp
    );
  }
}
