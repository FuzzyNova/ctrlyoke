/**
 * Shared event-mapping utilities for OpenCode harness parsers.
 *
 * OpenCodeLogParser maps the same OpenCode JSON event format for both headless
 * stdout and interactive polling and produces the shared CliEvent types.
 * This module is the single source of truth for tool and token mapping.
 */
import * as Diff from "diff";
import {
  type CliEvent,
  type AskUserQuestionData,
  type AskUserQuestionEntry,
  type AskUserQuestionOption,
  type UnifiedDiffHunk,
  type TokenUsage,
} from "../../../types/CliOutputTypes";
import type { BaseCliEvent } from "../shared/interfaces/ILogParser";
import {
  CLI_EVENT_TYPES,
  OPERATION_STATUS,
  TOKEN_TOTAL_CONFIDENCE,
} from "../../../types/DashboardConstants";
import {
  OPENCODE_DURABLE_EVENT_TYPES,
  OPENCODE_EVENT_TYPES,
} from "./OpenCodeProtocolConstants";

const OPEN_CODE_QUESTION_TOOL = "question";

type DurableEventType =
  (typeof OPENCODE_DURABLE_EVENT_TYPES)[keyof typeof OPENCODE_DURABLE_EVENT_TYPES];

interface OpenCodeDurableBaseData {
  readonly timestamp: number;
  readonly sessionID: string;
}

interface OpenCodeDurableEnvelope<
  TType extends DurableEventType,
  TData extends OpenCodeDurableBaseData,
> {
  readonly id?: string;
  readonly type: TType;
  readonly data: TData;
  readonly durable?: {
    readonly aggregateID: string;
    readonly seq: number;
    readonly version: number;
  };
}

interface OpenCodePromptData extends OpenCodeDurableBaseData {
  readonly messageID: string;
  readonly prompt: { readonly text: string };
  readonly delivery: "steer" | "queue";
}

interface OpenCodeStepStartedData extends OpenCodeDurableBaseData {
  readonly assistantMessageID: string;
  readonly agent: string;
  readonly model: {
    readonly id: string;
    readonly providerID: string;
    readonly variant?: string;
  };
  readonly snapshot?: string;
}

interface OpenCodeStepEndedData extends OpenCodeDurableBaseData {
  readonly assistantMessageID: string;
  readonly finish: string;
  readonly cost: number;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly reasoning: number;
    readonly cache: { readonly read: number; readonly write: number };
  };
  readonly snapshot?: string;
  readonly files?: readonly string[];
}

interface OpenCodeStepFailedData extends OpenCodeDurableBaseData {
  readonly assistantMessageID: string;
  readonly error: { readonly message: string };
}

interface OpenCodeTextStartedData extends OpenCodeDurableBaseData {
  readonly assistantMessageID: string;
  readonly textID: string;
}

interface OpenCodeTextEndedData extends OpenCodeTextStartedData {
  readonly text: string;
}

interface OpenCodeReasoningStartedData extends OpenCodeDurableBaseData {
  readonly assistantMessageID: string;
  readonly reasoningID: string;
}

interface OpenCodeReasoningEndedData extends OpenCodeReasoningStartedData {
  readonly text: string;
}

interface OpenCodeToolBaseData extends OpenCodeDurableBaseData {
  readonly assistantMessageID: string;
  readonly callID: string;
}

interface OpenCodeToolCalledData extends OpenCodeToolBaseData {
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly provider: { readonly executed: boolean };
}

interface OpenCodeToolContentText {
  readonly type: "text";
  readonly text: string;
}

interface OpenCodeToolContentFile {
  readonly type: "file";
  readonly uri: string;
  readonly mime: string;
  readonly name?: string;
}

type OpenCodeToolContent = OpenCodeToolContentText | OpenCodeToolContentFile;

interface OpenCodeToolResultData extends OpenCodeToolBaseData {
  readonly structured: Record<string, unknown>;
  readonly content: readonly OpenCodeToolContent[];
  readonly result?: unknown;
}

interface OpenCodeToolFailedData extends OpenCodeToolBaseData {
  readonly error: { readonly message: string };
  readonly result?: unknown;
}

interface OpenCodeRetriedData extends OpenCodeDurableBaseData {
  readonly attempt: number;
  readonly error: { readonly message: string };
}

interface OpenCodeCompactionStartedData extends OpenCodeDurableBaseData {
  readonly messageID: string;
  readonly reason: "auto" | "manual";
}

interface OpenCodeCompactionEndedData extends OpenCodeCompactionStartedData {
  readonly text: string;
  readonly recent: string;
}

interface OpenCodeShellStartedData extends OpenCodeDurableBaseData {
  readonly messageID: string;
  readonly callID: string;
  readonly command: string;
}

interface OpenCodeShellEndedData extends OpenCodeDurableBaseData {
  readonly callID: string;
  readonly output: string;
}

export type OpenCodeDurableEvent =
  | OpenCodeDurableEnvelope<
      typeof OPENCODE_DURABLE_EVENT_TYPES.PROMPT_ADMITTED,
      OpenCodePromptData
    >
  | OpenCodeDurableEnvelope<
      typeof OPENCODE_DURABLE_EVENT_TYPES.PROMPTED,
      OpenCodePromptData
    >
  | OpenCodeDurableEnvelope<
      typeof OPENCODE_DURABLE_EVENT_TYPES.STEP_STARTED,
      OpenCodeStepStartedData
    >
  | OpenCodeDurableEnvelope<
      typeof OPENCODE_DURABLE_EVENT_TYPES.STEP_ENDED,
      OpenCodeStepEndedData
    >
  | OpenCodeDurableEnvelope<
      typeof OPENCODE_DURABLE_EVENT_TYPES.STEP_FAILED,
      OpenCodeStepFailedData
    >
  | OpenCodeDurableEnvelope<
      typeof OPENCODE_DURABLE_EVENT_TYPES.TEXT_STARTED,
      OpenCodeTextStartedData
    >
  | OpenCodeDurableEnvelope<
      typeof OPENCODE_DURABLE_EVENT_TYPES.TEXT_ENDED,
      OpenCodeTextEndedData
    >
  | OpenCodeDurableEnvelope<
      typeof OPENCODE_DURABLE_EVENT_TYPES.TOOL_CALLED,
      OpenCodeToolCalledData
    >
  | OpenCodeDurableEnvelope<
      typeof OPENCODE_DURABLE_EVENT_TYPES.TOOL_PROGRESS,
      OpenCodeToolResultData
    >
  | OpenCodeDurableEnvelope<
      typeof OPENCODE_DURABLE_EVENT_TYPES.TOOL_SUCCESS,
      OpenCodeToolResultData
    >
  | OpenCodeDurableEnvelope<
      typeof OPENCODE_DURABLE_EVENT_TYPES.TOOL_FAILED,
      OpenCodeToolFailedData
    >
  | OpenCodeDurableEnvelope<
      typeof OPENCODE_DURABLE_EVENT_TYPES.REASONING_STARTED,
      OpenCodeReasoningStartedData
    >
  | OpenCodeDurableEnvelope<
      typeof OPENCODE_DURABLE_EVENT_TYPES.REASONING_ENDED,
      OpenCodeReasoningEndedData
    >
  | OpenCodeDurableEnvelope<
      typeof OPENCODE_DURABLE_EVENT_TYPES.RETRIED,
      OpenCodeRetriedData
    >
  | OpenCodeDurableEnvelope<
      typeof OPENCODE_DURABLE_EVENT_TYPES.COMPACTION_STARTED,
      OpenCodeCompactionStartedData
    >
  | OpenCodeDurableEnvelope<
      typeof OPENCODE_DURABLE_EVENT_TYPES.COMPACTION_ENDED,
      OpenCodeCompactionEndedData
    >
  | OpenCodeDurableEnvelope<
      typeof OPENCODE_DURABLE_EVENT_TYPES.SHELL_STARTED,
      OpenCodeShellStartedData
    >
  | OpenCodeDurableEnvelope<
      typeof OPENCODE_DURABLE_EVENT_TYPES.SHELL_ENDED,
      OpenCodeShellEndedData
    >;

type NormalizedToolState = {
  readonly status: "pending" | "completed";
  readonly input?: Record<string, unknown>;
  readonly output?: string;
  readonly metadata?: Record<string, unknown>;
};

function toBaseEvent(
  event: OpenCodeDurableEvent,
  type: string,
  part: Record<string, unknown>
): BaseCliEvent {
  return {
    type,
    sessionID: event.data.sessionID,
    timestamp: event.data.timestamp,
    part,
  };
}

function qualifyOpenCodeModel(model: OpenCodeStepStartedData["model"]): string {
  return model.providerID ? `${model.providerID}/${model.id}` : model.id;
}

function computeDurableStepTokenTotal(
  tokens: OpenCodeStepEndedData["tokens"]
): number {
  return (
    tokens.input +
    tokens.output +
    tokens.reasoning +
    tokens.cache.read +
    tokens.cache.write
  );
}

function stringifyToolContent(content: readonly OpenCodeToolContent[]): string {
  return content
    .map((item) => (item.type === "text" ? item.text : item.uri))
    .join("\n");
}

function mapDurableToolState(
  status: NormalizedToolState["status"],
  data: OpenCodeToolCalledData | OpenCodeToolResultData | OpenCodeToolFailedData
): NormalizedToolState {
  if ("tool" in data) {
    return { status, input: data.input };
  }

  if ("content" in data) {
    return {
      status,
      output: stringifyToolContent(data.content),
      metadata: {
        ...data.structured,
        structured: data.structured,
        content: data.content,
        ...(data.result === undefined ? {} : { result: data.result }),
      },
    };
  }

  return {
    status,
    output: data.error.message,
    metadata: {
      error: data.error.message,
      ...(data.result === undefined ? {} : { result: data.result }),
    },
  };
}

function durableToolName(
  data: OpenCodeToolResultData | OpenCodeToolFailedData
): string {
  const structured = "structured" in data ? data.structured : undefined;
  return typeof structured?.tool === "string" ? structured.tool : "unknown";
}

function withToolContext(
  event: BaseCliEvent,
  context: { readonly tool: string; readonly input: Record<string, unknown> }
): BaseCliEvent {
  const part = event["part"] as Record<string, unknown>;
  const state = part.state as Record<string, unknown> | undefined;
  return {
    ...event,
    part: {
      ...part,
      tool: context.tool,
      state: {
        ...state,
        input: context.input,
      },
    },
  };
}

/**
 * Map one durable history event to the export-shaped BaseCliEvent vocabulary.
 * Non-displayable lifecycle markers return undefined; their replayable end
 * events carry the complete text, reasoning, or tool result.
 */
export function mapOpenCodeDurableEventToBaseCliEvent(
  event: OpenCodeDurableEvent
): BaseCliEvent | undefined {
  switch (event.type) {
    case OPENCODE_DURABLE_EVENT_TYPES.PROMPT_ADMITTED:
      // Admission is a queue boundary; prompted is the single user-text boundary.
      return undefined;

    case OPENCODE_DURABLE_EVENT_TYPES.PROMPTED:
      return {
        type: OPENCODE_EVENT_TYPES.USER_TEXT,
        sessionID: event.data.sessionID,
        timestamp: event.data.timestamp,
        text: event.data.prompt.text,
      };

    case OPENCODE_DURABLE_EVENT_TYPES.STEP_STARTED:
      return toBaseEvent(event, OPENCODE_EVENT_TYPES.STEP_START, {
        model: qualifyOpenCodeModel(event.data.model),
        providerID: event.data.model.providerID,
        agent: event.data.agent,
        snapshot: event.data.snapshot,
      });

    case OPENCODE_DURABLE_EVENT_TYPES.STEP_ENDED:
      return toBaseEvent(event, OPENCODE_EVENT_TYPES.STEP_FINISH, {
        reason: event.data.finish,
        cost: event.data.cost,
        tokens: {
          ...event.data.tokens,
          total: computeDurableStepTokenTotal(event.data.tokens),
        },
      });

    case OPENCODE_DURABLE_EVENT_TYPES.STEP_FAILED:
      return toBaseEvent(event, OPENCODE_EVENT_TYPES.STEP_FINISH, {
        reason: "error",
        error: event.data.error.message,
      });

    case OPENCODE_DURABLE_EVENT_TYPES.TEXT_STARTED:
      return undefined;

    case OPENCODE_DURABLE_EVENT_TYPES.TEXT_ENDED:
      return toBaseEvent(event, OPENCODE_EVENT_TYPES.TEXT, {
        text: event.data.text,
      });

    // Tool and reasoning durable payloads are schema-derived; no live history capture has exercised them yet.
    case OPENCODE_DURABLE_EVENT_TYPES.TOOL_CALLED:
      return toBaseEvent(event, OPENCODE_EVENT_TYPES.TOOL_USE, {
        tool: event.data.tool,
        callID: event.data.callID,
        state: mapDurableToolState("pending", event.data),
      });

    case OPENCODE_DURABLE_EVENT_TYPES.TOOL_PROGRESS:
      return toBaseEvent(event, OPENCODE_EVENT_TYPES.TOOL_USE, {
        tool: durableToolName(event.data),
        callID: event.data.callID,
        state: mapDurableToolState("pending", event.data),
      });

    case OPENCODE_DURABLE_EVENT_TYPES.TOOL_SUCCESS:
      return toBaseEvent(event, OPENCODE_EVENT_TYPES.TOOL_USE, {
        tool: durableToolName(event.data),
        callID: event.data.callID,
        state: mapDurableToolState("completed", event.data),
      });

    case OPENCODE_DURABLE_EVENT_TYPES.TOOL_FAILED:
      return toBaseEvent(event, OPENCODE_EVENT_TYPES.TOOL_USE, {
        tool: durableToolName(event.data),
        callID: event.data.callID,
        state: mapDurableToolState("completed", event.data),
      });

    case OPENCODE_DURABLE_EVENT_TYPES.REASONING_STARTED:
      return undefined;

    case OPENCODE_DURABLE_EVENT_TYPES.REASONING_ENDED:
      return toBaseEvent(event, OPENCODE_EVENT_TYPES.THINKING, {
        text: event.data.text,
      });

    case OPENCODE_DURABLE_EVENT_TYPES.RETRIED:
      return toBaseEvent(event, OPENCODE_EVENT_TYPES.RETRY, {
        attempt: event.data.attempt,
        error: event.data.error.message,
      });

    case OPENCODE_DURABLE_EVENT_TYPES.COMPACTION_STARTED:
      return toBaseEvent(event, OPENCODE_EVENT_TYPES.COMPACTION, {
        auto: event.data.reason === "auto",
      });

    case OPENCODE_DURABLE_EVENT_TYPES.COMPACTION_ENDED:
      return toBaseEvent(event, OPENCODE_EVENT_TYPES.COMPACTION, {
        auto: event.data.reason === "auto",
        summary: event.data.text,
        recent: event.data.recent,
      });

    case OPENCODE_DURABLE_EVENT_TYPES.SHELL_STARTED:
      return toBaseEvent(event, OPENCODE_EVENT_TYPES.TOOL_USE, {
        tool: "bash",
        callID: event.data.callID,
        state: { status: "pending", input: { command: event.data.command } },
      });

    case OPENCODE_DURABLE_EVENT_TYPES.SHELL_ENDED:
      return toBaseEvent(event, OPENCODE_EVENT_TYPES.TOOL_USE, {
        tool: "bash",
        callID: event.data.callID,
        state: {
          status: "completed",
          output: event.data.output,
        },
      });
  }
}

/** Map a history page while retaining only events with a displayable boundary. */
export function mapOpenCodeDurableEventsToBaseCliEvents(
  events: readonly OpenCodeDurableEvent[]
): BaseCliEvent[] {
  const toolContext = new Map<
    string,
    { readonly tool: string; readonly input: Record<string, unknown> }
  >();

  return events.flatMap((event) => {
    if (event.type === OPENCODE_DURABLE_EVENT_TYPES.TOOL_CALLED) {
      toolContext.set(event.data.callID, {
        tool: event.data.tool,
        input: event.data.input,
      });
    }

    const mapped = mapOpenCodeDurableEventToBaseCliEvent(event);
    if (!mapped) return [];

    if (
      event.type === OPENCODE_DURABLE_EVENT_TYPES.TOOL_PROGRESS ||
      event.type === OPENCODE_DURABLE_EVENT_TYPES.TOOL_SUCCESS ||
      event.type === OPENCODE_DURABLE_EVENT_TYPES.TOOL_FAILED
    ) {
      const context = toolContext.get(event.data.callID);
      if (context) {
        const contextualized = withToolContext(mapped, context);
        if (
          event.type === OPENCODE_DURABLE_EVENT_TYPES.TOOL_SUCCESS ||
          event.type === OPENCODE_DURABLE_EVENT_TYPES.TOOL_FAILED
        ) {
          toolContext.delete(event.data.callID);
        }
        return [contextualized];
      }
    }

    if (
      event.type === OPENCODE_DURABLE_EVENT_TYPES.TOOL_SUCCESS ||
      event.type === OPENCODE_DURABLE_EVENT_TYPES.TOOL_FAILED
    ) {
      toolContext.delete(event.data.callID);
    }

    return [mapped];
  });
}

/**
 * Compute structured diff hunks from a full before/after file pair.
 * Returns undefined when either input is unavailable (incomplete tool call).
 */
function computeStructuredPatch(
  filePath: string,
  before: string,
  after: string
): UnifiedDiffHunk[] | undefined {
  const result = Diff.structuredPatch(
    filePath,
    filePath,
    before,
    after,
    "",
    "",
    { context: 3 }
  );
  if (!result.hunks.length) return undefined;
  return result.hunks.map((h) => ({
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    lines: h.lines as string[],
  }));
}

/**
 * Accumulate token counts from a step_finish event's `tokens` field into a
 * running TokenUsage object. Returns the `tokens.total` value (full context
 * occupancy for this step) when present, so callers can track `lastStepTotal`
 * for `contextWindowUsedTokens`. Returns undefined when total is not a number.
 *
 * step_start and step_finish are structural markers — they are NOT converted to
 * CliEvents for display. step_finish is consumed here only for token accounting.
 */
export function accumulateOpenCodeStepTokens(
  tokens: Record<string, any>,
  tokenUsage: TokenUsage
): number | undefined {
  tokenUsage.inputTokens = (tokenUsage.inputTokens ?? 0) + (tokens.input ?? 0);
  tokenUsage.outputTokens =
    (tokenUsage.outputTokens ?? 0) + (tokens.output ?? 0);
  tokenUsage.totalTokens =
    (tokenUsage.totalTokens ?? 0) + (tokens.input ?? 0) + (tokens.output ?? 0);
  tokenUsage.totalConfidence = TOKEN_TOTAL_CONFIDENCE.ACCUMULATED;
  if (typeof tokens.cache?.read === "number") {
    tokenUsage.cachedInputTokens =
      (tokenUsage.cachedInputTokens ?? 0) + tokens.cache.read;
  }
  if (typeof tokens.cache?.write === "number") {
    tokenUsage.cacheCreatedTokens =
      (tokenUsage.cacheCreatedTokens ?? 0) + tokens.cache.write;
  }
  if (typeof tokens.reasoning === "number") {
    tokenUsage.reasoningOutputTokens =
      (tokenUsage.reasoningOutputTokens ?? 0) + tokens.reasoning;
  }
  return typeof tokens.total === "number" ? tokens.total : undefined;
}

/**
 * Map an OpenCode tool_use part to the appropriate CliEvent.
 *
 * Handles the four built-in OpenCode tools (bash, write, edit, read) plus a
 * catch-all for any other tool calls. Returns undefined only when `part.tool`
 * is absent.
 *
 * `timestamp` may be undefined when the event source does not carry one.
 */
export function mapOpenCodeToolPartToCliEvent(
  timestamp: number | undefined,
  part: Record<string, any>
): CliEvent | undefined {
  const toolName = part.tool as string | undefined;
  if (!toolName) return undefined;

  const input = part.state?.input ?? {};
  const output = part.state?.output ?? "";
  const isCompleted = part.state?.status === "completed";

  if (toolName === OPEN_CODE_QUESTION_TOOL) {
    return mapOpenCodeQuestionPartToCliEvent(timestamp, part, isCompleted);
  }

  switch (toolName) {
    case "bash":
      return {
        type: CLI_EVENT_TYPES.BASH_COMMAND,
        timestamp,
        data: {
          command: input.command ?? "",
          output: typeof output === "string" ? output : JSON.stringify(output),
          exitCode: part.state?.metadata?.exit,
        },
      };

    case "write":
      return {
        type: CLI_EVENT_TYPES.FILE_WRITE,
        timestamp,
        data: {
          path: input.filePath ?? input.path ?? input.file_path ?? "",
          content: input.content ?? "",
        },
      };

    case "edit": {
      const filediff = part.state?.metadata?.filediff;
      const filePath = input.filePath ?? input.path ?? input.file_path ?? "";
      const structuredPatch =
        filediff?.before != null && filediff?.after != null
          ? computeStructuredPatch(filePath, filediff.before, filediff.after)
          : undefined;
      return {
        type: CLI_EVENT_TYPES.FILE_EDIT,
        timestamp,
        data: {
          path: filePath,
          // Use old_string/new_string for display (shows only the changed region,
          // matching Claude CLI behaviour). Falls back to full before/after when input
          // params are absent (unexpected) so the diff is never empty.
          oldContent: input.oldString ?? filediff?.before ?? "",
          newContent: input.newString ?? filediff?.after ?? "",
          structuredPatch,
          success: isCompleted,
        },
      };
    }

    case "read":
      return {
        type: CLI_EVENT_TYPES.FILE_READ,
        timestamp,
        data: {
          path: input.filePath ?? input.path ?? input.file_path ?? "",
          ...readLineRange(part.state?.metadata?.display),
        },
      };

    default: {
      const error =
        typeof part.state?.metadata?.error === "string"
          ? part.state.metadata.error
          : undefined;
      return {
        type: CLI_EVENT_TYPES.TOOL_CALL,
        timestamp,
        data: {
          name: toolName,
          parameters: input as Record<string, unknown>,
          result: isCompleted
            ? {
                success: error === undefined,
                output:
                  typeof output === "string" ? output : JSON.stringify(output),
                ...(error === undefined ? {} : { error }),
              }
            : undefined,
        },
      };
    }
  }
}

/**
 * OpenCode's read tool result already reports the served range as structured
 * numbers in `state.metadata.display` (lineStart/lineEnd/totalLines) — unlike
 * Antigravity, there is no rendered summary line to regex-parse. A whole-file
 * read reports lineStart 1 and lineEnd === totalLines, which should not
 * surface as a segment read.
 */
function readLineRange(display: unknown): {
  lineStart?: number;
  lineEnd?: number;
} {
  const d = display as
    | { lineStart?: number; lineEnd?: number; totalLines?: number }
    | undefined;
  if (!d || typeof d.lineStart !== "number" || typeof d.lineEnd !== "number") {
    return {};
  }
  const isSegmentRead =
    d.lineStart > 1 ||
    (typeof d.totalLines === "number" && d.lineEnd < d.totalLines);
  return isSegmentRead ? { lineStart: d.lineStart, lineEnd: d.lineEnd } : {};
}

/**
 * Map OpenCode's question tool result into the shared question event shape.
 *
 * OpenCode stores the selected answers as an array of arrays in
 * `state.metadata.answers`; the question input and option descriptions live
 * in `state.input.questions`. OpenCode currently puts preview art in the
 * description after a blank line, so split that into the shared description
 * and preview fields for the renderer.
 */
function mapOpenCodeQuestionPartToCliEvent(
  timestamp: number | undefined,
  part: Record<string, any>,
  isCompleted: boolean
): CliEvent {
  const state = part.state ?? {};
  const input = state.input ?? {};
  const questions = parseOpenCodeQuestions(input.questions);
  const answers = parseOpenCodeAnswers(state.metadata?.answers);
  const output = typeof state.output === "string" ? state.output : "";
  const resolvedQuestions = questions.map((question, index) => {
    const answer =
      answers[index] ??
      parseOpenCodeAnswerFromOutput(output, question.question);
    const selectedOption = question.options.find(
      (option) => option.label === answer
    );
    return {
      ...question,
      answer,
      answerPreview: selectedOption?.preview,
    };
  });
  const declined = isOpenCodeQuestionDeclined(output, answers);

  return {
    type: CLI_EVENT_TYPES.ASK_USER_QUESTION,
    timestamp,
    data: {
      toolCallId: part.callID,
      questions: resolvedQuestions,
      status: !isCompleted
        ? OPERATION_STATUS.INITIATED
        : declined
          ? OPERATION_STATUS.FAILED
          : OPERATION_STATUS.COMPLETED,
      declined: declined
        ? { reason: "rejected", feedback: output || undefined }
        : undefined,
    } as AskUserQuestionData,
  };
}

function parseOpenCodeQuestions(rawQuestions: unknown): AskUserQuestionEntry[] {
  if (!Array.isArray(rawQuestions)) return [];

  return rawQuestions.map((rawQuestion) => {
    const question = (rawQuestion ?? {}) as Record<string, unknown>;
    return {
      question: typeof question.question === "string" ? question.question : "",
      header: typeof question.header === "string" ? question.header : undefined,
      multiSelect:
        typeof question.multiSelect === "boolean"
          ? question.multiSelect
          : typeof question.multiple === "boolean"
            ? question.multiple
            : undefined,
      options: parseOpenCodeOptions(question.options),
    };
  });
}

function parseOpenCodeOptions(rawOptions: unknown): AskUserQuestionOption[] {
  if (!Array.isArray(rawOptions)) return [];

  return rawOptions.map((rawOption) => {
    const option = (rawOption ?? {}) as Record<string, unknown>;
    const rawDescription =
      typeof option.description === "string" ? option.description : undefined;
    const [description, ...previewLines] = rawDescription
      ? rawDescription.split(/\r?\n\s*\r?\n/)
      : [];
    return {
      label: typeof option.label === "string" ? option.label : "",
      description,
      preview: previewLines.length ? previewLines.join("\n\n") : undefined,
    };
  });
}

function parseOpenCodeAnswers(rawAnswers: unknown): (string | undefined)[] {
  if (!Array.isArray(rawAnswers)) return [];

  return rawAnswers.map((rawAnswer) => {
    if (Array.isArray(rawAnswer)) {
      const answers = rawAnswer.filter(
        (answer): answer is string => typeof answer === "string"
      );
      return answers.length ? answers.join(", ") : undefined;
    }
    return typeof rawAnswer === "string" ? rawAnswer : undefined;
  });
}

function parseOpenCodeAnswerFromOutput(
  output: string,
  question: string
): string | undefined {
  if (!output || !question) return undefined;
  const escapedQuestion = question.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = output.match(new RegExp(`"${escapedQuestion}"="([^"]*)"`));
  return match?.[1];
}

function isOpenCodeQuestionDeclined(
  output: string,
  answers: (string | undefined)[]
): boolean {
  return (
    answers.every((answer) => answer === undefined) &&
    /\b(reject|declin|cancel)\w*/i.test(output)
  );
}
