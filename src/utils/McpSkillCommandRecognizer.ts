import type {
  BashCommandData,
  CliEvent,
  McpToolCallData,
  ToolResultData,
} from "../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  MCP_CALL_VIA,
  MCP_SERVER_IDS,
  OPERATION_STATUS,
} from "../types/DashboardConstants";

export interface RecognizedMcpSkillCommand {
  tool: string;
  parameters: Record<string, unknown>;
}

/**
 * Rewrites the skill's bash call and any matching trailing tool result into
 * MCP events. Keep one instance for a stream so result-only halves retain the
 * identity established by the initiated bash event.
 */
export class McpSkillEventRewriter {
  private readonly recognizedCalls = new Map<
    string,
    RecognizedMcpSkillCommand
  >();

  rewrite(event: CliEvent): CliEvent {
    if (event.type === CLI_EVENT_TYPES.BASH_COMMAND) {
      const data = event.data as BashCommandData;
      const recognized = recognizeMcpSkillCommand(data.command);
      if (!recognized) {
        return event;
      }

      if (data.toolCallId) {
        this.recognizedCalls.set(data.toolCallId, recognized);
      }
      const completed =
        data.status === OPERATION_STATUS.COMPLETED ||
        data.status === OPERATION_STATUS.FAILED ||
        data.output !== undefined ||
        data.error !== undefined ||
        data.exitCode !== undefined;
      return {
        ...event,
        type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
        data: {
          ...this.buildCallData(recognized, data.toolCallId),
          ...(completed
            ? {
                result: {
                  success:
                    data.status !== OPERATION_STATUS.FAILED &&
                    (data.exitCode === undefined || data.exitCode === 0),
                  output: data.output,
                  error: data.error,
                },
              }
            : {}),
        } as McpToolCallData,
      };
    }

    if (event.type === CLI_EVENT_TYPES.TOOL_RESULT) {
      const data = event.data as ToolResultData;
      const recognized = this.recognizedCalls.get(data.toolCallId);
      if (recognized) {
        return {
          ...event,
          type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
          data: {
            ...this.buildCallData(recognized, data.toolCallId),
            result: data.result,
          } as McpToolCallData,
        };
      }
    }

    // Already rewritten events pass through unchanged, making this safe for
    // legacy normalizer callers that can also receive current stream events.
    return event;
  }

  private buildCallData(
    recognized: RecognizedMcpSkillCommand,
    toolCallId: string | undefined
  ): McpToolCallData {
    return {
      server: MCP_SERVER_IDS.CTRLYOKE,
      tool: recognized.tool,
      parameters: recognized.parameters,
      toolCallId,
      via: MCP_CALL_VIA.SKILL,
    };
  }
}

function tokenizeCommand(command: string): string[] | undefined {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let tokenStarted = false;

  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (quote === "'") {
      if (character === "'") {
        quote = undefined;
      } else {
        token += character;
      }
      continue;
    }

    if (quote === '"') {
      if (character === '"') {
        quote = undefined;
      } else if (
        character === "\\" &&
        (command[index + 1] === '"' || command[index + 1] === "\\")
      ) {
        token += command[++index];
      } else {
        token += character;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
    } else if (character === "\\" && index + 1 < command.length) {
      const next = command[index + 1];
      if (/\s/.test(next) || next === "'" || next === '"') {
        token += next;
        index++;
      } else {
        token += character;
      }
      tokenStarted = true;
    } else if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
    } else {
      token += character;
      tokenStarted = true;
    }
  }

  if (quote) {
    return undefined;
  }
  if (tokenStarted) {
    tokens.push(token);
  }
  return tokens;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).split("\\").pop() ?? path;
}

/** Recognize the command form documented by the ctrlyoke MCP skill. */
export function recognizeMcpSkillCommand(
  command: string
): RecognizedMcpSkillCommand | undefined {
  const tokens = tokenizeCommand(command);
  if (!tokens) {
    return undefined;
  }

  const scriptIndex = tokens.findIndex(
    (token, index) =>
      index > 0 &&
      basename(token).toLowerCase() === "mcp-server.js" &&
      /^(?:node|node\.exe)$/i.test(basename(tokens[index - 1]))
  );
  if (scriptIndex < 0) {
    return undefined;
  }

  let tool: string | undefined;
  let args: string | undefined;
  for (let index = scriptIndex + 1; index < tokens.length; index++) {
    if (tokens[index] === "--tool" && tool === undefined) {
      tool = tokens[index + 1];
      index++;
    } else if (tokens[index] === "--args" && args === undefined) {
      args = tokens[index + 1];
      index++;
    }
  }
  if (!tool || args === undefined) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(args);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return { tool, parameters: parsed as Record<string, unknown> };
  } catch {
    return undefined;
  }
}
