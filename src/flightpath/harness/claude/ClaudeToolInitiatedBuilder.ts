import {
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
 * Builds INITIATED CliEvents for Claude CLI tool_use blocks.
 *
 * Both ClaudeLogParser (assistant event content blocks) and ClaudeResponseParser
 * (processAssistantContent + streaming content_block_stop) emit INITIATED events —
 * this class is the single source for that logic.
 *
 * Claude's tool lifecycle: tool_use in assistant content → INITIATED here.
 * Results arrive separately in tool_result user content blocks,
 * handled by ClaudeToolResultProcessor.
 */
export class ClaudeToolInitiatedBuilder {
  /**
   * Build an INITIATED CliEvent for a Claude tool_use block.
   *
   * @param toolName - Tool name from tool_use block
   * @param input - Tool input parameters from tool_use block
   * @param toolId - Tool call ID (used in generic TOOL_CALL fallback)
   * @param timestamp - Event timestamp in milliseconds
   * @returns A single CliEvent to push onto the event stream
   */
  static buildEvent(
    toolName: string,
    input: Record<string, unknown>,
    toolId: string | undefined,
    timestamp: number
  ): CliEvent {
    const classification = CliEventMapper.classifyTool(toolName);
    const path = (input.path ?? input.file_path) as string | undefined;

    switch (classification.type) {
      case CLI_EVENT_TYPES.BASH_COMMAND:
        return {
          type: CLI_EVENT_TYPES.BASH_COMMAND,
          timestamp,
          data: {
            command:
              ((input.command ?? input.cmd) as string | undefined) || "unknown",
            workingDir: (input.working_dir ?? input.cwd ?? input.workingDir) as
              | string
              | undefined,
            status: OPERATION_STATUS.INITIATED,
          } as BashCommandData,
        };

      case CLI_EVENT_TYPES.FILE_READ:
        return {
          type: CLI_EVENT_TYPES.FILE_READ,
          timestamp,
          data: {
            path: path || "unknown",
            status: OPERATION_STATUS.INITIATED,
          } as FileReadData,
        };

      case CLI_EVENT_TYPES.FILE_WRITE:
        return {
          type: CLI_EVENT_TYPES.FILE_WRITE,
          timestamp,
          data: {
            path: path || "unknown",
            content:
              ((input.content ?? input.file_text) as string | undefined) || "",
            status: OPERATION_STATUS.INITIATED,
          } as FileWriteData,
        };

      case CLI_EVENT_TYPES.FILE_EDIT: {
        const oldContent = (
          input.oldString ??
          input.old_string ??
          input.oldContent ??
          input.old_content ??
          input.old_str
        ) as string | undefined;
        const newContent = (
          input.newString ??
          input.new_string ??
          input.newContent ??
          input.new_content ??
          input.new_str
        ) as string | undefined;
        return {
          type: CLI_EVENT_TYPES.FILE_EDIT,
          timestamp,
          data: {
            path: path || "unknown",
            oldContent,
            newContent,
            status: OPERATION_STATUS.INITIATED,
          } as FileEditData,
        };
      }

      case CLI_EVENT_TYPES.FILE_DELETE:
        return {
          type: CLI_EVENT_TYPES.FILE_DELETE,
          timestamp,
          data: {
            path: path || "unknown",
          } as FileDeleteData,
        };

      case CLI_EVENT_TYPES.WEB_SEARCH:
        return {
          type: CLI_EVENT_TYPES.WEB_SEARCH,
          timestamp,
          data: {
            query: (input.query as string) || "",
          } as WebSearchData,
        };

      case CLI_EVENT_TYPES.MCP_TOOL_CALL: {
        const mcp = classification as {
          type: typeof CLI_EVENT_TYPES.MCP_TOOL_CALL;
          server: string;
          tool: string;
        };
        return {
          type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
          timestamp,
          data: {
            server: mcp.server,
            tool: mcp.tool,
            parameters: input,
          } as McpToolCallData,
        };
      }

      default:
        return {
          type: CLI_EVENT_TYPES.TOOL_CALL,
          timestamp,
          data: {
            name: toolName,
            parameters: input,
            id: toolId,
          } as ToolCall,
        };
    }
  }
}
