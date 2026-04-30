import type {
  CliEvent,
  BashCommandData,
  FileReadData,
  FileWriteData,
  FileEditData,
  FileDeleteData,
  McpToolCallData,
  WebSearchData,
  ToolCall,
} from "../../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  OPERATION_STATUS,
} from "../../../types/DashboardConstants";
import { CliEventMapper } from "../shared/CliEventMapper";

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
    toolInput: Record<string, any>,
    toolCallId: string,
    timestamp: number
  ): CliEvent[] {
    const classification = CliEventMapper.classifyTool(toolName);
    // Resolve file path across all Qwen parameter name variants (most specific first)
    const filePath = (toolInput.absolute_path ??
      toolInput.file_path ??
      toolInput.path ??
      toolInput.pattern) as string | undefined;

    switch (classification.type) {
      case CLI_EVENT_TYPES.BASH_COMMAND:
        return [
          {
            type: CLI_EVENT_TYPES.BASH_COMMAND,
            timestamp,
            data: {
              command:
                ((toolInput.command ?? toolInput.cmd) as string | undefined) ||
                "unknown",
              workingDir: (toolInput.working_dir ??
                toolInput.cwd ??
                toolInput.workingDir) as string | undefined,
              status: OPERATION_STATUS.INITIATED,
            } as BashCommandData,
          },
        ];

      case CLI_EVENT_TYPES.FILE_READ:
        return [
          {
            type: CLI_EVENT_TYPES.FILE_READ,
            timestamp,
            data: {
              path: filePath || "unknown",
              status: OPERATION_STATUS.INITIATED,
            } as FileReadData,
          },
        ];

      case CLI_EVENT_TYPES.FILE_WRITE:
        return [
          {
            type: CLI_EVENT_TYPES.FILE_WRITE,
            timestamp,
            data: {
              path: filePath || "unknown",
              content:
                ((toolInput.content ?? toolInput.file_text) as
                  | string
                  | undefined) || "",
              status: OPERATION_STATUS.INITIATED,
            } as FileWriteData,
          },
        ];

      case CLI_EVENT_TYPES.FILE_EDIT: {
        const oldContent = (toolInput.oldString ??
          toolInput.old_string ??
          toolInput.oldContent ??
          toolInput.old_content ??
          toolInput.old_str) as string | undefined;
        const newContent = (toolInput.newString ??
          toolInput.new_string ??
          toolInput.newContent ??
          toolInput.new_content ??
          toolInput.new_str) as string | undefined;
        return [
          {
            type: CLI_EVENT_TYPES.FILE_EDIT,
            timestamp,
            data: {
              path: filePath || "unknown",
              oldContent,
              newContent,
              status: OPERATION_STATUS.INITIATED,
            } as FileEditData,
          },
        ];
      }

      case CLI_EVENT_TYPES.FILE_DELETE:
        return [
          {
            type: CLI_EVENT_TYPES.FILE_DELETE,
            timestamp,
            data: {
              path: filePath || "unknown",
            } as FileDeleteData,
          },
        ];

      case CLI_EVENT_TYPES.WEB_SEARCH:
        return [
          {
            type: CLI_EVENT_TYPES.WEB_SEARCH,
            timestamp,
            data: {
              query: (toolInput.query as string) || "",
            } as WebSearchData,
          },
        ];

      case CLI_EVENT_TYPES.MCP_TOOL_CALL: {
        const mcp = classification as {
          type: typeof CLI_EVENT_TYPES.MCP_TOOL_CALL;
          server: string;
          tool: string;
        };
        return [
          {
            type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
            timestamp,
            data: {
              server: mcp.server,
              tool: mcp.tool,
              parameters: toolInput,
            } as McpToolCallData,
          },
        ];
      }

      default:
        return [
          {
            type: CLI_EVENT_TYPES.TOOL_CALL,
            timestamp,
            data: {
              name: toolName,
              parameters: toolInput,
              id: toolCallId,
            } as ToolCall,
          },
        ];
    }
  }
}
