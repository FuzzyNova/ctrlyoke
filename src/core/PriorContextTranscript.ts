import type {
  AskUserQuestionData,
  BashCommandData,
  CliEvent,
  FileDeleteData,
  FileEditData,
  FileReadData,
  FileWriteData,
  McpToolCallData,
  ToolCall,
  ToolResult,
  UserSteerData,
  TerminalOutputData,
  WebSearchData,
} from "../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  OPERATION_STATUS,
  PRIOR_CONTEXT_LIMITS,
  PRIOR_CONTEXT_TRUNCATION,
  PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS,
} from "../types/DashboardConstants";
import {
  countStructuredPatchChanges,
  formatCreatedFileDiff,
  formatEditDiff,
} from "../utils/CliEventDiff";
import { normalizeCliEvents } from "../utils/CliEventNormalizer";

export type OmittedPart =
  | typeof PRIOR_CONTEXT_TRUNCATION.OMITTED_START
  | typeof PRIOR_CONTEXT_TRUNCATION.OMITTED_END;

export interface PriorContextText {
  text: string;
  omitted?: OmittedPart;
  omittedBytes?: number;
}

interface EntryBase {
  failed?: true;
}

export type PriorContextTranscriptEntry =
  | (EntryBase & {
      kind: typeof PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.TEXT;
      text: string;
    })
  | (EntryBase & {
      kind: typeof PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.THINKING;
      text: string;
    })
  | (EntryBase & {
      kind: typeof PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.EDIT;
      path: string;
      added: number;
      removed: number;
      diff?: PriorContextText;
    })
  | (EntryBase & {
      kind: typeof PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.CREATE;
      path: string;
      added: number;
      diff: PriorContextText;
    })
  | (EntryBase & {
      kind: typeof PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.DELETE;
      path: string;
    })
  | (EntryBase & {
      kind: typeof PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.COMMAND;
      command: string;
      exitCode?: number;
      output: PriorContextText;
    })
  | (EntryBase & {
      kind: typeof PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.READ;
      path: string;
      lineStart?: number;
      lineEnd?: number;
    })
  | (EntryBase & {
      kind: typeof PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.TOOL;
      name: string;
      arguments: PriorContextText;
      result: PriorContextText;
    })
  | (EntryBase & {
      kind: typeof PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.SEARCH;
      query: string;
      results: NonNullable<WebSearchData["results"]>;
      failed?: true;
    })
  | (EntryBase & {
      kind: typeof PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.QUESTION;
      questions: AskUserQuestionData["questions"];
      declined?: AskUserQuestionData["declined"];
    })
  | (EntryBase & {
      kind: typeof PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.USER_STEER;
      text: string;
    })
  | (EntryBase & {
      kind: typeof PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.TERMINAL_OUTPUT;
      text: string;
      reason: string;
    });

const encoder = new TextEncoder();

function utf8Bytes(text: string): number {
  return encoder.encode(text).byteLength;
}

function codePointSlice(text: string, maxBytes: number, keepEnd: boolean): string {
  const points = Array.from(text);
  const selected: string[] = [];
  let bytes = 0;
  const sequence = keepEnd ? points.reverse() : points;
  for (const point of sequence) {
    const pointBytes = utf8Bytes(point);
    if (bytes + pointBytes > maxBytes) break;
    selected.push(point);
    bytes += pointBytes;
  }
  if (keepEnd) selected.reverse();
  return selected.join("");
}

/** Bounds text by UTF-8 bytes, preferring complete lines and never splitting code points. */
export function boundPriorContextText(
  text: string,
  maxBytes: number,
  keep:
    | typeof PRIOR_CONTEXT_TRUNCATION.HEAD
    | typeof PRIOR_CONTEXT_TRUNCATION.TAIL
): PriorContextText {
  const totalBytes = utf8Bytes(text);
  if (totalBytes <= maxBytes) return { text };

  const lines = text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const kept: string[] = [];
  let keptBytes = 0;
  const orderedLines =
    keep === PRIOR_CONTEXT_TRUNCATION.HEAD ? lines : [...lines].reverse();
  for (const line of orderedLines) {
    const lineBytes = utf8Bytes(line);
    if (keptBytes + lineBytes > maxBytes) break;
    kept.push(line);
    keptBytes += lineBytes;
  }

  let keptText: string;
  if (kept.length > 0) {
    keptText =
      (keep === PRIOR_CONTEXT_TRUNCATION.HEAD ? kept : kept.reverse()).join("");
  } else {
    // A single overlong line has no possible line-boundary cut within the cap.
    keptText = codePointSlice(
      text,
      maxBytes,
      keep === PRIOR_CONTEXT_TRUNCATION.TAIL
    );
    keptBytes = utf8Bytes(keptText);
  }

  return {
    text: keptText,
    omitted:
      keep === PRIOR_CONTEXT_TRUNCATION.HEAD
        ? PRIOR_CONTEXT_TRUNCATION.OMITTED_END
        : PRIOR_CONTEXT_TRUNCATION.OMITTED_START,
    omittedBytes: totalBytes - keptBytes,
  };
}

function isFailed(data: { status?: string; success?: boolean; error?: string }): boolean {
  return (
    data.status === OPERATION_STATUS.FAILED ||
    data.success === false ||
    !!data.error
  );
}

function resultText(result: ToolResult | undefined): string {
  if (!result) return "";
  return result.output ?? result.error ?? "";
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}) ?? "{}";
  } catch {
    return "[unserializable arguments]";
  }
}

function diffLineCounts(diff: string): { added: number; removed: number } {
  const lines = diff.split("\n");
  return countStructuredPatchChanges([
    {
      oldStart: 0,
      oldLines: 0,
      newStart: 0,
      newLines: 0,
      lines: lines.filter((line) => !line.startsWith("---") && !line.startsWith("+++")),
    },
  ]);
}

function projectEvent(event: CliEvent): PriorContextTranscriptEntry | undefined {
  if (event.priorContextExcluded) return undefined;
  switch (event.type) {
    case CLI_EVENT_TYPES.TEXT:
      return { kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.TEXT, text: (event.data as { text: string }).text };
    case CLI_EVENT_TYPES.THINKING:
      return { kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.THINKING, text: (event.data as { text: string }).text };
    case CLI_EVENT_TYPES.FILE_EDIT: {
      const data = event.data as FileEditData;
      const diff = isFailed(data) ? undefined : formatEditDiff(data);
      const counts = data.structuredPatch?.length
        ? countStructuredPatchChanges(data.structuredPatch)
        : diff
          ? diffLineCounts(diff)
          : { added: 0, removed: 0 };
      return {
        kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.EDIT,
        path: data.path,
        ...counts,
        ...(diff
          ? {
              diff: boundPriorContextText(
                diff,
                PRIOR_CONTEXT_LIMITS.DIFF_BYTES,
                PRIOR_CONTEXT_TRUNCATION.HEAD
              ),
            }
          : {}),
        ...(isFailed(data) ? { failed: true } : {}),
      };
    }
    case CLI_EVENT_TYPES.FILE_WRITE: {
      const data = event.data as FileWriteData;
      const failed = isFailed(data);
      const diff = failed ? "" : formatCreatedFileDiff(data);
      const added = diff ? diffLineCounts(diff).added : 0;
      return {
        kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.CREATE,
        path: data.path,
        added,
        diff: boundPriorContextText(
          diff,
          PRIOR_CONTEXT_LIMITS.DIFF_BYTES,
          PRIOR_CONTEXT_TRUNCATION.HEAD
        ),
        ...(failed ? { failed: true } : {}),
      };
    }
    case CLI_EVENT_TYPES.FILE_DELETE: {
      const data = event.data as FileDeleteData;
      return {
        kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.DELETE,
        path: data.path,
        ...(isFailed(data) ? { failed: true } : {}),
      };
    }
    case CLI_EVENT_TYPES.BASH_COMMAND: {
      const data = event.data as BashCommandData;
      const output = [data.output, data.error].filter(Boolean).join("\n");
      return {
        kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.COMMAND,
        command: data.command,
        ...(data.exitCode === undefined ? {} : { exitCode: data.exitCode }),
        output: boundPriorContextText(
          output,
          PRIOR_CONTEXT_LIMITS.COMMAND_OUTPUT_TAIL_BYTES,
          PRIOR_CONTEXT_TRUNCATION.TAIL
        ),
        ...(isFailed(data) || (data.exitCode !== undefined && data.exitCode !== 0)
          ? { failed: true }
          : {}),
      };
    }
    case CLI_EVENT_TYPES.FILE_READ: {
      const data = event.data as FileReadData;
      return {
        kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.READ,
        path: data.path,
        ...(data.lineStart === undefined ? {} : { lineStart: data.lineStart }),
        ...(data.lineEnd === undefined ? {} : { lineEnd: data.lineEnd }),
        ...(isFailed(data) ? { failed: true } : {}),
      };
    }
    case CLI_EVENT_TYPES.MCP_TOOL_CALL: {
      const data = event.data as McpToolCallData;
      const result = data.result;
      return {
        kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.TOOL,
        name: `${data.server}/${data.tool}`,
        arguments: boundPriorContextText(
          compactJson(data.parameters),
          PRIOR_CONTEXT_LIMITS.TOOL_ARGUMENTS_HEAD_BYTES,
          PRIOR_CONTEXT_TRUNCATION.HEAD
        ),
        result: boundPriorContextText(
          resultText(result),
          PRIOR_CONTEXT_LIMITS.TOOL_RESULT_TAIL_BYTES,
          PRIOR_CONTEXT_TRUNCATION.TAIL
        ),
        ...(result?.success === false ? { failed: true } : {}),
      };
    }
    case CLI_EVENT_TYPES.TOOL_CALL: {
      const data = event.data as ToolCall;
      return {
        kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.TOOL,
        name: data.name,
        arguments: boundPriorContextText(
          compactJson(data.parameters),
          PRIOR_CONTEXT_LIMITS.TOOL_ARGUMENTS_HEAD_BYTES,
          PRIOR_CONTEXT_TRUNCATION.HEAD
        ),
        result: boundPriorContextText(
          resultText(data.result),
          PRIOR_CONTEXT_LIMITS.TOOL_RESULT_TAIL_BYTES,
          PRIOR_CONTEXT_TRUNCATION.TAIL
        ),
        ...(data.result?.success === false ? { failed: true } : {}),
      };
    }
    case CLI_EVENT_TYPES.WEB_SEARCH: {
      const data = event.data as WebSearchData;
      return {
        kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.SEARCH,
        query: data.query,
        results: data.results ?? [],
        ...(data.success === false || !!data.error ? { failed: true } : {}),
      };
    }
    case CLI_EVENT_TYPES.ASK_USER_QUESTION: {
      const data = event.data as AskUserQuestionData;
      return {
        kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.QUESTION,
        questions: data.questions,
        ...(data.declined ? { declined: data.declined } : {}),
        ...(data.status === OPERATION_STATUS.FAILED ? { failed: true } : {}),
      };
    }
    case CLI_EVENT_TYPES.USER_STEER:
      return {
        kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.USER_STEER,
        text: (event.data as UserSteerData).text,
      };
    case CLI_EVENT_TYPES.TERMINAL_OUTPUT: {
      const data = event.data as TerminalOutputData;
      return {
        kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.TERMINAL_OUTPUT,
        text: data.text,
        reason: data.reason,
      };
    }
    case CLI_EVENT_TYPES.TOOL_RESULT:
    case CLI_EVENT_TYPES.COMPACTION:
    case CLI_EVENT_TYPES.FOLLOW_UP_RESUMED:
    case CLI_EVENT_TYPES.BACKGROUND_WORK_HOLD:
    case CLI_EVENT_TYPES.CONTEXT_WINDOW_SYNC:
      return undefined;
    default: {
      event.type satisfies never;
      return undefined;
    }
  }
}

export function projectPriorContextTranscript(
  events: readonly CliEvent[]
): PriorContextTranscriptEntry[] {
  return normalizeCliEvents(events)
    .map(projectEvent)
    .filter((entry): entry is PriorContextTranscriptEntry => entry !== undefined);
}
