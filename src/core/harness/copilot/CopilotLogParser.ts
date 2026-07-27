import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { BaseLogParser } from "../shared/BaseLogParser";
import {
  BaseCliEvent,
  UserEventClassification,
} from "../shared/interfaces/ILogParser";
import { CopilotToolBuilder } from "./CopilotToolBuilder";
import { Log } from "../../../utils/Log";
import { retryWithBackoff } from "../../../utils/RetryUtils";
import { getCopilotContextWindowSize } from "../../../utils/ModelConstants";
import {
  UniversalCliOutput,
  ThinkingBlock,
  CliEvent,
  TextData,
  ToolResultData,
} from "../../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  HARNESS_IDS,
} from "../../../types/DashboardConstants";
import { BackgroundFollowUpState } from "../shared/BackgroundFollowUpState";

// ============================================================================
// Copilot Log Event Type Definitions
// ============================================================================

// ============================================================================
// CopilotLogParser Implementation
// ============================================================================

/**
 * Copilot CLI log parser
 *
 * Parses Copilot CLI session logs to extract responses, session IDs, and
 * detect completion. Supports both old (pre-v0.0.384) and new (v0.0.384+)
 * log formats.
 *
 * @remarks
 * **Log Location:** `~/.copilot/session-state/`
 *
 * **Format Evolution:**
 * - **Old format (pre-v0.0.384):** `<session-id>.jsonl` (flat file)
 * - **New format (v0.0.384+):** `<session-id>/events.jsonl` (subdirectory)
 *
 * **Supported Event Types (9 types per COPILOT_LOG_SCHEMA.md):**
 * - `session.start` - Session initialization (sessionId, copilotVersion, selectedModel)
 * - `session.info` - Informational messages (authentication, MCP connections)
 * - `session.error` - Session-level errors (model call failures, API errors)
 * - `user.message` - User prompt with file attachments
 * - `assistant.turn_start` - Turn begins (sequential turnId)
 * - `assistant.message` - Response content and tool requests
 * - `assistant.reasoning` - Chain-of-thought reasoning blocks
 * - `tool.execution_start` - Tool call initiated (toolCallId, toolName, arguments)
 * - `tool.execution_complete` - Tool call finished (toolCallId, success, result)
 * - `assistant.turn_end` - Turn completes (fires after EACH tool, not at final completion!)
 *
 * **Completion Detection:**
 * - **IMPORTANT:** `assistant.turn_end` fires after EACH tool call, not at final completion
 * - Interactive mode: Use sessionEnd hook (CopilotNotificationMonitor)
 * - Headless mode: Process exit signals completion
 *
 * @example
 * ```typescript
 * const parser = new CopilotLogParser();
 * const logPath = await parser.discoverSessionLog("Analyze this code", new Date());
 * if (logPath) {
 *   const events = await parser.readNewLines(logPath);
 *   const response = parser.extractResponse(events);
 *   const sessionId = parser.extractSessionId(events);
 * }
 * ```
 *
 * @see docs/schemas/COPILOT_LOG_SCHEMA.md for complete event type documentation
 */

/**
 * Provider-specific event type for internal loop bodies.
 *
 * Extends BaseCliEvent with a typed `data` property for Copilot's nested event structure.
 * This avoids `as any[]` casts while preserving flexible access to provider-specific data fields.
 * Top-level fields (`type`, `timestamp`) remain properly typed from BaseCliEvent.
 */
interface CopilotProviderEvent extends BaseCliEvent {
  data?: Record<string, any>;
}

type CopilotPendingTool = {
  toolName: string;
  args: Record<string, unknown> | string;
  timestamp: number;
};

export class CopilotLogParser extends BaseLogParser {
  /**
   * Event buffer for multi-event responses
   *
   * Copilot may send multiple assistant.message events for a single response.
   */

  /** Tracks in-flight tool calls across streaming events for extractStructuredEventsFromEvent. */
  private pendingStreamingTools = new Map<string, CopilotPendingTool>();

  // ========================================================================
  // OpenTelemetry Context Window Tracking
  // ========================================================================
  //
  // Copilot CLI 1.0.x removed every per-turn context signal from events.jsonl and
  // process-*.log (see extractResponse()/extractContextFromProcessLog() comments).
  // The only remaining live signal is Copilot's built-in OpenTelemetry file exporter
  // (`copilot help monitoring`): setting COPILOT_OTEL_ENABLED + COPILOT_OTEL_FILE_EXPORTER_PATH
  // makes Copilot write one JSON line per span/metric to that file, incrementally, DURING
  // execution (confirmed empirically — lines appear mid-run, not just at process exit).
  // Each `chat <model>` span carries `gen_ai.usage.input_tokens` / `.output_tokens` attributes
  // directly (no histogram math needed) — `input_tokens` is the full context size resent on
  // that turn, i.e. exactly what session.truncation/session.shutdown used to report.
  //
  // This uses its own byte-offset tracker (separate from `lastReadPosition`, which
  // BaseLogParser dedicates to the harness's main events.jsonl) because both files are
  // tailed concurrently during the same monitoring session.

  /** Byte offset into the OTel export file, independent of the main log's lastReadPosition. */
  private otelReadPosition = 0;
  /** Path set by CopilotCliProvider once it generates a per-invocation OTel export path. */
  private otelFilePath: string | undefined;
  /** Most recent chat span's input token count (= current context window usage). */
  private otelLastInputTokens = 0;
  /** Running total of output tokens across all chat spans seen this invocation. */
  private otelCumulativeOutputTokens = 0;
  /** Model reported by the most recent chat span, used to size the context window. */
  private otelLastModel: string | undefined;

  /**
   * Register (or clear) the OTel export file for this invocation.
   * Resets all OTel tracking state — must be called once per invocation, even when
   * no path is available, so a previous invocation's state never leaks into this one
   * (the parser instance is reused across prompts by CopilotCliProvider).
   */
  setOtelFilePath(filePath: string | undefined): void {
    this.otelFilePath = filePath;
    this.otelReadPosition = 0;
    this.otelLastInputTokens = 0;
    this.otelCumulativeOutputTokens = 0;
    this.otelLastModel = undefined;
  }

  /** Read new lines from the OTel export file using its own dedicated offset tracker. */
  private async readNewOtelLines(): Promise<Record<string, any>[]> {
    if (!this.otelFilePath || !fs.existsSync(this.otelFilePath)) {
      return [];
    }

    const stats = fs.statSync(this.otelFilePath);
    const currentSize = stats.size;
    if (currentSize < this.otelReadPosition) {
      this.otelReadPosition = 0; // file truncated/rotated
    }
    if (currentSize === this.otelReadPosition) {
      return [];
    }

    const buffer = Buffer.alloc(currentSize - this.otelReadPosition);
    const fd = fs.openSync(this.otelFilePath, "r");
    try {
      fs.readSync(fd, buffer, 0, buffer.length, this.otelReadPosition);
    } finally {
      fs.closeSync(fd);
    }
    this.otelReadPosition = currentSize;

    const entries: Record<string, any>[] = [];
    for (const line of buffer.toString("utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        // Skip malformed lines (partial write mid-flush)
      }
    }
    return entries;
  }

  /**
   * Poll the OTel export file for new `chat <model>` spans and fold them into
   * running context-window state. Call repeatedly during monitoring (interactive
   * mode) for live updates, and once more at completion to catch any final spans.
   *
   * @param modelId - Fallback model when a span doesn't report its own model
   * @returns The latest context-window reading if any new chat span arrived, else null
   */
  async pollOtelContextWindow(
    modelId: string
  ): Promise<{ used: number; size: number } | null> {
    if (!this.otelFilePath) {
      return null;
    }

    const lines = await this.readNewOtelLines();
    let updated = false;

    for (const line of lines) {
      if (
        line.type === "span" &&
        typeof line.name === "string" &&
        line.name.startsWith("chat ") &&
        line.attributes
      ) {
        const input = line.attributes["gen_ai.usage.input_tokens"];
        const output = line.attributes["gen_ai.usage.output_tokens"];
        if (typeof input === "number") {
          this.otelLastInputTokens = input;
          updated = true;
        }
        if (typeof output === "number") {
          this.otelCumulativeOutputTokens += output;
        }
        this.otelLastModel =
          line.attributes["gen_ai.response.model"] ??
          line.attributes["gen_ai.request.model"] ??
          this.otelLastModel;
      }
    }

    if (!updated) {
      return null;
    }
    return {
      used: this.otelLastInputTokens,
      size: getCopilotContextWindowSize(this.otelLastModel ?? modelId),
    };
  }

  /**
   * Final OTel-derived usage snapshot for this invocation, after all chat spans
   * have been observed via pollOtelContextWindow(). Returns null if no chat span
   * was ever seen (OTel unavailable, or the CLI made no model calls this turn).
   */
  getFinalOtelUsage(): {
    inputTokens: number;
    outputTokens: number;
    contextWindowUsedTokens: number;
    contextWindowSize: number;
  } | null {
    if (this.otelLastInputTokens <= 0) {
      return null;
    }
    return {
      inputTokens: this.otelLastInputTokens,
      outputTokens: this.otelCumulativeOutputTokens,
      contextWindowUsedTokens: this.otelLastInputTokens,
      contextWindowSize: getCopilotContextWindowSize(
        this.otelLastModel ?? this.resolvedModel
      ),
    };
  }

  /**
   * Extract complete response from Copilot log events
   *
   * Combines multiple assistant.message events into a single response object.
   * Extracts tool requests, tool results, thinking blocks, metadata, and session information.
   *
   * @param events - Array of parsed Copilot log events
   * @returns UniversalCliOutput - Standardized response object
   *
   * @remarks
   * **Supported Event Types:**
   * - `session.start` - Session initialization (sessionId, model)
   * - `session.info` - Authentication/MCP connection info (logged, not output)
   * - `session.error` - Session errors (emitted as TEXT with error details)
   * - `assistant.message` - Response text and tool requests
   * - `assistant.reasoning` - Chain-of-thought thinking blocks
   * - `tool.execution_start` - Tool call initiation (emitted as semantic events: BASH_COMMAND, FILE_READ, etc.)
   * - `tool.execution_complete` - Tool results (emitted as TOOL_RESULT)
   *
   * **Event Structure:**
   * ```json
   * {
   *   "type": "assistant.message",
   *   "data": {
   *     "content": "Response text...",
   *     "toolRequests": [...]
   *   },
   *   "timestamp": "ISO8601"
   * }
   * ```
   */
  extractResponse(events: BaseCliEvent[]): UniversalCliOutput {
    const outputEvents: CliEvent[] = [];
    let sessionId: string | undefined;
    let model: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    // Context window usage: pre-1.0 Copilot CLI fired session.truncation every turn as a
    // pre-call snapshot (postTruncationTokensInMessages + tokenLimit). Versions 1.0.x+ removed
    // that event entirely — the only remaining source is session.shutdown's currentTokens,
    // which fires once at process exit and carries no tokenLimit, so the model's known
    // context window size is used instead (see getCopilotContextWindowSize fallback below).
    let contextWindowUsedTokens = 0;
    let contextWindowSize: number | undefined;

    // Track pending tool calls to associate execution_start with execution_complete
    const pendingTools = new Map<string, CopilotPendingTool>();

    for (const event of events as CopilotProviderEvent[]) {
      const timestamp = event.timestamp
        ? new Date(event.timestamp).getTime()
        : Date.now();

      // Extract session metadata from session.start event
      if (event.type === "session.start" && event.data) {
        sessionId = event.data.sessionId;
        model = event.data.selectedModel;
      }

      // Headless stdout carries the session identity in its final result event
      // instead of the session.start event used by events.jsonl.
      if (event.type === "result") {
        if (typeof event.sessionId === "string") {
          sessionId = event.sessionId;
        }
        if (typeof event.model === "string") {
          model = event.model;
        }
      }

      // Handle session.info events (log for debugging, not emitted as output)
      if (event.type === "session.info" && event.data) {
        if (event.data.infoType === "authentication") {
          Log.debug(`[CopilotLogParser] ${event.data.message}`);
        }
        if (event.data.infoType === "mcp") {
          Log.debug(`[CopilotLogParser] MCP: ${event.data.message}`);
        }
      }

      // session.truncation fires every turn as a pre-call context snapshot (not just during actual truncation).
      // postTruncationTokensInMessages = tokens actually sent to the model this turn (grows each turn).
      // Always take the latest value — use it to track context window fill across the session.
      if (event.type === "session.truncation" && event.data) {
        contextWindowUsedTokens =
          event.data.postTruncationTokensInMessages || 0;
        contextWindowSize = event.data.tokenLimit;

        // Also surface it as a visible event when messages were actually dropped
        const removed = event.data.tokensRemovedDuringTruncation;
        if (removed > 0) {
          const post = event.data.postTruncationTokensInMessages;
          const limit = event.data.tokenLimit;
          outputEvents.push({
            type: CLI_EVENT_TYPES.TEXT,
            timestamp,
            data: {
              text: `[Context truncated: ${removed.toLocaleString()} tokens removed, ${post.toLocaleString()}/${limit.toLocaleString()} tokens remaining]`,
            } as TextData,
          });
        }
      }

      // session.shutdown fires once at process exit (Copilot CLI 1.0.x+). It's the only
      // context window source left in current log versions — currentTokens reflects the
      // total context in use (system + conversation + tool definitions) at session end.
      if (event.type === "session.shutdown" && event.data) {
        if (typeof event.data.currentTokens === "number") {
          contextWindowUsedTokens = event.data.currentTokens;
        }
      }

      // Handle session.error events (emit as error text)
      if (event.type === "session.error" && event.data) {
        const errorCode = event.data.errorType || "UNKNOWN";
        const errorMessage = event.data.message || "Unknown error";
        outputEvents.push({
          type: CLI_EVENT_TYPES.TEXT,
          timestamp,
          data: {
            text: `Error [${errorCode}]: ${errorMessage}`,
          } as TextData,
        });
      }

      // Extract text content from assistant messages
      if (event.type === "assistant.message" && event.data) {
        // Extract inline reasoning (new format: reasoningText embedded in assistant.message)
        // Newer Copilot versions embed reasoning here instead of a separate assistant.reasoning event.
        // Reasoning always appears before the message in the TUI, so emit THINKING first.
        if (event.data.reasoningText) {
          outputEvents.push({
            type: CLI_EVENT_TYPES.THINKING,
            timestamp,
            data: {
              text: event.data.reasoningText,
              label: "Reasoning",
              timestamp,
            } as ThinkingBlock,
          });
        }

        if (event.data.content) {
          outputEvents.push({
            type: CLI_EVENT_TYPES.TEXT,
            timestamp,
            data: {
              text: event.data.content,
            } as TextData,
          });
        }

        // Extract output token count (available in newer Copilot log format)
        if (typeof event.data.outputTokens === "number") {
          outputTokens += event.data.outputTokens;
        }

        // Note: tool calls are extracted from tool.execution_start (not toolRequests)
        // because tool.execution_start provides more accurate timestamps and allows
        // us to add structuredPatch from tool.execution_complete
      }

      // Extract thinking/reasoning blocks (old format: separate assistant.reasoning event)
      if (event.type === "assistant.reasoning" && event.data?.content) {
        outputEvents.push({
          type: CLI_EVENT_TYPES.THINKING,
          timestamp,
          data: {
            text: event.data.content,
            label: "Reasoning",
            timestamp,
          } as ThinkingBlock,
        });
      }

      // Store tool execution start data for later association with completion
      if (event.type === "tool.execution_start" && event.data) {
        pendingTools.set(event.data.toolCallId, {
          toolName: event.data.toolName,
          args: event.data.arguments || {},
          timestamp,
        });

        // Emit semantic events for all tools immediately (for real-time feedback)
        outputEvents.push(
          ...CopilotToolBuilder.buildInitiatedEvents(
            event.data.toolName,
            event.data.arguments || {},
            event.data.toolCallId,
            timestamp
          )
        );
      }

      // Emit COMPLETED events for all tool types from tool.execution_complete
      if (event.type === "tool.execution_complete" && event.data) {
        const pendingTool = pendingTools.get(event.data.toolCallId);

        if (pendingTool) {
          outputEvents.push(
            ...CopilotToolBuilder.buildCompletedEvents(
              pendingTool.toolName,
              pendingTool.args,
              event.data
            )
          );
          pendingTools.delete(event.data.toolCallId);
        }

        // Always emit TOOL_RESULT
        const toolResultRaw = event.data.result?.content;
        const toolResultStr =
          typeof toolResultRaw === "string"
            ? toolResultRaw
            : toolResultRaw
              ? JSON.stringify(toolResultRaw)
              : undefined;
        outputEvents.push({
          type: CLI_EVENT_TYPES.TOOL_RESULT,
          timestamp,
          data: {
            toolCallId: event.data.toolCallId,
            result: {
              success: event.data.success,
              output: toolResultStr,
              error: event.data.success ? undefined : toolResultStr,
            },
          } as ToolResultData,
        });
      }
    }

    // Prefer context window data from session.truncation (fires every turn, most accurate source).
    // Fall back to metadata.usage accumulation (not seen in practice, kept as safety net).
    const effectiveInputTokens =
      contextWindowUsedTokens > 0 ? contextWindowUsedTokens : inputTokens;
    const effectiveContextWindowSize =
      contextWindowSize ??
      getCopilotContextWindowSize(model ?? this.resolvedModel);

    return {
      events: outputEvents,
      metadata: {
        sessionId,
        model: (model ?? this.resolvedModel) || undefined,
        harness: HARNESS_IDS.COPILOT_CLI,
        usage:
          effectiveInputTokens > 0 || outputTokens > 0
            ? {
                inputTokens: effectiveInputTokens,
                outputTokens,
                totalTokens: effectiveInputTokens + outputTokens,
                // postTruncationTokensInMessages = full context sent to model on last turn
                contextWindowUsedTokens: effectiveInputTokens,
                contextWindowSize: effectiveContextWindowSize,
              }
            : undefined,
      },
    };
  }

  /**
   * Check if log event indicates completion
   *
   * **CRITICAL: Copilot's `assistant.turn_end` fires after EACH tool call, not at final completion!**
   *
   * This makes log-based completion detection fundamentally unreliable for Copilot CLI.
   *
   * **Event Sequence for Multi-Tool Response:**
   * ```
   * assistant.message (with toolRequests: [tool1])
   * tool.execution_start (tool 1)
   * tool.execution_complete (tool 1)
   * assistant.turn_end (turn 0) ← FIRES HERE but NOT done!
   * assistant.message (with toolRequests: [tool2])
   * tool.execution_start (tool 2)
   * tool.execution_complete (tool 2)
   * assistant.turn_end (turn 1) ← FIRES AGAIN
   * ... continues until no more tools needed
   * ```
   *
   * **Reliable Completion Detection:**
   * - **Interactive mode**: sessionEnd hook (via CopilotNotificationMonitor)
   * - **Headless mode**: Process exit
   *
   * @param _event - Single parsed log event (unused - always returns false)
   * @returns Always false - Use sessionEnd hook for reliable completion detection
   *
   * @see CopilotNotificationMonitor for interactive mode completion
   * @see CopilotCliProvider.executePrompt for headless mode completion
   */
  isComplete(_event: BaseCliEvent): boolean {
    // NEVER detect completion from log files for Copilot - use hooks instead!
    // Reason: assistant.turn_end fires after EACH tool call, not at final completion.
    //
    // For reliable completion detection:
    // - Interactive mode: sessionEnd hook configured in CopilotCliProvider
    // - Headless mode: Process exit signals completion
    return false;
  }

  override extractLiveContextWindow(
    event: BaseCliEvent,
    modelId: string
  ): { used: number; size: number } | null {
    if (event.type === "session.truncation") {
      const data = (event as any).data;
      const used = data?.postTruncationTokensInMessages;
      const size = data?.tokenLimit ?? getCopilotContextWindowSize(modelId);
      return used != null && used > 0 ? { used, size } : null;
    }
    // Copilot CLI 1.0.x+ dropped session.truncation; session.shutdown's currentTokens
    // is the only remaining live signal, and it only arrives once at process exit.
    if (event.type === "session.shutdown") {
      const data = (event as any).data;
      const used = data?.currentTokens;
      return used != null && used > 0
        ? { used, size: getCopilotContextWindowSize(modelId) }
        : null;
    }
    return null;
  }

  /**
   * shellId → still-pending async shells launched via `tool.execution_complete`
   * with `data.toolTelemetry.properties.executionMode === "async"`. Cleared by
   * a matching `system.notification` with `data.kind.type ===
   * "shell_completed" | "shell_failed"`. Unlike Claude, "any pending shellId"
   * is safe here — every terminating command emits a completion notification,
   * so there is no superseded/"zombie" case to guard against (see
   * `dev/implemented/TERMINAL_FOLLOWUP_TRACKING_PLAN.md`, "Copilot CLI").
   */
  /** Background follow-up state; Copilot's provider-specific signals feed it below. */
  private readonly backgroundFollowUpState = new BackgroundFollowUpState({
    staleStopGuardChecks: 2,
  });

  /** Set after a matching notification until the resumed turn starts. */
  private resumedTurnStarted = false;

  override trackBackgroundWorkState(event: BaseCliEvent): void {
    const e = event as CopilotProviderEvent;

    // Parser instances may be reused across prompts. A new session.start is
    // the explicit provider lifecycle boundary; resumed sessions do not emit
    // another one while appending to the same events.jsonl.
    if (e.type === "session.start") {
      this.backgroundFollowUpState.reset();
      this.resumedTurnStarted = false;
      return;
    }

    if (e.type === "tool.execution_complete" && e.data) {
      const executionMode = e.data.toolTelemetry?.properties?.executionMode;
      if (executionMode === "async") {
        const shellId = this.extractShellId(e.data.result?.content);
        if (shellId) {
          this.backgroundFollowUpState.launch(shellId);
        }
      }
      return;
    }

    if (e.type === "system.notification" && e.data?.kind) {
      const kind = e.data.kind;
      if (
        (kind.type === "shell_completed" || kind.type === "shell_failed") &&
        kind.shellId !== undefined
      ) {
        const shellId = String(kind.shellId);
        if (this.backgroundFollowUpState.consumeNotification(shellId)) {
          this.resumedTurnStarted = false;
        }
      }
      return;
    }

    if (e.type === "assistant.turn_start") {
      if (this.backgroundFollowUpState.isResumedTurnPending()) {
        this.resumedTurnStarted = true;
      }
      return;
    }

    if (
      e.type === "assistant.turn_end" &&
      this.backgroundFollowUpState.isResumedTurnPending() &&
      this.resumedTurnStarted
    ) {
      this.backgroundFollowUpState.resumedTurnClosed();
      this.resumedTurnStarted = false;
    }
  }

  override hasPendingBackgroundWork(): boolean {
    return this.backgroundFollowUpState.isCompletionBlocked();
  }

  /**
   * Classify a `user.message` log event. Unlike Claude, Copilot never reuses
   * this event type for tool results or resume signals (those are
   * `tool.execution_complete` and `system.notification` respectively — see
   * `hasPendingBackgroundWork`), so the only two possibilities are ctrlyoke's
   * own injected prompt echoed back, or genuine text typed into the live TUI.
   */
  override classifyUserEvent(
    event: BaseCliEvent,
    ctx: { dispatchedPromptText?: string }
  ): UserEventClassification {
    const e = event as CopilotProviderEvent;
    if (e.type !== "user.message") {
      return "other";
    }

    const text =
      typeof e.data?.content === "string" ? e.data.content.trim() : "";
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
      // Copilot may append file-attachment metadata after the prompt text, so
      // match by prefix containment rather than exact equality (mirrors
      // discoverSessionLog's own matching strategy above).
      if (normalizedLogged.includes(normalizedDispatched)) {
        return "injected-prompt";
      }
    }

    return "human-steer";
  }

  override extractUserSteerText(event: BaseCliEvent): string | undefined {
    const e = event as CopilotProviderEvent;
    if (e.type !== "user.message") {
      return undefined;
    }
    const text =
      typeof e.data?.content === "string" ? e.data.content.trim() : "";
    return text || undefined;
  }

  /** Extracts the shellId from a launch ack like `"<command started in background with shellId: 0>"`. */
  private extractShellId(content: unknown): string | undefined {
    if (typeof content !== "string") {
      return undefined;
    }
    const match = content.match(/shellId:\s*(\S+?)>/);
    return match ? match[1] : undefined;
  }

  /**
   * Discover session log file for a prompt
   *
   * Searches `~/.copilot/session-state/` for the log file corresponding to
   * a specific prompt execution. Uses session ID (if provided) or prompt text matching.
   *
   * @param promptText - The prompt text sent to Copilot CLI (not used when sessionId provided)
   * @param startTime - Execution start timestamp
   * @param sessionId - Optional session ID for direct path construction (bypasses prompt matching)
   * @returns Absolute path to session log file, or null if not found
   *
   * @remarks
   * **Discovery Algorithm:**
   * 1. If sessionId provided: Construct path directly (`~/.copilot/session-state/{sessionId}/events.jsonl`)
   * 2. Otherwise: Find `~/.copilot/session-state/` directory
   * 3. Use inherited `findModifiedSessionLogs()` to get recently modified files/dirs
   * 4. For each candidate, resolve to actual log path using `getLogPath()`
   * 5. Read first 10 events from each log
   * 6. Look for user.message event containing prompt text (first 100 chars)
   * 7. Return first matching log file path
   *
   * **Prompt Matching:**
   * - Uses first 100 chars of prompt for fuzzy matching
   * - Copilot may transform prompts (whitespace, formatting)
   * - Case-insensitive substring match
   *
   * **Format Handling:**
   * - Supports both old (`.jsonl`) and new (`/events.jsonl`) formats
   * - `getLogPath()` handles format detection automatically
   */
  async discoverSessionLog(
    promptText: string,
    startTime: Date,
    sessionId?: string
  ): Promise<string | null> {
    try {
      const logDir = path.join(os.homedir(), ".copilot", "session-state");
      if (!fs.existsSync(logDir)) {
        Log.debug("[CopilotLogParser] Session state directory not found");
        return null;
      }

      // If session ID provided, construct path directly (resumed sessions)
      if (sessionId) {
        Log.debug(
          `[CopilotLogParser] Using session ID ${sessionId} for direct path construction`
        );

        // Try directory format first: ~/.copilot/session-state/{sessionId}/events.jsonl
        const sessionDir = path.join(logDir, sessionId);
        const eventsPath = path.join(sessionDir, "events.jsonl");

        if (fs.existsSync(eventsPath)) {
          Log.debug(
            `[CopilotLogParser] Found session log at ${eventsPath} (directory format)`
          );
          return eventsPath;
        }

        // Try flat file format: ~/.copilot/session-state/{sessionId}.jsonl
        const flatPath = path.join(logDir, `${sessionId}.jsonl`);
        if (fs.existsSync(flatPath)) {
          Log.debug(
            `[CopilotLogParser] Found session log at ${flatPath} (flat file format)`
          );
          return flatPath;
        }

        // Session ID provided but file not found - fall back to prompt-text matching
        // This handles: bad session ID from user, logs cleaned up, or format change
        Log.warn(
          `[CopilotLogParser] Session ${sessionId} not found in either format. Tried:\n` +
            `  - ${eventsPath}\n` +
            `  - ${flatPath}\n` +
            `  Falling back to prompt-text matching.`
        );
        // Fall through to prompt-text matching below
      }

      // Prepare prompt matcher (first 100 chars, normalized)
      // Normalize for path escaping: Copilot may double backslashes in file paths
      const promptPrefix = this.normalizePromptForMatching(
        promptText.slice(0, 100)
      );

      // Retry with backoff: Copilot may take a moment to create the log file after SessionStart hook
      const result = await retryWithBackoff(
        async () => {
          // Get recently modified files/directories
          const candidates = this.findModifiedSessionLogs(logDir, startTime);
          if (candidates.length === 0) {
            return null; // Will retry
          }

          // Check each candidate
          for (const candidate of candidates) {
            try {
              // Resolve to actual log file path
              const logPath = await this.resolveLogPath(candidate);
              if (!logPath) {
                continue;
              }

              // Read first 10 events
              const events = await this.readFirstNJsonlEvents(logPath, 10);

              // Look for user.message event containing prompt text
              for (const event of events as CopilotProviderEvent[]) {
                if (event.type === "user.message" && event.data?.content) {
                  const content = this.normalizePromptForMatching(
                    event.data.content
                  );
                  if (content.includes(promptPrefix)) {
                    return logPath; // Success - found matching log
                  }
                }
              }
            } catch (error) {
              // Skip candidates that can't be read
              Log.debug(
                `[CopilotLogParser] Error reading candidate ${candidate}:`,
                error
              );
              continue;
            }
          }

          return null; // No match found, will retry
        },
        {
          // Uses default: 10s
          onRetry: (attempt, max, delay) => {
            if (attempt > 1) {
              Log.debug(
                `[CopilotLogParser] Session log file not found (attempt ${attempt}/${max}), retrying in ${delay}ms...`
              );
            }
          },
        }
      );

      if (result) {
        Log.debug(`[CopilotLogParser] Found matching session log: ${result}`);
        return result;
      }

      Log.debug("[CopilotLogParser] No matching session log found");
      return null;
    } catch (error) {
      Log.warn("[CopilotLogParser] Error discovering session log:", error);
      return null;
    }
  }

  /**
   * Extract session ID from log events
   *
   * Searches for session.start event containing session ID.
   *
   * @param events - Array of parsed log events
   * @returns Session ID (UUID v4), or null if not found
   *
   * @remarks
   * **Session ID Format:** UUID v4 (e.g., `6e2ec013-11bd-4862-ab32-c5b4d5a71131`)
   *
   * **Extraction Logic:**
   * - Find first `session.start` event
   * - Return `event.data.sessionId`
   * - Returns null if no session.start event found
   */
  extractSessionId(events: BaseCliEvent[]): string | null {
    for (const event of events as CopilotProviderEvent[]) {
      if (event.type === "session.start" && event.data?.sessionId) {
        return event.data.sessionId;
      }
    }
    return null;
  }

  /**
   * Extract text content from a single Copilot log event for streaming
   *
   * Used during real-time log monitoring to extract displayable content
   * as events are written to the log file.
   *
   * @deprecated Superseded by `extractStructuredEventsFromEvent` in the streaming path,
   * which emits typed CliEvents (TEXT, THINKING, BASH_COMMAND, TOOL_RESULT, etc.) instead of
   * plain strings. This method is retained only for the BaseLogParser default fallback.
   *
   * @param event - Single parsed Copilot log event
   * @returns Text content to display, or undefined if no displayable content
   *
   * @remarks
   * **Supported Event Types:**
   * - `assistant.message` - Response text content
   * - `assistant.reasoning` - Chain-of-thought reasoning (prefixed with [Reasoning])
   * - `tool.execution_complete` - Tool execution result
   * - `session.error` - Error messages
   *
   * **Event Formats:**
   * ```json
   * { "type": "assistant.message", "data": { "content": "..." } }
   * { "type": "assistant.reasoning", "data": { "content": "..." } }
   * { "type": "tool.execution_complete", "data": { "result": { "content": "..." } } }
   * { "type": "session.error", "data": { "message": "..." } }
   * ```
   */
  extractContentFromEvent(event: BaseCliEvent): string | undefined {
    // Provider-specific nested property access
    const data = event.data as Record<string, any> | undefined;

    // Assistant message content (primary response text)
    if (event.type === "assistant.message" && data?.content) {
      return data.content;
    }

    // Inline reasoning (new format: reasoningText in assistant.message)
    // Streaming this gives users visible progress while Copilot thinks
    if (event.type === "assistant.message" && data?.reasoningText) {
      return `[Thinking] ${data.reasoningText}`;
    }

    // Assistant reasoning content (old format: separate assistant.reasoning event)
    if (event.type === "assistant.reasoning" && data?.content) {
      return `[Reasoning] ${data.content}`;
    }

    // NOTE: tool.execution_complete results are intentionally NOT streamed here.
    // Emitting raw tool result content (file contents, command output, etc.) as
    // plain text chunks produces garbled output — no ⎿ prefix, no structure, all
    // concatenated together. Tool results are properly rendered via extractResponse()
    // which builds typed CliEvents (BASH_COMMAND, FILE_READ, TOOL_RESULT, etc.)
    // at completion. During streaming, only assistant text/reasoning is surfaced.

    // Session error content
    if (event.type === "session.error" && data) {
      const errorCode = data.errorType || "UNKNOWN";
      const errorMessage = data.message || "Unknown error";
      return `Error [${errorCode}]: ${errorMessage}`;
    }

    return undefined;
  }

  /**
   * Extract structured CliEvents from a single Copilot log event for streaming.
   *
   * Full override of the BaseLogParser default. Produces typed CliEvents
   * (TEXT, THINKING, BASH_COMMAND, FILE_READ, FILE_WRITE, FILE_EDIT, TOOL_RESULT, etc.)
   * identical to the events emitted by `extractResponse()` — but processed one event at
   * a time. Uses `pendingStreamingTools` (instance state) to carry tool call context
   * across consecutive event calls, mirroring the local `pendingTools` map in
   * `extractResponse()`.
   *
   * @param event - Single parsed Copilot log event
   * @returns Array of CliEvents to emit; empty if the event produces no streamable output
   */
  override extractStructuredEventsFromEvent(event: BaseCliEvent): CliEvent[] {
    const ev = event as CopilotProviderEvent;
    const timestamp = ev.timestamp
      ? new Date(ev.timestamp as string | number).getTime()
      : Date.now();
    const data = ev.data;
    const results: CliEvent[] = [];

    if (!data) {
      return results;
    }

    // assistant.message: text content and inline reasoning (new format)
    if (ev.type === "assistant.message") {
      // Reasoning always appears before the message in the TUI, so emit THINKING first.
      if (data.reasoningText) {
        results.push({
          type: CLI_EVENT_TYPES.THINKING,
          timestamp,
          data: {
            text: data.reasoningText,
            label: "Reasoning",
            timestamp,
          } as ThinkingBlock,
        });
      }
      if (data.content) {
        results.push({
          type: CLI_EVENT_TYPES.TEXT,
          timestamp,
          data: { text: data.content } as TextData,
        });
      }
      return results;
    }

    // assistant.reasoning: old-format chain-of-thought (separate event)
    if (ev.type === "assistant.reasoning" && data.content) {
      results.push({
        type: CLI_EVENT_TYPES.THINKING,
        timestamp,
        data: {
          text: data.content,
          label: "Reasoning",
          timestamp,
        } as ThinkingBlock,
      });
      return results;
    }

    // session.error: surface as TEXT
    if (ev.type === "session.error") {
      const errorCode = data.errorType || "UNKNOWN";
      const errorMessage = data.message || "Unknown error";
      results.push({
        type: CLI_EVENT_TYPES.TEXT,
        timestamp,
        data: { text: `Error [${errorCode}]: ${errorMessage}` } as TextData,
      });
      return results;
    }

    // tool.execution_start: store pending state AND emit the semantic initiated event
    if (ev.type === "tool.execution_start") {
      this.pendingStreamingTools.set(data.toolCallId, {
        toolName: data.toolName,
        args: data.arguments || {},
        timestamp,
      });
      results.push(
        ...CopilotToolBuilder.buildInitiatedEvents(
          data.toolName,
          data.arguments || {},
          data.toolCallId,
          timestamp
        )
      );
      return results;
    }

    // tool.execution_complete: emit completed events + TOOL_RESULT, then clean up
    if (ev.type === "tool.execution_complete") {
      const pending = this.pendingStreamingTools.get(data.toolCallId);
      if (pending) {
        results.push(
          ...CopilotToolBuilder.buildCompletedEvents(
            pending.toolName,
            pending.args,
            data
          )
        );
        this.pendingStreamingTools.delete(data.toolCallId);
      }

      const toolResultRaw = data.result?.content;
      const toolResultStr =
        typeof toolResultRaw === "string"
          ? toolResultRaw
          : toolResultRaw
            ? JSON.stringify(toolResultRaw)
            : undefined;
      results.push({
        type: CLI_EVENT_TYPES.TOOL_RESULT,
        timestamp,
        data: {
          toolCallId: data.toolCallId,
          result: {
            success: data.success,
            output: toolResultStr,
            error: data.success ? undefined : toolResultStr,
          },
        } as ToolResultData,
      });
      return results;
    }

    return results;
  }

  /**
   * Format Copilot metadata into statistics string for display
   *
   * Creates a human-readable summary of session metadata including
   * session ID, model name, and token usage statistics.
   *
   * @param metadata - Metadata from extractResponse() (sessionId, model, usage)
   * @returns Formatted statistics string with pipe-separated values
   *
   * @example
   * ```typescript
   * const metadata = {
   *   sessionId: "6e2ec013-11bd-4862-ab32-c5b4d5a71131",
   *   model: "gpt-5-mini",
   *   usage: { inputTokens: 1500, outputTokens: 500 }
   * };
   * const stats = parser.formatStatistics(metadata);
   * // "Session: 6e2ec013... | Model: gpt-5-mini | Tokens: 1500 in / 500 out"
   * ```
   */
  formatStatistics(metadata: BaseCliEvent): string {
    return this.buildCommonStatisticsParts(metadata, 8, "...").join(" | ");
  }

  /**
   * Get log file path for a session ID
   *
   * Resolves session ID to actual log file path, handling both old and new formats.
   *
   * @param sessionId - Session ID (UUID v4)
   * @returns Absolute path to log file, or null if not found
   *
   * @remarks
   * **Format Detection:**
   * 1. Try new format first: `~/.copilot/session-state/<session-id>/events.jsonl`
   * 2. Fall back to old format: `~/.copilot/session-state/<session-id>.jsonl`
   * 3. Return null if neither exists
   *
   * **Example Paths:**
   * - New: `/home/user/.copilot/session-state/abc-123/events.jsonl`
   * - Old: `/home/user/.copilot/session-state/abc-123.jsonl`
   */
  static async getLogPath(sessionId: string): Promise<string | null> {
    const logDir = path.join(os.homedir(), ".copilot", "session-state");

    // Try new format first (v0.0.384+)
    const newFormatPath = path.join(logDir, sessionId, "events.jsonl");
    if (fs.existsSync(newFormatPath)) {
      return newFormatPath;
    }

    // Fall back to old format (pre-v0.0.384)
    const oldFormatPath = path.join(logDir, `${sessionId}.jsonl`);
    if (fs.existsSync(oldFormatPath)) {
      return oldFormatPath;
    }

    return null;
  }

  /**
   * Extract context window data from a session log by session ID.
   *
   * Reads the last `session.truncation` event from the session log, which fired
   * once per model call turn (pre-1.0 Copilot CLI) and contains the most accurate
   * context fill data. Returns the final (highest) values from a multi-turn session.
   *
   * Copilot CLI 1.0.x+ removed `session.truncation` entirely. When no truncation
   * event is found, falls back to `session.shutdown`'s `currentTokens` — the only
   * remaining context signal, fired once at process exit with no token-limit field,
   * so `getCopilotContextWindowSize(modelId)` supplies the denominator.
   *
   * Used by CopilotCliProvider.augmentParsedOutput() to patch missing input token
   * data in JSON-mode headless output.
   *
   * @param sessionId - Session UUID from the `result` event in JSONL stdout
   * @param modelId - Selected model, used to size the fallback context window when
   *   only session.shutdown data is available (no tokenLimit field in that event)
   * @returns Truncation data if found, undefined if log unavailable or unreadable
   */
  static async extractTruncationDataFromLog(
    sessionId: string,
    modelId?: string
  ): Promise<
    { postTruncationTokensInMessages: number; tokenLimit: number } | undefined
  > {
    const logPath = await CopilotLogParser.getLogPath(sessionId);
    if (!logPath) {
      return undefined;
    }

    try {
      const content = fs.readFileSync(logPath, "utf-8");
      let last:
        | { postTruncationTokensInMessages: number; tokenLimit: number }
        | undefined;
      let shutdownTokens: number | undefined;

      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);
          if (
            event.type === "session.truncation" &&
            typeof event.data?.postTruncationTokensInMessages === "number" &&
            typeof event.data?.tokenLimit === "number"
          ) {
            last = {
              postTruncationTokensInMessages:
                event.data.postTruncationTokensInMessages,
              tokenLimit: event.data.tokenLimit,
            };
          }
          if (
            event.type === "session.shutdown" &&
            typeof event.data?.currentTokens === "number"
          ) {
            shutdownTokens = event.data.currentTokens;
          }
        } catch {
          // Skip malformed lines
        }
      }

      if (last) {
        return last;
      }
      if (shutdownTokens !== undefined) {
        return {
          postTruncationTokensInMessages: shutdownTokens,
          tokenLimit: getCopilotContextWindowSize(modelId),
        };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Extract session ID from a known log file path.
   *
   * Reads only the first event (session.start) to extract the session ID.
   * This is stateless - unlike readNewLines(), it always reads from the
   * beginning of the file, so it's safe to call regardless of prior monitoring state.
   *
   * @param logPath Absolute path to a session log file (events.jsonl or .jsonl)
   * @returns Session ID (UUID) if found, null otherwise
   *
   * @remarks
   * Used by CopilotCliProvider.extractSessionIdFromLogs() after discoverSessionLog()
   * has already identified the correct log file via prompt-text matching.
   */
  async extractSessionIdFromLogPath(logPath: string): Promise<string | null> {
    try {
      const events = await this.readFirstNJsonlEvents(logPath, 1);
      if (events.length === 0) {
        Log.debug(
          `[CopilotLogParser] No events found in ${path.basename(logPath)}`
        );
        return null;
      }

      const sessionId = this.extractSessionId(events);
      if (sessionId) {
        Log.debug(
          `[CopilotLogParser] Extracted session ID from ${path.basename(logPath)}: ${sessionId}`
        );
      }
      return sessionId;
    } catch (error) {
      Log.debug(
        `[CopilotLogParser] Error reading session ID from ${logPath}:`,
        error
      );
      return null;
    }
  }

  // ========================================================================
  // Process Log — Context Window Extraction
  // ========================================================================

  /**
   * Extract context window usage from the Copilot process log for a session.
   *
   * Copilot writes per-process log files to `~/.copilot/logs/process-*.log`.
   * Each file begins with `Workspace initialized: {sessionId}`, making session
   * matching straightforward. The `CompactionProcessor` lines report the current
   * context utilization every turn:
   *
   * ```
   * 2026-03-04T15:14:58.073Z [INFO] CompactionProcessor: Utilization 37.2% (47591/128000 tokens) below threshold 80%
   * ```
   *
   * We use the **last** such line (most recent turn) to get the final context
   * window state after the prompt completed.
   *
   * @param sessionId - Copilot session UUID (from session.start event / hook)
   * @returns Context window tokens `{ used, size }`, or undefined if unavailable
   */
  async extractContextFromProcessLog(
    sessionId: string
  ): Promise<{ used: number; size: number } | undefined> {
    try {
      const logsDir = path.join(os.homedir(), ".copilot", "logs");
      if (!fs.existsSync(logsDir)) {
        return undefined;
      }

      // Find the process-*.log file for this session
      const processLog = this.findProcessLogForSession(logsDir, sessionId);
      if (!processLog) {
        Log.debug(
          `[CopilotLogParser] No process log found for session ${sessionId}`
        );
        return undefined;
      }

      // Read file and scan for the last CompactionProcessor line
      const content = fs.readFileSync(processLog, "utf8");
      let used: number | undefined;
      let size: number | undefined;

      for (const line of content.split("\n")) {
        const match = line.match(
          /CompactionProcessor: Utilization [\d.]+% \((\d+)\/(\d+) tokens\)/
        );
        if (match) {
          used = parseInt(match[1], 10);
          size = parseInt(match[2], 10);
        }
      }

      if (used === undefined || size === undefined) {
        Log.debug(
          `[CopilotLogParser] No CompactionProcessor events in ${path.basename(processLog)}`
        );
        return undefined;
      }

      Log.debug(
        `[CopilotLogParser] Context from process log: ${used}/${size} tokens (${path.basename(processLog)})`
      );
      return { used, size };
    } catch (error) {
      Log.debug(
        `[CopilotLogParser] Failed to read process log for context: ${error}`
      );
      return undefined;
    }
  }

  /**
   * Find the process-*.log file whose first line identifies the given session.
   *
   * @param logsDir - `~/.copilot/logs/`
   * @param sessionId - Session UUID to search for
   * @returns Absolute path to the matching log file, or null
   */
  private findProcessLogForSession(
    logsDir: string,
    sessionId: string
  ): string | null {
    try {
      const files = fs
        .readdirSync(logsDir)
        .filter((f) => f.startsWith("process-") && f.endsWith(".log"));

      // Collect all matching files with their mtimes so we can return the most
      // recently modified one. Resumed sessions spawn a new process per prompt —
      // each writes its own process-*.log with the same session ID in the header.
      // Without sorting by mtime, we'd always return the first (oldest) match,
      // which never reflects context growth across resumed prompts.
      const matches: { filePath: string; mtime: number }[] = [];

      for (const file of files) {
        const filePath = path.join(logsDir, file);
        try {
          // Read the first ~1024 bytes to find the session ID.
          // "Workspace initialized: {UUID}" appears on line 4 of the file,
          // at approximately byte 310 — so 256 bytes is not enough. Using
          // 1024 provides headroom if Copilot adds more preamble lines later.
          const fd = fs.openSync(filePath, "r");
          const buf = Buffer.alloc(1024);
          const bytesRead = fs.readSync(fd, buf, 0, 1024, 0);
          fs.closeSync(fd);
          const firstChunk = buf.toString("utf8", 0, bytesRead);
          if (firstChunk.includes(`Workspace initialized: ${sessionId}`)) {
            const mtime = fs.statSync(filePath).mtimeMs;
            matches.push({ filePath, mtime });
          }
        } catch {
          continue;
        }
      }

      if (matches.length === 0) {
        return null;
      }

      // Return the most recently modified match — it contains the latest
      // CompactionProcessor lines for the current resumed prompt turn.
      matches.sort((a, b) => b.mtime - a.mtime);
      return matches[0].filePath;
    } catch {
      return null;
    }
  }

  // ========================================================================
  // Private Helper Methods
  // ========================================================================

  /**
   * Resolve log path from candidate file/directory
   *
   * Handles both flat files (old format) and directories (new format).
   *
   * @param candidate - Path to candidate file or directory
   * @returns Actual log file path, or null if invalid
   */
  private async resolveLogPath(candidate: string): Promise<string | null> {
    try {
      const stats = fs.statSync(candidate);

      // Old format: Direct file (e.g., abc-123.jsonl)
      if (stats.isFile() && candidate.endsWith(".jsonl")) {
        return candidate;
      }

      // New format: Directory containing events.jsonl
      if (stats.isDirectory()) {
        const eventsPath = path.join(candidate, "events.jsonl");
        if (fs.existsSync(eventsPath)) {
          return eventsPath;
        }
      }

      return null;
    } catch {
      return null;
    }
  }
}
