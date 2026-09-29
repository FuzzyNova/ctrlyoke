/**
 * Shared event-mapping utilities for OpenCode harness parsers.
 *
 * OpenCodeLogParser maps the same OpenCode JSON event format for both headless
 * stdout and interactive polling and produces the shared CliEvent types.
 * This module is the single source of truth for tool and token mapping.
 */
import {
  type CliEvent,
  type AskUserQuestionData,
  type AskUserQuestionEntry,
  type AskUserQuestionOption,
  type TokenUsage,
} from "../../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  OPERATION_STATUS,
  TOKEN_TOTAL_CONFIDENCE,
} from "../../../types/DashboardConstants";
import { CliParseUtils } from "../shared/CliParseUtils";
import { OPENCODE_TOOL_NAMES } from "./OpenCodeProtocolConstants";

const OPEN_CODE_QUESTION_TOOL = "question";

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
  const reasoning = typeof tokens.reasoning === "number" ? tokens.reasoning : 0;
  tokenUsage.totalTokens =
    (tokenUsage.totalTokens ?? 0) +
    (tokens.input ?? 0) +
    (tokens.output ?? 0) +
    reasoning;
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
  const isCompleted = part.state?.status === OPERATION_STATUS.COMPLETED;

  if (toolName === OPEN_CODE_QUESTION_TOOL) {
    return mapOpenCodeQuestionPartToCliEvent(timestamp, part, isCompleted);
  }

  switch (toolName) {
    case OPENCODE_TOOL_NAMES.BASH:
      return {
        type: CLI_EVENT_TYPES.BASH_COMMAND,
        timestamp,
        data: {
          command: input.command ?? "",
          output: typeof output === "string" ? output : JSON.stringify(output),
          exitCode: part.state?.metadata?.exit,
        },
      };

    case OPENCODE_TOOL_NAMES.WRITE:
      return {
        type: CLI_EVENT_TYPES.FILE_WRITE,
        timestamp,
        data: {
          path: input.filePath ?? input.path ?? input.file_path ?? "",
          content: input.content ?? "",
        },
      };

    case OPENCODE_TOOL_NAMES.EDIT: {
      // OpenCode's edit metadata carries a ready-made unified diff string
      // (`filediff.patch`, e.g. `@@ -16,19 +16,19 @@`) with accurate line
      // offsets — not a before/after content pair. Parsing it with the same
      // unified-diff parser other harnesses use keeps this single-sourced.
      const filediff = part.state?.metadata?.filediff;
      const filePath = input.filePath ?? input.path ?? input.file_path ?? "";
      const structuredPatch =
        typeof filediff?.patch === "string"
          ? CliParseUtils.parseUnifiedDiff(filediff.patch)
          : undefined;
      return {
        type: CLI_EVENT_TYPES.FILE_EDIT,
        timestamp,
        data: {
          path: filePath,
          // old_string/new_string show only the changed region, matching Claude
          // CLI behaviour.
          oldContent: input.oldString ?? "",
          newContent: input.newString ?? "",
          structuredPatch,
          success: isCompleted,
        },
      };
    }

    case OPENCODE_TOOL_NAMES.READ:
      return {
        type: CLI_EVENT_TYPES.FILE_READ,
        timestamp,
        data: {
          path: input.filePath ?? input.path ?? input.file_path ?? "",
          ...readLineRange(part.state?.metadata?.display),
        },
      };

    default:
      return {
        type: CLI_EVENT_TYPES.TOOL_CALL,
        timestamp,
        data: {
          name: toolName,
          id: part.callID,
          parameters: input as Record<string, unknown>,
          result: isCompleted
            ? {
                success: true,
                output:
                  typeof output === "string" ? output : JSON.stringify(output),
              }
            : undefined,
        },
      };
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
    { lineStart?: number; lineEnd?: number; totalLines?: number } | undefined;
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
