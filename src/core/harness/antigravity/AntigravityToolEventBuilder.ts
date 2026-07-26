import {
  BashCommandData,
  CliEvent,
  FileEditData,
  FileReadData,
  FileWriteData,
  McpToolCallData,
  ToolCall,
  WebSearchData,
} from "../../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  OPERATION_STATUS,
} from "../../../types/DashboardConstants";
import { CliResponseParser } from "../shared/CliResponseParser";
import {
  AntigravityPlannerToolCall,
  AntigravityTranscriptEntry,
  isRecord,
} from "./AntigravityTranscriptTypes";

export interface AntigravityToolMapping {
  call?: AntigravityPlannerToolCall;
  result: AntigravityTranscriptEntry;
  timestamp: number;
  eventId?: string;
  taskId?: string;
}

/**
 * Converts Antigravity's provider-local tool vocabulary into shared CliEvents.
 * Pairing is deliberately kept outside this builder; this class only shapes a
 * call plus its adjacent result, or a result that had no matching call.
 */
export class AntigravityToolEventBuilder {
  static build(mapping: AntigravityToolMapping): CliEvent[] {
    const { call, result, timestamp, eventId, taskId } = mapping;
    const toolName = call?.name ?? this.toolNameFromResult(result);
    const args = call?.args ?? {};
    const normalizedName = toolName.toLowerCase();
    const success = this.resultSucceeded(result);
    const error = success ? undefined : this.resultError(result);
    const resultText = this.stringContent(result);
    const id = taskId ?? eventId;

    if (result.status === "RUNNING") {
      return [
        {
          type: CLI_EVENT_TYPES.TOOL_CALL,
          timestamp,
          data: {
            name: toolName,
            parameters: args,
            id,
            result: {
              success: true,
              output: resultText || undefined,
            },
          } as ToolCall,
        },
      ];
    }

    if (result.type === "RUN_COMMAND") {
      const exitCode = this.exitCode(result);
      const command = this.stringArg(args, ["CommandLine", "command", "cmd"]);
      const workingDir = this.stringArg(args, ["Cwd", "cwd", "workingDir"]);
      const { output, stderr } = this.parseCommandOutput(resultText);
      return [
        {
          type: CLI_EVENT_TYPES.BASH_COMMAND,
          timestamp,
          data: {
            command: command ?? "unknown",
            workingDir,
            exitCode,
            output,
            error: error ?? stderr,
            status: success
              ? OPERATION_STATUS.COMPLETED
              : OPERATION_STATUS.FAILED,
          } as BashCommandData,
        },
      ];
    }

    if (result.type === "VIEW_FILE" || normalizedName === "view_file") {
      return [
        {
          type: CLI_EVENT_TYPES.FILE_READ,
          timestamp,
          data: {
            path:
              this.pathArg(args) ?? this.pathFromText(resultText) ?? "unknown",
            content: resultText || undefined,
            success,
            error,
            status: success
              ? OPERATION_STATUS.COMPLETED
              : OPERATION_STATUS.FAILED,
          } as FileReadData,
        },
      ];
    }

    if (result.type === "CODE_ACTION") {
      return this.buildCodeAction(call, result, timestamp, success, error);
    }

    if (
      result.type === "MCP_TOOL" ||
      result.type === "LIST_RESOURCES" ||
      result.type === "READ_RESOURCE" ||
      normalizedName === "call_mcp_tool" ||
      normalizedName === "list_resources" ||
      normalizedName === "read_resource"
    ) {
      const target = this.mcpTarget(call, result);
      return [
        {
          type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
          timestamp,
          data: {
            server: target.server,
            tool: target.tool,
            parameters: this.mcpParameters(args),
            result: {
              success,
              output: resultText || undefined,
              error,
            },
          } as McpToolCallData,
        },
      ];
    }

    if (result.type === "SEARCH_WEB" || normalizedName === "search_web") {
      const query =
        this.stringArg(args, ["SearchQuery", "query", "Query"]) ?? "";
      return [
        {
          type: CLI_EVENT_TYPES.WEB_SEARCH,
          timestamp,
          data: {
            query,
            results: this.parseWebSources(resultText),
            summary: this.webSummary(resultText),
            success,
            error,
          } as WebSearchData & { summary?: string },
        },
      ];
    }

    if (result.type === "SYSTEM_MESSAGE") {
      return [
        {
          type: CLI_EVENT_TYPES.TOOL_CALL,
          timestamp,
          data: {
            name: "background_task",
            parameters: taskId ? { taskId } : {},
            id,
            result: {
              success,
              output: resultText || undefined,
              error,
            },
          } as ToolCall,
        },
      ];
    }

    return [
      {
        type: CLI_EVENT_TYPES.TOOL_CALL,
        timestamp,
        data: {
          name: toolName,
          parameters: args,
          id,
          result: {
            success,
            output: resultText || undefined,
            error,
          },
        } as ToolCall,
      },
    ];
  }

  static buildUnmatchedCall(
    call: AntigravityPlannerToolCall,
    timestamp: number,
    eventId?: string
  ): CliEvent {
    return {
      type: CLI_EVENT_TYPES.TOOL_CALL,
      timestamp,
      data: {
        name: call.name,
        parameters: call.args ?? {},
        id: eventId,
      } as ToolCall,
    };
  }

  private static buildCodeAction(
    call: AntigravityPlannerToolCall | undefined,
    result: AntigravityTranscriptEntry,
    timestamp: number,
    success: boolean,
    error: string | undefined
  ): CliEvent[] {
    const args = call?.args ?? {};
    const toolName = call?.name.toLowerCase() ?? "";
    const resultText = this.stringContent(result);
    const path =
      this.pathArg(args) ?? this.pathFromText(resultText) ?? "unknown";
    const isCreate =
      toolName === "write_to_file" || /created file/i.test(resultText);

    if (isCreate) {
      return [
        {
          type: CLI_EVENT_TYPES.FILE_WRITE,
          timestamp,
          data: {
            path,
            content:
              this.stringArg(args, ["CodeContent", "content", "file_text"]) ??
              "",
            status: success
              ? OPERATION_STATUS.COMPLETED
              : OPERATION_STATUS.FAILED,
            success,
            error,
          } as FileWriteData,
        },
      ];
    }

    const diff = this.diffBlock(resultText) ?? resultText;
    const structuredPatch = CliResponseParser.parseUnifiedDiff(diff);
    return [
      {
        type: CLI_EVENT_TYPES.FILE_EDIT,
        timestamp,
        data: {
          path,
          structuredPatch,
          oldContent: this.stringArg(args, ["TargetContent", "oldContent"]),
          newContent: this.stringArg(args, [
            "ReplacementContent",
            "newContent",
          ]),
          status: success
            ? OPERATION_STATUS.COMPLETED
            : OPERATION_STATUS.FAILED,
          success,
          error,
        } as FileEditData,
      },
    ];
  }

  private static resultSucceeded(entry: AntigravityTranscriptEntry): boolean {
    const explicit = entry.success;
    if (typeof explicit === "boolean") {
      return explicit;
    }
    const exitCode = this.exitCode(entry);
    if (exitCode !== undefined) {
      return exitCode === 0;
    }
    if (entry.source === "SYSTEM" && entry.type === "SYSTEM_MESSAGE") {
      return !/\b(error|failed|failure|cancelled|canceled)\b/i.test(
        this.stringContent(entry)
      );
    }
    if (/^\s*(error|failed|failure|cancelled|canceled)\b/i.test(this.stringContent(entry))) {
      return false;
    }
    return entry.source !== "SYSTEM" || entry.type === "SYSTEM_MESSAGE";
  }

  private static resultError(
    entry: AntigravityTranscriptEntry
  ): string | undefined {
    const error = entry.error;
    if (typeof error === "string" && error.trim()) {
      return error.trim();
    }
    const content = this.stringContent(entry);
    return content &&
      /\b(error|failed|failure|cancelled|canceled)\b/i.test(content)
      ? content
      : undefined;
  }

  private static exitCode(
    entry: AntigravityTranscriptEntry
  ): number | undefined {
    const value = entry.exit_code ?? entry.exitCode;
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    const content = this.stringContent(entry);
    const match = content.match(/(?:exit\s*code|exit_code)\s*[:=]\s*(-?\d+)/i);
    return match ? Number(match[1]) : undefined;
  }

  private static stringContent(entry: AntigravityTranscriptEntry): string {
    return typeof entry.content === "string" ? entry.content.trim() : "";
  }

  private static stringArg(
    args: Record<string, unknown>,
    keys: string[]
  ): string | undefined {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
    return undefined;
  }

  private static pathArg(args: Record<string, unknown>): string | undefined {
    const value = this.stringArg(args, [
      "AbsolutePath",
      "TargetFile",
      "FilePath",
      "file_path",
      "path",
    ]);
    return value ? this.normalizePath(value) : undefined;
  }

  private static pathFromText(text: string): string | undefined {
    const match = text.match(
      /(?:file(?:\s+path)?|to)\s*[:=]?\s*(file:\/\/\/[^\s]+|[A-Za-z]:[\\/][^\r\n]+)$/im
    );
    return match?.[1]
      ? this.normalizePath(match[1].replace(/[.,]+$/, ""))
      : undefined;
  }

  private static normalizePath(value: string): string {
    let normalized = value.trim();
    if (normalized.startsWith("file://")) {
      normalized = normalized.replace(/^file:\/\//i, "");
      if (normalized.startsWith("/")) {
        normalized = normalized.slice(1);
      }
      try {
        normalized = decodeURIComponent(normalized);
      } catch {
        // Keep the provider's path when the URI is not valid percent-encoding.
      }
    }
    return normalized;
  }

  private static diffBlock(text: string): string | undefined {
    const match = text.match(
      /\[diff_block_start\]\s*([\s\S]*?)\s*\[diff_block_end\]/i
    );
    return match?.[1];
  }

  private static parseCommandOutput(text: string): {
    output?: string;
    stderr?: string;
  } {
    const stdoutMatch = text.match(
      /(?:^|\n)\s*(?:stdout|standard output)\s*:\s*([\s\S]*?)(?=\n\s*(?:stderr|standard error|exit\s*code|completed at)\s*:|$)/i
    );
    const stderrMatch = text.match(
      /(?:^|\n)\s*(?:stderr|standard error)\s*:\s*([\s\S]*?)(?=\n\s*(?:stdout|standard output|exit\s*code|completed at)\s*:|$)/i
    );
    return {
      output:
        stdoutMatch?.[1]?.trim() ||
        (!stderrMatch ? text || undefined : undefined),
      stderr: stderrMatch?.[1]?.trim() || undefined,
    };
  }

  private static mcpTarget(
    call: AntigravityPlannerToolCall | undefined,
    result: AntigravityTranscriptEntry
  ): { server: string; tool: string } {
    const args = call?.args ?? {};
    const target = this.stringArg(args, [
      "Target",
      "target",
      "tool",
      "ServerName",
    ]);
    const serverName = this.stringArg(args, ["ServerName"]);
    const toolName = this.stringArg(args, ["ToolName"]);
    if (serverName && toolName) {
      return { server: serverName, tool: toolName };
    }
    if (target) {
      const match = target.match(/^([^/().]+)[/.]([^/().]+)$/);
      if (match) {
        return { server: match[1], tool: match[2] };
      }
      return { server: "unknown", tool: target };
    }
    return {
      server: typeof result.server === "string" ? result.server : "unknown",
      tool:
        (typeof result.tool === "string" && result.tool) ||
        call?.name ||
        result.type.toLowerCase(),
    };
  }

  private static mcpParameters(
    args: Record<string, unknown>
  ): Record<string, unknown> | undefined {
    const parameters = args.Arguments ?? args.arguments;
    return isRecord(parameters)
      ? parameters
      : Object.keys(args).length > 0
        ? args
        : undefined;
  }

  private static parseWebSources(
    text: string
  ): Array<{ title: string; url: string; snippet?: string }> | undefined {
    const sources: Array<{ title: string; url: string; snippet?: string }> = [];
    for (const line of text.split(/\r?\n/)) {
      const linked = line.match(
        /^\s*(?:\d+[.)]|\[\d+\])\s+\[([^\]]+)\]\((https?:\/\/[^)]+)\)/
      );
      if (linked) {
        sources.push({ title: linked[1], url: linked[2] });
        continue;
      }
      const plain = line.match(
        /^\s*(?:\d+[.)]|\[\d+\])\s+(https?:\/\/\S+)/
      );
      if (plain) {
        const url = plain[1].replace(/[),.;]+$/, "");
        sources.push({ title: url, url });
      }
    }
    return sources.length > 0 ? sources : undefined;
  }

  private static webSummary(text: string): string | undefined {
    const summary = text.split(/\r?\n\s*Sources\s*:/i)[0]?.trim();
    return summary || undefined;
  }

  private static toolNameFromResult(entry: AntigravityTranscriptEntry): string {
    if (typeof entry.tool === "string" && entry.tool) {
      return entry.tool;
    }
    if (isRecord(entry.result) && typeof entry.result.tool === "string") {
      return entry.result.tool;
    }
    return entry.type.toLowerCase();
  }
}
