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
  ToolResultData,
  WebSearchData,
} from "../types/CliOutputTypes";
import { CLI_EVENT_TYPES, OPERATION_STATUS } from "../types/DashboardConstants";
import { McpSkillEventRewriter } from "./McpSkillCommandRecognizer";

const PENDING_KINDS = {
  SEMANTIC: "semantic",
  TOOL_CALL: "toolCall",
  MCP: "mcp",
  WEB_SEARCH: "webSearch",
} as const;
type PendingKind = (typeof PENDING_KINDS)[keyof typeof PENDING_KINDS];

interface PendingEvent {
  index: number;
  kind: PendingKind;
  type: string;
  key?: string;
  toolCallId?: string;
}

const SEMANTIC_OPERATION_TYPES = new Set<string>([
  CLI_EVENT_TYPES.BASH_COMMAND,
  CLI_EVENT_TYPES.FILE_READ,
  CLI_EVENT_TYPES.FILE_WRITE,
  CLI_EVENT_TYPES.FILE_EDIT,
  CLI_EVENT_TYPES.FILE_DELETE,
  CLI_EVENT_TYPES.ASK_USER_QUESTION,
]);

function cloneEvent(event: CliEvent): CliEvent {
  return {
    ...event,
    data: {
      ...((event.data as unknown as Record<string, unknown>) ?? {}),
    } as unknown as CliEvent["data"],
  };
}

/**
 * Provider streams and legacy histories can carry rich content blocks even
 * though the shared ToolResult contract is string-only. Collapse them at the
 * event-normalization boundary so every downstream renderer sees that contract.
 */
function normalizeToolResultText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (
          part != null &&
          typeof part === "object" &&
          "text" in part &&
          typeof part.text === "string"
        ) {
          return part.text;
        }
        return JSON.stringify(part);
      })
      .filter((part): part is string => typeof part === "string")
      .join("\n");
  }

  return JSON.stringify(value);
}

function normalizeToolResult(result: ToolResult): ToolResult {
  const output = normalizeToolResultText(result.output);
  const error = normalizeToolResultText(result.error);
  if (output === result.output && error === result.error) {
    return result;
  }
  return { ...result, output, error };
}

function normalizeEventToolResult(event: CliEvent): CliEvent {
  switch (event.type) {
    case CLI_EVENT_TYPES.TOOL_RESULT: {
      const data = event.data as ToolResultData;
      return {
        ...event,
        data: { ...data, result: normalizeToolResult(data.result) },
      };
    }
    case CLI_EVENT_TYPES.TOOL_CALL: {
      const data = event.data as ToolCall;
      return data.result
        ? {
            ...event,
            data: { ...data, result: normalizeToolResult(data.result) },
          }
        : event;
    }
    case CLI_EVENT_TYPES.MCP_TOOL_CALL: {
      const data = event.data as McpToolCallData;
      return data.result
        ? {
            ...event,
            data: { ...data, result: normalizeToolResult(data.result) },
          }
        : event;
    }
    default:
      return event;
  }
}

function normalizePath(pathValue: string | undefined): string | undefined {
  if (!pathValue) {
    return undefined;
  }
  return pathValue.replace(/\\/g, "/").toLowerCase();
}

function getEventKey(event: CliEvent): string | undefined {
  switch (event.type) {
    case CLI_EVENT_TYPES.BASH_COMMAND: {
      const data = event.data as BashCommandData;
      return data.command ? `bash:${data.command}` : undefined;
    }
    case CLI_EVENT_TYPES.FILE_READ:
    case CLI_EVENT_TYPES.FILE_WRITE:
    case CLI_EVENT_TYPES.FILE_EDIT:
    case CLI_EVENT_TYPES.FILE_DELETE: {
      const data = event.data as
        FileReadData | FileWriteData | FileEditData | FileDeleteData;
      if (
        event.type === CLI_EVENT_TYPES.FILE_READ &&
        "toolCallId" in data &&
        data.toolCallId
      ) {
        return `${event.type}:call:${data.toolCallId}`;
      }
      const path = normalizePath(data.path);
      return path ? `${event.type}:${path}` : undefined;
    }
    case CLI_EVENT_TYPES.MCP_TOOL_CALL: {
      const data = event.data as McpToolCallData;
      if (data.toolCallId) {
        return `mcp:call:${data.toolCallId}`;
      }
      return data.server && data.tool
        ? `mcp:${data.server}.${data.tool}`
        : undefined;
    }
    case CLI_EVENT_TYPES.ASK_USER_QUESTION: {
      const data = event.data as AskUserQuestionData;
      return data.toolCallId ? `askUserQuestion:${data.toolCallId}` : undefined;
    }
    case CLI_EVENT_TYPES.WEB_SEARCH: {
      const data = event.data as WebSearchData;
      return data.query ? `web:${data.query}` : undefined;
    }
    case CLI_EVENT_TYPES.TOOL_CALL: {
      const data = event.data as ToolCall;
      if (data.id) {
        return `tool:${data.id}`;
      }
      return data.name
        ? `tool:${data.name}:${JSON.stringify(data.parameters ?? {})}`
        : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Every semantic operation type (BASH_COMMAND, FILE_READ/WRITE/EDIT/DELETE,
 * ASK_USER_QUESTION) now carries an optional `toolCallId` on its data — read
 * it generically instead of listing types one by one, so a new semantic type
 * gets id-based correlation for free instead of silently falling back to the
 * unsafe LIFO guess in `findPendingForResult`/`findOutputIndexForResultFallback`.
 */
function getToolCallId(event: CliEvent): string | undefined {
  if (event.type === CLI_EVENT_TYPES.TOOL_CALL) {
    return (event.data as ToolCall).id;
  }
  const data = event.data as { toolCallId?: unknown };
  return typeof data.toolCallId === "string" ? data.toolCallId : undefined;
}

function isSemanticCompletionEvent(event: CliEvent): boolean {
  if (!SEMANTIC_OPERATION_TYPES.has(event.type)) {
    return false;
  }

  const data = event.data as unknown as Record<string, unknown>;
  if (
    data.status === OPERATION_STATUS.COMPLETED ||
    data.status === OPERATION_STATUS.FAILED
  ) {
    return true;
  }

  if (
    event.type === CLI_EVENT_TYPES.FILE_DELETE &&
    (typeof data.success === "boolean" || typeof data.error === "string")
  ) {
    return true;
  }

  return false;
}

function isSemanticInitiatedEvent(event: CliEvent): boolean {
  if (!SEMANTIC_OPERATION_TYPES.has(event.type)) {
    return false;
  }

  const data = event.data as unknown as Record<string, unknown>;
  if (data.status === OPERATION_STATUS.INITIATED) {
    return true;
  }

  if (
    event.type === CLI_EVENT_TYPES.FILE_DELETE &&
    data.success === undefined &&
    data.error === undefined
  ) {
    return true;
  }

  return false;
}

function createPendingEvent(
  event: CliEvent,
  index: number
): PendingEvent | undefined {
  if (isSemanticInitiatedEvent(event)) {
    return {
      index,
      kind: PENDING_KINDS.SEMANTIC,
      type: event.type,
      key: getEventKey(event),
      toolCallId: getToolCallId(event),
    };
  }

  if (event.type === CLI_EVENT_TYPES.TOOL_CALL) {
    const data = event.data as ToolCall;
    if (!data.result) {
      return {
        index,
        kind: PENDING_KINDS.TOOL_CALL,
        type: event.type,
        key: getEventKey(event),
        toolCallId: data.id,
      };
    }
  }

  if (event.type === CLI_EVENT_TYPES.MCP_TOOL_CALL) {
    const data = event.data as McpToolCallData;
    if (!data.result) {
      return {
        index,
        kind: PENDING_KINDS.MCP,
        type: event.type,
        key: getEventKey(event),
        toolCallId: data.toolCallId,
      };
    }
  }

  if (event.type === CLI_EVENT_TYPES.WEB_SEARCH) {
    const data = event.data as WebSearchData;
    if (data.success === undefined && !data.error) {
      return {
        index,
        kind: PENDING_KINDS.WEB_SEARCH,
        type: event.type,
        key: getEventKey(event),
      };
    }
  }

  return undefined;
}

/** True when the event opens a slot that may be completed by a later event. */
export function isOpenCliOperation(event: CliEvent): boolean {
  return createPendingEvent(event, 0) !== undefined;
}

function removePending(pending: PendingEvent[], match: PendingEvent): void {
  const index = pending.indexOf(match);
  if (index >= 0) {
    pending.splice(index, 1);
  }
}

function findMatchingPendingForCompletion(
  pending: PendingEvent[],
  event: CliEvent
): PendingEvent | undefined {
  const key = getEventKey(event);
  const toolCallId = getToolCallId(event);
  for (let i = pending.length - 1; i >= 0; i--) {
    const candidate = pending[i];
    if (
      candidate.kind !== PENDING_KINDS.SEMANTIC ||
      candidate.type !== event.type
    ) {
      continue;
    }
    // Two ids that disagree are two different calls, even when the command
    // text or path is identical (Copilot runs same-text commands in parallel).
    if (
      toolCallId &&
      candidate.toolCallId &&
      candidate.toolCallId !== toolCallId
    ) {
      continue;
    }
    const sameCall = !!toolCallId && candidate.toolCallId === toolCallId;
    if (candidate.key && key) {
      if (
        candidate.key === key ||
        (sameCall && keysShareTrailingPath(candidate.key, key))
      ) {
        return candidate;
      }
      continue;
    }
    return candidate;
  }
  return undefined;
}

/**
 * Within one call, a harness may report the same file relative at start and
 * absolute at completion (Copilot's multi-file apply_patch: the model's patch
 * text vs. the git diff it reports back). Keys are `<type>:<normalized path>`.
 */
function keysShareTrailingPath(a: string, b: string): boolean {
  const pathA = a.slice(a.indexOf(":") + 1);
  const pathB = b.slice(b.indexOf(":") + 1);
  return pathA.endsWith(`/${pathB}`) || pathB.endsWith(`/${pathA}`);
}

function findOutputIndexForCompletionFallback(
  output: CliEvent[],
  event: CliEvent
): number | undefined {
  const key = getEventKey(event);

  // When the immediately-preceding output event is already a completed version
  // of the same operation (same type + key), merge into it. This handles
  // streaming batches where INITIATED+TOOL_RESULT in one batch produces a
  // COMPLETED event, and a later batch delivers the same COMPLETED event again.
  // The adjacency requirement (no other output events between them) prevents
  // this from collapsing genuinely separate operations on the same file.
  if (key && output.length > 0) {
    const last = output[output.length - 1];
    if (
      last.type === event.type &&
      isSemanticCompletionEvent(last) &&
      getEventKey(last) === key
    ) {
      return output.length - 1;
    }
  }

  for (let i = output.length - 1; i >= 0; i--) {
    const candidate = output[i];
    if (candidate.type !== event.type) {
      continue;
    }
    const candidateKey = getEventKey(candidate);
    if (key && candidateKey) {
      // Only match an INITIATED event. A COMPLETED event at the same path is a
      // different operation — matching it would silently merge a second (third…)
      // edit to the same file into the first one, losing all but the last diff.
      if (key === candidateKey && isSemanticInitiatedEvent(candidate)) {
        return i;
      }
      continue;
    }

    // If the completion event has no key (for example, Codex omitted the bash
    // command text), only fall back to an INITIATED event. Falling back to the
    // last completed bash event can incorrectly glue a new command's output
    // onto the previous command block.
    if (!key && isSemanticInitiatedEvent(candidate)) {
      return i;
    }
  }
  return undefined;
}

function findPendingForResult(
  pending: PendingEvent[],
  output: CliEvent[],
  result: ToolResultData
): PendingEvent | undefined {
  if (result.toolCallId) {
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].toolCallId === result.toolCallId) {
        return pending[i];
      }
    }
    // The call's own row exists but is no longer pending — a harness that
    // pairs start/complete itself (Copilot) already merged its semantic
    // COMPLETED event, then sends a trailing TOOL_RESULT. Leave that to the
    // by-id output lookup instead of letting it hijack an in-flight call.
    if (findOutputIndexByToolCallId(output, result.toolCallId) !== undefined) {
      return undefined;
    }
  }

  // No id match: only guess among pending entries that never carried an id of
  // their own. An id-carrying entry (e.g. a FILE_READ awaiting its own
  // result) has a reliable correlation channel and must never be stolen by a
  // differently-typed result that merely happens to be the most recently
  // initiated — that mismatch previously left an unrelated pending entry
  // permanently stuck at "running" while its result silently corrupted the
  // wrong row.
  for (let i = pending.length - 1; i >= 0; i--) {
    if (!pending[i].toolCallId) {
      return pending[i];
    }
  }

  return undefined;
}

function findOutputIndexByToolCallId(
  output: CliEvent[],
  toolCallId: string
): number | undefined {
  for (let i = output.length - 1; i >= 0; i--) {
    if (getToolCallId(output[i]) === toolCallId) {
      return i;
    }
  }
  return undefined;
}

function findOutputIndexByToolCallIdAndType(
  output: CliEvent[],
  event: CliEvent,
  toolCallId: string
): number | undefined {
  for (let i = output.length - 1; i >= 0; i--) {
    if (
      output[i].type === event.type &&
      getToolCallId(output[i]) === toolCallId
    ) {
      return i;
    }
  }
  return undefined;
}

function findOutputIndexForResultFallback(
  output: CliEvent[],
  result: ToolResultData
): number | undefined {
  if (result.toolCallId) {
    const byId = findOutputIndexByToolCallId(output, result.toolCallId);
    if (byId !== undefined) {
      return byId;
    }
  }

  for (let i = output.length - 1; i >= 0; i--) {
    const event = output[i];
    if (
      event.type === CLI_EVENT_TYPES.TOOL_CALL ||
      event.type === CLI_EVENT_TYPES.MCP_TOOL_CALL ||
      event.type === CLI_EVENT_TYPES.WEB_SEARCH ||
      SEMANTIC_OPERATION_TYPES.has(event.type)
    ) {
      return i;
    }
  }

  return undefined;
}

function mergeInitiatedWithResult(
  event: CliEvent,
  result: ToolResult
): CliEvent | undefined {
  switch (event.type) {
    case CLI_EVENT_TYPES.BASH_COMMAND: {
      const data = event.data as BashCommandData;
      return {
        ...event,
        data: {
          ...data,
          output: data.output ?? result.output,
          error:
            data.error ??
            (result.success ? undefined : (result.error ?? result.output)),
          exitCode:
            data.exitCode ?? (result.success ? 0 : (data.exitCode ?? 1)),
          status: result.success
            ? OPERATION_STATUS.COMPLETED
            : OPERATION_STATUS.FAILED,
        } as BashCommandData,
      };
    }
    case CLI_EVENT_TYPES.FILE_READ: {
      const data = event.data as FileReadData;
      return {
        ...event,
        data: {
          ...data,
          content: data.content ?? result.output,
          success: result.success,
          error: result.success ? undefined : (result.error ?? result.output),
          status: result.success
            ? OPERATION_STATUS.COMPLETED
            : OPERATION_STATUS.FAILED,
        } as FileReadData,
      };
    }
    case CLI_EVENT_TYPES.FILE_WRITE: {
      const data = event.data as FileWriteData;
      return {
        ...event,
        data: {
          ...data,
          success: result.success,
          error: result.success ? undefined : (result.error ?? result.output),
          status: result.success
            ? OPERATION_STATUS.COMPLETED
            : OPERATION_STATUS.FAILED,
        } as FileWriteData,
      };
    }
    case CLI_EVENT_TYPES.FILE_EDIT: {
      const data = event.data as FileEditData;
      return {
        ...event,
        data: {
          ...data,
          success: result.success,
          error: result.success ? undefined : (result.error ?? result.output),
          status: result.success
            ? OPERATION_STATUS.COMPLETED
            : OPERATION_STATUS.FAILED,
        } as FileEditData,
      };
    }
    case CLI_EVENT_TYPES.FILE_DELETE: {
      const data = event.data as FileDeleteData;
      return {
        ...event,
        data: {
          ...data,
          success: result.success,
          error: result.success ? undefined : (result.error ?? result.output),
        } as FileDeleteData,
      };
    }
    case CLI_EVENT_TYPES.MCP_TOOL_CALL: {
      const data = event.data as McpToolCallData;
      return {
        ...event,
        data: {
          ...data,
          result,
        } as McpToolCallData,
      };
    }
    case CLI_EVENT_TYPES.WEB_SEARCH: {
      const data = event.data as WebSearchData;
      return {
        ...event,
        data: {
          ...data,
          success: result.success,
          error: result.success ? undefined : (result.error ?? result.output),
        } as WebSearchData,
      };
    }
    case CLI_EVENT_TYPES.TOOL_CALL: {
      const data = event.data as ToolCall;
      return {
        ...event,
        data: {
          ...data,
          result,
        } as ToolCall,
      };
    }
    default:
      return undefined;
  }
}

function mergeInitiatedWithCompleted(
  initiated: CliEvent,
  completed: CliEvent
): CliEvent {
  switch (completed.type) {
    case CLI_EVENT_TYPES.TOOL_CALL: {
      const initiatedData = initiated.data as ToolCall;
      const completedData = completed.data as ToolCall;
      return {
        ...completed,
        timestamp: initiated.timestamp ?? completed.timestamp,
        data: {
          ...completedData,
          parameters: initiatedData.parameters ?? completedData.parameters,
          id: initiatedData.id ?? completedData.id,
          result: completedData.result ?? initiatedData.result,
        } as ToolCall,
      };
    }
    case CLI_EVENT_TYPES.MCP_TOOL_CALL: {
      const initiatedData = initiated.data as McpToolCallData;
      const completedData = completed.data as McpToolCallData;
      return {
        ...completed,
        timestamp: initiated.timestamp ?? completed.timestamp,
        data: {
          ...completedData,
          parameters: initiatedData.parameters ?? completedData.parameters,
          toolCallId: initiatedData.toolCallId ?? completedData.toolCallId,
          result: completedData.result ?? initiatedData.result,
        } as McpToolCallData,
      };
    }
    case CLI_EVENT_TYPES.BASH_COMMAND: {
      const initiatedData = initiated.data as BashCommandData;
      const completedData = completed.data as BashCommandData;
      return {
        ...completed,
        timestamp: initiated.timestamp ?? completed.timestamp,
        data: {
          ...completedData,
          command: completedData.command || initiatedData.command,
          workingDir: completedData.workingDir ?? initiatedData.workingDir,
          exitCode: completedData.exitCode ?? initiatedData.exitCode,
          output: completedData.output ?? initiatedData.output,
          error: completedData.error ?? initiatedData.error,
          toolCallId: completedData.toolCallId ?? initiatedData.toolCallId,
        } as BashCommandData,
      };
    }
    case CLI_EVENT_TYPES.FILE_READ: {
      const initiatedData = initiated.data as FileReadData;
      const completedData = completed.data as FileReadData;
      return {
        ...completed,
        timestamp: initiated.timestamp ?? completed.timestamp,
        data: {
          ...completedData,
          path: completedData.path || initiatedData.path,
          content: completedData.content ?? initiatedData.content,
          toolCallId: completedData.toolCallId ?? initiatedData.toolCallId,
          lineStart: completedData.lineStart ?? initiatedData.lineStart,
          lineEnd: completedData.lineEnd ?? initiatedData.lineEnd,
          error: completedData.error ?? initiatedData.error,
          success: completedData.success ?? initiatedData.success,
        } as FileReadData,
      };
    }
    case CLI_EVENT_TYPES.FILE_WRITE: {
      const initiatedData = initiated.data as FileWriteData;
      const completedData = completed.data as FileWriteData;
      return {
        ...completed,
        timestamp: initiated.timestamp ?? completed.timestamp,
        data: {
          ...completedData,
          path: completedData.path || initiatedData.path,
          content: completedData.content ?? initiatedData.content,
          error: completedData.error ?? initiatedData.error,
          toolCallId: completedData.toolCallId ?? initiatedData.toolCallId,
          success: completedData.success ?? initiatedData.success,
        } as FileWriteData,
      };
    }
    case CLI_EVENT_TYPES.FILE_EDIT: {
      const initiatedData = initiated.data as FileEditData;
      const completedData = completed.data as FileEditData;
      return {
        ...completed,
        timestamp: initiated.timestamp ?? completed.timestamp,
        data: {
          ...completedData,
          path: completedData.path || initiatedData.path,
          oldContent: completedData.oldContent ?? initiatedData.oldContent,
          newContent: completedData.newContent ?? initiatedData.newContent,
          structuredPatch:
            completedData.structuredPatch ?? initiatedData.structuredPatch,
          error: completedData.error ?? initiatedData.error,
          toolCallId: completedData.toolCallId ?? initiatedData.toolCallId,
          success: completedData.success ?? initiatedData.success,
          userModified:
            completedData.userModified ?? initiatedData.userModified,
          replaceAll: completedData.replaceAll ?? initiatedData.replaceAll,
        } as FileEditData,
      };
    }
    case CLI_EVENT_TYPES.FILE_DELETE: {
      const initiatedData = initiated.data as FileDeleteData;
      const completedData = completed.data as FileDeleteData;
      return {
        ...completed,
        timestamp: initiated.timestamp ?? completed.timestamp,
        data: {
          ...completedData,
          path: completedData.path || initiatedData.path,
          error: completedData.error ?? initiatedData.error,
          toolCallId: completedData.toolCallId ?? initiatedData.toolCallId,
          success: completedData.success ?? initiatedData.success,
        } as FileDeleteData,
      };
    }
    case CLI_EVENT_TYPES.ASK_USER_QUESTION: {
      const initiatedData = initiated.data as AskUserQuestionData;
      const completedData = completed.data as AskUserQuestionData;
      // A decline carries no structured question data of its own (the CLI
      // only reports a rejection string) — fall back to the full question set
      // the INITIATED event parsed from the original tool_use.
      return {
        ...completed,
        timestamp: initiated.timestamp ?? completed.timestamp,
        data: {
          ...completedData,
          questions: completedData.questions.length
            ? completedData.questions
            : initiatedData.questions,
        } as AskUserQuestionData,
      };
    }
    default:
      return completed;
  }
}

export interface NormalizedCliEvent {
  event: CliEvent;
  /**
   * Index, in the input array, of the event that *opened* this slot — the
   * INITIATED half of a merged pair, not the completion that filled it in.
   *
   * Callers that place normalized events back onto a timeline must anchor to
   * this. Anchoring to the completion instead would jump every tool block
   * forward to the moment it finished, reordering it against everything the
   * harness did while it ran.
   */
  sourceIndex: number;
}

function eventsEqual(left: CliEvent, right: CliEvent): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * `normalizeCliEvents` plus the provenance needed to re-anchor each merged
 * event to where its operation started. Kept as the single implementation so
 * the pairing rules can never drift between the two entry points.
 */
export class CliEventNormalizer {
  private readonly output: CliEvent[] = [];
  private readonly sourceIndexes: number[] = [];
  private readonly pending: PendingEvent[] = [];
  private readonly skillEventRewriter = new McpSkillEventRewriter();
  private inputCount = 0;

  append(events: readonly CliEvent[]): number[] {
    const changedSlots = new Set<number>();
    for (const originalEvent of events) {
      const inputIndex = this.inputCount++;
      const event = normalizeEventToolResult(
        // Keep support for histories recorded before skill events were rewritten
        // at the shared parsed-event boundary; the rewriter is idempotent.
        this.skillEventRewriter.rewrite(cloneEvent(originalEvent))
      );

      if (
        (event.type === CLI_EVENT_TYPES.TOOL_CALL ||
          event.type === CLI_EVENT_TYPES.MCP_TOOL_CALL) &&
        (event.data as ToolCall | McpToolCallData).result
      ) {
        const toolCallId = getToolCallId(event);
        if (toolCallId) {
          const pendingMatch = [...this.pending]
            .reverse()
            .find(
              (candidate) =>
                candidate.type === event.type &&
                candidate.toolCallId === toolCallId
            );
          const outputIndex =
            pendingMatch?.index ??
            findOutputIndexByToolCallIdAndType(this.output, event, toolCallId);
          if (outputIndex !== undefined) {
            this.replaceSlot(
              outputIndex,
              mergeInitiatedWithCompleted(this.output[outputIndex], event),
              changedSlots
            );
            if (pendingMatch) {
              removePending(this.pending, pendingMatch);
            }
            continue;
          }
        }
      }

      if (event.type === CLI_EVENT_TYPES.TOOL_RESULT) {
        const resultData = event.data as ToolResultData;
        const pendingMatch = findPendingForResult(
          this.pending,
          this.output,
          resultData
        );
        if (pendingMatch) {
          const merged = mergeInitiatedWithResult(
            this.output[pendingMatch.index],
            resultData.result
          );
          if (merged) {
            this.replaceSlot(pendingMatch.index, merged, changedSlots);
            if (pendingMatch.kind !== PENDING_KINDS.SEMANTIC) {
              removePending(this.pending, pendingMatch);
            }
            continue;
          }
        }

        const fallbackIndex = findOutputIndexForResultFallback(
          this.output,
          resultData
        );
        if (fallbackIndex !== undefined) {
          const merged = mergeInitiatedWithResult(
            this.output[fallbackIndex],
            resultData.result
          );
          if (merged) {
            this.replaceSlot(fallbackIndex, merged, changedSlots);
            continue;
          }
        }

        this.pushSlot(event, inputIndex, changedSlots);
        continue;
      }

      if (isSemanticCompletionEvent(event)) {
        const pendingMatch = findMatchingPendingForCompletion(
          this.pending,
          event
        );
        if (pendingMatch) {
          this.replaceSlot(
            pendingMatch.index,
            mergeInitiatedWithCompleted(this.output[pendingMatch.index], event),
            changedSlots
          );
          removePending(this.pending, pendingMatch);
          continue;
        }

        const fallbackIndex = findOutputIndexForCompletionFallback(
          this.output,
          event
        );
        if (fallbackIndex !== undefined) {
          this.replaceSlot(
            fallbackIndex,
            mergeInitiatedWithCompleted(this.output[fallbackIndex], event),
            changedSlots
          );
          continue;
        }
      }

      this.pushSlot(event, inputIndex, changedSlots);
      const pendingEvent = createPendingEvent(event, this.output.length - 1);
      if (pendingEvent) {
        this.pending.push(pendingEvent);
      }
    }

    return [...changedSlots].sort((left, right) => left - right);
  }

  snapshot(): NormalizedCliEvent[] {
    return this.output.map((event, index) => ({
      event,
      sourceIndex: this.sourceIndexes[index],
    }));
  }

  private pushSlot(
    event: CliEvent,
    sourceIndex: number,
    changedSlots: Set<number>
  ): void {
    const slotIndex = this.output.length;
    this.output.push(event);
    this.sourceIndexes.push(sourceIndex);
    changedSlots.add(slotIndex);
  }

  private replaceSlot(
    index: number,
    event: CliEvent,
    changedSlots: Set<number>
  ): void {
    const previous = this.output[index];
    if (!eventsEqual(previous, event)) {
      this.output[index] = event;
      changedSlots.add(index);
    }
  }
}

export function normalizeCliEventsWithSource(
  events: readonly CliEvent[]
): NormalizedCliEvent[] {
  const normalizer = new CliEventNormalizer();
  normalizer.append(events);
  return normalizer.snapshot();
}

export function normalizeCliEvents(events: readonly CliEvent[]): CliEvent[] {
  return normalizeCliEventsWithSource(events).map((entry) => entry.event);
}
