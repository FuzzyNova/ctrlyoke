import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { BaseLogParser } from "../shared/BaseLogParser";
import { BaseCliEvent } from "../shared/interfaces/ILogParser";
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
} from "../../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  HARNESS_IDS,
  OPERATION_STATUS,
} from "../../../types/DashboardConstants";
import { getQwenContextWindowSize } from "../../../utils/ModelConstants";
import { QwenToolBuilder } from "./QwenToolBuilder";

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
 * - Sanitization: `C:\dev\FlightPath` → `c--dev-flightpath`
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
    resultDisplay?: string;
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
    let lastAssistantUsage: QwenProviderEvent["usageMetadata"] | undefined;
    let model: string | undefined;
    // Maps callId → full file path so tool_result events can get the path from the
    // original functionCall args (resultDisplay.fileName is basename only)
    const callPathMap = new Map<string, string>();

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
              ...QwenToolBuilder.buildInitiatedEvents(
                part.functionCall.name,
                args,
                part.functionCall.id,
                timestamp
              )
            );
          }
        }

        // Token usage is on usageMetadata at top level of assistant event
        if (event.usageMetadata) {
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
      totalInputTokens > 0 || totalOutputTokens > 0
        ? {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            totalTokens: totalInputTokens + totalOutputTokens,
            cachedInputTokens:
              totalCachedTokens > 0 ? totalCachedTokens : undefined,
            contextWindowUsedTokens,
            contextWindowSize: getQwenContextWindowSize(model ?? ""),
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
    event: BaseCliEvent
  ): { used: number; size: number } | null {
    const e = event as QwenProviderEvent;
    if (e.type === "assistant" && e.usageMetadata?.promptTokenCount != null) {
      const used = e.usageMetadata.promptTokenCount;
      const size = getQwenContextWindowSize(e.model ?? "");
      return used > 0 && size ? { used, size } : null;
    }
    return null;
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
    sessionId?: string
  ): Promise<string | null> {
    try {
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
            onRetry: (attempt, max, delay) => {
              if (attempt > 1) {
                Log.debug(
                  `[QwenLogParser] Session log not ready (attempt ${attempt}/${max}), retrying in ${delay}ms...`
                );
              }
            },
          }
        );

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
            ...QwenToolBuilder.buildInitiatedEvents(
              part.functionCall.name,
              part.functionCall.args || {},
              part.functionCall.id,
              timestamp
            )
          );
        }
      }
    }

    if (e.type === "tool_result" && e.message?.parts) {
      for (const part of e.message.parts) {
        if (part.functionResponse) {
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
   * - Example: `/home/user/dev/FlightPath` → `-home-user-dev-flightpath`
   * - Windows: `C:\dev\FlightPath` → `c--dev-flightpath`
   */
  private getQwenProjectDirectory(): string | null {
    // Use stored workspaceRoot (set by CliIntegration) or fall back to process.cwd()
    const workspacePath = this.workspaceRoot || process.cwd();

    if (!workspacePath) {
      return null;
    }

    // Sanitize workspace path for Qwen's naming convention.
    // All path separators (/ \ :) become dashes; other non-alphanumeric chars are stripped.
    // Example: /home/user/dev/FlightPath → -home-user-dev-flightpath
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
