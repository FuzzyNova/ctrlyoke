import React from "react";
import type {
  AskUserQuestionData,
  BashCommandData,
  CliEvent,
  CompactionData,
  FileDeleteData,
  FileEditData,
  FileReadData,
  FileWriteData,
  McpToolCallData,
  TextData,
  ThinkingBlock,
  ToolCall,
  ToolResultData,
  WebSearchData,
} from "@/types/cliEvents";
import { CLI_EVENT_TYPES } from "@/types/cliEvents";
import { sanitizeTerminalOutput } from "@root/utils/TerminalOutputSanitizer";
import { DEFAULT_SCRIPT_VERDICT_EXPECTED_TEXT } from "@root/types/CtrlYokeTypes";
import { normalizeStructuredPatch } from "./diffUtils";
import type { OutputMessageTarget } from "./outputProjection";
import type { OutputRenderRow } from "./outputRows";
import { formatCliCommandDisplay } from "./outputCommandDisplay";
import { buildAskUserQuestionSearchSegments } from "./askUserQuestionLayout";
import { getGenericToolCallParamsText } from "./toolCallLayout";
import { resolveCtrlYokeToolView } from "../components/output/ctrlyoke-tools/registry";
import { OUTPUT_ROW_KINDS } from "@root/types/DashboardConstants";
import { buildSelectionReferenceText } from "@root/completions/ContextReferenceBuilder";
import { getToolResultText } from "./toolResultText";

export { getToolResultText } from "./toolResultText";

type OutputFindField =
  | "header"
  | "prompt"
  | "command"
  | "error"
  | "response"
  | "status"
  | "expected"
  | "actual"
  | "action"
  | "filePath"
  | "toolLabel"
  | "params"
  | "toolContent"
  | "diff";

export interface OutputFindMatch {
  matchId: string;
  rowKey: string;
  rowIndex: number;
  rowKind: OutputRenderRow["rowKind"];
  target?: OutputMessageTarget;
  field: OutputFindField;
  start: number;
  end: number;
  preview: string;
}

export interface RowFindDecoration {
  matches: Array<{
    start: number;
    end: number;
    active: boolean;
  }>;
}

export interface OutputRowSearchSegment {
  field: OutputFindField;
  text: string;
  start: number;
  end: number;
}

export const OUTPUT_FIND_ACTIVE_ATTRIBUTE = "data-find-active";
export const OUTPUT_FIND_ACTIVE_CLASS = "diff-code-mark-find-active";

function getRenderedBashTexts(data: BashCommandData): {
  command: string;
  output: string;
  error: string;
} {
  const command =
    sanitizeTerminalOutput(data.command ?? "")
      .trim()
      .replace(/\s*\n+\s*/g, " ") || "command unavailable";
  const output = sanitizeTerminalOutput(data.output ?? "");
  const error = sanitizeTerminalOutput(data.error ?? "");
  const isDuplicateOutputAndError =
    output.trim().length > 0 && output.trim() === error.trim();

  return {
    command,
    output: isDuplicateOutputAndError ? "" : output,
    error,
  };
}

function getStructuredPatchText(event: CliEvent): string {
  if (
    event.type !== CLI_EVENT_TYPES.FILE_EDIT &&
    event.type !== CLI_EVENT_TYPES.FILE_WRITE &&
    event.type !== CLI_EVENT_TYPES.FILE_DELETE
  ) {
    return "";
  }

  const data = event.data as FileEditData;
  // Normalize (dedup identical hunks) so offsets computed here line up with
  // `locateActiveDiffMatch`, which walks the same normalized sequence to map a
  // match back to the diff line/side it renders on.
  return normalizeStructuredPatch(data.structuredPatch)
    .flatMap((hunk) => hunk.lines)
    .join("\n");
}

/**
 * Canonical header text for a FILE_READ row's "filePath" search segment.
 * A segment read is shown as a `#selection:path:start-end` reference instead
 * of the bare path (see FileOperationOutput's FileReadOutput), so the search
 * corpus must match that same text for find highlighting/expansion to align.
 */
export function getFileReadHeaderText(data: FileReadData): string {
  return data.lineStart !== undefined && data.lineEnd !== undefined
    ? buildSelectionReferenceText(data.path, data.lineStart, data.lineEnd)
    : data.path;
}

function createSegments(
  entries: Array<{ field: OutputFindField; text?: string }>
): OutputRowSearchSegment[] {
  const segments: OutputRowSearchSegment[] = [];
  let cursor = 0;

  for (const entry of entries) {
    const text = entry.text ?? "";
    if (!text) {
      continue;
    }
    const start = cursor;
    const end = start + text.length;
    segments.push({
      field: entry.field,
      text,
      start,
      end,
    });
    cursor = end + 1;
  }

  return segments;
}

export function getOutputRowSearchSegments(
  row: OutputRenderRow
): OutputRowSearchSegment[] {
  switch (row.rowKind) {
    case OUTPUT_ROW_KINDS.STATS:
    case OUTPUT_ROW_KINDS.STEP_ANCHOR:
    case OUTPUT_ROW_KINDS.STEP_HIDDEN:
    case OUTPUT_ROW_KINDS.FINAL_STEP_LABEL:
    case OUTPUT_ROW_KINDS.PARALLEL_GROUP_HEADER:
    case OUTPUT_ROW_KINDS.ATTEMPT_GROUP_SUMMARY:
      return [];
    case OUTPUT_ROW_KINDS.SCRIPT_VERDICT:
      return createSegments([
        {
          field: "expected",
          text: row.verdict.expected ?? DEFAULT_SCRIPT_VERDICT_EXPECTED_TEXT,
        },
        { field: "actual", text: row.verdict.actual },
        {
          field: "action",
          text: row.verdict.actionDetail ?? row.verdict.action,
        },
      ]);
    case OUTPUT_ROW_KINDS.CLI_HEADER:
      return createSegments([
        { field: "header", text: row.stepLabel },
        { field: "header", text: row.stepName },
      ]);
    case OUTPUT_ROW_KINDS.PROMPT:
      return createSegments([{ field: "prompt", text: row.text }]);
    case OUTPUT_ROW_KINDS.CLI_COMMAND:
    case OUTPUT_ROW_KINDS.SCRIPT_COMMAND:
      return createSegments([
        {
          field: "command",
          text: formatCliCommandDisplay(
            row.command,
            row.workingDirectory,
            row.wasInjected
          ),
        },
      ]);
    case OUTPUT_ROW_KINDS.ERROR:
      return createSegments([{ field: "error", text: row.errorMessage }]);
    case OUTPUT_ROW_KINDS.PLAIN_RESPONSE:
    case OUTPUT_ROW_KINDS.SCRIPT_OUTPUT:
      return createSegments([{ field: "response", text: row.text }]);
    case OUTPUT_ROW_KINDS.STATUS:
      return createSegments([{ field: "status", text: row.status.message }]);
    case OUTPUT_ROW_KINDS.STRUCTURED_EVENT: {
      const event = row.event;
      switch (event.type) {
        case CLI_EVENT_TYPES.TEXT:
          return createSegments([
            { field: "response", text: (event.data as TextData).text },
          ]);
        case CLI_EVENT_TYPES.THINKING:
          return createSegments([
            { field: "response", text: (event.data as ThinkingBlock).text },
          ]);
        case CLI_EVENT_TYPES.BASH_COMMAND: {
          const data = event.data as BashCommandData;
          const rendered = getRenderedBashTexts(data);
          return createSegments([
            { field: "command", text: rendered.command },
            { field: "response", text: rendered.output },
            { field: "error", text: rendered.error },
          ]);
        }
        case CLI_EVENT_TYPES.FILE_EDIT:
        case CLI_EVENT_TYPES.FILE_WRITE:
        case CLI_EVENT_TYPES.FILE_DELETE: {
          const data = event.data as
            FileEditData | FileWriteData | FileDeleteData;
          return createSegments([
            { field: "filePath", text: data.path },
            { field: "diff", text: getStructuredPatchText(event) },
          ]);
        }
        case CLI_EVENT_TYPES.FILE_READ: {
          const data = event.data as FileReadData;
          return createSegments([
            { field: "filePath", text: getFileReadHeaderText(data) },
          ]);
        }
        case CLI_EVENT_TYPES.MCP_TOOL_CALL: {
          const data = event.data as McpToolCallData;
          const customView = resolveCtrlYokeToolView(data);
          if (customView) {
            return createSegments([
              { field: "toolLabel", text: customView.summary },
              { field: "toolContent", text: customView.searchText[1] ?? "" },
              ...(row.toolCall?.expansion.rawExpanded
                ? [
                    {
                      field: "params" as const,
                      text: getGenericToolCallParamsText(data.parameters),
                    },
                    {
                      field: "toolContent" as const,
                      text: getToolResultText(data.result),
                    },
                  ]
                : []),
            ]);
          }
          return createSegments([
            { field: "toolLabel", text: `MCP: ${data.server}.${data.tool}` },
            {
              field: "params",
              text: getGenericToolCallParamsText(data.parameters),
            },
            { field: "toolContent", text: getToolResultText(data.result) },
          ]);
        }
        case CLI_EVENT_TYPES.WEB_SEARCH: {
          const data = event.data as WebSearchData;
          return createSegments([
            { field: "response", text: data.query },
            { field: "error", text: data.error },
          ]);
        }
        case CLI_EVENT_TYPES.TOOL_CALL: {
          const data = event.data as ToolCall;
          return createSegments([
            { field: "toolLabel", text: data.name },
            {
              field: "params",
              text: getGenericToolCallParamsText(data.parameters),
            },
            { field: "toolContent", text: getToolResultText(data.result) },
          ]);
        }
        case CLI_EVENT_TYPES.TOOL_RESULT: {
          const data = event.data as ToolResultData;
          return createSegments([
            { field: "toolContent", text: getToolResultText(data.result) },
          ]);
        }
        case CLI_EVENT_TYPES.ASK_USER_QUESTION: {
          const data = event.data as AskUserQuestionData;
          return buildAskUserQuestionSearchSegments(data).map(
            ({ field, text, start, end }) => ({ field, text, start, end })
          );
        }
        case CLI_EVENT_TYPES.COMPACTION: {
          const data = event.data as CompactionData;
          const tokenInfo =
            data.preTokens != null && data.postTokens != null
              ? ` — ${data.preTokens.toLocaleString()} → ${data.postTokens.toLocaleString()} tokens`
              : data.preTokens != null
                ? ` — ${data.preTokens.toLocaleString()} tokens compacted`
                : "";
          return createSegments([
            {
              field: "response",
              text: `Conversation compacted (${data.trigger})${tokenInfo}`,
            },
          ]);
        }
        default:
          return [];
      }
    }
  }
}

function normalizeMatches(
  textLength: number,
  decorations: RowFindDecoration["matches"]
): RowFindDecoration["matches"] {
  const validMatches = decorations
    .filter((match) => match.end > match.start)
    .map((match) => ({
      start: Math.max(0, Math.min(textLength, match.start)),
      end: Math.max(0, Math.min(textLength, match.end)),
      active: match.active,
    }))
    .filter((match) => match.end > match.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  if (validMatches.length === 0) {
    return [];
  }

  const merged: RowFindDecoration["matches"] = [validMatches[0]];
  for (const match of validMatches.slice(1)) {
    const previous = merged[merged.length - 1];
    if (match.start <= previous.end) {
      previous.end = Math.max(previous.end, match.end);
      previous.active = previous.active || match.active;
      continue;
    }
    merged.push(match);
  }

  return merged;
}

export function sliceDecorationMatches(
  decoration: RowFindDecoration | undefined,
  start: number,
  end: number
): RowFindDecoration["matches"] {
  if (!decoration) {
    return [];
  }

  return decoration.matches
    .filter((match) => match.start < end && match.end > start)
    .map((match) => ({
      start: Math.max(0, match.start - start),
      end: Math.min(end, match.end) - start,
      active: match.active,
    }));
}

export function highlightText(
  text: string,
  decorations: RowFindDecoration["matches"]
): React.ReactNode {
  const normalizedMatches = normalizeMatches(text.length, decorations);
  if (normalizedMatches.length === 0) {
    return text;
  }

  const nodes: React.ReactNode[] = [];
  let cursor = 0;

  normalizedMatches.forEach((match, index) => {
    if (match.start > cursor) {
      nodes.push(
        React.createElement(
          React.Fragment,
          { key: `text-${index}-${cursor}` },
          text.slice(cursor, match.start)
        )
      );
    }

    nodes.push(
      React.createElement(
        "mark",
        {
          key: `mark-${index}-${match.start}`,
          [OUTPUT_FIND_ACTIVE_ATTRIBUTE]: match.active ? "true" : undefined,
          className: `rounded px-0.5 ${
            match.active
              ? "bg-find-match text-foreground ring-1 ring-find-match-border"
              : "bg-find-match-highlight text-foreground"
          }`,
        },
        text.slice(match.start, match.end)
      )
    );
    cursor = match.end;
  });

  if (cursor < text.length) {
    nodes.push(
      React.createElement(
        React.Fragment,
        { key: `text-tail-${cursor}` },
        text.slice(cursor)
      )
    );
  }

  return nodes;
}

function findOccurrences(
  text: string,
  query: string,
  caseSensitive: boolean
): number[] {
  if (!query) {
    return [];
  }

  const haystack = caseSensitive ? text : text.toLocaleLowerCase();
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  const indices: number[] = [];
  let searchStart = 0;

  while (searchStart <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, searchStart);
    if (index === -1) {
      break;
    }
    indices.push(index);
    searchStart = index + Math.max(1, needle.length);
  }

  return indices;
}

export function findOutputMatches(
  rows: OutputRenderRow[],
  query: string,
  caseSensitive: boolean
): OutputFindMatch[] {
  if (!query) {
    return [];
  }

  const matches: OutputFindMatch[] = [];

  rows.forEach((row, rowIndex) => {
    const segments = getOutputRowSearchSegments(row);
    for (const segment of segments) {
      const occurrences = findOccurrences(segment.text, query, caseSensitive);
      for (const localStart of occurrences) {
        const globalStart = segment.start + localStart;
        matches.push({
          matchId: `${rowIndex}-${segment.field}-${globalStart}`,
          rowKey: row.key,
          rowIndex,
          rowKind: row.rowKind,
          target: row.target,
          field: segment.field,
          start: globalStart,
          end: globalStart + query.length,
          preview: segment.text.slice(0, 80),
        });
      }
    }
  });

  return matches;
}
