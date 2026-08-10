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
  type UnifiedDiffHunk,
  type TokenUsage,
} from "../../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  TOKEN_TOTAL_CONFIDENCE,
} from "../../../types/DashboardConstants";

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
        },
      };

    default:
      return {
        type: CLI_EVENT_TYPES.TOOL_CALL,
        timestamp,
        data: {
          name: toolName,
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
