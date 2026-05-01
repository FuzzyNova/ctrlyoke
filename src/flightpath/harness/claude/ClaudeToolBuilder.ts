import type {
  CliEvent,
  ToolResultData,
  FileEditData,
  FileWriteData,
  FileReadData,
  BashCommandData,
} from "../../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  OPERATION_STATUS,
} from "../../../types/DashboardConstants";
import { Log } from "../../../utils/Log";
import { BaseToolBuilder } from "../shared/BaseToolBuilder";

/**
 * Builds CliEvents from Claude CLI tool call payloads.
 *
 * Three static methods cover Claude's tool lifecycle:
 * - `buildInitiatedEvents` — tool_use in assistant content → INITIATED event(s) (array)
 * - `processToolResultBlocks` — tool_result in user content → TOOL_RESULT events
 * - `processToolUseResultMetadata` — CLI structured metadata → COMPLETED semantic events
 *
 * Both ClaudeLogParser and ClaudeResponseParser use these methods so the
 * event-shaping logic is never duplicated.
 *
 * Note: Claude's lifecycle differs from Copilot's — there is no start/complete
 * pair correlated by toolCallId. Instead, tool_use and tool_result are separate
 * message-level constructs, and structured completion metadata arrives as a
 * separate CLI-injected field (toolUseResult).
 */
export class ClaudeToolBuilder {
  // ── INITIATED ──────────────────────────────────────────────────────────────

  /**
   * Build INITIATED CliEvents for a Claude tool_use block.
   *
   * Returns an array to support multi-file tools like `multiedit`, which fans
   * out to one FILE_EDIT event per edited file. All other tools return a
   * single-element array.
   *
   * @param toolName - Tool name from tool_use block
   * @param input - Tool input parameters from tool_use block
   * @param toolId - Tool call ID (used in generic TOOL_CALL fallback)
   * @param timestamp - Event timestamp in milliseconds
   * @param callerType - 'direct' for top-level calls, 'subagent' for sub-agent calls
   * @returns Array of CliEvents to spread onto the event stream
   */
  static buildInitiatedEvents(
    toolName: string,
    input: Record<string, unknown>,
    toolId: string | undefined,
    timestamp: number,
    callerType?: string
  ): CliEvent[] {
    const ct = callerType ? { callerType } : {};

    // Claude-specific: multiedit fans out to one FILE_EDIT per edited file
    if (toolName === "multiedit" && Array.isArray(input.edits)) {
      return (input.edits as Record<string, unknown>[]).map((edit) => ({
        type: CLI_EVENT_TYPES.FILE_EDIT,
        timestamp,
        ...ct,
        data: {
          path:
            ((edit.file_path ?? edit.path) as string | undefined) || "unknown",
          oldContent: (edit.old_string ??
            edit.oldString ??
            edit.old_content ??
            edit.oldContent) as string | undefined,
          newContent: (edit.new_string ??
            edit.newString ??
            edit.new_content ??
            edit.newContent) as string | undefined,
          status: OPERATION_STATUS.INITIATED,
        } as FileEditData,
      }));
    }

    return BaseToolBuilder.buildInitiatedEvents(toolName, input, toolId, timestamp, ct);
  }

  // ── TOOL RESULTS ───────────────────────────────────────────────────────────

  /**
   * Extract display text from a Claude tool_result content block.
   *
   * Claude tool_result content can be:
   * - A string (most common)
   * - An array of content blocks (e.g., `[{type: "text", text: "..."}]`)
   * - null/undefined (empty result)
   * - Other object (serialized as JSON)
   */
  static extractToolResultText(content: unknown): string {
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .filter(
          (b: Record<string, unknown>) =>
            b.type === "text" && typeof b.text === "string"
        )
        .map((b: Record<string, unknown>) => b.text)
        .join("\n");
    }
    if (content != null) {
      return JSON.stringify(content);
    }
    return "";
  }

  /**
   * Process tool_result content blocks into TOOL_RESULT events.
   *
   * Processes content array from user-type messages, creating a TOOL_RESULT event
   * for each `tool_result` block. Handles the `is_error` flag from Claude API.
   *
   * @param contentBlocks - Array of content blocks from a user message
   * @param timestamp - Timestamp to use for created events
   * @param events - Array to append events to
   */
  static processToolResultBlocks(
    contentBlocks: Record<string, any>[],
    timestamp: number,
    events: CliEvent[]
  ): void {
    for (const block of contentBlocks) {
      if (block.type === "tool_result") {
        const outputText = ClaudeToolBuilder.extractToolResultText(
          block.content
        );
        events.push({
          type: CLI_EVENT_TYPES.TOOL_RESULT,
          timestamp,
          data: {
            toolCallId: block.tool_use_id,
            result: {
              success: !block.is_error,
              output: outputText,
              error: block.is_error ? outputText : undefined,
            },
          } as ToolResultData,
        });
      }
    }
  }

  // ── COMPLETED (structured CLI metadata) ────────────────────────────────────

  /**
   * Process structured toolUseResult metadata into COMPLETED semantic events.
   *
   * Converts Claude CLI's tool execution metadata into typed CliEvents:
   * - File edit (Edit tool) → FILE_EDIT event with structured diff data
   * - File write (Write tool) → FILE_WRITE event
   * - File read (Read tool) → FILE_READ event
   * - Bash command → BASH_COMMAND event with exit code
   *
   * Handles both camelCase (headless mode) and snake_case (interactive terminal)
   * field names for Edit tool parameters.
   *
   * @param toolUseResult - Structured tool execution metadata from Claude CLI
   * @param timestamp - Timestamp to use for created events
   * @param events - Array to append events to
   */
  static processToolUseResultMetadata(
    toolUseResult: Record<string, any>,
    timestamp: number,
    events: CliEvent[]
  ): void {
    // File edit result (Edit tool) - check both camelCase and snake_case
    // Headless mode uses camelCase (oldString/newString)
    // Interactive terminal uses snake_case (old_string/new_string)
    const oldString = toolUseResult.oldString || toolUseResult.old_string;
    const newString = toolUseResult.newString || toolUseResult.new_string;

    if (oldString && newString) {
      Log.debug(
        `[ClaudeToolResult] Edit operation - oldString=${oldString ? "present" : "missing"}, ` +
          `newString=${newString ? "present" : "missing"}, ` +
          `structuredPatch=${toolUseResult.structuredPatch ? `${toolUseResult.structuredPatch.length} hunks` : "missing"}`
      );

      events.push({
        type: CLI_EVENT_TYPES.FILE_EDIT,
        timestamp,
        data: {
          path: toolUseResult.filePath || "unknown",
          oldContent: oldString,
          newContent: newString,
          structuredPatch: toolUseResult.structuredPatch,
          userModified: toolUseResult.userModified,
          replaceAll: toolUseResult.replaceAll,
          status: OPERATION_STATUS.COMPLETED,
          success: true,
        } as FileEditData,
      });
      return;
    }

    // File write result (Write tool)
    // Must have a file path to avoid matching Grep results (which also have a `content` field)
    // Check both "create" (log format) and "write" (stream format) type values
    if (
      (toolUseResult.type === "create" ||
        toolUseResult.type === "write" ||
        toolUseResult.content) &&
      (toolUseResult.filePath || toolUseResult.path)
    ) {
      events.push({
        type: CLI_EVENT_TYPES.FILE_WRITE,
        timestamp,
        data: {
          path: toolUseResult.filePath || toolUseResult.path || "unknown",
          content: toolUseResult.content || "",
          status: OPERATION_STATUS.COMPLETED,
          success: true,
        } as FileWriteData,
      });
      return;
    }

    // File read result (Read tool)
    if (toolUseResult.type === "text" && toolUseResult.file) {
      events.push({
        type: CLI_EVENT_TYPES.FILE_READ,
        timestamp,
        data: {
          path: toolUseResult.file.filePath || "unknown",
          content: toolUseResult.file.content || "",
          status: OPERATION_STATUS.COMPLETED,
          success: true,
        } as FileReadData,
      });
      return;
    }

    // Bash command result
    if (toolUseResult.command || toolUseResult.type === "bash") {
      const exitCode = toolUseResult.exitCode ?? (toolUseResult.error ? 1 : 0);
      events.push({
        type: CLI_EVENT_TYPES.BASH_COMMAND,
        timestamp,
        data: {
          command: toolUseResult.command || "unknown",
          workingDir: toolUseResult.workingDir || toolUseResult.cwd,
          exitCode,
          // Prefer stdout over output — stdout has full content while output may contain <persisted-output> placeholder
          output: toolUseResult.stdout || toolUseResult.output,
          error: toolUseResult.stderr || toolUseResult.error,
          status:
            exitCode === 0
              ? OPERATION_STATUS.COMPLETED
              : OPERATION_STATUS.FAILED,
        } as BashCommandData,
      });
      return;
    }
  }
}
