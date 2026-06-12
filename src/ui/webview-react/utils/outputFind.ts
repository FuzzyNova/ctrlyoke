import React from "react";
import type {
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
  ToolResult,
  ToolResultData,
  WebSearchData,
} from "@/types/cliEvents";
import { CLI_EVENT_TYPES } from "@/types/cliEvents";
import { sanitizeTerminalOutput } from "@root/utils/TerminalOutputSanitizer";
import type { OutputMessageTarget } from "./outputProjection";
import type { OutputRenderRow } from "./outputRows";
import { formatCliCommandDisplay } from "./outputCommandDisplay";

export type OutputFindField =
  | "header"
  | "prompt"
  | "command"
  | "error"
  | "response"
  | "status"
  | "filePath"
  | "toolLabel"
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

export function getToolResultText(result: ToolResult | undefined): string {
  if (!result) {
    return "";
  }
  if (!result.success && typeof result.error === "string") {
    return result.error;
  }
  if (typeof result.output === "string") {
    return result.output;
  }
  return result.success ? "Success" : "Failed";
}

function getRenderedBashTexts(data: BashCommandData): {
  command: string;
  output: string;
  error: string;
} {
  const command = sanitizeTerminalOutput(data.command ?? "").trim() || "command unavailable";
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
  return data.structuredPatch?.flatMap((hunk) => hunk.lines).join("\n") ?? "";
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
    case "stats":
    case "history-banner":
    case "step-anchor":
    case "final-step-label":
      return [];
    case "cli-header":
      return createSegments([
        { field: "header", text: row.stepLabel },
        { field: "header", text: row.stepName },
      ]);
    case "prompt":
      return createSegments([{ field: "prompt", text: row.text }]);
    case "cli-command":
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
    case "error":
      return createSegments([{ field: "error", text: row.errorMessage }]);
    case "plain-response":
      return createSegments([{ field: "response", text: row.text }]);
    case "status":
      return createSegments([{ field: "status", text: row.status.message }]);
    case "structured-event": {
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
        case CLI_EVENT_TYPES.FILE_READ:
        case CLI_EVENT_TYPES.FILE_DELETE: {
          const data = event.data as
            | FileEditData
            | FileWriteData
            | FileReadData
            | FileDeleteData;
          return createSegments([
            { field: "filePath", text: data.path },
            { field: "diff", text: getStructuredPatchText(event) },
          ]);
        }
        case CLI_EVENT_TYPES.MCP_TOOL_CALL: {
          const data = event.data as McpToolCallData;
          return createSegments([
            { field: "toolLabel", text: `MCP: ${data.server}.${data.tool}` },
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
            { field: "toolContent", text: getToolResultText(data.result) },
          ]);
        }
        case CLI_EVENT_TYPES.TOOL_RESULT: {
          const data = event.data as ToolResultData;
          return createSegments([
            { field: "toolContent", text: getToolResultText(data.result) },
          ]);
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
          "data-find-active": match.active ? "true" : undefined,
          className: `rounded px-0.5 ${
            match.active
              ? "bg-badge-bg text-foreground ring-1 ring-focus-border"
              : "bg-badge-bg/70 text-foreground"
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
