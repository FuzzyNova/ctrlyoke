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
import { CliResponseParser } from "../shared/CliResponseParser";
import { BaseToolBuilder } from "../shared/BaseToolBuilder";

/**
 * Builds CliEvents from Copilot CLI tool call payloads.
 *
 * Two static methods cover the full tool call lifecycle:
 * - `buildInitiatedEvent` — called on tool.execution_start (or toolRequests);
 *   includes old/new content for FILE_EDIT so the attempted diff is visible
 *   immediately and on failure.
 * - `buildCompletedEvents` — called on tool.execution_complete; carries
 *   structuredPatch with accurate line numbers which the UI prefers over
 *   the client-side diff generated from INITIATED old/new content.
 *
 * Both CopilotLogParser and CopilotResponseParser use these methods so the
 * event-shaping logic is never duplicated.
 */
export class CopilotToolBuilder {
  /**
   * Build an INITIATED CliEvent for a Copilot tool call.
   *
   * For FILE_EDIT, old/new content is included so the attempted diff is visible
   * immediately. When buildCompletedEvents() fires for the same path, the UI
   * suppresses the INITIATED event in favour of the COMPLETED one (which carries
   * structuredPatch with accurate line numbers). If the edit fails, the INITIATED
   * diff remains visible alongside the failure event.
   *
   * @param toolName - Tool name from tool.execution_start or toolRequests
   * @param args - Raw tool arguments
   * @param toolCallId - Unique call ID (used in generic TOOL_CALL fallback)
   * @param timestamp - Event timestamp in milliseconds
   * @returns A single CliEvent to push onto the event stream
   */
  static buildInitiatedEvent(
    toolName: string,
    args: Record<string, unknown>,
    toolCallId: string | undefined,
    timestamp: number
  ): CliEvent {
    return BaseToolBuilder.buildInitiatedEvents(
      toolName,
      args,
      toolCallId,
      timestamp
    )[0] as CliEvent;
  }

  /**
   * Build COMPLETED/FAILED events for a Copilot tool call outcome.
   *
   * @param toolName - Tool name from the tool.execution_start event
   * @param args - Raw tool arguments from tool.execution_start
   * @param completionData - The data field from tool.execution_complete
   * @returns Zero or more CliEvents to append to the event stream
   */
  static buildCompletedEvents(
    toolName: string,
    args: Record<string, unknown>,
    completionData: {
      success?: boolean;
      result?: { content?: string; detailedContent?: string };
      error?: { message?: string };
    }
  ): CliEvent[] {
    const classification = CliEventMapper.classifyTool(toolName);
    const classifiedType = classification.type;
    const success = completionData?.success === true;
    const errorMsg: string | undefined = completionData?.error?.message;
    const resultContent: string | undefined =
      completionData?.result?.content ||
      completionData?.result?.detailedContent;

    const path = (args.path ?? args.file_path) as string | undefined;
    const oldStr = (args.old_str ?? args.old_string) as string | undefined;
    const newStr = (args.new_str ?? args.new_string) as string | undefined;
    const content = (args.content ?? args.file_text) as string | undefined;
    const command = (args.command ?? args.cmd ?? args.script) as
      | string
      | undefined;
    const query = args.query as string | undefined;

    if (classifiedType === CLI_EVENT_TYPES.FILE_EDIT) {
      const structuredPatch = completionData?.result?.detailedContent
        ? CliResponseParser.parseUnifiedDiff(
            completionData.result.detailedContent
          )
        : undefined;
      return [
        {
          type: CLI_EVENT_TYPES.FILE_EDIT,
          timestamp: Date.now(),
          data: {
            path: path || "unknown",
            oldContent: oldStr,
            newContent: newStr,
            structuredPatch,
            status: success
              ? OPERATION_STATUS.COMPLETED
              : OPERATION_STATUS.FAILED,
            success,
            error: errorMsg,
          } as FileEditData,
        },
      ];
    }

    if (classifiedType === CLI_EVENT_TYPES.FILE_WRITE) {
      return [
        {
          type: CLI_EVENT_TYPES.FILE_WRITE,
          timestamp: Date.now(),
          data: {
            path: path || "unknown",
            content: content || "",
            status: success
              ? OPERATION_STATUS.COMPLETED
              : OPERATION_STATUS.FAILED,
            success,
            error: errorMsg,
          } as FileWriteData,
        },
      ];
    }

    if (classifiedType === CLI_EVENT_TYPES.BASH_COMMAND) {
      return [
        {
          type: CLI_EVENT_TYPES.BASH_COMMAND,
          timestamp: Date.now(),
          data: {
            command: command || "unknown",
            output: success ? resultContent : undefined,
            status: success
              ? OPERATION_STATUS.COMPLETED
              : OPERATION_STATUS.FAILED,
            error: errorMsg,
          } as BashCommandData,
        },
      ];
    }

    if (classifiedType === CLI_EVENT_TYPES.FILE_READ) {
      return [
        {
          type: CLI_EVENT_TYPES.FILE_READ,
          timestamp: Date.now(),
          data: {
            path: path || "unknown",
            status: success
              ? OPERATION_STATUS.COMPLETED
              : OPERATION_STATUS.FAILED,
            success,
            error: errorMsg,
          } as FileReadData,
        },
      ];
    }

    if (classifiedType === CLI_EVENT_TYPES.FILE_DELETE) {
      return [
        {
          type: CLI_EVENT_TYPES.FILE_DELETE,
          timestamp: Date.now(),
          data: {
            path: path || "unknown",
            success,
            error: errorMsg,
          } as FileDeleteData,
        },
      ];
    }

    if (classifiedType === CLI_EVENT_TYPES.WEB_SEARCH) {
      return [
        {
          type: CLI_EVENT_TYPES.WEB_SEARCH,
          timestamp: Date.now(),
          data: {
            query: query || "",
            success,
            error: errorMsg,
          } as WebSearchData,
        },
      ];
    }

    if (classifiedType === CLI_EVENT_TYPES.MCP_TOOL_CALL) {
      const mcp = classification as {
        type: typeof CLI_EVENT_TYPES.MCP_TOOL_CALL;
        server: string;
        tool: string;
      };
      return [
        {
          type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
          timestamp: Date.now(),
          data: {
            server: mcp.server,
            tool: mcp.tool,
            result: { success, output: resultContent, error: errorMsg },
          } as McpToolCallData,
        },
      ];
    }

    // Generic TOOL_CALL fallback (report_intent, task_complete, etc.)
    return [
      {
        type: CLI_EVENT_TYPES.TOOL_CALL,
        timestamp: Date.now(),
        data: {
          name: toolName,
          result: { success, output: resultContent, error: errorMsg },
        } as ToolCall,
      },
    ];
  }
}
