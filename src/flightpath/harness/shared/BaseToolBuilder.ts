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
import { CliEventMapper } from "./CliEventMapper";

/**
 * Shared INITIATED event builder for all CLI harnesses.
 *
 * Resolves tool input field names across the full union of all harness naming
 * conventions (snake_case, camelCase, harness-specific aliases). Harnesses
 * handle their own special-case tools (Claude: multiedit, Codex: apply_patch)
 * before delegating here for the standard tool types.
 *
 * Field name coverage:
 *   path       — absolute_path, file_path, path, file, pattern
 *   command    — command, cmd, script
 *   workingDir — working_dir, cwd, workingDir
 *   content    — content, file_text
 *   oldContent — oldString, old_string, oldContent, old_content, old_str
 *   newContent — newString, new_string, newContent, new_content, new_str, content
 */
export class BaseToolBuilder {
  static buildInitiatedEvents(
    toolName: string,
    input: Record<string, unknown>,
    toolId: string | undefined,
    timestamp: number,
    extras?: { callerType?: string }
  ): CliEvent[] {
    const classification = CliEventMapper.classifyTool(toolName);
    const path = (input.absolute_path ??
      input.file_path ??
      input.path ??
      input.file ??
      input.pattern) as string | undefined;
    const ex = extras ?? {};

    switch (classification.type) {
      case CLI_EVENT_TYPES.BASH_COMMAND:
        return [
          {
            type: CLI_EVENT_TYPES.BASH_COMMAND,
            timestamp,
            ...ex,
            data: {
              command:
                ((input.command ?? input.cmd ?? input.script) as
                  | string
                  | undefined) ?? "",
              workingDir: (input.working_dir ??
                input.cwd ??
                input.workingDir) as string | undefined,
              status: OPERATION_STATUS.INITIATED,
            } as BashCommandData,
          },
        ];

      case CLI_EVENT_TYPES.FILE_READ:
        return [
          {
            type: CLI_EVENT_TYPES.FILE_READ,
            timestamp,
            ...ex,
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
            ...ex,
            data: {
              path: path || "unknown",
              content:
                ((input.content ?? input.file_text) as string | undefined) ||
                "",
              status: OPERATION_STATUS.INITIATED,
            } as FileWriteData,
          },
        ];

      case CLI_EVENT_TYPES.FILE_EDIT:
        return [
          {
            type: CLI_EVENT_TYPES.FILE_EDIT,
            timestamp,
            ...ex,
            data: {
              path: path || "unknown",
              oldContent: (input.oldString ??
                input.old_string ??
                input.oldContent ??
                input.old_content ??
                input.old_str) as string | undefined,
              newContent: (input.newString ??
                input.new_string ??
                input.newContent ??
                input.new_content ??
                input.new_str ??
                input.content) as string | undefined,
              status: OPERATION_STATUS.INITIATED,
            } as FileEditData,
          },
        ];

      case CLI_EVENT_TYPES.FILE_DELETE:
        return [
          {
            type: CLI_EVENT_TYPES.FILE_DELETE,
            timestamp,
            ...ex,
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
            ...ex,
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
            ...ex,
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
            ...ex,
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
