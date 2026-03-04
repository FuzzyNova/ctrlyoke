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

/**
 * Shared Claude tool result processing utilities
 *
 * Used by both ClaudeLogParser (log file parsing) and ClaudeResponseParser
 * (streaming/stdout parsing) to avoid duplicating tool_result → CliEvent
 * conversion logic.
 *
 * @remarks
 * **Two processing stages:**
 * 1. `processToolResultContentBlocks()` — Converts Claude API `tool_result` content blocks
 *    into TOOL_RESULT events (text extraction, error detection)
 * 2. `processToolUseResultMetadata()` — Converts Claude CLI's structured `toolUseResult`
 *    metadata into semantic events (FILE_EDIT, FILE_WRITE, FILE_READ, BASH_COMMAND)
 */

/**
 * Extract display text from a Claude tool_result content block.
 *
 * Claude tool_result content can be:
 * - A string (most common)
 * - An array of content blocks (e.g., `[{type: "text", text: "..."}]`)
 * - null/undefined (empty result)
 * - Other object (serialized as JSON)
 */
export function extractToolResultText(content: unknown): string {
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
export function processToolResultContentBlocks(
  contentBlocks: Record<string, any>[],
  timestamp: number,
  events: CliEvent[]
): void {
  for (const block of contentBlocks) {
    if (block.type === "tool_result") {
      const outputText = extractToolResultText(block.content);
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

/**
 * Process structured toolUseResult metadata into semantic events.
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
export function processToolUseResultMetadata(
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
        originalFile: toolUseResult.originalFile,
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
          exitCode === 0 ? OPERATION_STATUS.COMPLETED : OPERATION_STATUS.FAILED,
      } as BashCommandData,
    });
    return;
  }
}
