/**
 * Shared event-mapping utilities for OpenCode harness parsers.
 *
 * OpenCodeLogParser maps the same OpenCode JSON event format for both headless
 * stdout and interactive polling and produces the shared CliEvent types.
 * This module is the single source of truth for tool and token mapping.
 */
import { isRecord } from "../../../utils/JsonTypeGuards";
import { escapeRegExp } from "../../../utils/TextUtils";
import {
  type CliEvent,
  type AskUserQuestionData,
  type AskUserQuestionEntry,
  type AskUserQuestionOption,
  type TokenUsage,
  type WebSearchData,
} from "../../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  OPERATION_STATUS,
  TOKEN_TOTAL_CONFIDENCE,
  SUBAGENT_SPAWN_STATES,
} from "../../../types/DashboardConstants";
import { CliParseUtils } from "../shared/CliParseUtils";
import { CliEventMapper, type McpToolHint } from "../shared/CliEventMapper";
import {
  OPENCODE_SHELL_TOOL_NAMES,
  OPENCODE_SUBAGENT_TOOL_NAMES,
  OPENCODE_TOOL_NAMES,
  OPENCODE_TOOL_STATUS,
} from "./OpenCodeProtocolConstants";

const OPEN_CODE_QUESTION_TOOL = "question";

/**
 * A step's full context occupancy. OpenCode 1 reports it as `tokens.total`;
 * OpenCode 2 drops the field, so it is rebuilt from the same parts (input
 * excludes cache in both generations).
 */
export function openCodeStepTotal(
  tokens: Record<string, any>
): number | undefined {
  if (typeof tokens.total === "number") return tokens.total;
  const parts = [
    tokens.input,
    tokens.output,
    tokens.reasoning,
    tokens.cache?.read,
    tokens.cache?.write,
  ];
  if (typeof tokens.input !== "number") return undefined;
  return parts.reduce<number>(
    (sum, value) => sum + (typeof value === "number" ? value : 0),
    0
  );
}

/** Text of an OpenCode 2 tool result's `content` array. */
function openCodeToolContentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((item) => isRecord(item) && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("");
  return text || undefined;
}

/**
 * Bring an OpenCode tool part to the OpenCode 1 shape the mapper reads:
 * `{ tool, callID, state: { status, input, output, error, metadata } }`.
 *
 * Three shapes reach here, told apart by their fields rather than by version:
 * - OpenCode 1 parts: `id` is the part id, `callID` the call id, flat metadata.
 * - OpenCode 2 `run --format json` parts: `partID` is the part id, `id` the
 *   call id, and the tool's own metadata is nested in `state.metadata.metadata`.
 * - OpenCode 2 export content items: `name` instead of `tool`, `id` the call
 *   id, output in `state.content`, and `state.error` a `{ message }` object.
 *
 * OpenCode 2 also names file paths `path` (was `filePath`) and reports a
 * subagent's child session as `sessionID` (was `sessionId`); both are mapped.
 */
export function normalizeOpenCodeToolPart(
  part: Record<string, any>
): Record<string, any> {
  const state = isRecord(part.state) ? part.state : {};
  const isV2Stream = typeof part.partID === "string";
  const isV2Export = typeof part.name === "string" && part.tool === undefined;
  const rawMetadata = isRecord(state.metadata) ? state.metadata : undefined;
  const metadata =
    isV2Stream && isRecord(rawMetadata?.metadata)
      ? rawMetadata.metadata
      : rawMetadata;
  const childSessionId =
    typeof metadata?.sessionId === "string"
      ? metadata.sessionId
      : typeof metadata?.sessionID === "string"
        ? metadata.sessionID
        : undefined;
  const error =
    typeof state.error === "string"
      ? state.error
      : isRecord(state.error) && typeof state.error.message === "string"
        ? state.error.message
        : undefined;
  return {
    ...part,
    tool: part.tool ?? part.name,
    callID: part.callID ?? (isV2Stream || isV2Export ? part.id : undefined),
    state: {
      ...state,
      output: state.output ?? openCodeToolContentText(state.content),
      ...(error !== undefined ? { error } : {}),
      metadata:
        metadata || childSessionId
          ? {
              ...metadata,
              ...(childSessionId ? { sessionId: childSessionId } : {}),
            }
          : undefined,
    },
  };
}

/** The file path a file tool names, under its OpenCode 1 or 2 key. */
function openCodeToolPath(input: Record<string, any>): string {
  return input.filePath ?? input.path ?? input.file_path ?? "";
}

/**
 * OpenCode 2's edit metadata lists `files[]` each with a unified `patch`;
 * OpenCode 1 carried one `filediff.patch`.
 */
function openCodeEditPatch(
  metadata: Record<string, any> | undefined,
  filePath: string
): string | undefined {
  if (typeof metadata?.filediff?.patch === "string") {
    return metadata.filediff.patch;
  }
  const files = Array.isArray(metadata?.files) ? metadata.files : [];
  const match =
    files.find((file: any) => isRecord(file) && file.file === filePath) ??
    (files.length === 1 ? files[0] : undefined);
  return typeof match?.patch === "string" ? match.patch : undefined;
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
  return openCodeStepTotal(tokens);
}

/**
 * Map an OpenCode tool_use part to the appropriate CliEvent.
 *
 * Handles the built-in OpenCode tools (bash/shell, write, edit, read,
 * task/subagent) plus a catch-all for any other tool calls. Accepts every
 * shape normalizeOpenCodeToolPart() does. Returns undefined only when the part
 * names no tool.
 *
 * `timestamp` may be undefined when the event source does not carry one.
 */
export function mapOpenCodeToolPartToCliEvent(
  timestamp: number | undefined,
  rawPart: Record<string, any>,
  attachedMcpServerIds: ReadonlySet<string> = new Set()
): CliEvent | undefined {
  const part = normalizeOpenCodeToolPart(rawPart);
  const toolName = part.tool as string | undefined;
  if (!toolName) return undefined;

  const input = part.state?.input ?? {};
  const output = part.state?.output ?? "";
  const isCompleted = part.state?.status === OPERATION_STATUS.COMPLETED;
  const error =
    typeof part.state?.error === "string" ? part.state.error : undefined;
  const isFailed = part.state?.status === OPENCODE_TOOL_STATUS.ERROR;
  const success = isFailed ? false : isCompleted ? true : undefined;

  if (toolName === OPEN_CODE_QUESTION_TOOL) {
    return mapOpenCodeQuestionPartToCliEvent(timestamp, part, isCompleted);
  }

  if (OPENCODE_SUBAGENT_TOOL_NAMES.has(toolName)) {
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
          : isFailed
            ? { success: false, output: error, error }
            : undefined,
        subagentSpawn: {
          agentType:
            typeof input.agent === "string"
              ? input.agent
              : OPENCODE_TOOL_NAMES.TASK,
          description:
            typeof input.description === "string" ? input.description : "",
          state: isCompleted
            ? SUBAGENT_SPAWN_STATES.COMPLETED
            : SUBAGENT_SPAWN_STATES.RUNNING,
          children:
            typeof part.state?.metadata?.sessionId === "string"
              ? [
                  {
                    agentId: part.state.metadata.sessionId,
                    label:
                      typeof input.agent === "string"
                        ? input.agent
                        : OPENCODE_TOOL_NAMES.TASK,
                  },
                ]
              : [],
        },
      },
    };
  }

  if (OPENCODE_SHELL_TOOL_NAMES.has(toolName)) {
    return {
      type: CLI_EVENT_TYPES.BASH_COMMAND,
      timestamp,
      data: {
        command: input.command ?? "",
        output: isFailed
          ? (error ?? "")
          : typeof output === "string"
            ? output
            : JSON.stringify(output),
        exitCode: part.state?.metadata?.exit,
        ...(isFailed
          ? {
              status: OPERATION_STATUS.FAILED,
              error,
            }
          : {}),
      },
    };
  }

  switch (toolName) {
    case OPENCODE_TOOL_NAMES.WRITE:
      return {
        type: CLI_EVENT_TYPES.FILE_WRITE,
        timestamp,
        data: {
          path: openCodeToolPath(input),
          content: input.content ?? "",
          ...(isFailed
            ? {
                status: OPERATION_STATUS.FAILED,
                success: false,
                error,
              }
            : {}),
        },
      };

    case OPENCODE_TOOL_NAMES.EDIT: {
      // OpenCode's edit metadata carries a ready-made unified diff string
      // (e.g. `@@ -16,19 +16,19 @@`) with accurate line offsets — not a
      // before/after content pair. Parsing it with the same unified-diff
      // parser other harnesses use keeps this single-sourced.
      const filePath = openCodeToolPath(input);
      const patch = openCodeEditPatch(part.state?.metadata, filePath);
      const structuredPatch =
        patch !== undefined ? CliParseUtils.parseUnifiedDiff(patch) : undefined;
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
          success,
          ...(isFailed
            ? {
                status: OPERATION_STATUS.FAILED,
                error,
              }
            : {}),
        },
      };
    }

    case OPENCODE_TOOL_NAMES.READ:
      return {
        type: CLI_EVENT_TYPES.FILE_READ,
        timestamp,
        data: {
          path: openCodeToolPath(input),
          ...readLineRange(part.state?.metadata?.display),
          ...(isFailed
            ? {
                status: OPERATION_STATUS.FAILED,
                success: false,
                error,
              }
            : {}),
        },
      };

    default: {
      const mcpHint = findOpenCodeMcpToolHint(toolName, attachedMcpServerIds);
      const classification = CliEventMapper.classifyTool(toolName, mcpHint);
      if (classification.type === CLI_EVENT_TYPES.WEB_SEARCH) {
        const results = isCompleted ? parseOpenCodeWebResults(output) : [];
        return {
          type: CLI_EVENT_TYPES.WEB_SEARCH,
          timestamp,
          data: {
            query: typeof input.query === "string" ? input.query : "",
            toolCallId: part.callID,
            ...(results.length > 0
              ? { results }
              : isCompleted && typeof output === "string"
                ? { output }
                : {}),
            ...(isCompleted ? { success: true } : {}),
            ...(isFailed ? { success: false, error } : {}),
          } as WebSearchData,
        };
      }
      if (classification.type === CLI_EVENT_TYPES.MCP_TOOL_CALL) {
        return {
          type: classification.type,
          timestamp,
          data: {
            server: classification.server,
            tool: classification.tool,
            toolCallId: part.callID,
            parameters: input as Record<string, unknown>,
            result: isCompleted
              ? {
                  success: true,
                  output:
                    typeof output === "string"
                      ? output
                      : JSON.stringify(output),
                }
              : isFailed
                ? { success: false, output: error, error }
                : undefined,
          },
        };
      }

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
            : isFailed
              ? { success: false, output: error, error }
              : undefined,
        },
      };
    }
  }
}

/**
 * OpenCode's websearch output is JSON: `results[]` of `{ url, title,
 * excerpts[] }`. Each becomes a source with its first excerpt as the snippet;
 * anything else yields none, and the raw output is shown instead.
 */
function parseOpenCodeWebResults(
  output: unknown
): NonNullable<WebSearchData["results"]> {
  let parsed: unknown = output;
  if (typeof output === "string") {
    try {
      parsed = JSON.parse(output);
    } catch {
      return [];
    }
  }
  const results = (parsed as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((result) => {
    const item = result as {
      url?: unknown;
      title?: unknown;
      excerpts?: unknown;
    };
    if (typeof item?.url !== "string") return [];
    const excerpt = Array.isArray(item.excerpts) ? item.excerpts[0] : undefined;
    return [
      {
        title: typeof item.title === "string" ? item.title : item.url,
        url: item.url,
        ...(typeof excerpt === "string" ? { snippet: excerpt.trim() } : {}),
      },
    ];
  });
}

/** Resolve OpenCode's `<server>_<tool>` name using only execution-attached ids. */
function findOpenCodeMcpToolHint(
  toolName: string,
  attachedMcpServerIds: ReadonlySet<string>
): McpToolHint | undefined {
  const serverId = [...attachedMcpServerIds]
    .filter((id) => toolName.startsWith(`${id}_`))
    .sort((left, right) => right.length - left.length)[0];
  if (!serverId) return undefined;

  return {
    server: serverId,
    tool: toolName.slice(serverId.length + 1),
  };
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
  const escapedQuestion = escapeRegExp(question);
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
