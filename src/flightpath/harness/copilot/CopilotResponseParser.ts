import {
  IResponseParser,
  ResponseParserBase,
} from "../shared/interfaces/IResponseParser";
import {
  UniversalCliOutput,
  CliEvent,
  TokenUsage,
  FileEditData,
} from "../../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  OPERATION_STATUS,
} from "../../../types/DashboardConstants";
import { COPILOT_CLI_CONTEXT_WINDOW_SIZE } from "../../../utils/ModelConstants";
import { CliResponseParser } from "../shared/CliResponseParser";
import { CliEventMapper } from "../shared/CliEventMapper";

/**
 * Copilot CLI Response Parser
 *
 * Supports two output formats:
 *
 * **JSON mode** (`--output-format json`, headless): JSONL stream where each line is a
 * structured event object. Key event types:
 * - `assistant.message` — complete turn text + tool requests + outputTokens
 * - `assistant.reasoning` — reasoning/thinking block (ephemeral)
 * - `tool.execution_start` — tool call initiated
 * - `tool.execution_complete` — tool execution result
 * - `result` — session summary with sessionId and exitCode
 *
 * **Plain text mode** (interactive fallback): Response on stdout, statistics on stderr.
 * - Token counts: "59.0k in, 207 out, 0 cached" or "25.7k input, 223 output, 6.1k cache read"
 */
export class CopilotResponseParser
  extends ResponseParserBase
  implements IResponseParser
{
  /**
   * Parse Copilot CLI output — dispatches to JSON or plain-text parser based on content.
   *
   * @param stdout CLI stdout (JSONL events or plain text response)
   * @param stderr CLI stderr (statistics + errors)
   * @param exitCode Process exit code
   * @returns Structured output with events array and metadata
   */
  parse(stdout: string, stderr: string, exitCode: number): UniversalCliOutput {
    // Detect JSON output: first non-whitespace character is '{'
    const firstNonWs = stdout.trimStart()[0];
    if (firstNonWs === "{") {
      return this.parseJsonLines(stdout, stderr, exitCode);
    }
    return this.parsePlainText(stdout, stderr, exitCode);
  }

  /**
   * Parse JSONL event stream from `--output-format json` (headless mode).
   *
   * Processes non-ephemeral events only:
   * - `assistant.message` → TEXT event + tool request events
   * - `assistant.reasoning` → THINKING event
   * - `result` → session ID, exit code
   *
   * Token counts: output tokens summed from assistant.message events; input tokens
   * from stderr stats (same format as plain text mode, still emitted alongside JSON).
   */
  private parseJsonLines(
    stdout: string,
    stderr: string,
    exitCode: number
  ): UniversalCliOutput {
    const events: CliEvent[] = [];
    const { objects } = CliResponseParser.extractJsonObjectsFromStream(stdout);

    let sessionId: string | undefined;
    let model: string | undefined;
    let totalOutputTokens = 0;

    // Track pending tool calls by toolCallId for completion correlation.
    // Populated from assistant.message.data.toolRequests; consumed on tool.execution_complete.
    const pendingToolCalls = new Map<
      string,
      { name: string; path?: string; oldStr?: string; newStr?: string }
    >();

    for (const json of objects) {
      // Only process non-ephemeral events in batch parse.
      // Ephemeral events (message_delta, reasoning_delta, assistant.reasoning) are
      // streaming helpers — their content is also present in the non-ephemeral
      // assistant.message event (data.content and data.reasoningText).
      if (json.ephemeral === true) {
        continue;
      }

      switch (json.type) {
        case "assistant.message": {
          const data = json.data;
          if (!data) break;

          // Extract reasoning text — present alongside content when the model used
          // extended reasoning. Comes from assistant.message.data.reasoningText
          // (same text as the ephemeral assistant.reasoning event, but available here
          // without needing to process ephemeral events).
          if (data.reasoningText) {
            events.push({
              type: CLI_EVENT_TYPES.THINKING,
              timestamp: Date.now(),
              data: { text: data.reasoningText, label: "Reasoning" },
            });
          }

          // Extract response text
          if (data.content) {
            events.push({
              type: CLI_EVENT_TYPES.TEXT,
              timestamp: Date.now(),
              data: { text: data.content },
            });
          }

          // Map tool requests to semantic events and store for completion correlation
          if (Array.isArray(data.toolRequests)) {
            for (const toolReq of data.toolRequests) {
              this.mapToolRequestToEvent(toolReq, events);
              if (toolReq.toolCallId) {
                pendingToolCalls.set(toolReq.toolCallId, {
                  name: toolReq.name,
                  path:
                    toolReq.arguments?.path || toolReq.arguments?.file_path,
                  oldStr:
                    toolReq.arguments?.old_str ||
                    toolReq.arguments?.old_string,
                  newStr:
                    toolReq.arguments?.new_str ||
                    toolReq.arguments?.new_string,
                });
              }
            }
          }

          // Accumulate output tokens across all turns
          if (typeof data.outputTokens === "number") {
            totalOutputTokens += data.outputTokens;
          }
          break;
        }

        case "tool.execution_complete": {
          // Track the model used (available on each tool completion)
          if (!model && json.data?.model) {
            model = json.data.model;
          }

          // Emit COMPLETED event for file edits so the UI shows the diff and undo button.
          // The detailedContent field contains a git unified diff when the tool was "edit".
          const toolCallId: string | undefined = json.data?.toolCallId;
          if (toolCallId) {
            const pending = pendingToolCalls.get(toolCallId);
            if (
              pending &&
              CliEventMapper.classifyTool(pending.name).type ===
                CLI_EVENT_TYPES.FILE_EDIT
            ) {
              const result = json.data?.result;
              const structuredPatch = result?.detailedContent
                ? CliResponseParser.parseUnifiedDiff(result.detailedContent)
                : undefined;
              const success = json.data?.success === true;
              events.push({
                type: CLI_EVENT_TYPES.FILE_EDIT,
                timestamp: Date.now(),
                data: {
                  path: pending.path || "unknown",
                  oldContent: pending.oldStr,
                  newContent: pending.newStr,
                  structuredPatch,
                  status: success
                    ? OPERATION_STATUS.COMPLETED
                    : OPERATION_STATUS.FAILED,
                  success,
                  error: json.data?.error?.message,
                } as FileEditData,
              });
              pendingToolCalls.delete(toolCallId);
            }
          }
          break;
        }

        case "result": {
          // Primary session ID source in JSON mode
          if (json.sessionId) {
            sessionId = json.sessionId;
          }
          break;
        }
      }
    }

    // Error: non-zero exit code
    if (exitCode !== 0 && stderr.trim()) {
      events.push({
        type: CLI_EVENT_TYPES.TEXT,
        timestamp: Date.now(),
        data: { text: `Error: ${stderr.trim()}` },
      });
    }

    // Token usage: output tokens come from assistant.message.data.outputTokens (per-turn sum).
    // Input tokens are NOT present in the JSON output format — the result event only carries
    // timing/change metrics. contextWindowUsedTokens requires input tokens so is unavailable.
    let usage: TokenUsage | undefined;
    if (totalOutputTokens > 0) {
      usage = {
        inputTokens: 0,
        outputTokens: totalOutputTokens,
        totalTokens: totalOutputTokens,
        contextWindowSize: COPILOT_CLI_CONTEXT_WINDOW_SIZE,
      };
    }

    return {
      events,
      metadata: {
        sessionId,
        model,
        usage,
        harness: "copilot-cli",
        rawTextOutput: false,
      },
    };
  }

  /**
   * Parse plain text output (interactive mode fallback or pre-JSON Copilot versions).
   *
   * Response text is on stdout, token statistics on stderr.
   * Sets rawTextOutput:true so the UI skips the markdown pipeline (Copilot pre-formats output).
   */
  private parsePlainText(
    stdout: string,
    stderr: string,
    exitCode: number
  ): UniversalCliOutput {
    const events: CliEvent[] = [];

    if (stdout.trim()) {
      events.push({
        type: CLI_EVENT_TYPES.TEXT,
        timestamp: Date.now(),
        data: { text: stdout.trim() },
      });
    }

    if (exitCode !== 0 && stderr.trim()) {
      events.push({
        type: CLI_EVENT_TYPES.TEXT,
        timestamp: Date.now(),
        data: { text: `Error: ${stderr.trim()}` },
      });
    }

    const tokenCounts = this.parseTokenCounts(stderr);

    return {
      events,
      metadata: {
        // Session ID is extracted from log files in plain text mode
        sessionId: undefined,
        usage: tokenCounts
          ? {
              inputTokens: tokenCounts.prompt,
              outputTokens: tokenCounts.completion,
              totalTokens: tokenCounts.prompt + tokenCounts.completion,
              cachedInputTokens: tokenCounts.cached,
              contextWindowUsedTokens: tokenCounts.prompt,
              contextWindowSize: COPILOT_CLI_CONTEXT_WINDOW_SIZE,
            }
          : undefined,
        harness: "copilot-cli",
        // Plain text output is pre-formatted by Copilot; skip markdown pipeline.
        rawTextOutput: true,
      },
    };
  }

  /**
   * Map a Copilot tool request to a semantic CliEvent.
   *
   * Uses CliEventMapper.classifyTool() for consistent tool → event mapping across harnesses.
   * Copilot tool names in JSON mode: "powershell", "read_file", "write_file", "report_intent", etc.
   *
   * @param toolReq Tool request from assistant.message.data.toolRequests
   * @param events Array to append the resulting event to
   */
  private mapToolRequestToEvent(
    toolReq: { toolCallId?: string; name: string; arguments?: any; type?: string },
    events: CliEvent[]
  ): void {
    const toolName = toolReq.name;
    const input = toolReq.arguments || {};
    const classification = CliEventMapper.classifyTool(toolName);
    const timestamp = Date.now();

    switch (classification.type) {
      case CLI_EVENT_TYPES.BASH_COMMAND:
        events.push({
          type: CLI_EVENT_TYPES.BASH_COMMAND,
          timestamp,
          data: {
            command: input.command || input.cmd || "unknown",
            workingDir: input.cwd || input.workingDir,
            status: OPERATION_STATUS.INITIATED,
          },
        });
        return;

      case CLI_EVENT_TYPES.FILE_WRITE:
        events.push({
          type: CLI_EVENT_TYPES.FILE_WRITE,
          timestamp,
          data: {
            path: input.path || input.file_path || "unknown",
            content: input.content || input.file_text || "",
            status: OPERATION_STATUS.INITIATED,
          },
        });
        return;

      case CLI_EVENT_TYPES.FILE_EDIT:
        events.push({
          type: CLI_EVENT_TYPES.FILE_EDIT,
          timestamp,
          data: {
            path: input.path || input.file_path || "unknown",
            oldContent: input.old_str || input.old_string || input.oldString,
            newContent: input.new_str || input.new_string || input.newString,
            status: OPERATION_STATUS.INITIATED,
          },
        });
        return;

      case CLI_EVENT_TYPES.FILE_READ:
        events.push({
          type: CLI_EVENT_TYPES.FILE_READ,
          timestamp,
          data: {
            path: input.path || input.file_path || "unknown",
            status: OPERATION_STATUS.INITIATED,
          },
        });
        return;

      case CLI_EVENT_TYPES.FILE_DELETE:
        events.push({
          type: CLI_EVENT_TYPES.FILE_DELETE,
          timestamp,
          data: {
            path: input.path || input.file_path || "unknown",
          },
        });
        return;

      case CLI_EVENT_TYPES.WEB_SEARCH:
        events.push({
          type: CLI_EVENT_TYPES.WEB_SEARCH,
          timestamp,
          data: {
            query: input.query || "",
          },
        });
        return;

      case CLI_EVENT_TYPES.MCP_TOOL_CALL:
        events.push({
          type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
          timestamp,
          data: {
            server: (classification as { server: string }).server,
            tool: (classification as { tool: string }).tool,
            parameters: input,
          },
        });
        return;

      default:
        events.push({
          type: CLI_EVENT_TYPES.TOOL_CALL,
          timestamp,
          data: {
            name: toolName,
            parameters: input,
            id: toolReq.toolCallId,
          },
        });
    }
  }

  /**
   * Process a streaming stdout chunk for real-time display (JSON mode).
   *
   * Handles JSONL streaming events from `--output-format json`:
   * - `assistant.message_delta` → TEXT event (real-time character streaming)
   * - `assistant.reasoning_delta` → THINKING event (real-time reasoning)
   * - `tool.execution_start` → Semantic tool-call event
   *
   * `assistant.message` events are skipped during streaming to avoid duplicating
   * text already emitted via `message_delta` deltas.
   *
   * @param chunk Raw stdout chunk (may contain partial or multiple JSONL lines)
   * @param streamState Accumulated state across chunks (key: "streamBuffer")
   * @returns Structured events to emit, or undefined if no complete events yet
   */
  processStreamingChunk(
    chunk: string,
    streamState: Map<string, any>
  ): CliEvent[] | undefined {
    let buffer = (streamState.get("streamBuffer") as string) || "";
    buffer += chunk;

    const { objects, remainder } =
      CliResponseParser.extractJsonObjectsFromStream(buffer);
    streamState.set("streamBuffer", remainder);

    if (objects.length === 0) {
      return undefined;
    }

    const events: CliEvent[] = [];

    for (const json of objects) {
      switch (json.type) {
        case "assistant.message_delta": {
          const delta = json.data?.deltaContent;
          if (delta) {
            events.push({
              type: CLI_EVENT_TYPES.TEXT,
              timestamp: Date.now(),
              data: { text: delta },
            });
          }
          break;
        }

        case "assistant.reasoning_delta": {
          const delta = json.data?.deltaContent;
          if (delta) {
            events.push({
              type: CLI_EVENT_TYPES.THINKING,
              timestamp: Date.now(),
              data: { text: delta, label: "Reasoning" },
            });
          }
          break;
        }

        case "tool.execution_start": {
          // Emit tool start event for real-time tool visualization
          if (json.data?.toolName && json.data?.arguments) {
            this.mapToolRequestToEvent(
              {
                toolCallId: json.data.toolCallId,
                name: json.data.toolName,
                arguments: json.data.arguments,
              },
              events
            );
            // Store for completion correlation
            if (json.data.toolCallId) {
              const pendingCalls =
                (streamState.get("pendingToolCalls") as Map<
                  string,
                  { name: string; path?: string; oldStr?: string; newStr?: string }
                >) ?? new Map();
              pendingCalls.set(json.data.toolCallId, {
                name: json.data.toolName,
                path:
                  json.data.arguments?.path || json.data.arguments?.file_path,
                oldStr:
                  json.data.arguments?.old_str ||
                  json.data.arguments?.old_string,
                newStr:
                  json.data.arguments?.new_str ||
                  json.data.arguments?.new_string,
              });
              streamState.set("pendingToolCalls", pendingCalls);
            }
          }
          break;
        }

        case "tool.execution_complete": {
          // Emit COMPLETED event for file edits so the UI shows the diff and undo button.
          const toolCallId: string | undefined = json.data?.toolCallId;
          if (toolCallId) {
            const pendingCalls = streamState.get("pendingToolCalls") as
              | Map<string, { name: string; path?: string; oldStr?: string; newStr?: string }>
              | undefined;
            const pending = pendingCalls?.get(toolCallId);
            if (
              pending &&
              CliEventMapper.classifyTool(pending.name).type ===
                CLI_EVENT_TYPES.FILE_EDIT
            ) {
              const result = json.data?.result;
              const structuredPatch = result?.detailedContent
                ? CliResponseParser.parseUnifiedDiff(result.detailedContent)
                : undefined;
              const success = json.data?.success === true;
              events.push({
                type: CLI_EVENT_TYPES.FILE_EDIT,
                timestamp: Date.now(),
                data: {
                  path: pending.path || "unknown",
                  oldContent: pending.oldStr,
                  newContent: pending.newStr,
                  structuredPatch,
                  status: success
                    ? OPERATION_STATUS.COMPLETED
                    : OPERATION_STATUS.FAILED,
                  success,
                  error: json.data?.error?.message,
                } as FileEditData,
              });
              pendingCalls!.delete(toolCallId);
            }
          }
          break;
        }
      }
    }

    return events.length > 0 ? events : undefined;
  }

  /**
   * Extract session ID from Copilot CLI JSON output.
   *
   * In JSON mode, the session ID is in the final `result` event's `sessionId` field.
   *
   * @param output Raw CLI stdout (JSONL)
   * @returns Session ID UUID if found
   */
  extractSessionId(output: string): string | undefined {
    const trimmed = output.trimStart();
    if (!trimmed.startsWith("{")) {
      return undefined;
    }

    const { objects } = CliResponseParser.extractJsonObjectsFromStream(output);
    for (const json of objects) {
      if (json.type === "result" && json.sessionId) {
        return json.sessionId;
      }
    }
    return undefined;
  }

  /**
   * Parse token counts from Copilot CLI statistics string (stderr).
   *
   * Handles two formats (supports optional k suffix on all values):
   * - New: "59.0k in, 207 out, 0 cached"
   * - Old: "25.7k input, 223 output, 6.1k cache read"
   *
   * @param statistics Statistics string from stderr
   * @returns Token counts if found, undefined otherwise
   */
  parseTokenCounts(
    statistics: string
  ): { prompt: number; completion: number; cached?: number } | undefined {
    // Match both "in/out" and "input/output" labels, with optional cached/cache read suffix
    const match = statistics.match(
      /([\d.]+)(k)?\s+in(?:put)?,\s+([\d.]+)(k)?\s+out(?:put)?(?:,\s+([\d.]+)(k)?\s+(?:cached?|cache\s+read))?/i
    );
    if (!match) {
      return undefined;
    }

    const parseValue = (
      numStr: string,
      hasSuffix: string | undefined
    ): number => {
      const num = parseFloat(numStr);
      // If suffix exists (captured as 'k'), multiply by 1000
      return hasSuffix ? Math.round(num * 1000) : num;
    };

    return {
      prompt: parseValue(match[1], match[2]),
      completion: parseValue(match[3], match[4]),
      cached:
        match[5] !== undefined ? parseValue(match[5], match[6]) : undefined,
    };
  }
}
