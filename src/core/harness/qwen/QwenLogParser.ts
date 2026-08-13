import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { BaseLogParser } from "../shared/BaseLogParser";
import {
  BaseCliEvent,
  UserEventClassification,
} from "../shared/interfaces/ILogParser";
import { Log } from "../../../utils/Log";
import { retryWithBackoff } from "../../../utils/RetryUtils";
import {
  UniversalCliOutput,
  CliEvent,
  TokenUsage,
  FileEditData,
  FileWriteData,
  ThinkingBlock,
  TextData,
  UnifiedDiffHunk,
  AskUserQuestionData,
  AskUserQuestionEntry,
  AskUserQuestionOption,
} from "../../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  HARNESS_IDS,
  OPERATION_STATUS,
  TOKEN_TOTAL_CONFIDENCE,
} from "../../../types/DashboardConstants";
import { getQwenContextWindowSize } from "../../../utils/ModelConstants";
import { BaseToolBuilder } from "../shared/BaseToolBuilder";

/**
 * Qwen Code CLI Log Parser
 *
 * Parses Qwen Code CLI log files in JSONL format from `~/.qwen/projects/<workspace-path>/chats/`.
 * Each session creates a `<session-id>.jsonl` file with streaming event entries.
 *
 * @remarks
 * **Log Format:**
 * - Location: `~/.qwen/projects/<sanitized-workspace-path>/chats/`
 * - File naming: `<session-id>.jsonl` (e.g., `uuid-123-abc.jsonl`)
 * - Sanitization: `C:\dev\ctrlyoke` → `c--dev-ctrlyoke`
 *
 * **Event Types:**
 * 1. `system`      - Telemetry/context; subtype `"at_command"` or `"ui_telemetry"`
 * 2. `user`        - User message; `message.parts[].text`
 * 3. `assistant`   - AI response; `message.parts[]` with text, thinking, and functionCall parts
 * 4. `tool_result` - Tool execution result; `message.parts[].functionResponse`
 *
 * **Message Part Types (Gemini-style, NOT Claude content blocks):**
 * - `{ text }` - Response text
 * - `{ text, thought: true }` - Internal thinking block
 * - `{ functionCall: { id, name, args } }` - Tool invocation (in assistant events)
 * - `{ functionResponse: { id, name, response } }` - Tool result (in tool_result events)
 *
 * **Usage Metadata (top-level on assistant events):**
 * - `promptTokenCount` - Input tokens (includes cached)
 * - `candidatesTokenCount` - Output text tokens
 * - `thoughtsTokenCount` - Output thinking tokens
 * - `cachedContentTokenCount` - Cache hit tokens
 * - `totalTokenCount` - Total tokens for this call
 *
 * **Completion Detection:**
 * No `stop_reason` or `result` event. A session is complete when an assistant
 * event has no `functionCall` parts (pure text/thinking response).
 *
 * **Session Discovery:**
 * - Uses `findModifiedSessionLogs()` to get recently modified files
 * - Reads first 10 events from each candidate
 * - Matches prompt text against user event content (first 100 chars)
 * - Returns first matching log file path
 *
 * @example
 * ```typescript
 * const parser = new QwenLogParser();
 * const logPath = await parser.discoverSessionLog("Analyze code", new Date());
 * if (logPath) {
 *   const events = await parser.readNewLines(logPath);
 *   const response = parser.extractResponse(events);
 *   const sessionId = parser.extractSessionId(events);
 * }
 * ```
 */

/**
 * A single part in a Qwen message's `parts` array.
 *
 * Qwen uses a Gemini-style message format where content is broken into typed
 * parts rather than Claude-style typed content blocks.
 */
interface QwenMessagePart {
  /** Plain text content. Present with `thought: true` for thinking blocks. */
  text?: string;
  /** When true, this text part is an internal thinking/reasoning block. */
  thought?: boolean;
  /** Tool invocation initiated by the assistant. */
  functionCall?: {
    id: string;
    name: string;
    args: Record<string, any>;
  };
  /** Tool execution result returned to the assistant. */
  functionResponse?: {
    id: string;
    name: string;
    response: {
      output?: string;
      error?: string;
    };
  };
}

/**
 * Provider-specific event type for internal loop bodies.
 *
 * Extends BaseCliEvent with typed properties for Qwen's actual JSONL log format.
 *
 * **Actual event types (from log files):**
 * - `system`      — session/tool telemetry; subtype is `"at_command"` or `"ui_telemetry"`
 * - `user`        — initial user message; message.parts contains {text} blocks
 * - `assistant`   — AI response; message.parts contains text, thinking, and functionCall blocks
 * - `tool_result` — tool execution result; message.parts contains functionResponse blocks
 */
interface QwenProviderEvent extends BaseCliEvent {
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  model?: string;
  message?: {
    role: string;
    parts: QwenMessagePart[];
  };
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    thoughtsTokenCount: number;
    totalTokenCount: number;
    cachedContentTokenCount: number;
  };
  subtype?: string;
  systemPayload?: Record<string, any>;
  toolCallResult?: {
    callId: string;
    status: "success" | "error";
    resultDisplay?: string | Record<string, unknown>;
  };
}

export class QwenLogParser extends BaseLogParser {
  /**
   * Workspace root directory — set by CliIntegration after construction.
   * Used by getQwenProjectDirectory() to locate Qwen's session log folder.
   * Falls back to process.cwd() when not set (CLI mode).
   */
  private workspaceRoot?: string;

  /**
   * Streaming extraction receives one JSONL event at a time, so retain the
   * question set until Qwen emits the matching tool_result event.
   */
  private readonly streamingAskQuestions = new Map<
    string,
    AskUserQuestionEntry[]
  >();

  /**
   * Set the workspace root directory for session log discovery.
   * Called by CliIntegration so the log parser knows where to look.
   */
  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
  }

  /**
   * Extract complete response from Qwen log events
   *
   * Processes Qwen JSONL events and combines:
   * - Text and thinking content from `assistant` event `message.parts`
   * - Tool calls from `functionCall` parts in assistant events
   * - Tool results from `tool_result` events (separate from user events)
   * - Token usage from `usageMetadata` (Gemini-style field, not message.usage)
   * - Cache hit tokens from `usageMetadata.cachedContentTokenCount`
   * - Model from top-level `model` field (not message.model)
   * - Session ID from top-level `sessionId` field (present on all event types)
   *
   * @param events - Array of parsed Qwen log events
   * @returns UniversalCliOutput - Standardized response object
   */
  extractResponse(events: BaseCliEvent[]): UniversalCliOutput {
    const outputEvents: CliEvent[] = [];
    let sessionId: string | undefined;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCachedTokens = 0;
    let sawUsageMetadata = false;
    let lastAssistantUsage: QwenProviderEvent["usageMetadata"] | undefined;
    let model: string | undefined;
    // Maps callId → full file path so tool_result events can get the path from the
    // original functionCall args (resultDisplay.fileName is basename only)
    const callPathMap = new Map<string, string>();
    const askQuestionMap = new Map<string, AskUserQuestionEntry[]>();

    for (const event of events as QwenProviderEvent[]) {
      // Extract session ID from top-level field (present on all event types)
      if (event.sessionId && !sessionId) {
        sessionId = event.sessionId;
      }

      const timestamp = event.timestamp
        ? new Date(event.timestamp).getTime()
        : Date.now();

      // ASSISTANT — process parts array (text, thinking, functionCall)
      if (event.type === "assistant" && event.message?.parts) {
        for (const part of event.message.parts) {
          // THINKING — text part with thought: true
          if (part.text && part.thought === true) {
            outputEvents.push({
              type: CLI_EVENT_TYPES.THINKING,
              timestamp,
              data: {
                text: part.text,
                label: "Extended Thinking",
              } as ThinkingBlock,
            });
          }

          // TEXT — plain text response (no thought flag)
          if (part.text && part.thought !== true) {
            outputEvents.push({
              type: CLI_EVENT_TYPES.TEXT,
              timestamp,
              data: { text: part.text } as TextData,
            });
          }

          // TOOL_USE — functionCall block
          if (part.functionCall) {
            const args = part.functionCall.args || {};
            // Track file path for later correlation with tool_result resultDisplay
            const fp = (args.absolute_path ?? args.file_path ?? args.path) as
              | string
              | undefined;
            if (fp) {
              callPathMap.set(part.functionCall.id, fp);
            }
            outputEvents.push(
              ...this.buildFunctionCallEvents(
                part.functionCall,
                timestamp,
                askQuestionMap
              )
            );
          }
        }

        // Token usage is on usageMetadata at top level of assistant event
        if (event.usageMetadata) {
          sawUsageMetadata = true;
          const u = event.usageMetadata;
          totalInputTokens += u.promptTokenCount || 0;
          // Output = candidate tokens + thinking tokens (both count toward billing)
          totalOutputTokens +=
            (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);
          totalCachedTokens += u.cachedContentTokenCount || 0;
          lastAssistantUsage = u;
        }

        // Model is a top-level field on assistant events
        if (event.model && !model) {
          model = event.model;
        }
      }

      // TOOL_RESULT — separate event type (not nested in user events)
      if (event.type === "tool_result" && event.message?.parts) {
        for (const part of event.message.parts) {
          if (part.functionResponse) {
            const askEvent = this.buildAskUserQuestionCompletedEvent(
              part.functionResponse,
              event,
              askQuestionMap
            );
            if (askEvent) {
              outputEvents.push(askEvent);
              continue;
            }

            const resp = part.functionResponse.response;
            const isError = !!resp.error;
            outputEvents.push({
              type: CLI_EVENT_TYPES.TOOL_RESULT,
              timestamp,
              data: {
                toolCallId: part.functionResponse.id,
                result: {
                  success: !isError,
                  output: resp.output,
                  error: isError ? resp.error : undefined,
                },
              },
            });
          }
        }

        // Emit COMPLETED semantic events from structured result metadata.
        // toolCallResult.resultDisplay provides fileDiff, originalContent, and newContent
        // for edit/write operations — richer than what's in functionResponse.response.
        const tcr = event.toolCallResult;
        if (tcr && tcr.resultDisplay && typeof tcr.resultDisplay === "object") {
          const rd = tcr.resultDisplay as Record<string, any>;
          const toolName = event.message.parts[0]?.functionResponse?.name;
          const fullPath =
            callPathMap.get(tcr.callId) ?? rd.fileName ?? "unknown";
          const succeeded = tcr.status === "success";

          if (toolName === "edit" && rd.fileDiff) {
            outputEvents.push({
              type: CLI_EVENT_TYPES.FILE_EDIT,
              timestamp,
              data: {
                path: fullPath,
                oldContent: rd.originalContent || undefined,
                newContent: rd.newContent || undefined,
                structuredPatch: this.parseUnifiedDiff(rd.fileDiff as string),
                status: OPERATION_STATUS.COMPLETED,
                success: succeeded,
              } as FileEditData,
            });
          } else if (toolName === "write_file" && rd.newContent !== undefined) {
            outputEvents.push({
              type: CLI_EVENT_TYPES.FILE_WRITE,
              timestamp,
              data: {
                path: fullPath,
                content: rd.newContent as string,
                status: OPERATION_STATUS.COMPLETED,
                success: succeeded,
              } as FileWriteData,
            });
          }
        }
      }
    }

    // Context window state = last assistant turn's prompt token count.
    // This represents current occupancy, not cumulative billing totals.
    const contextWindowUsedTokens = lastAssistantUsage
      ? lastAssistantUsage.promptTokenCount || 0
      : undefined;

    const tokenUsage: TokenUsage | undefined =
      sawUsageMetadata
        ? {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            totalTokens: totalInputTokens + totalOutputTokens,
            totalConfidence: TOKEN_TOTAL_CONFIDENCE.ACCUMULATED,
            cachedInputTokens:
              totalCachedTokens > 0 ? totalCachedTokens : undefined,
            contextWindowUsedTokens,
            contextWindowSize: getQwenContextWindowSize(
              model ?? this.resolvedModel
            ),
          }
        : undefined;

    return {
      events: outputEvents,
      metadata: {
        sessionId,
        model,
        harness: HARNESS_IDS.QWEN_CLI,
        usage: tokenUsage,
        ...(totalCachedTokens > 0
          ? { cacheTokens: { read: totalCachedTokens } }
          : {}),
      },
    };
  }

  /**
   * Check if event indicates completion
   *
   * Qwen has no `stop_reason` field or `result` event type. A session is
   * complete when an `assistant` event contains no `functionCall` parts —
   * if it had tool calls, Qwen would continue with a `tool_result` event
   * and another API round.
   *
   * @param event - Single parsed Qwen log event
   * @returns True if event signals completion
   */
  isComplete(event: BaseCliEvent): boolean {
    // Qwen has no stop_reason or result event. An assistant event is the final
    // response when it contains no functionCall parts — if it did have tool calls,
    // Qwen would have continued with tool_result events and another API round.
    if (event.type !== "assistant") {
      return false;
    }

    const parts = (event as QwenProviderEvent).message?.parts ?? [];
    return !parts.some((p) => p.functionCall !== undefined);
  }

  override extractLiveContextWindow(
    event: BaseCliEvent,
    modelId: string
  ): { used: number; size: number } | null {
    const e = event as QwenProviderEvent;
    if (e.type === "assistant" && e.usageMetadata?.promptTokenCount != null) {
      const used = e.usageMetadata.promptTokenCount;
      const size = getQwenContextWindowSize(e.model ?? modelId);
      return used > 0 && size ? { used, size } : null;
    }
    return null;
  }

  /**
   * Classify a `user` log event. Qwen's `user` type is only ever the initial
   * prompt or a genuine follow-up typed into the live TUI (tool results arrive
   * as a separate `tool_result` event type — see `extractResponse`), so the
   * only distinction needed is against ctrlyoke's own injected prompt.
   */
  override classifyUserEvent(
    event: BaseCliEvent,
    ctx: { dispatchedPromptText?: string }
  ): UserEventClassification {
    const e = event as QwenProviderEvent;
    if (e.type !== "user") {
      return "other";
    }

    const text = this.extractUserMessageText(e);
    if (!text) {
      return "other";
    }

    if (ctx.dispatchedPromptText) {
      const normalizedDispatched = this.normalizePromptForMatching(
        ctx.dispatchedPromptText.substring(0, 100)
      );
      const normalizedLogged = this.normalizePromptForMatching(
        text.substring(0, 100)
      );
      if (normalizedDispatched === normalizedLogged) {
        return "injected-prompt";
      }
    }

    return "human-steer";
  }

  override extractUserSteerText(event: BaseCliEvent): string | undefined {
    const e = event as QwenProviderEvent;
    if (e.type !== "user") {
      return undefined;
    }
    const text = this.extractUserMessageText(e);
    return text || undefined;
  }

  /** Concatenates all text parts in a Qwen `user` event's message (Gemini-style parts, not Claude content blocks). */
  private extractUserMessageText(e: QwenProviderEvent): string {
    if (!Array.isArray(e.message?.parts)) {
      return "";
    }
    return e.message.parts
      .filter((part) => typeof part.text === "string")
      .map((part) => part.text as string)
      .join("")
      .trim();
  }

  /**
   * Discover session log file for a prompt
   *
   * Searches Qwen project directory for log file matching session ID or prompt text.
   *
   * @param promptText - The prompt text sent to Qwen CLI (used for matching if no sessionId)
   * @param startTime - Execution start timestamp (used to filter candidates)
   * @param sessionId - Optional session ID (not typically available from hooks for Qwen)
   * @returns Absolute path to session log file, or null if not found
   */
  async discoverSessionLog(
    promptText: string,
    startTime: Date,
    sessionId?: string,
    signal?: AbortSignal
  ): Promise<string | null> {
    try {
      if (signal?.aborted) {
        return null;
      }

      const projectDir = this.getQwenProjectDirectory();
      if (!projectDir) {
        Log.debug("[QwenLogParser] No Qwen project directory found");
        return null;
      }

      const chatsDir = path.join(projectDir, "chats");

      if (!fs.existsSync(chatsDir)) {
        Log.debug("[QwenLogParser] No chats directory found");
        return null;
      }

      Log.debug(`[QwenLogParser] Searching for session logs in: ${chatsDir}`);

      // FAST PATH: session ID → direct file lookup with retry
      // (Qwen writes the log file within ~50-100ms of the hook firing)
      if (sessionId) {
        const logPath = path.join(chatsDir, `${sessionId}.jsonl`);

        const result = await retryWithBackoff(
          async () => {
            if (fs.existsSync(logPath)) {
              const stats = fs.statSync(logPath);
              if (stats.mtime >= startTime) {
                return logPath;
              }
              Log.debug(
                `[QwenLogParser] Session log exists but not yet updated (mtime: ${stats.mtime.toISOString()}, startTime: ${startTime.toISOString()}), will retry...`
              );
            }
            return null;
          },
          {
            signal,
            onRetry: (attempt, max, delay) => {
              if (attempt > 1) {
                Log.debug(
                  `[QwenLogParser] Session log not ready (attempt ${attempt}/${max}), retrying in ${delay}ms...`
                );
              }
            },
          }
        );

        if (signal?.aborted) {
          return null;
        }

        if (result) {
          Log.debug(
            `[QwenLogParser] Found session log via session ID: ${result}`
          );
          return result;
        } else {
          Log.debug(
            `[QwenLogParser] Session log file not found after retries: ${logPath}`
          );
        }
      }

      // FALLBACK: scan recently modified files and match by prompt text
      const candidates = this.findModifiedSessionLogs(chatsDir, startTime);
      if (candidates.length === 0) {
        Log.debug("[QwenLogParser] No candidate log files found");
        return null;
      }

      Log.debug(
        `[QwenLogParser] Found ${candidates.length} candidate log files`
      );

      const promptPrefix = this.normalizePromptForMatching(
        promptText.substring(0, 100)
      );

      for (const candidatePath of candidates) {
        try {
          const events = await this.readFirstNJsonlEvents(candidatePath, 10);

          // Qwen user events have message.parts[].text (Gemini-style)
          for (const event of events as QwenProviderEvent[]) {
            if (event.type === "user" && event.message?.parts) {
              for (const part of event.message.parts) {
                if (part.text) {
                  const logPromptPrefix = this.normalizePromptForMatching(
                    part.text.substring(0, 100)
                  );
                  if (logPromptPrefix === promptPrefix) {
                    Log.debug(
                      `[QwenLogParser] Found matching session log: ${candidatePath}`
                    );
                    return candidatePath;
                  }
                }
              }
            }
          }
        } catch (error) {
          Log.debug(
            `[QwenLogParser] Error reading candidate ${candidatePath}:`,
            error
          );
          continue;
        }
      }

      Log.debug("[QwenLogParser] No matching session log found");
      return null;
    } catch (error) {
      Log.warn("[QwenLogParser] Error discovering session log:", error);
      return null;
    }
  }

  /**
   * Extract session ID from log events
   *
   * Searches events for first entry with sessionId field.
   *
   * @param events - Array of parsed Qwen log events
   * @returns Session ID (UUID format), or null if not found
   */
  extractSessionId(events: BaseCliEvent[]): string | null {
    for (const event of events) {
      if ((event as QwenProviderEvent).sessionId) {
        return (event as QwenProviderEvent).sessionId as string;
      }
    }
    return null;
  }

  /**
   * Extract structured CliEvents from a single Qwen log event for streaming.
   *
   * Mirrors the per-event logic in `extractResponse` so that thinking blocks,
   * text, tool invocations, and tool results all stream with proper structure.
   *
   * A single `assistant` event can produce multiple CliEvents (one per part).
   * `tool_result` events emit TOOL_RESULT CliEvents.
   *
   * Note: The callPathMap used by `extractResponse` for resolving full file paths
   * on tool_result events is not available here (requires cross-event state).
   * Tool results are emitted with the information available in the single event.
   */
  extractStructuredEventsFromEvent(event: BaseCliEvent): CliEvent[] {
    const e = event as QwenProviderEvent;
    const cliEvents: CliEvent[] = [];

    const timestamp = e.timestamp
      ? new Date(e.timestamp).getTime()
      : Date.now();

    if (e.type === "assistant" && e.message?.parts) {
      for (const part of e.message.parts) {
        if (part.text && part.thought === true) {
          cliEvents.push({
            type: CLI_EVENT_TYPES.THINKING,
            timestamp,
            data: {
              text: part.text,
              label: "Extended Thinking",
            } as ThinkingBlock,
          });
        }

        if (part.text && part.thought !== true) {
          cliEvents.push({
            type: CLI_EVENT_TYPES.TEXT,
            timestamp,
            data: { text: part.text } as TextData,
          });
        }

        if (part.functionCall) {
          cliEvents.push(
            ...this.buildFunctionCallEvents(
              part.functionCall,
              timestamp,
              this.streamingAskQuestions
            )
          );
        }
      }
    }

    if (e.type === "tool_result" && e.message?.parts) {
      for (const part of e.message.parts) {
        if (part.functionResponse) {
          const askEvent = this.buildAskUserQuestionCompletedEvent(
            part.functionResponse,
            e,
            this.streamingAskQuestions
          );
          if (askEvent) {
            cliEvents.push(askEvent);
            continue;
          }

          const resp = part.functionResponse.response;
          const isError = !!resp.error;
          cliEvents.push({
            type: CLI_EVENT_TYPES.TOOL_RESULT,
            timestamp,
            data: {
              toolCallId: part.functionResponse.id,
              result: {
                success: !isError,
                output: resp.output,
                error: isError ? resp.error : undefined,
              },
            },
          });
        }
      }
    }

    return cliEvents;
  }

  private static readonly ASK_USER_QUESTION_TOOL_NAMES = new Set([
    "ask_user_question",
    "ask_user",
    "askuserquestion",
  ]);

  private isAskUserQuestionTool(toolName: string | undefined): boolean {
    return (
      !!toolName &&
      QwenLogParser.ASK_USER_QUESTION_TOOL_NAMES.has(toolName.toLowerCase())
    );
  }

  private buildFunctionCallEvents(
    functionCall: NonNullable<QwenMessagePart["functionCall"]>,
    timestamp: number,
    askQuestionMap: Map<string, AskUserQuestionEntry[]>
  ): CliEvent[] {
    const args = functionCall.args || {};
    if (!this.isAskUserQuestionTool(functionCall.name)) {
      return BaseToolBuilder.buildInitiatedEvents(
        functionCall.name,
        args,
        functionCall.id,
        timestamp
      );
    }

    const questions = this.parseAskUserQuestionEntries(args);
    askQuestionMap.set(functionCall.id, questions);
    return [
      {
        type: CLI_EVENT_TYPES.ASK_USER_QUESTION,
        timestamp,
        data: {
          toolCallId: functionCall.id,
          questions,
          status: OPERATION_STATUS.INITIATED,
        } as AskUserQuestionData,
      },
    ];
  }

  private buildAskUserQuestionCompletedEvent(
    functionResponse: NonNullable<QwenMessagePart["functionResponse"]>,
    event: QwenProviderEvent,
    askQuestionMap: Map<string, AskUserQuestionEntry[]>
  ): CliEvent | undefined {
    const callId = functionResponse.id;
    const questions = askQuestionMap.get(callId) ?? [];
    if (
      !this.isAskUserQuestionTool(functionResponse.name) &&
      !questions.length
    ) {
      return undefined;
    }

    askQuestionMap.delete(callId);
    const response = functionResponse.response;
    const resultText = this.getQwenToolResultText(response, event);
    const success = !response.error && event.toolCallResult?.status !== "error";

    if (!success) {
      return {
        type: CLI_EVENT_TYPES.ASK_USER_QUESTION,
        timestamp: this.getEventTimestamp(event),
        data: {
          toolCallId: callId,
          questions,
          status: OPERATION_STATUS.FAILED,
          declined: {
            reason: "rejected",
            feedback: resultText || response.error,
          },
        } as AskUserQuestionData,
      };
    }

    const answers = this.parseQwenAnswers(resultText);
    return {
      type: CLI_EVENT_TYPES.ASK_USER_QUESTION,
      timestamp: this.getEventTimestamp(event),
      data: {
        toolCallId: callId,
        questions: questions.map((question, index) =>
          this.resolveQwenAnswer(question, answers, index, resultText)
        ),
        status: OPERATION_STATUS.COMPLETED,
      } as AskUserQuestionData,
    };
  }

  private getEventTimestamp(event: QwenProviderEvent): number {
    return event.timestamp ? new Date(event.timestamp).getTime() : Date.now();
  }

  private getQwenToolResultText(
    response: NonNullable<QwenMessagePart["functionResponse"]>["response"],
    event: QwenProviderEvent
  ): string {
    if (typeof response.output === "string" && response.output.length > 0) {
      return response.output;
    }
    const resultDisplay = event.toolCallResult?.resultDisplay;
    return typeof resultDisplay === "string"
      ? resultDisplay
      : resultDisplay
        ? JSON.stringify(resultDisplay)
        : "";
  }

  private parseAskUserQuestionEntries(
    args: Record<string, any>
  ): AskUserQuestionEntry[] {
    let rawQuestions: unknown = args.questions;
    if (typeof rawQuestions === "string") {
      try {
        rawQuestions = JSON.parse(rawQuestions);
      } catch {
        rawQuestions = undefined;
      }
    }

    if (Array.isArray(rawQuestions)) {
      return rawQuestions.map((rawQuestion) => {
        const question = (rawQuestion ?? {}) as Record<string, unknown>;
        return {
          id: typeof question.id === "string" ? question.id : undefined,
          question:
            typeof question.question === "string" ? question.question : "",
          header:
            typeof question.header === "string" ? question.header : undefined,
          multiSelect:
            typeof question.multiSelect === "boolean"
              ? question.multiSelect
              : typeof question.multi_select === "boolean"
                ? question.multi_select
                : undefined,
          options: this.parseQwenOptions(question.options ?? question.choices),
        };
      });
    }

    if (typeof args.question === "string") {
      return [
        {
          question: args.question,
          options: this.parseQwenOptions(args.options ?? args.choices),
        },
      ];
    }

    return [];
  }

  private parseQwenOptions(rawOptions: unknown): AskUserQuestionOption[] {
    if (!Array.isArray(rawOptions)) {
      return [];
    }

    return rawOptions.map((rawOption) => {
      if (typeof rawOption === "string") {
        return { label: rawOption };
      }

      const option = (rawOption ?? {}) as Record<string, unknown>;
      const rawDescription =
        typeof option.description === "string" ? option.description : undefined;
      const inferred = rawDescription
        ? this.splitQwenDescription(rawDescription)
        : {};
      return {
        label: typeof option.label === "string" ? option.label : "",
        description: inferred.description,
        preview:
          typeof option.preview === "string"
            ? option.preview
            : inferred.preview,
      };
    });
  }

  private splitQwenDescription(description: string): {
    description?: string;
    preview?: string;
  } {
    const paragraphs = description.split(/\r?\n\s*\r?\n/);
    if (paragraphs.length < 2) {
      return { description };
    }

    const preview = paragraphs.slice(1).join("\n\n").trimEnd();
    const asciiLines = preview
      .split(/\r?\n/)
      .filter((line) => /[\\/|()<>^~_=]/.test(line));
    if (asciiLines.length < 2) {
      return { description };
    }

    return {
      description: paragraphs[0].trim(),
      preview,
    };
  }

  private parseQwenAnswers(resultText: string): Map<string, string> {
    const answers = new Map<string, string>();
    const answerPattern = /\*\*(.+?)\*\*\s*:\s*([^\r\n]*)/g;
    let match: RegExpExecArray | null;
    while ((match = answerPattern.exec(resultText)) !== null) {
      answers.set(match[1].trim(), match[2].trim());
    }
    return answers;
  }

  private resolveQwenAnswer(
    question: AskUserQuestionEntry,
    answers: Map<string, string>,
    index: number,
    resultText: string
  ): AskUserQuestionEntry {
    const answer =
      answers.get(question.header ?? "") ??
      answers.get(question.question) ??
      (answers.size === 1 ? answers.values().next().value : undefined) ??
      (answers.size === 0 && index === 0 && question.options.length === 0
        ? resultText.trim()
        : undefined);
    if (!answer) {
      return { ...question };
    }

    const selected = question.options.find(
      (option) =>
        answer === option.label ||
        answer.startsWith(`${option.label} \u2014 `) ||
        answer.startsWith(`${option.label}\n`)
    );
    return {
      ...question,
      answer: selected?.label ?? answer,
      answerPreview: selected?.preview,
    };
  }

  /**
   * Extract text content from a single Qwen log event for streaming
   *
   * @param event - Single parsed Qwen log event
   * @returns Text content to display, or undefined if no displayable content
   */
  extractContentFromEvent(event: BaseCliEvent): string | undefined {
    const e = event as QwenProviderEvent;

    // Qwen assistant: extract non-thinking text parts from message.parts
    if (e.type === "assistant" && e.message?.parts) {
      const textContent = e.message.parts
        .filter((p) => p.text !== undefined && p.thought !== true)
        .map((p) => p.text as string)
        .join("");
      return textContent || undefined;
    }

    return undefined;
  }

  /**
   * Format Qwen metadata into statistics string
   *
   * Extends common parts (session, model, tokens) with Qwen-specific fields:
   * - Cache read tokens (cachedContentTokenCount from usageMetadata)
   *
   * @param metadata - Metadata from extractResponse() (sessionId, model, usage, cacheTokens)
   * @returns Formatted statistics string
   */
  formatStatistics(metadata: BaseCliEvent): string {
    const parts = this.buildCommonStatisticsParts(metadata);
    const meta = metadata as Record<string, any>;

    // Cache read tokens (Qwen reports cache hits via cachedContentTokenCount)
    if (meta.cacheTokens?.read > 0) {
      parts.push(`Cache: ${meta.cacheTokens.read} read`);
    }

    return parts.join(" | ");
  }

  /**
   * Parse a unified diff string into structured hunk objects for UI rendering.
   *
   * Qwen provides `toolCallResult.resultDisplay.fileDiff` as a standard unified
   * diff string. This converts it to `UnifiedDiffHunk[]` so the dashboard can
   * render line-numbered diffs exactly as it does for Claude's `structuredPatch`.
   *
   * @param diffStr - Unified diff string (e.g. from `fileDiff` in resultDisplay)
   * @returns Array of parsed hunks, empty if no valid hunk headers found
   */
  private parseUnifiedDiff(diffStr: string): UnifiedDiffHunk[] {
    const hunks: UnifiedDiffHunk[] = [];
    const lines = diffStr.split("\n");
    let current: UnifiedDiffHunk | null = null;
    // Matches: @@ -oldStart[,oldLines] +newStart[,newLines] @@
    const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

    for (const line of lines) {
      const match = hunkHeader.exec(line);
      if (match) {
        if (current) {
          hunks.push(current);
        }
        current = {
          oldStart: parseInt(match[1], 10),
          oldLines: match[2] !== undefined ? parseInt(match[2], 10) : 1,
          newStart: parseInt(match[3], 10),
          newLines: match[4] !== undefined ? parseInt(match[4], 10) : 1,
          lines: [],
        };
        continue;
      }

      if (
        current &&
        (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))
      ) {
        current.lines.push(line);
      }
    }

    if (current) {
      hunks.push(current);
    }

    return hunks;
  }

  /**
   * Get Qwen project directory for current workspace
   *
   * Resolves to `~/.qwen/projects/<sanitized-workspace-path>/`
   *
   * @returns Absolute path to Qwen project directory, or null if no workspace
   *
   * @remarks
   * **Path Sanitization:**
   * - Lowercases the path
   * - Replaces all path separators (/ \ :) with dashes
   * - Strips any remaining non-alphanumeric, non-dash characters
   * - Example: `/home/user/dev/ctrlyoke` → `-home-user-dev-ctrlyoke`
   * - Windows: `C:\dev\ctrlyoke` → `c--dev-ctrlyoke`
   */
  private getQwenProjectDirectory(): string | null {
    // Use stored workspaceRoot (set by CliIntegration) or fall back to process.cwd()
    const workspacePath = this.workspaceRoot || process.cwd();

    if (!workspacePath) {
      return null;
    }

    // Sanitize workspace path for Qwen's naming convention.
    // All path separators (/ \ :) become dashes; other non-alphanumeric chars are stripped.
    // Example: /home/user/dev/ctrlyoke → -home-user-dev-ctrlyoke
    const sanitizedPath = workspacePath
      .toLowerCase()
      .replace(/[:\\/]/g, "-")
      .replace(/[^a-z0-9-]/g, "");

    const baseDir = path.join(os.homedir(), ".qwen", "projects");
    const projectDir = path.join(baseDir, sanitizedPath);

    Log.debug(
      `[QwenLogParser] Project directory: ${projectDir} (from ${workspacePath})`
    );

    return fs.existsSync(projectDir) ? projectDir : null;
  }
}
