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
    const classification = CliEventMapper.classifyTool(toolName);
    const path = (input.path ?? input.file_path) as string | undefined;

    switch (classification.type) {
      case CLI_EVENT_TYPES.BASH_COMMAND:
        return [
          {
            type: CLI_EVENT_TYPES.BASH_COMMAND,
            timestamp,
            data: {
              command: (input.command ?? input.cmd ?? "unknown") as string,
              workingDir: (input.working_dir ?? input.cwd) as
                | string
                | undefined,
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
              path: path || "unknown",
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
              path: path || "unknown",
              content: (input.content ?? input.file_text ?? "") as string,
              status: OPERATION_STATUS.INITIATED,
            } as FileWriteData,
          },
        ];

      case CLI_EVENT_TYPES.FILE_EDIT:
        return [
          {
            type: CLI_EVENT_TYPES.FILE_EDIT,
            timestamp,
            data: {
              path: path || "unknown",
              oldContent: (input.oldString ?? input.old_string) as
                | string
                | undefined,
              newContent: (input.newString ?? input.new_string) as
                | string
                | undefined,
              status: OPERATION_STATUS.INITIATED,
            } as FileEditData,
          },
        ];

      case CLI_EVENT_TYPES.FILE_DELETE:
        return [
          {
            type: CLI_EVENT_TYPES.FILE_DELETE,
            timestamp,
            data: {
              path: path || "unknown",
            } as FileDeleteData,
          },
        ];

      case CLI_EVENT_TYPES.WEB_SEARCH:
        return [
          {
            type: CLI_EVENT_TYPES.WEB_SEARCH,
            timestamp,
            data: {
              query: (input.query as string) || "",
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
              parameters: input,
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
              parameters: input,
              id: toolId,
            } as ToolCall,
          },
        ];
    }
  }
}
