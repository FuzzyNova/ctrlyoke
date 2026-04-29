import type {
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

type PendingKind = "semantic" | "toolCall" | "mcp" | "webSearch";

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
]);

function cloneEvent(event: CliEvent): CliEvent {
  return {
    ...event,
    data: {
      ...((event.data as unknown as Record<string, unknown>) ?? {}),
    } as unknown as CliEvent["data"],
  };
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
        | FileReadData
        | FileWriteData
        | FileEditData
        | FileDeleteData;
      const path = normalizePath(data.path);
      return path ? `${event.type}:${path}` : undefined;
    }
    case CLI_EVENT_TYPES.MCP_TOOL_CALL: {
      const data = event.data as McpToolCallData;
      return data.server && data.tool
        ? `mcp:${data.server}.${data.tool}`
        : undefined;
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

function getToolCallId(event: CliEvent): string | undefined {
  if (event.type === CLI_EVENT_TYPES.TOOL_CALL) {
    return (event.data as ToolCall).id;
  }
  return undefined;
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
      kind: "semantic",
      type: event.type,
      key: getEventKey(event),
    };
  }

  if (event.type === CLI_EVENT_TYPES.TOOL_CALL) {
    const data = event.data as ToolCall;
    if (!data.result) {
      return {
        index,
        kind: "toolCall",
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
        kind: "mcp",
        type: event.type,
        key: getEventKey(event),
      };
    }
  }

  if (event.type === CLI_EVENT_TYPES.WEB_SEARCH) {
    const data = event.data as WebSearchData;
    if (data.success === undefined && !data.error) {
      return {
        index,
        kind: "webSearch",
        type: event.type,
        key: getEventKey(event),
      };
    }
  }

  return undefined;
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
  for (let i = pending.length - 1; i >= 0; i--) {
    const candidate = pending[i];
    if (candidate.kind !== "semantic" || candidate.type !== event.type) {
      continue;
    }
    if (candidate.key && key) {
      if (candidate.key === key) {
        return candidate;
      }
      continue;
    }
    return candidate;
  }
  return undefined;
}

function findOutputIndexForCompletionFallback(
  output: CliEvent[],
  event: CliEvent
): number | undefined {
  const key = getEventKey(event);
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
  result: ToolResultData
): PendingEvent | undefined {
  if (result.toolCallId) {
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].toolCallId === result.toolCallId) {
        return pending[i];
      }
    }
  }

  return pending[pending.length - 1];
}

function findOutputIndexForResultFallback(
  output: CliEvent[],
  result: ToolResultData
): number | undefined {
  if (result.toolCallId) {
    for (let i = output.length - 1; i >= 0; i--) {
      const event = output[i];
      if (getToolCallId(event) === result.toolCallId) {
        return i;
      }
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
          success: completedData.success ?? initiatedData.success,
        } as FileDeleteData,
      };
    }
    default:
      return completed;
  }
}

export function normalizeCliEvents(events: readonly CliEvent[]): CliEvent[] {
  const output: CliEvent[] = [];
  const pending: PendingEvent[] = [];

  for (const originalEvent of events) {
    const event = cloneEvent(originalEvent);

    if (event.type === CLI_EVENT_TYPES.TOOL_RESULT) {
      const resultData = event.data as ToolResultData;
      const pendingMatch = findPendingForResult(pending, resultData);
      if (pendingMatch) {
        const merged = mergeInitiatedWithResult(
          output[pendingMatch.index],
          resultData.result
        );
        if (merged) {
          output[pendingMatch.index] = merged;
          if (pendingMatch.kind !== "semantic") {
            removePending(pending, pendingMatch);
          }
          continue;
        }
      }

      const fallbackIndex = findOutputIndexForResultFallback(
        output,
        resultData
      );
      if (fallbackIndex !== undefined) {
        const merged = mergeInitiatedWithResult(
          output[fallbackIndex],
          resultData.result
        );
        if (merged) {
          output[fallbackIndex] = merged;
          continue;
        }
      }

      output.push(event);
      continue;
    }

    if (isSemanticCompletionEvent(event)) {
      const pendingMatch = findMatchingPendingForCompletion(pending, event);
      if (pendingMatch) {
        output[pendingMatch.index] = mergeInitiatedWithCompleted(
          output[pendingMatch.index],
          event
        );
        removePending(pending, pendingMatch);
        continue;
      }

      const fallbackIndex = findOutputIndexForCompletionFallback(output, event);
      if (fallbackIndex !== undefined) {
        output[fallbackIndex] = mergeInitiatedWithCompleted(
          output[fallbackIndex],
          event
        );
        continue;
      }
    }

    output.push(event);
    const pendingEvent = createPendingEvent(event, output.length - 1);
    if (pendingEvent) {
      pending.push(pendingEvent);
    }
  }

  return output;
}
