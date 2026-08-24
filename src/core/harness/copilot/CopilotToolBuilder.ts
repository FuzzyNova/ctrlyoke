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
  AskUserQuestionData,
  AskUserQuestionEntry,
  AskUserQuestionOption,
} from "../../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  OPERATION_STATUS,
} from "../../../types/DashboardConstants";
import { CliEventMapper } from "../shared/CliEventMapper";
import { ApplyPatchParser } from "../shared/ApplyPatchParser";
import { CliParseUtils } from "../shared/CliParseUtils";
import {
  BaseToolBuilder,
  extractFileReadRange,
} from "../shared/BaseToolBuilder";

type CopilotToolArgs = Record<string, unknown> | string;

interface CopilotToolTelemetry {
  properties?: Record<string, unknown>;
  restrictedProperties?: Record<string, unknown>;
}

interface CopilotCompletionData {
  toolCallId?: string;
  success?: boolean;
  result?: { content?: string; detailedContent?: string };
  error?: { message?: string };
  toolTelemetry?: CopilotToolTelemetry;
}

/**
 * Builds CliEvents from Copilot CLI tool call payloads.
 *
 * The static builders cover the full tool call lifecycle:
 * - `buildInitiatedEvents` — called on tool.execution_start (or toolRequests);
 *   includes the complete question/options payload for ask_user and old/new
 *   content for FILE_EDIT so the attempted operation is visible immediately.
 * - `buildCompletedEvents` — called on tool.execution_complete; carries
 *   resolved answers for ask_user and structuredPatch with accurate line
 *   numbers which the UI prefers over the client-side diff generated from
 *   INITIATED old/new content.
 *
 * CopilotLogParser uses these methods for both interactive log events and
 * headless stdout events, so the event-shaping logic is never duplicated.
 */
export class CopilotToolBuilder {
  private static readonly ASK_USER_TOOL_NAMES = new Set([
    "ask_user",
    "ask_user_question",
    "askuserquestion",
  ]);

  static isAskUserQuestionTool(toolName: string): boolean {
    return this.ASK_USER_TOOL_NAMES.has(toolName.toLowerCase());
  }

  private static parseChoice(rawChoice: unknown): AskUserQuestionOption {
    if (typeof rawChoice !== "string") {
      const choice = (rawChoice ?? {}) as Record<string, unknown>;
      return {
        label: typeof choice.label === "string" ? choice.label : "",
        description:
          typeof choice.description === "string"
            ? choice.description
            : undefined,
        preview:
          typeof choice.preview === "string" ? choice.preview : undefined,
      };
    }

    const [firstLine, ...previewLines] = rawChoice.split("\n");
    const descriptionSeparator = firstLine.indexOf(" \u2014 ");
    if (descriptionSeparator <= 0) {
      return { label: rawChoice };
    }

    return {
      label: firstLine.slice(0, descriptionSeparator),
      description: firstLine.slice(descriptionSeparator + 3),
      preview: previewLines.length ? previewLines.join("\n") : undefined,
    };
  }

  private static parseChoices(rawChoices: unknown): AskUserQuestionOption[] {
    let choices: unknown = rawChoices;
    if (typeof choices === "string") {
      try {
        choices = JSON.parse(choices);
      } catch {
        choices = [choices];
      }
    }
    return Array.isArray(choices)
      ? choices.map((choice) => this.parseChoice(choice))
      : [];
  }

  private static parseQuestionEntries(
    args: CopilotToolArgs,
    fallbackQuestion?: string,
    fallbackChoices?: unknown
  ): AskUserQuestionEntry[] {
    const input =
      typeof args === "string" ? undefined : (args as Record<string, unknown>);
    const rawQuestions = input?.questions;

    if (Array.isArray(rawQuestions)) {
      return rawQuestions.map((rawQuestion) => {
        const question = (rawQuestion ?? {}) as Record<string, unknown>;
        return {
          question:
            typeof question.question === "string"
              ? question.question
              : (fallbackQuestion ?? ""),
          header:
            typeof question.header === "string" ? question.header : undefined,
          multiSelect:
            typeof question.multiSelect === "boolean"
              ? question.multiSelect
              : undefined,
          options: this.parseChoices(
            question.options ?? question.choices ?? fallbackChoices
          ),
        };
      });
    }

    return [
      {
        question:
          typeof input?.question === "string"
            ? input.question
            : (fallbackQuestion ?? ""),
        options: this.parseChoices(input?.choices ?? fallbackChoices),
      },
    ];
  }

  private static getCompletionText(
    completionData: CopilotCompletionData
  ): string | undefined {
    const resultText =
      completionData.result?.content || completionData.result?.detailedContent;
    if (!resultText) {
      return undefined;
    }
    const selectedPrefix = "User selected: ";
    return resultText.startsWith(selectedPrefix)
      ? resultText.slice(selectedPrefix.length)
      : resultText;
  }

  private static getAnswer(
    completionData: CopilotCompletionData
  ): string | undefined {
    const answer = completionData.toolTelemetry?.restrictedProperties?.answer;
    return typeof answer === "string"
      ? answer
      : this.getCompletionText(completionData);
  }

  private static resolveAnswer(
    answer: string | undefined,
    options: AskUserQuestionOption[]
  ): { answer?: string; answerPreview?: string } {
    if (!answer) {
      return {};
    }

    const selected = options.find(
      (option) =>
        answer === option.label ||
        answer.startsWith(`${option.label} \u2014 `) ||
        answer.startsWith(`${option.label}\n`)
    );
    return selected
      ? { answer: selected.label, answerPreview: selected.preview }
      : { answer };
  }

  private static buildAskUserQuestionInitiatedEvent(
    args: CopilotToolArgs,
    toolCallId: string | undefined,
    timestamp: number
  ): CliEvent {
    return {
      type: CLI_EVENT_TYPES.ASK_USER_QUESTION,
      timestamp,
      data: {
        toolCallId,
        questions: this.parseQuestionEntries(args),
        status: OPERATION_STATUS.INITIATED,
      } as AskUserQuestionData,
    };
  }

  private static buildAskUserQuestionCompletedEvent(
    args: CopilotToolArgs,
    toolCallId: string | undefined,
    completionData: CopilotCompletionData
  ): CliEvent {
    const restricted = completionData.toolTelemetry?.restrictedProperties;
    const fallbackQuestion =
      typeof restricted?.question === "string"
        ? restricted.question
        : undefined;
    const fallbackChoices = restricted?.choices;
    const questions = this.parseQuestionEntries(
      args,
      fallbackQuestion,
      fallbackChoices
    );
    const success = completionData.success === true;
    const answer = success ? this.getAnswer(completionData) : undefined;
    const resolvedQuestions = questions.map((question) => ({
      ...question,
      ...this.resolveAnswer(answer, question.options),
    }));
    const declinedText = this.getCompletionText(completionData);

    return {
      type: CLI_EVENT_TYPES.ASK_USER_QUESTION,
      timestamp: Date.now(),
      data: {
        toolCallId,
        questions: resolvedQuestions,
        status: success ? OPERATION_STATUS.COMPLETED : OPERATION_STATUS.FAILED,
        declined: success
          ? undefined
          : {
              reason: "rejected",
              feedback: declinedText,
            },
      } as AskUserQuestionData,
    };
  }

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
  static buildInitiatedEvents(
    toolName: string,
    args: CopilotToolArgs,
    toolCallId: string | undefined,
    timestamp: number
  ): CliEvent[] {
    if (this.isAskUserQuestionTool(toolName)) {
      return [
        this.buildAskUserQuestionInitiatedEvent(args, toolCallId, timestamp),
      ];
    }

    if (toolName === "apply_patch" && typeof args === "string") {
      const fileEdits = ApplyPatchParser.parseFileEdits(args);
      if (fileEdits.length > 0) {
        return fileEdits.map((fileEdit) => ({
          type: CLI_EVENT_TYPES.FILE_EDIT,
          timestamp,
          data: {
            path: fileEdit.path,
            structuredPatch: fileEdit.structuredPatch,
            status: OPERATION_STATUS.INITIATED,
          } as FileEditData,
        }));
      }

      return [
        {
          type: CLI_EVENT_TYPES.FILE_EDIT,
          timestamp,
          data: {
            path: ApplyPatchParser.extractFirstPath(args) ?? "unknown",
            structuredPatch: ApplyPatchParser.parse(args),
            status: OPERATION_STATUS.INITIATED,
          } as FileEditData,
        },
      ];
    }

    return BaseToolBuilder.buildInitiatedEvents(
      toolName,
      typeof args === "string" ? {} : args,
      toolCallId,
      timestamp
    ) as CliEvent[];
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
    args: CopilotToolArgs,
    completionData: CopilotCompletionData
  ): CliEvent[] {
    if (this.isAskUserQuestionTool(toolName)) {
      return [
        this.buildAskUserQuestionCompletedEvent(
          args,
          completionData.toolCallId,
          completionData
        ),
      ];
    }

    const classification = CliEventMapper.classifyTool(toolName);
    const classifiedType = classification.type;
    const success = completionData?.success === true;
    const errorMsg: string | undefined = completionData?.error?.message;
    const resultContent: string | undefined =
      completionData?.result?.content ||
      completionData?.result?.detailedContent;

    if (
      classifiedType === CLI_EVENT_TYPES.FILE_EDIT &&
      toolName === "apply_patch"
    ) {
      const patchText =
        completionData?.result?.detailedContent ||
        completionData?.result?.content ||
        (typeof args === "string" ? args : "");
      const fileEdits = patchText
        ? ApplyPatchParser.parseFileEdits(patchText)
        : [];
      if (fileEdits.length > 0) {
        return fileEdits.map((fileEdit) => ({
          type: CLI_EVENT_TYPES.FILE_EDIT,
          timestamp: Date.now(),
          data: {
            path: fileEdit.path,
            structuredPatch: fileEdit.structuredPatch,
            status: success
              ? OPERATION_STATUS.COMPLETED
              : OPERATION_STATUS.FAILED,
            success,
            error: errorMsg,
          } as FileEditData,
        }));
      }

      const fallbackPatch =
        typeof args === "string" ? ApplyPatchParser.parse(args) : undefined;
      const fallbackPath =
        typeof args === "string"
          ? ApplyPatchParser.extractFirstPath(args)
          : undefined;
      return [
        {
          type: CLI_EVENT_TYPES.FILE_EDIT,
          timestamp: Date.now(),
          data: {
            path: fallbackPath || "unknown",
            structuredPatch: fallbackPatch,
            status: success
              ? OPERATION_STATUS.COMPLETED
              : OPERATION_STATUS.FAILED,
            success,
            error: errorMsg,
          } as FileEditData,
        },
      ];
    }

    const normalizedArgs = typeof args === "string" ? {} : args;
    const path = (normalizedArgs.path ?? normalizedArgs.file_path) as
      | string
      | undefined;
    const oldStr = (normalizedArgs.old_str ?? normalizedArgs.old_string) as
      | string
      | undefined;
    const newStr = (normalizedArgs.new_str ?? normalizedArgs.new_string) as
      | string
      | undefined;
    const content = (normalizedArgs.content ?? normalizedArgs.file_text) as
      | string
      | undefined;
    const command = (normalizedArgs.command ??
      normalizedArgs.cmd ??
      normalizedArgs.script) as string | undefined;
    const query = normalizedArgs.query as string | undefined;

    if (classifiedType === CLI_EVENT_TYPES.FILE_EDIT) {
      const structuredPatch = completionData?.result?.detailedContent
        ? CliParseUtils.parseUnifiedDiff(completionData.result.detailedContent)
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
      const fileReadRange =
        typeof args === "string" ? {} : extractFileReadRange(args);
      return [
        {
          type: CLI_EVENT_TYPES.FILE_READ,
          timestamp: Date.now(),
          data: {
            path: path || "unknown",
            toolCallId: completionData.toolCallId,
            ...fileReadRange,
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
