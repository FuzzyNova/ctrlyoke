import {
  BashCommandData,
  CliEvent,
  FileEditData,
  FileReadData,
  FileWriteData,
  McpToolCallData,
  ToolCall,
  WebSearchData,
  AskUserQuestionData,
  AskUserQuestionEntry,
  AskUserQuestionOption,
} from "../../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  OPERATION_STATUS,
} from "../../../types/DashboardConstants";
import { CliParseUtils } from "../shared/CliParseUtils";
import {
  AntigravityPlannerToolCall,
  AntigravityTranscriptEntry,
  isRecord,
} from "./AntigravityTranscriptTypes";
import {
  ANTIGRAVITY_ENTRY_TYPES,
  ANTIGRAVITY_TOOL_NAMES,
  ANTIGRAVITY_WIRE_VALUES,
} from "./AntigravityProtocolConstants";

export interface AntigravityToolMapping {
  call?: AntigravityPlannerToolCall;
  result: AntigravityTranscriptEntry;
  timestamp: number;
  eventId?: string;
  toolCallId?: string;
  taskId?: string;
}

/**
 * Converts Antigravity's provider-local tool vocabulary into shared CliEvents.
 * Pairing is deliberately kept outside this builder; this class only shapes a
 * call plus its adjacent result, or a result that had no matching call.
 */
export class AntigravityToolEventBuilder {
  static isAskUserQuestionTool(toolName: string | undefined): boolean {
    return toolName?.toLowerCase() === ANTIGRAVITY_TOOL_NAMES.ASK_QUESTION;
  }

  static build(mapping: AntigravityToolMapping): CliEvent[] {
    const { call, result, timestamp, eventId, taskId } = mapping;
    const toolName = call?.name ?? this.toolNameFromResult(result);
    const args = call?.args ?? {};
    const normalizedName = toolName.toLowerCase();
    const success = this.resultSucceeded(result);
    const error = success ? undefined : this.resultError(result);
    const resultText = error || this.stringContent(result);
    const id = taskId ?? eventId;

    if (result.type === ANTIGRAVITY_ENTRY_TYPES.ASK_QUESTION) {
      return [
        this.buildAskUserQuestionCompletedEvent(
          call,
          result,
          mapping.toolCallId,
          timestamp
        ),
      ];
    }

    if (result.status === ANTIGRAVITY_WIRE_VALUES.RUNNING) {
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

    if (
      result.type === ANTIGRAVITY_ENTRY_TYPES.RUN_COMMAND ||
      normalizedName === ANTIGRAVITY_TOOL_NAMES.RUN_COMMAND
    ) {
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

    if (
      result.type === ANTIGRAVITY_ENTRY_TYPES.VIEW_FILE ||
      normalizedName === ANTIGRAVITY_TOOL_NAMES.VIEW_FILE
    ) {
      return [
        {
          type: CLI_EVENT_TYPES.FILE_READ,
          timestamp,
          data: {
            path:
              this.pathArg(args) ?? this.pathFromText(resultText) ?? "unknown",
            content: resultText || undefined,
            ...this.viewFileLineRange(resultText),
            success,
            error,
            status: success
              ? OPERATION_STATUS.COMPLETED
              : OPERATION_STATUS.FAILED,
          } as FileReadData,
        },
      ];
    }

    const codeActionToolNames: string[] = [
      ANTIGRAVITY_TOOL_NAMES.WRITE_TO_FILE,
      ANTIGRAVITY_TOOL_NAMES.REPLACE_FILE_CONTENT,
      ANTIGRAVITY_TOOL_NAMES.MULTI_REPLACE_FILE_CONTENT,
    ];
    if (
      result.type === ANTIGRAVITY_ENTRY_TYPES.CODE_ACTION ||
      codeActionToolNames.includes(normalizedName)
    ) {
      return this.buildCodeAction(call, result, timestamp, success, error);
    }

    if (
      result.type === ANTIGRAVITY_ENTRY_TYPES.MCP_TOOL ||
      result.type === ANTIGRAVITY_ENTRY_TYPES.LIST_RESOURCES ||
      result.type === ANTIGRAVITY_ENTRY_TYPES.READ_RESOURCE ||
      normalizedName === ANTIGRAVITY_TOOL_NAMES.CALL_MCP_TOOL ||
      normalizedName === ANTIGRAVITY_TOOL_NAMES.LIST_RESOURCES ||
      normalizedName === ANTIGRAVITY_TOOL_NAMES.READ_RESOURCE
    ) {
      const target = this.mcpTarget(call, result);
      return [
        {
          type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
          timestamp,
          data: {
            server: target.server,
            tool: target.tool,
            toolCallId: mapping.toolCallId,
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

    if (
      result.type === ANTIGRAVITY_ENTRY_TYPES.SEARCH_WEB ||
      normalizedName === ANTIGRAVITY_TOOL_NAMES.SEARCH_WEB
    ) {
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

    if (result.type === ANTIGRAVITY_WIRE_VALUES.SYSTEM_MESSAGE) {
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

  static buildAskUserQuestionInitiatedEvent(
    call: AntigravityPlannerToolCall,
    toolCallId: string,
    timestamp: number
  ): CliEvent {
    return {
      type: CLI_EVENT_TYPES.ASK_USER_QUESTION,
      timestamp,
      data: {
        toolCallId,
        questions: this.parseQuestions(call.args),
        status: OPERATION_STATUS.INITIATED,
      } as AskUserQuestionData,
    };
  }

  private static buildAskUserQuestionCompletedEvent(
    call: AntigravityPlannerToolCall | undefined,
    result: AntigravityTranscriptEntry,
    toolCallId: string | undefined,
    timestamp: number
  ): CliEvent {
    const questions = this.parseQuestions(call?.args);
    const answers = this.parseAnswers(this.stringContent(result));
    const resolvedQuestions = questions.map((question, index) => ({
      ...question,
      ...this.resolveAnswer(
        answers.get(index + 1) ??
          (questions.length === 1 ? this.stringContent(result) : undefined),
        question.options
      ),
    }));
    const completed = result.status === ANTIGRAVITY_WIRE_VALUES.DONE;

    return {
      type: CLI_EVENT_TYPES.ASK_USER_QUESTION,
      timestamp,
      data: {
        toolCallId,
        questions: resolvedQuestions,
        status: completed
          ? OPERATION_STATUS.COMPLETED
          : OPERATION_STATUS.FAILED,
        declined: completed
          ? undefined
          : {
              reason: "rejected",
              feedback: this.stringContent(result) || undefined,
            },
      } as AskUserQuestionData,
    };
  }

  private static parseQuestions(
    args: Record<string, unknown> | undefined
  ): AskUserQuestionEntry[] {
    let rawQuestions = args?.questions;
    if (typeof rawQuestions === "string") {
      try {
        rawQuestions = JSON.parse(rawQuestions);
      } catch {
        return [];
      }
    }
    if (!Array.isArray(rawQuestions)) {
      return [];
    }

    return rawQuestions.map((rawQuestion) => {
      const question = isRecord(rawQuestion) ? rawQuestion : {};
      return {
        question:
          typeof question.question === "string" ? question.question : "",
        multiSelect:
          typeof question.is_multi_select === "boolean"
            ? question.is_multi_select
            : typeof question.multiSelect === "boolean"
              ? question.multiSelect
              : undefined,
        options: this.parseOptions(question.options),
      };
    });
  }

  private static parseOptions(rawOptions: unknown): AskUserQuestionOption[] {
    if (!Array.isArray(rawOptions)) {
      return [];
    }

    return rawOptions.map((rawOption) => {
      if (isRecord(rawOption)) {
        return {
          label: typeof rawOption.label === "string" ? rawOption.label : "",
          description:
            typeof rawOption.description === "string"
              ? rawOption.description
              : undefined,
          preview:
            typeof rawOption.preview === "string"
              ? rawOption.preview
              : undefined,
        };
      }

      if (typeof rawOption !== "string") {
        return { label: "" };
      }

      const normalized = rawOption
        .replace(/^\s*\(Recommended\)\s*/i, "")
        .trim();
      const separator = normalized.match(/\s+-\s+/);
      if (!separator || separator.index === undefined) {
        return { label: normalized };
      }

      const label = normalized.slice(0, separator.index).trim();
      const detail = normalized.slice(separator.index + separator[0].length);
      const previewMarker = detail.search(/ASCII Art\s*:/i);
      if (previewMarker < 0) {
        return { label, description: detail.trim() };
      }

      const description = detail.slice(0, previewMarker).trim();
      const preview = detail
        .slice(previewMarker + "ASCII Art:".length)
        .replace(/^\r?\n/, "")
        .replace(/\s+$/, "");
      return {
        label,
        description: description || undefined,
        preview: preview || undefined,
      };
    });
  }

  private static parseAnswers(content: string): Map<number, string> {
    const answers = new Map<number, string>();
    let currentAnswer: number | undefined;
    let lines: string[] = [];

    const flush = () => {
      if (currentAnswer !== undefined) {
        answers.set(currentAnswer, lines.join("\n").trim());
      }
    };

    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*A(\d+)\s*:\s*(.*)$/i);
      if (match) {
        flush();
        currentAnswer = Number(match[1]);
        lines = [match[2]];
      } else if (currentAnswer !== undefined) {
        lines.push(line);
      }
    }
    flush();
    return answers;
  }

  private static resolveAnswer(
    answer: string | undefined,
    options: AskUserQuestionOption[]
  ): { answer?: string; answerPreview?: string } {
    if (!answer) {
      return {};
    }

    const normalizedAnswer = answer
      .replace(/^\s*\(Recommended\)\s*/i, "")
      .trim();
    const selected = options.find(
      (option) =>
        normalizedAnswer === option.label ||
        normalizedAnswer.startsWith(`${option.label} - `) ||
        normalizedAnswer.startsWith(`${option.label}\n`)
    );
    return selected
      ? { answer: selected.label, answerPreview: selected.preview }
      : { answer: normalizedAnswer };
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
      toolName === ANTIGRAVITY_TOOL_NAMES.WRITE_TO_FILE ||
      /created file/i.test(resultText);

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
    const structuredPatch = CliParseUtils.parseUnifiedDiff(diff);
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
    if (
      entry.status === ANTIGRAVITY_WIRE_VALUES.ERROR ||
      (typeof entry.error === "string" && entry.error.trim())
    ) {
      return false;
    }
    const explicit = entry.success;
    if (typeof explicit === "boolean") {
      return explicit;
    }
    const exitCode = this.exitCode(entry);
    if (exitCode !== undefined) {
      return exitCode === 0;
    }
    if (
      entry.source === ANTIGRAVITY_WIRE_VALUES.SYSTEM &&
      entry.type === ANTIGRAVITY_WIRE_VALUES.SYSTEM_MESSAGE
    ) {
      return !/\b(error|failed|failure|cancelled|canceled)\b/i.test(
        this.stringContent(entry)
      );
    }
    if (
      /^\s*(error|failed|failure|cancelled|canceled)\b/i.test(
        this.stringContent(entry)
      )
    ) {
      return false;
    }
    return (
      entry.source !== ANTIGRAVITY_WIRE_VALUES.SYSTEM ||
      entry.type === ANTIGRAVITY_WIRE_VALUES.SYSTEM_MESSAGE
    );
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
    // "exit code: N" / "exit_code=N" and agy's own "exited with code N"
    // phrasing (confirmed in real background-task completion messages).
    const match = content.match(
      /(?:exit\s*code|exit_code)\s*[:=]\s*(-?\d+)|exited with code\s+(-?\d+)/i
    );
    if (!match) {
      return undefined;
    }
    const raw = match[1] ?? match[2];
    return raw !== undefined ? Number(raw) : undefined;
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

  /**
   * agy's view_file result never echoes the requested StartLine/EndLine
   * directly — the only record of what was actually returned is the rendered
   * summary line ("Showing lines X to Y" / "Total Lines: N"). A whole-file
   * read reports the same range as [1, totalLines], which should not surface
   * as a segment read.
   */
  private static viewFileLineRange(text: string): {
    lineStart?: number;
    lineEnd?: number;
  } {
    const showing = text.match(/Showing lines\s+(\d+)\s+to\s+(\d+)/i);
    if (!showing) {
      return {};
    }
    const lineStart = Number(showing[1]);
    const lineEnd = Number(showing[2]);
    const total = text.match(/Total Lines:\s*(\d+)/i);
    const totalLines = total ? Number(total[1]) : undefined;
    const isSegmentRead =
      lineStart > 1 || (totalLines !== undefined && lineEnd < totalLines);
    return isSegmentRead ? { lineStart, lineEnd } : {};
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
      const plain = line.match(/^\s*(?:\d+[.)]|\[\d+\])\s+(https?:\/\/\S+)/);
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
