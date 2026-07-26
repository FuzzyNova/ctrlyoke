import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { BaseLogParser } from "../shared/BaseLogParser";
import {
  BaseCliEvent,
  ILogParser,
  UserEventClassification,
} from "../shared/interfaces/ILogParser";
import { Log } from "../../../utils/Log";
import { getClaudeContextWindowSize } from "../../../utils/ModelConstants";
import { retryWithBackoff } from "../../../utils/RetryUtils";
import {
  UniversalCliOutput,
  ThinkingBlock,
  CliEvent,
  TextData,
  ToolResultData,
  CompactionData,
} from "../../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  COMPACTION_TRIGGERS,
  HARNESS_IDS,
} from "../../../types/DashboardConstants";
import { ClaudeToolBuilder } from "./ClaudeToolBuilder";
import { BackgroundFollowUpState } from "../shared/BackgroundFollowUpState";

/**
 * Claude CLI Log Parser
 *
 * Parses Claude CLI log files in JSONL format from `~/.claude/projects/<workspace-path>/`.
 * Each session creates a `<session-id>.jsonl` file with streaming event entries.
 *
 * @remarks
 * **Log Format:**
 * - Location: `~/.claude/projects/<workspace-path>/`
 * - File naming: `<session-id>.jsonl` (e.g., `550e8400-e29b-41d4-a716-446655440000.jsonl`)
 * - Index file: `sessions-index.json` (metadata about all sessions)
 *
 * **Event Types (6 main types):**
 * 1. `assistant` - Claude responses with text, thinking, tool_use blocks
 * 2. `user` - User messages and tool_result blocks
 * 3. `progress` - Hook progress, bash progress, agent progress
 * 4. `system` - stop_hook_summary, turn_duration, local_command
 * 5. `file-history-snapshot` - File backup tracking
 * 6. `summary` - Session summary
 *
 * **Content Block Types (in assistant/user events):**
 * - `text` - Response text (field: `text`)
 * - `thinking` - Extended thinking (field: `thinking`, NOT `text`)
 * - `tool_use` - Tool invocation (fields: `id`, `name`, `input`)
 * - `tool_result` - Tool execution result (in user events)
 *
 * **Session Discovery:**
 * - Uses `findModifiedSessionLogs()` to get recently modified files
 * - Reads first 10 events from each candidate
 * - Matches prompt text against user event content (first 100 chars)
 * - Returns first matching log file path
 *
 * @example
 * ```typescript
 * const parser = new ClaudeLogParser();
 * const logPath = await parser.discoverSessionLog("Analyze code", new Date());
 * if (logPath) {
 *   const events = await parser.readNewLines(logPath);
 *   const response = parser.extractResponse(events);
 *   const sessionId = parser.extractSessionId(events);
 * }
 * ```
 */

/**
 * Provider-specific event type for internal loop bodies.
 *
 * Extends BaseCliEvent with typed properties for Claude's log event structure.
 * This avoids `as any[]` casts while preserving flexible access to provider-specific fields.
 * Top-level fields (`type`, `timestamp`) remain properly typed from BaseCliEvent.
 */
interface ClaudeProviderEvent extends BaseCliEvent {
  message?: Record<string, any>;
  sessionId?: string;
  subtype?: string;
  durationMs?: number;
  toolUseResult?: Record<string, any>;
  data?: Record<string, any>;
  content?: string;
  attachment?: {
    prompt?: string;
  };
}

export class ClaudeLogParser extends BaseLogParser implements ILogParser {
  /**
   * Workspace root directory — set by CliIntegration after construction.
   * Used by getClaudeProjectDirectory() to locate Claude's session log folder.
   * Falls back to process.cwd() when not set (CLI mode).
   */
  private workspaceRoot?: string;

  /** Maps tool_use id → tool name for associating streaming tool results with their calls. */
  private pendingStreamingToolUses = new Map<string, string>();

  /** Background follow-up state; Claude's provider-specific signals feed it below. */
  private readonly backgroundFollowUpState = new BackgroundFollowUpState();

  /**
   * Tool calls whose asynchronous launch must be confirmed by their result.
   * Explicit `run_in_background: true` is sufficient on its own, but Agent
   * calls without that field and Monitor calls report their async status only
   * in the correlated tool result.
   */
  private unconfirmedAsyncLaunches = new Map<string, "Agent" | "Monitor">();

  /**
   * Set the workspace root directory for session log discovery.
   * Called by CliIntegration so the log parser knows where to look.
   */
  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
  }

  /**
   * Extract complete response from Claude log events
   *
   * Processes Claude JSONL events and combines:
   * - Text content from assistant messages
   * - Tool calls (tool_use events) with normalized 'parameters' field
   * - Thinking blocks (extended thinking feature)
   * - Tool results from user events (both content and structured metadata)
   * - Metadata (session ID, usage stats including cache tokens, model info)
   *
   * @param events - Array of parsed Claude log events
   * @returns UniversalCliOutput - Standardized response object
   *
   * @remarks
   * **Event Types Processed:**
   * - `assistant` - Claude responses with content blocks
   * - `user` - Tool results (tool_result blocks + toolUseResult metadata)
   * - `progress` - Bash progress (extracted for streaming display)
   * - `system` - Turn duration (for metadata)
   *
   * **Content Block Types:**
   * - `text` - Response text (field: `text`)
   * - `thinking` - Extended thinking (field: `thinking`, NOT `text`)
   * - `tool_use` - Tool invocation (fields: `id`, `name`, `input`)
   * - `tool_result` - Tool execution result (in user events)
   *
   * **Tool Result Metadata (toolUseResult field):**
   * - Edit operations: Extracts `structuredPatch` for line-number-based diffs
   * - Edit operations: Extracts `originalFile` for full file context
   * - Edit operations: Supports both camelCase (oldString) and snake_case (old_string)
   * - Write operations: Extracts file creation metadata
   * - Read operations: Extracts file read results
   *
   * **Usage Statistics:**
   * - Standard: input_tokens, output_tokens
   * - Cache: cache_creation_input_tokens, cache_read_input_tokens
   * - Service tier: "standard" or other tier identifiers
   *
   * @example
   * ```typescript
   * const events = [
   *   { type: "assistant", message: { content: [{type: "text", text: "Hello"}] }, sessionId: "abc" },
   *   { type: "user", message: { content: [{type: "tool_result", tool_use_id: "123", content: "result"}] },
   *     toolUseResult: { oldString: "old", newString: "new", structuredPatch: [...] } },
   *   { type: "assistant", message: { stop_reason: "end_turn", usage: {...} } }
   * ];
   * const response = parser.extractResponse(events);
   * // { events: [...], metadata: { sessionId, usage: {...}, cacheTokens: {...} } }
   * ```
   */
  extractResponse(events: BaseCliEvent[]): UniversalCliOutput {
    const outputEvents: CliEvent[] = [];
    let sessionId: string | undefined;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;
    let lastAssistantUsage:
      | {
          input_tokens: number;
          output_tokens: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        }
      | undefined;
    let model: string | undefined;
    let elapsed: number | undefined;

    for (const event of events as ClaudeProviderEvent[]) {
      // Extract session ID from any event
      if (event.sessionId && !sessionId) {
        sessionId = event.sessionId;
      }

      // Get timestamp for events
      const timestamp = event.timestamp
        ? new Date(event.timestamp).getTime()
        : Date.now();

      // Process assistant messages (Claude responses)
      if (event.type === "assistant" && event.message?.content) {
        // Process content blocks in order they appear
        for (const contentBlock of event.message.content) {
          // TEXT - Extract text content
          if (contentBlock.type === "text" && contentBlock.text) {
            outputEvents.push({
              type: CLI_EVENT_TYPES.TEXT,
              timestamp,
              data: {
                text: contentBlock.text,
              } as TextData,
            });
          }

          // THINKING - Note: field is 'thinking' NOT 'text'
          if (contentBlock.type === "thinking" && contentBlock.thinking) {
            outputEvents.push({
              type: CLI_EVENT_TYPES.THINKING,
              timestamp,
              data: {
                text: contentBlock.thinking,
                label: "Extended Thinking",
              } as ThinkingBlock,
            });
          }

          // TOOL_USE - Map Claude tools to semantic event types
          if (contentBlock.type === "tool_use") {
            outputEvents.push(
              ...ClaudeToolBuilder.buildInitiatedEvents(
                contentBlock.name,
                contentBlock.input || {},
                contentBlock.id,
                timestamp
              )
            );
          }
        }

        // Extract usage stats (including cache tokens)
        if (event.message.usage) {
          const usage = event.message.usage;
          totalInputTokens += usage.input_tokens || 0;
          totalOutputTokens += usage.output_tokens || 0;
          cacheCreationTokens += usage.cache_creation_input_tokens || 0;
          cacheReadTokens += usage.cache_read_input_tokens || 0;
          // Track last assistant turn's usage — this represents the current
          // context window state (not cumulative across turns like the totals above)
          lastAssistantUsage = usage;
        }

        // Extract model info
        if (event.message.model && !model) {
          model = event.message.model;
        }
      }

      // Process user events for TOOL_RESULT blocks and structured metadata
      if (event.type === "user" && Array.isArray(event.message?.content)) {
        ClaudeToolBuilder.processToolResultBlocks(
          event.message.content,
          timestamp,
          outputEvents
        );

        // Process structured tool_use_result metadata for rich diff data
        // This contains accurate line numbers and full file context for Edit operations
        if (event.toolUseResult) {
          ClaudeToolBuilder.processToolUseResultMetadata(
            event.toolUseResult,
            timestamp,
            outputEvents
          );
        }
      }

      // Process system events
      if (event.type === "system") {
        // Turn duration → elapsed time metadata
        if (
          event.subtype === "turn_duration" &&
          typeof event.durationMs === "number"
        ) {
          elapsed = event.durationMs;
        }

        // Compact boundary → visible compaction event
        if (event.subtype === "compact_boundary") {
          const meta =
            (event as any).compactMetadata ??
            (event as any).compact_metadata ??
            {};
          outputEvents.push({
            type: CLI_EVENT_TYPES.COMPACTION,
            timestamp,
            data: {
              trigger: meta.trigger ?? COMPACTION_TRIGGERS.AUTO,
              preTokens: meta.preTokens ?? meta.pre_tokens,
              postTokens: meta.postTokens ?? meta.post_tokens,
              durationMs: meta.durationMs ?? meta.duration_ms,
            } as CompactionData,
          });
        }
      }
    }

    // Compute context window occupancy from last assistant turn only.
    // Cumulative totals (totalInputTokens etc.) are billing totals across all turns,
    // not the current context window state.
    const contextWindowUsedTokens = lastAssistantUsage
      ? (lastAssistantUsage.input_tokens || 0) +
        (lastAssistantUsage.cache_creation_input_tokens || 0) +
        (lastAssistantUsage.cache_read_input_tokens || 0)
      : undefined;

    return {
      events: outputEvents,
      metadata: {
        sessionId,
        model,
        harness: HARNESS_IDS.CLAUDE_CLI,
        elapsed,
        usage:
          totalInputTokens > 0 || totalOutputTokens > 0
            ? {
                inputTokens: totalInputTokens,
                outputTokens: totalOutputTokens,
                totalTokens: totalInputTokens + totalOutputTokens,
                cachedInputTokens:
                  cacheReadTokens > 0 ? cacheReadTokens : undefined,
                cacheCreatedTokens:
                  cacheCreationTokens > 0 ? cacheCreationTokens : undefined,
                contextWindowUsedTokens,
                contextWindowSize: getClaudeContextWindowSize(
                  model ?? this.resolvedModel
                ),
              }
            : undefined,
        ...(cacheCreationTokens > 0 || cacheReadTokens > 0
          ? {
              cacheTokens: {
                created: cacheCreationTokens,
                read: cacheReadTokens,
              },
            }
          : {}),
      },
    };
  }

  /**
   * Check if event indicates completion
   *
   * Claude events are complete when:
   * - Event type is "assistant"
   * - message.stop_reason is not null AND not "tool_use"
   *
   * @param event - Single parsed Claude log event
   * @returns True if event signals final completion
   *
   * @remarks
   * **Stop Reason Values:**
   * - `null` - Still streaming (NOT complete)
   * - `"end_turn"` - Normal completion ✓ COMPLETE
   * - `"max_tokens"` - Token limit reached ✓ COMPLETE
   * - `"stop_sequence"` - Stop sequence encountered ✓ COMPLETE
   * - `"tool_use"` - Stopped to execute tools (intermediate, NOT final)
   *
   * **Important:** `tool_use` stop reason is NOT a final completion.
   * Claude stops to let the tool execute, then continues after receiving
   * the tool_result. Only treat as complete when stop_reason indicates
   * the turn is truly finished.
   *
   * @example
   * ```typescript
   * // Final completion
   * const event = { type: "assistant", message: { stop_reason: "end_turn" } };
   * if (parser.isComplete(event)) {
   *   // Response is complete - stop watching
   * }
   *
   * // Intermediate (tool execution)
   * const toolEvent = { type: "assistant", message: { stop_reason: "tool_use" } };
   * if (!parser.isComplete(toolEvent)) {
   *   // Keep watching - Claude will continue after tool result
   * }
   * ```
   */
  isComplete(event: BaseCliEvent): boolean {
    // Must be an assistant event with a stop_reason
    if (event.type !== "assistant") {
      return false;
    }

    const stopReason = (event as ClaudeProviderEvent).message?.stop_reason;

    // Still streaming if stop_reason is null/undefined
    if (stopReason === null || stopReason === undefined) {
      return false;
    }

    // "tool_use" is NOT a final completion - Claude paused to execute tools
    // and will continue after receiving tool_result
    if (stopReason === "tool_use") {
      return false;
    }

    // All other stop reasons indicate final completion:
    // - "end_turn" - Normal completion
    // - "max_tokens" - Token limit reached
    // - "stop_sequence" - Stop sequence encountered
    return true;
  }

  override extractLiveContextWindow(
    event: BaseCliEvent,
    modelId: string
  ): { used: number; size: number } | null {
    if (event.type === "assistant") {
      const assistantEvent = event as ClaudeProviderEvent;
      const usage = assistantEvent.message?.usage;
      if (!usage) return null;
      const used =
        (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0);
      const eventModel = assistantEvent.message?.model as string | undefined;
      const size = getClaudeContextWindowSize(eventModel ?? modelId);
      return used > 0 && size ? { used, size } : null;
    }
    return null;
  }

  /**
   * Classify a `user` log event per the four-way rule (see `UserEventClassification`):
   * Claude's log uses the `user` role for tool results, ctrlyoke's own injected
   * prompts echoed back, its own `<task-notification>` resume signal, and genuine
   * human follow-ups typed into the live TUI — only the last is a "user steer".
   *
   * Non-`user` events and events with no text content are always `"other"`.
   */
  override classifyUserEvent(
    event: BaseCliEvent,
    ctx: { dispatchedPromptText?: string }
  ): UserEventClassification {
    const e = event as ClaudeProviderEvent;
    if (e.type !== "user") {
      return "other";
    }

    if (this.hasToolResultBlock(e)) {
      return "tool-result";
    }

    const text = this.extractUserMessageText(e);
    if (!text) {
      return "other";
    }

    if (text.includes("<task-notification>")) {
      return "resume-signal";
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

  /**
   * Extract the display text for an event already classified as `"human-steer"`
   * by `classifyUserEvent`. Reuses the same block-text extraction so the two
   * stay in sync — see `extractUserMessageText`.
   */
  override extractUserSteerText(event: BaseCliEvent): string | undefined {
    const e = event as ClaudeProviderEvent;
    if (e.type !== "user") {
      return undefined;
    }
    const text = this.extractUserMessageText(e);
    return text || undefined;
  }

  /** Returns true when a `user` event is only carrying tool results. */
  private hasToolResultBlock(e: ClaudeProviderEvent): boolean {
    return (
      Array.isArray(e.message?.content) &&
      (e.message.content as Array<Record<string, any>>).some(
        (block) => block.type === "tool_result"
      )
    );
  }

  /**
   * Extracts text from a Claude `user` event.
   *
   * Claude logs user-originated content in both historical block-array form
   * and current string form. Task notifications use the string shape, so
   * background-work tracking must normalize both.
   */
  private extractUserMessageText(e: ClaudeProviderEvent): string {
    const content = e.message?.content;
    if (typeof content === "string") {
      return content.trim();
    }
    if (!Array.isArray(content)) {
      return "";
    }
    return (content as Array<Record<string, any>>)
      .filter(
        (block) => block.type === "text" && typeof block.text === "string"
      )
      .map((block) => block.text as string)
      .join("")
      .trim();
  }

  /**
   * Extract a background-task notification only after Claude has consumed it.
   * Between turns, delivery is a `user` message. During an active turn, Claude
   * injects it as a `queued_command` attachment before continuing. A preceding
   * `queue-operation` only records queue bookkeeping: clearing on `enqueue`
   * creates a race where the current turn can Stop before the notification is
   * delivered and starts the resumed turn.
   */
  private extractTaskNotificationText(e: ClaudeProviderEvent): string {
    if (e.type === "user") {
      return this.extractUserMessageText(e);
    }
    if (e.type === "attachment" && typeof e.attachment?.prompt === "string") {
      return e.attachment.prompt;
    }
    return "";
  }

  /** Update pending launch state from correlated tool results. */
  private trackAsyncLaunchResult(e: ClaudeProviderEvent): void {
    if (e.type !== "user" || !Array.isArray(e.message?.content)) {
      return;
    }

    for (const block of e.message.content as Array<Record<string, any>>) {
      const toolUseId = block.tool_use_id;
      if (block.type !== "tool_result" || typeof toolUseId !== "string") {
        continue;
      }

      if (block.is_error === true) {
        this.backgroundFollowUpState.remove(toolUseId);
      }

      const candidateType = this.unconfirmedAsyncLaunches.get(toolUseId);
      if (!candidateType) {
        continue;
      }
      this.unconfirmedAsyncLaunches.delete(toolUseId);

      const resultText = ClaudeToolBuilder.extractToolResultText(block.content);
      const launchConfirmed =
        candidateType === "Agent"
          ? resultText.includes("Async agent launched successfully")
          : resultText.includes("Monitor started");
      if (block.is_error !== true && launchConfirmed) {
        this.backgroundFollowUpState.launch(toolUseId);
      }
    }
  }

  /**
   * Track background-task launch/notification markers per the empirically
   * confirmed rule (see `dev/backlog/TERMINAL_FOLLOWUP_TRACKING_PLAN.md`,
   * "Claude Code — CONFIRMED"):
   * - **Launch:** any `assistant` `tool_use` block with
   *   `input.run_in_background === true` (Claude uses both `Bash` and
   *   `PowerShell` command tools), or an Agent/Monitor result that confirms
   *   asynchronous execution. Every outstanding id is retained because Claude
   *   can run and notify several background tools concurrently.
   * - **Notification delivery:** a `user` or `attachment` event whose payload contains
   *   `<task-notification>`. It clears a matching launch id and latches
   *   resumed-turn completion: the Stop preceding delivery is intermediate,
   *   so completion remains gated until the auto-resumed turn reaches a later
   *   terminal assistant event. Queue operations deliberately do not affect
   *   either state because they are bookkeeping, not notification consumption.
   */
  override trackBackgroundWorkState(event: BaseCliEvent): void {
    const e = event as ClaudeProviderEvent;

    if (e.type === "assistant") {
      if (Array.isArray(e.message?.content)) {
        for (const block of e.message.content as Array<Record<string, any>>) {
          if (block.type !== "tool_use" || typeof block.id !== "string") {
            continue;
          }

          if (block.input?.run_in_background === true) {
            this.backgroundFollowUpState.launch(block.id);
          } else if (
            block.name === "Agent" &&
            block.input?.run_in_background !== false
          ) {
            this.unconfirmedAsyncLaunches.set(block.id, "Agent");
          } else if (block.name === "Monitor") {
            this.unconfirmedAsyncLaunches.set(block.id, "Monitor");
          }
        }
      }

      const stopReason = e.message?.stop_reason;
      if (
        this.backgroundFollowUpState.isResumedTurnPending() &&
        stopReason !== null &&
        stopReason !== undefined &&
        stopReason !== "tool_use"
      ) {
        this.backgroundFollowUpState.resumedTurnClosed();
      }
      return;
    }

    this.trackAsyncLaunchResult(e);

    const text = this.extractTaskNotificationText(e);
    if (text.includes("<task-notification>")) {
      const match = text.match(/<tool-use-id>([^<]+)<\/tool-use-id>/);
      if (match) {
        this.backgroundFollowUpState.consumeNotification(match[1]);
      }
    }
  }

  override hasPendingBackgroundWork(): boolean {
    return this.backgroundFollowUpState.isCompletionBlocked();
  }

  /**
   * Discover session log file for a prompt
   *
   * Searches Claude project directory for log file matching session ID or prompt text.
   *
   * @param promptText - The prompt text sent to Claude CLI (used for matching if no sessionId)
   * @param startTime - Execution start timestamp (used to filter candidates)
   * @param sessionId - Optional session ID from SessionStart hook (faster, more reliable)
   * @returns Absolute path to session log file, or null if not found
   *
   * @remarks
   * **Fast Path (Session ID provided):**
   * 1. Find Claude project directory for current workspace
   * 2. Construct log file path: `<projectDir>/<sessionId>.jsonl`
   * 3. Verify file exists and was modified after startTime
   * 4. Return file path if valid
   *
   * **Fallback (No Session ID):**
   * 1. Find Claude project directory for current workspace
   * 2. Get candidate log files modified after startTime (via findModifiedSessionLogs)
   * 3. Read first 10 events from each candidate
   * 4. Look for user event containing prompt text (first 100 chars)
   * 5. Return first matching file path
   *
   * **Project Directory Resolution:**
   * - Base: `~/.claude/projects/`
   * - Path: Normalized workspace path (e.g., `dev_ctrlyoke`)
   * - Full: `~/.claude/projects/dev_ctrlyoke/`
   *
   * **Matching Strategy:**
   * - Session ID: Direct file lookup (much faster)
   * - Prompt text: Compares first 100 chars, case-sensitive exact match
   *
   * @example
   * ```typescript
   * // Fast path (with session ID from hook)
   * const logPath = await parser.discoverSessionLog(
   *   "Analyze code",
   *   new Date(),
   *   "abc-123-session-id"
   * );
   *
   * // Fallback (no session ID)
   * const logPath = await parser.discoverSessionLog("Analyze code", new Date());
   * ```
   */
  async discoverSessionLog(
    promptText: string,
    startTime: Date,
    sessionId?: string
  ): Promise<string | null> {
    try {
      // Get Claude project directory for current workspace
      const projectDir = this.getClaudeProjectDirectory();
      if (!projectDir) {
        Log.debug("[ClaudeLogParser] No Claude project directory found");
        return null;
      }

      Log.debug(
        `[ClaudeLogParser] Searching for session logs in: ${projectDir}`
      );

      // FAST PATH: If session ID provided, construct direct file path
      if (sessionId) {
        const logPath = path.join(projectDir, `${sessionId}.jsonl`);

        // Retry with backoff: Claude writes log file within ~50-100ms of SessionStart hook
        // NOTE: When resuming a session, the log file may have an old mtime initially,
        // but the CLI will update it as it writes new content. This can take several seconds
        // if Claude is processing the resume request. We retry with longer delays to handle this.
        const result = await retryWithBackoff(
          async () => {
            // Verify file exists
            if (fs.existsSync(logPath)) {
              const stats = fs.statSync(logPath);
              if (stats.mtime >= startTime) {
                return logPath; // Success - file exists and is recent
              } else {
                // File exists but hasn't been updated yet - might be resuming an old session
                // The CLI will update it soon, so retry instead of failing
                Log.debug(
                  `[ClaudeLogParser] Session log exists but not yet updated (mtime: ${stats.mtime.toISOString()}, startTime: ${startTime.toISOString()}), will retry...`
                );
                return null; // Retry - file will be updated soon
              }
            }
            return null; // File doesn't exist yet, will retry
          },
          {
            // Uses default: 10s
            onRetry: (attempt, max, delay) => {
              if (attempt > 1) {
                Log.debug(
                  `[ClaudeLogParser] Session log not ready (attempt ${attempt}/${max}), retrying in ${delay}ms...`
                );
              }
            },
          }
        );

        if (result) {
          Log.debug(
            `[ClaudeLogParser] Found session log via session ID: ${result}`
          );
          return result;
        } else {
          Log.debug(
            `[ClaudeLogParser] Session log file not found after retries: ${logPath}`
          );
        }
      }

      // FALLBACK: Get candidate log files modified after startTime
      const candidates = this.findModifiedSessionLogs(projectDir, startTime);
      if (candidates.length === 0) {
        Log.debug("[ClaudeLogParser] No candidate log files found");
        return null;
      }

      Log.debug(
        `[ClaudeLogParser] Found ${candidates.length} candidate log files`
      );

      // Prepare prompt text for matching (first 100 chars)
      // Normalize for path escaping: Claude may escape backslashes in file paths
      const promptPrefix = this.normalizePromptForMatching(
        promptText.substring(0, 100)
      );

      // Check each candidate for matching prompt text
      for (const candidatePath of candidates) {
        try {
          // Read first 10 events from log file
          const events = await this.readFirstNJsonlEvents(candidatePath, 10);

          // Look for user event with matching prompt text
          for (const event of events as ClaudeProviderEvent[]) {
            if (event.type === "user") {
              const text = this.extractUserMessageText(event);
              if (text) {
                const logPromptPrefix = this.normalizePromptForMatching(
                  text.substring(0, 100)
                );
                if (logPromptPrefix === promptPrefix) {
                  Log.debug(
                    `[ClaudeLogParser] Found matching session log: ${candidatePath}`
                  );
                  return candidatePath;
                }
              }
            }
          }
        } catch (error) {
          // Skip files that can't be read or parsed
          Log.debug(
            `[ClaudeLogParser] Error reading candidate ${candidatePath}:`,
            error
          );
          continue;
        }
      }

      Log.debug("[ClaudeLogParser] No matching session log found");
      return null;
    } catch (error) {
      Log.warn("[ClaudeLogParser] Error discovering session log:", error);
      return null;
    }
  }

  /**
   * Extract session ID from log events
   *
   * Searches events for first entry with sessionId field.
   * Claude events include sessionId in most event types.
   *
   * @param events - Array of parsed Claude log events
   * @returns Session ID (UUID format), or null if not found
   *
   * @remarks
   * **Session ID Format:**
   * - UUID v4 (e.g., `550e8400-e29b-41d4-a716-446655440000`)
   * - Present in all event types (assistant, user, queue-operation)
   *
   * **Search Strategy:**
   * - Returns first non-empty sessionId field found
   * - No preference for event type
   *
   * @example
   * ```typescript
   * const events = [
   *   { type: "user", sessionId: "abc-123" },
   *   { type: "assistant", sessionId: "abc-123" }
   * ];
   * const sessionId = parser.extractSessionId(events);
   * // Returns: "abc-123"
   * ```
   */
  extractSessionId(events: BaseCliEvent[]): string | null {
    for (const event of events) {
      if (event.sessionId) {
        return event.sessionId as string;
      }
    }
    return null;
  }

  /**
   * Extract text content from a single Claude log event for streaming
   *
   * @param event - Single parsed Claude log event
   * @returns Text content to display, or undefined if no displayable content
   *
   * @remarks
   * **Supported Event Types:**
   * - `assistant` - Extract text from content blocks
   * - `progress` (bash_progress) - Extract bash output for real-time display
   *
   * **Claude Event Formats:**
   * - Assistant: `{ type: "assistant", message: { content: [{ type: "text", text: "..." }] } }`
   * - Bash Progress: `{ type: "progress", data: { type: "bash_progress", output: "...", fullOutput: "..." } }`
   */
  extractContentFromEvent(event: BaseCliEvent): string | undefined {
    // Claude assistant: Extract text from content array
    const e = event as ClaudeProviderEvent;
    if (e.type === "assistant" && e.message?.content) {
      const textContent = e.message.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");
      return textContent || undefined;
    }

    // Bash progress: Extract output for streaming display
    if (e.type === "progress" && e.data?.type === "bash_progress") {
      // Prefer incremental output over fullOutput for streaming
      return e.data.output || e.data.fullOutput || undefined;
    }

    return undefined;
  }

  /**
   * Extract structured CliEvents from a single Claude log event for streaming.
   *
   * Overrides the BaseLogParser default to emit rich semantic events:
   * - `assistant` text blocks → TEXT
   * - `assistant` thinking blocks → THINKING
   * - `assistant` tool_use blocks → semantic INITIATED event (BASH_COMMAND, FILE_READ, etc.)
   * - `user` tool_result blocks → TOOL_RESULT (looks up tool name from pendingStreamingToolUses)
   * - `progress` bash_progress → TEXT (same as extractContentFromEvent)
   */
  override extractStructuredEventsFromEvent(event: BaseCliEvent): CliEvent[] {
    const events: CliEvent[] = [];
    const e = event as ClaudeProviderEvent;
    const timestamp = e.timestamp
      ? new Date(e.timestamp as number).getTime()
      : Date.now();

    if (e.type === "assistant" && e.message?.content) {
      for (const block of e.message.content) {
        if (block.type === "text" && block.text) {
          events.push({
            type: CLI_EVENT_TYPES.TEXT,
            timestamp,
            data: { text: block.text } as TextData,
          });
        }

        if (block.type === "thinking" && block.thinking) {
          events.push({
            type: CLI_EVENT_TYPES.THINKING,
            timestamp,
            data: {
              text: block.thinking,
              label: "Extended Thinking",
            } as ThinkingBlock,
          });
        }

        if (block.type === "tool_use") {
          const callerType = block.caller?.type as string | undefined;
          events.push(
            ...ClaudeToolBuilder.buildInitiatedEvents(
              block.name,
              block.input || {},
              block.id,
              timestamp,
              callerType
            )
          );
          if (block.id && block.name) {
            this.pendingStreamingToolUses.set(block.id, block.name);
          }
        }
      }
    }

    if (e.type === "user" && Array.isArray(e.message?.content)) {
      for (const block of e.message.content) {
        if (block.type === "tool_result") {
          const outputText = ClaudeToolBuilder.extractToolResultText(
            block.content
          );
          events.push({
            type: CLI_EVENT_TYPES.TOOL_RESULT,
            timestamp,
            data: {
              toolCallId: block.tool_use_id,
              result: {
                success: !block.is_error,
                output: outputText,
                error: block.is_error ? outputText : undefined,
              },
            } as ToolResultData,
          });
          if (block.tool_use_id) {
            this.pendingStreamingToolUses.delete(block.tool_use_id);
          }
        }
      }
    }

    if (e.type === "progress" && e.data?.type === "bash_progress") {
      const text = e.data.output || e.data.fullOutput;
      if (text) {
        events.push({
          type: CLI_EVENT_TYPES.TEXT,
          timestamp,
          data: { text } as TextData,
        });
      }
    }

    // Compact boundary → emit visible compaction event during live log monitoring
    if (e.type === "system" && e.subtype === "compact_boundary") {
      const meta =
        (e as any).compactMetadata ?? (e as any).compact_metadata ?? {};
      events.push({
        type: CLI_EVENT_TYPES.COMPACTION,
        timestamp,
        data: {
          trigger: meta.trigger ?? COMPACTION_TRIGGERS.AUTO,
          preTokens: meta.preTokens ?? meta.pre_tokens,
          postTokens: meta.postTokens ?? meta.post_tokens,
          durationMs: meta.durationMs ?? meta.duration_ms,
        } as CompactionData,
      });
    }

    return events;
  }

  /**
   * Format Claude metadata into statistics string
   *
   * @param metadata - Metadata from extractResponse() (sessionId, model, usage, cacheTokens)
   * @returns Formatted statistics string
   *
   * @remarks
   * **Metadata Fields:**
   * - `sessionId` - Session UUID (truncated to 8 chars for display)
   * - `model` - Model name (e.g., "claude-sonnet-4-5-20250929")
   * - `usage` - Token counts (input, output, total)
   * - `cacheTokens` - Cache token counts (created, read) for cost optimization
   * - `elapsed` - Turn duration in milliseconds
   *
   * @example
   * ```typescript
   * const metadata = {
   *   sessionId: "abc-123",
   *   model: "claude-sonnet-4.5",
   *   usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
   *   cacheTokens: { created: 1000, read: 500 },
   *   elapsed: 2500
   * };
   * const stats = parser.formatStatistics(metadata);
   * // "Session: abc-123 | Model: claude-sonnet-4.5 | Tokens: 100 in / 50 out | Cache: 1000 created, 500 read | Duration: 2.5s"
   * ```
   */
  formatStatistics(metadata: BaseCliEvent): string {
    const parts = this.buildCommonStatisticsParts(metadata);
    const meta = metadata as Record<string, any>;

    // Cache tokens (Claude-specific, important for cost calculation)
    if (meta.cacheTokens) {
      const cache = meta.cacheTokens;
      const cacheParts: string[] = [];
      if (cache.created > 0) {
        cacheParts.push(`${cache.created} created`);
      }
      if (cache.read > 0) {
        cacheParts.push(`${cache.read} read`);
      }
      if (cacheParts.length > 0) {
        parts.push(`Cache: ${cacheParts.join(", ")}`);
      }
    }

    // Turn duration (Claude-specific)
    if (meta.elapsed) {
      const seconds = (meta.elapsed / 1000).toFixed(1);
      parts.push(`Duration: ${seconds}s`);
    }

    return parts.join(" | ");
  }

  // ========================================================================
  // Private Helper Methods
  // ========================================================================

  /**
   * Get Claude project directory for current workspace
   *
   * Resolves to `~/.claude/projects/<workspace-path>/`
   *
   * @returns Absolute path to Claude project directory, or null if no workspace
   *
   * @remarks
   * **Path Normalization:**
   * - Replaces path separators with underscores
   * - Example: `/Users/name/dev/ctrlyoke` → `dev_ctrlyoke`
   * - Windows: `C:\dev\ctrlyoke` → `dev_ctrlyoke`
   *
   * **Directory Structure:**
   * - Base: `~/.claude/projects/`
   * - Project: `<normalized-workspace-path>/`
   * - Session logs: `<session-id>.jsonl`
   */
  private getClaudeProjectDirectory(): string | null {
    // Use stored workspaceRoot (set by CliIntegration) or fall back to process.cwd()
    const workspacePath = this.workspaceRoot ?? process.cwd();
    const normalizedPath = this.normalizeWorkspacePath(workspacePath);

    // Build Claude project directory path
    const homeDir = os.homedir();
    const projectDir = path.join(
      homeDir,
      ".claude",
      "projects",
      normalizedPath
    );

    return projectDir;
  }

  /**
   * Normalize workspace path for Claude project directory
   *
   * Converts filesystem path to Claude's normalized format.
   *
   * @param workspacePath - Absolute workspace path
   * @returns Normalized path (e.g., "C--dev-ctrlyoke")
   *
   * @remarks
   * **Normalization Rules:**
   * - Convert drive colon to double dash (Windows: `C:\` → `C--`)
   * - Replace path separators with dashes (leading slash becomes a leading dash)
   * - Example Windows: `C:\dev\ctrlyoke` → `C--dev-ctrlyoke`
   * - Example Unix: `/home/name/dev/ctrlyoke` → `-home-name-dev-ctrlyoke`
   *
   * **Note:** This is based on observed Claude CLI behavior.
   * The actual normalization may vary depending on Claude CLI version.
   */
  private normalizeWorkspacePath(workspacePath: string): string {
    // Replace drive letter colon with double dash on Windows (e.g., "C:\dev\ctrlyoke" → "C--dev-ctrlyoke")
    let normalized = workspacePath.replace(/^([A-Z]):[\\\/]/i, "$1--");

    // Replace path separators with dashes (leading slash on Unix becomes a leading dash,
    // matching Claude CLI's observed behavior: "/home/user/dev" → "-home-user-dev")
    normalized = normalized.replace(/[\\\/]/g, "-");

    return normalized;
  }
}
