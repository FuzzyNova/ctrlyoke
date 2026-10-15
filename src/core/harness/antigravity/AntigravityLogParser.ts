import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { BaseLogParser } from "../shared/BaseLogParser";
import {
  BaseCliEvent,
  ILogParser,
  UserEventClassification,
} from "../shared/interfaces/ILogParser";
import {
  CLI_EVENT_TYPES,
  COMPACTION_TRIGGERS,
  HARNESS_IDS,
  TOKEN_TOTAL_CONFIDENCE,
} from "../../../types/DashboardConstants";
import {
  CliEvent,
  CompactionData,
  ThinkingBlock,
  TextData,
  TokenUsage,
  UniversalCliOutput,
  BackgroundWorkHoldSnapshot,
} from "../../../types/CliOutputTypes";
import { getAntigravityContextWindowSize } from "../../../utils/ModelConstants";
import {
  AntigravityTranscriptEntry,
  AntigravityPlannerToolCall,
} from "./AntigravityTranscriptTypes";
import {
  AntigravityTranscriptReader,
  AntigravityTranscriptRecord,
} from "./AntigravityTranscriptReader";
import { AntigravityToolEventBuilder } from "./AntigravityToolEventBuilder";
import {
  ANTIGRAVITY_ENTRY_TYPES,
  ANTIGRAVITY_TOOL_NAMES,
  ANTIGRAVITY_WIRE_VALUES,
} from "./AntigravityProtocolConstants";
import { BackgroundFollowUpState } from "../shared/BackgroundFollowUpState";
import {
  parseStatuslineCurrentUsage,
  type AntigravityCurrentUsage,
  type AntigravityStatuslineSnapshot,
} from "./AntigravityStatuslineSidecar";
import type {
  AntigravityStreamJsonUsage,
  AntigravityStreamJsonUsageSnapshot,
} from "./AntigravityStreamJsonUsage";
import { Log } from "../../../utils/Log";
import { CompositeFsWatcher } from "../shared/FsWatcherHandles";

/**
 * Synthetic `AntigravityLogEvent.type` tags — ctrlyoke's own internal event
 * shape, not values from Antigravity's wire protocol (see
 * `ANTIGRAVITY_ENTRY_TYPES`/`ANTIGRAVITY_WIRE_VALUES` in
 * `AntigravityProtocolConstants.ts` for those).
 */
const ANTIGRAVITY_LOG_EVENT_TYPES = {
  SESSION_CREATED: "session.created",
  RESPONSE_COMPLETED: "response.completed",
  LOG_LINE: "log.line",
  RESPONSE_TEXT: "response.text",
  USER_INPUT: "user_input",
  TRANSCRIPT_PLANNER: "transcript.planner",
  TRANSCRIPT_TOOL: "transcript.tool",
  TRANSCRIPT_CHECKPOINT: "transcript.checkpoint",
  TRANSCRIPT_ERROR: "transcript.error",
} as const;

type AntigravityLogEventType =
  (typeof ANTIGRAVITY_LOG_EVENT_TYPES)[keyof typeof ANTIGRAVITY_LOG_EVENT_TYPES];

interface AntigravityLogEvent extends BaseCliEvent {
  type: AntigravityLogEventType;
  line: string;
  sessionId?: string;
  timestamp?: number;
  eventId?: string;
  transcriptEntry?: AntigravityTranscriptEntry;
  thinking?: string;
  plannerToolCalls?: AntigravityTranscriptEntry["tool_calls"];
  plannerToolCallIds?: string[];
  toolCall?: AntigravityPlannerToolCall;
  toolCallId?: string;
  resultEntry?: AntigravityTranscriptEntry;
  taskId?: string;
  model?: string;
  contextWindowUsedTokens?: number;
  contextWindowSize?: number;
  outputTokens?: number;
  currentUsage?: AntigravityCurrentUsage;
}

const SESSION_ID_REGEX =
  /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

/**
 * `{{ CHECKPOINT 0 }}` is agy's baseline context scaffold, not a compaction.
 * It is written a few entries into *every* conversation — confirmed in a
 * 14-entry session where nothing could have been truncated — yet it carries
 * the same "earlier parts of this conversation have been truncated" boilerplate
 * as a real compaction, so the text is not a usable discriminator. Genuine
 * auto-compaction bumps the index (`{{ CHECKPOINT 1 }}` and up) and appears
 * mid-conversation with a "Previous Session Summary" section.
 */
const BASELINE_CHECKPOINT_REGEX = /\{\{\s*CHECKPOINT\s+0\s*\}\}/i;

interface PendingPlannerToolCall {
  call: AntigravityPlannerToolCall;
  plannerEventId: string;
  toolCallId: string;
  timestamp: number;
}

export class AntigravityLogParser extends BaseLogParser implements ILogParser {
  private cachedSessionId?: string;
  private cachedLastConversationsSessionId?: string;
  private readonly transcriptReader = new AntigravityTranscriptReader();
  private readonly pendingPlannerToolCalls: PendingPlannerToolCall[] = [];
  /**
   * Background follow-up state; transcript recognition remains provider-specific.
   * No stale-stop guard: unlike Copilot, Antigravity's transcript is tailed by an
   * independently-polling watcher (see `AntigravityTranscriptReader.watchForChanges`)
   * that keeps `isCompletionBlocked()` settled well before any Stop hook fires, so
   * there is no "old stale Stop catches up the resume in the same read" race to
   * guard against — and a real agy turn commonly emits exactly one Stop hook for
   * the whole exchange, so a guard requiring one more never resolves. See the
   * gotcha in harness-cli-providers.instructions.md.
   */
  private readonly backgroundFollowUpState = new BackgroundFollowUpState();
  private backgroundStateSessionId?: string;
  private latestStatuslineUsage?: TokenUsage;
  private latestStreamJsonUsage?: AntigravityStreamJsonUsageSnapshot;

  /** Reset the sidecar-derived usage before a new prompt starts. */
  setStatuslineSnapshot(snapshot?: AntigravityStatuslineSnapshot): void {
    this.latestStatuslineUsage = snapshot
      ? this.extractTokenUsageFromStatuslineSnapshot(snapshot)
      : undefined;
  }

  /** Reset or update the stdout-derived usage enrichment for the current prompt. */
  setStreamJsonUsage(usage?: AntigravityStreamJsonUsageSnapshot): void {
    this.latestStreamJsonUsage = usage;
  }

  /** Map the statusline's per-turn and cumulative fields to the shared usage contract. */
  extractTokenUsageFromStatuslineSnapshot(
    snapshot: AntigravityStatuslineSnapshot
  ): TokenUsage | undefined {
    const contextWindow = snapshot.context_window;
    const totalInputTokens = this.asFiniteNumber(
      contextWindow?.total_input_tokens
    );
    const totalOutputTokens = this.asFiniteNumber(
      contextWindow?.total_output_tokens
    );
    if (totalInputTokens === undefined || totalOutputTokens === undefined) {
      return undefined;
    }

    const currentUsage = parseStatuslineCurrentUsage(
      contextWindow?.current_usage
    );
    const inputTokens = currentUsage?.inputTokens ?? totalInputTokens;
    const outputTokens = currentUsage?.outputTokens ?? totalOutputTokens;
    const contextWindowSize =
      this.asFiniteNumber(contextWindow?.context_window_size) ??
      getAntigravityContextWindowSize(
        this.getSnapshotModel(snapshot) ?? this.resolvedModel
      );

    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cachedInputTokens: currentUsage?.cacheReadInputTokens,
      cacheCreatedTokens: currentUsage?.cacheCreationInputTokens,
      contextWindowUsedTokens: totalInputTokens + totalOutputTokens,
      contextWindowSize,
      totalConfidence: TOKEN_TOTAL_CONFIDENCE.PARTIAL,
    };
  }

  override async readNewLines(filePath: string): Promise<BaseCliEvent[]> {
    // The transcript is polled after the Go log so a session discovered on this
    // read can seed the authoritative transcript path; early-return and catch
    // paths below still poll it when the Go log has nothing new to report.
    try {
      const lines = this.readNewCompleteLines(filePath);
      const events: AntigravityLogEvent[] = [];
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }
        const sessionId = this.extractSessionIdFromLine(line);
        if (sessionId) {
          this.setCachedSessionId(sessionId);
        }

        if (
          line.includes("Starting conversation update stream for") ||
          line.includes("Print mode: conversation=")
        ) {
          events.push({
            type: ANTIGRAVITY_LOG_EVENT_TYPES.SESSION_CREATED,
            line,
            sessionId,
          });
          continue;
        }

        if (
          line.includes("clearing ResponsePending") ||
          line.includes("Language server shutting down")
        ) {
          events.push({
            type: ANTIGRAVITY_LOG_EVENT_TYPES.RESPONSE_COMPLETED,
            line,
            sessionId,
          });
          continue;
        }

        events.push({
          type: ANTIGRAVITY_LOG_EVENT_TYPES.LOG_LINE,
          line,
          sessionId,
        });
      }

      const transcriptEvents = await this.readNewTranscriptEvents();
      const completionEvents = events.filter(
        (event) => event.type === ANTIGRAVITY_LOG_EVENT_TYPES.RESPONSE_COMPLETED
      );
      const nonCompletionEvents = events.filter(
        (event) => event.type !== ANTIGRAVITY_LOG_EVENT_TYPES.RESPONSE_COMPLETED
      );
      return [...nonCompletionEvents, ...transcriptEvents, ...completionEvents];
    } catch {
      return await this.readNewTranscriptEvents();
    }
  }

  /**
   * Tail both Antigravity sources. The Go log discovered for a resumed session
   * may belong to the previous CLI process, while the conversation transcript
   * remains stable across that restart. Watching the transcript independently
   * prevents later human follow-ups from waiting forever for activity on the
   * stale Go log.
   */
  override watchLogFile(
    filePath: string,
    callback: (entry: BaseCliEvent) => void,
    startTime: Date
  ): fs.FSWatcher {
    const logWatcher = super.watchLogFile(filePath, callback, startTime);
    const transcriptWatcher = this.transcriptReader.watchForChanges(
      () => this.resolveAuthoritativeTranscriptPath(),
      () => {
        void this.forwardNewTranscriptEvents(callback, startTime);
      }
    );
    return new CompositeFsWatcher([logWatcher, transcriptWatcher]);
  }

  extractResponse(events: BaseCliEvent[]): UniversalCliOutput {
    const outputEvents = events.flatMap((event) =>
      this.extractStructuredEventsFromEvent(event)
    );
    const unmatchedEvents = this.pendingPlannerToolCalls
      .filter(
        (pending) =>
          !AntigravityToolEventBuilder.isAskUserQuestionTool(pending.call.name)
      )
      .map((pending) =>
        AntigravityToolEventBuilder.buildUnmatchedCall(
          pending.call,
          pending.timestamp,
          pending.plannerEventId
        )
      );
    for (const unmatched of unmatchedEvents) {
      const insertAt = outputEvents.findIndex(
        (event) =>
          event.timestamp !== undefined &&
          unmatched.timestamp !== undefined &&
          event.timestamp > unmatched.timestamp
      );
      if (insertAt < 0) {
        outputEvents.push(unmatched);
      } else {
        outputEvents.splice(insertAt, 0, unmatched);
      }
    }

    const usage = this.extractTokenUsage(events);

    return {
      events: outputEvents,
      metadata: {
        harness: HARNESS_IDS.ANTIGRAVITY_CLI,
        sessionId: this.extractSessionId(events) ?? undefined,
        model: this.resolvedModel || undefined,
        usage,
      },
    };
  }

  isComplete(event: BaseCliEvent): boolean {
    return event.type === ANTIGRAVITY_LOG_EVENT_TYPES.RESPONSE_COMPLETED;
  }

  async discoverSessionLog(
    _promptText: string,
    startTime: Date,
    sessionId?: string,
    signal?: AbortSignal
  ): Promise<string | null> {
    if (signal?.aborted) {
      return null;
    }

    const candidates = this.findModifiedSessionLogs(
      this.getLogDirectory(),
      startTime,
      {
        filter: (fileName) => /^cli-\d{8}_\d{6}\.log$/.test(fileName),
      }
    );

    if (sessionId) {
      this.cachedSessionId = sessionId;
      for (const candidate of candidates) {
        try {
          const content = fs.readFileSync(candidate, "utf8");
          if (content.includes(sessionId)) {
            return candidate;
          }
        } catch {
          // Ignore unreadable candidates
        }
      }
    }

    return candidates[0] ?? null;
  }

  /**
   * Stateless read of a discovered log file to recover the conversation UUID after the
   * process has already exited (headless fallback when `last_conversations.json` misses).
   */
  async extractSessionIdFromLogPath(
    logPath: string
  ): Promise<string | undefined> {
    try {
      const content = await fs.promises.readFile(logPath, "utf8");
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (
          !line.includes("Starting conversation update stream for") &&
          !line.includes("Print mode: conversation=")
        ) {
          continue;
        }
        const sessionId = this.extractSessionIdFromLine(line);
        if (sessionId) {
          return sessionId;
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  extractSessionId(events: BaseCliEvent[]): string | null {
    for (const event of events as AntigravityLogEvent[]) {
      if (event.sessionId) {
        return event.sessionId;
      }
    }
    return (
      this.cachedSessionId ?? this.cachedLastConversationsSessionId ?? null
    );
  }

  extractContentFromEvent(event: BaseCliEvent): string | undefined {
    if (
      event.type === ANTIGRAVITY_LOG_EVENT_TYPES.RESPONSE_TEXT ||
      event.type === ANTIGRAVITY_LOG_EVENT_TYPES.TRANSCRIPT_ERROR
    ) {
      return String((event as AntigravityLogEvent).line ?? "");
    }
    return undefined;
  }

  override extractStructuredEventsFromEvent(event: BaseCliEvent): CliEvent[] {
    const antigravityEvent = event as AntigravityLogEvent;
    const timestamp = antigravityEvent.timestamp ?? Date.now();

    if (
      antigravityEvent.type === ANTIGRAVITY_LOG_EVENT_TYPES.TRANSCRIPT_PLANNER
    ) {
      const structuredEvents: CliEvent[] = [];
      if (antigravityEvent.line) {
        structuredEvents.push({
          type: CLI_EVENT_TYPES.TEXT,
          timestamp,
          data: { text: antigravityEvent.line } as TextData,
        });
      }
      if (antigravityEvent.thinking) {
        structuredEvents.push({
          type: CLI_EVENT_TYPES.THINKING,
          timestamp,
          data: {
            text: antigravityEvent.thinking,
            timestamp,
          } as ThinkingBlock,
        });
      }
      for (const [index, call] of (
        antigravityEvent.plannerToolCalls ?? []
      ).entries()) {
        if (AntigravityToolEventBuilder.isAskUserQuestionTool(call.name)) {
          const toolCallId =
            antigravityEvent.plannerToolCallIds?.[index] ??
            `${antigravityEvent.eventId ?? "unknown"}:tool-${index}`;
          structuredEvents.push(
            AntigravityToolEventBuilder.buildAskUserQuestionInitiatedEvent(
              call,
              toolCallId,
              timestamp
            )
          );
        }
      }
      return structuredEvents;
    }

    if (
      antigravityEvent.type === ANTIGRAVITY_LOG_EVENT_TYPES.TRANSCRIPT_TOOL &&
      antigravityEvent.resultEntry
    ) {
      return AntigravityToolEventBuilder.build({
        call: antigravityEvent.toolCall,
        result: antigravityEvent.resultEntry,
        timestamp,
        eventId: antigravityEvent.eventId,
        toolCallId: antigravityEvent.toolCallId,
        taskId: antigravityEvent.taskId,
      });
    }

    if (
      antigravityEvent.type ===
      ANTIGRAVITY_LOG_EVENT_TYPES.TRANSCRIPT_CHECKPOINT
    ) {
      return [
        {
          type: CLI_EVENT_TYPES.COMPACTION,
          timestamp,
          data: {
            trigger: COMPACTION_TRIGGERS.AUTO,
            summary: antigravityEvent.line || undefined,
          } as CompactionData,
        },
      ];
    }

    return super.extractStructuredEventsFromEvent(event);
  }

  override extractLiveContextWindow(
    event: BaseCliEvent,
    modelId: string
  ): { used: number; size: number } | null {
    const antigravityEvent = event as AntigravityLogEvent;
    if (typeof antigravityEvent.contextWindowUsedTokens !== "number") {
      return null;
    }

    return {
      used: antigravityEvent.contextWindowUsedTokens,
      size:
        antigravityEvent.contextWindowSize ??
        getAntigravityContextWindowSize(antigravityEvent.model ?? modelId),
    };
  }

  formatStatistics(metadata: BaseCliEvent): string {
    const parts = this.buildCommonStatisticsParts(metadata, 8, "...");
    return parts.join(" | ");
  }

  /**
   * Transcript entries are read in append/file order and mapped once to
   * provider-local events. The raw entry and stable event ID remain attached
   * for the later tool-result pairing phase.
   *
   * Reached both by ordinary Go-log reads and by the transcript-specific
   * watcher. `AntigravityTranscriptReader` serializes overlapping calls, so a
   * Go-log change racing a transcript poll still emits each record only once.
   */
  private async readNewTranscriptEvents(): Promise<AntigravityLogEvent[]> {
    const sessionId =
      this.cachedSessionId ?? this.cachedLastConversationsSessionId;
    if (!sessionId) {
      return [];
    }
    this.resetProviderStateForSession(sessionId);
    const transcriptPath = this.getAuthoritativeTranscriptPath(sessionId);
    if (!transcriptPath) {
      return [];
    }
    const records = await this.transcriptReader.readRecords(transcriptPath);
    return this.parseTranscriptRecords(records, sessionId);
  }

  /** Parse vendor transcript records through the same stateful mapper used by runtime reads. */
  parseTranscriptRecords(
    records: readonly AntigravityTranscriptRecord[],
    sessionId: string
  ): AntigravityLogEvent[] {
    this.resetProviderStateForSession(sessionId);
    return records.flatMap((record) =>
      this.mapTranscriptRecord(record, sessionId)
    );
  }

  private resolveAuthoritativeTranscriptPath(): string | undefined {
    const sessionId =
      this.cachedSessionId ?? this.cachedLastConversationsSessionId;
    return sessionId
      ? this.getAuthoritativeTranscriptPath(sessionId)
      : undefined;
  }

  private async forwardNewTranscriptEvents(
    callback: (entry: BaseCliEvent) => void,
    startTime: Date
  ): Promise<void> {
    try {
      const events = await this.readNewTranscriptEvents();
      for (const event of events) {
        const entryTime = this.extractTimestamp(event);
        if (entryTime && entryTime < startTime) {
          continue;
        }
        try {
          callback(event);
        } catch (error) {
          Log.warn("[AntigravityLogParser] Transcript callback error:", error);
        }
      }
    } catch (error) {
      Log.warn("[AntigravityLogParser] Transcript tail read failed:", error);
    }
  }

  private mapTranscriptRecord(
    record: AntigravityTranscriptRecord,
    sessionId: string
  ): AntigravityLogEvent[] {
    const { entry, eventId } = record;
    // A background-task launch is a MODEL/GENERIC entry with status
    // "RUNNING": in observed agy CLI output every tool result (run_command,
    // view_file, manage_task, ...) is typed "GENERIC", never a per-tool type
    // like "RUN_COMMAND". A mid-stream PLANNER_RESPONSE can also carry
    // status "RUNNING" and must stay excluded here (and unfinished, so it
    // has nothing worth mapping yet). See the launch-detection note on
    // trackTranscriptBackgroundState.
    const isBackgroundLaunch =
      entry.source === ANTIGRAVITY_WIRE_VALUES.MODEL &&
      entry.type === ANTIGRAVITY_WIRE_VALUES.GENERIC &&
      entry.status === ANTIGRAVITY_WIRE_VALUES.RUNNING;
    const isAskQuestionResult =
      entry.source === ANTIGRAVITY_WIRE_VALUES.MODEL &&
      entry.type === ANTIGRAVITY_ENTRY_TYPES.ASK_QUESTION;
    const isFailedToolResult =
      entry.source === ANTIGRAVITY_WIRE_VALUES.MODEL &&
      this.isToolResultEntry(entry) &&
      entry.status === ANTIGRAVITY_WIRE_VALUES.ERROR;
    if (
      entry.status !== ANTIGRAVITY_WIRE_VALUES.DONE &&
      !isBackgroundLaunch &&
      !isAskQuestionResult &&
      !isFailedToolResult
    ) {
      return [];
    }

    this.trackTranscriptBackgroundState(entry, sessionId);

    const timestamp = this.getTranscriptTimestamp(entry);
    const base = {
      sessionId,
      timestamp,
      eventId,
      transcriptEntry: entry,
    };

    if (
      entry.source === ANTIGRAVITY_WIRE_VALUES.USER_EXPLICIT &&
      entry.type === ANTIGRAVITY_ENTRY_TYPES.USER_INPUT
    ) {
      if (typeof entry.content !== "string") {
        return [];
      }
      const text = this.unwrapUserRequest(entry.content);
      return text
        ? [
            {
              type: ANTIGRAVITY_LOG_EVENT_TYPES.USER_INPUT,
              line: text,
              ...base,
            },
          ]
        : [];
    }

    if (
      entry.source === ANTIGRAVITY_WIRE_VALUES.MODEL &&
      entry.type === ANTIGRAVITY_ENTRY_TYPES.PLANNER_RESPONSE
    ) {
      const text =
        typeof entry.content === "string" ? entry.content.trim() : "";
      const thinking = entry.thinking?.trim() ?? "";
      const plannerToolCalls = entry.tool_calls ?? [];
      const plannerToolCallIds = plannerToolCalls.map(
        (_call, index) => `${eventId}:tool-${index}`
      );
      for (const [index, call] of plannerToolCalls.entries()) {
        this.pendingPlannerToolCalls.push({
          call,
          plannerEventId: eventId,
          toolCallId: plannerToolCallIds[index],
          timestamp,
        });
      }
      if (!text && !thinking && !entry.tool_calls?.length) {
        return [];
      }
      return [
        {
          type: ANTIGRAVITY_LOG_EVENT_TYPES.TRANSCRIPT_PLANNER,
          line: text,
          thinking: thinking || undefined,
          plannerToolCalls,
          plannerToolCallIds,
          ...base,
        },
      ];
    }

    if (
      entry.source === ANTIGRAVITY_WIRE_VALUES.MODEL &&
      this.isToolResultEntry(entry)
    ) {
      const call = this.takePlannerCallForResult(entry);
      return [
        {
          type: ANTIGRAVITY_LOG_EVENT_TYPES.TRANSCRIPT_TOOL,
          line: typeof entry.content === "string" ? entry.content : "",
          toolCall: call?.call,
          toolCallId: call?.toolCallId,
          resultEntry: entry,
          taskId: this.extractTaskId(entry),
          ...base,
        },
      ];
    }

    if (
      entry.source === ANTIGRAVITY_WIRE_VALUES.SYSTEM &&
      entry.type === ANTIGRAVITY_WIRE_VALUES.SYSTEM_MESSAGE
    ) {
      return [
        {
          type: ANTIGRAVITY_LOG_EVENT_TYPES.TRANSCRIPT_TOOL,
          line: typeof entry.content === "string" ? entry.content : "",
          resultEntry: entry,
          taskId: this.extractTaskId(entry),
          ...base,
        },
      ];
    }

    if (
      entry.source === ANTIGRAVITY_WIRE_VALUES.SYSTEM &&
      entry.type === ANTIGRAVITY_ENTRY_TYPES.CHECKPOINT
    ) {
      const line = typeof entry.content === "string" ? entry.content : "";
      if (BASELINE_CHECKPOINT_REGEX.test(line)) {
        return [];
      }
      return [
        {
          type: ANTIGRAVITY_LOG_EVENT_TYPES.TRANSCRIPT_CHECKPOINT,
          line,
          ...base,
        },
      ];
    }

    if (
      entry.source === ANTIGRAVITY_WIRE_VALUES.SYSTEM &&
      (entry.type === ANTIGRAVITY_ENTRY_TYPES.ERROR_MESSAGE ||
        entry.type.includes("CANCEL"))
    ) {
      if (typeof entry.content !== "string" || !entry.content.trim()) {
        return [];
      }
      return [
        {
          type: ANTIGRAVITY_LOG_EVENT_TYPES.TRANSCRIPT_ERROR,
          line: entry.content.trim(),
          ...base,
        },
      ];
    }

    return [];
  }

  private isToolResultEntry(entry: AntigravityTranscriptEntry): boolean {
    const toolResultEntryTypes: string[] = [
      ANTIGRAVITY_ENTRY_TYPES.RUN_COMMAND,
      ANTIGRAVITY_ENTRY_TYPES.VIEW_FILE,
      ANTIGRAVITY_ENTRY_TYPES.CODE_ACTION,
      ANTIGRAVITY_WIRE_VALUES.GENERIC,
      ANTIGRAVITY_ENTRY_TYPES.LIST_DIRECTORY,
      ANTIGRAVITY_ENTRY_TYPES.GREP_SEARCH,
      ANTIGRAVITY_ENTRY_TYPES.MCP_TOOL,
      ANTIGRAVITY_ENTRY_TYPES.LIST_RESOURCES,
      ANTIGRAVITY_ENTRY_TYPES.READ_RESOURCE,
      ANTIGRAVITY_ENTRY_TYPES.SEARCH_WEB,
      ANTIGRAVITY_ENTRY_TYPES.ASK_QUESTION,
    ];
    return toolResultEntryTypes.includes(entry.type);
  }

  private takePlannerCallForResult(
    result: AntigravityTranscriptEntry
  ): PendingPlannerToolCall | undefined {
    const index = this.pendingPlannerToolCalls.findIndex((pending) =>
      this.toolCallMatchesResult(pending.call, result)
    );
    if (index < 0) {
      return undefined;
    }
    return this.pendingPlannerToolCalls.splice(index, 1)[0];
  }

  private toolCallMatchesResult(
    call: AntigravityPlannerToolCall,
    result: AntigravityTranscriptEntry
  ): boolean {
    const name = call.name.toLowerCase();
    switch (result.type) {
      case ANTIGRAVITY_ENTRY_TYPES.RUN_COMMAND:
        return name === ANTIGRAVITY_TOOL_NAMES.RUN_COMMAND;
      case ANTIGRAVITY_ENTRY_TYPES.VIEW_FILE:
        return name === ANTIGRAVITY_TOOL_NAMES.VIEW_FILE;
      case ANTIGRAVITY_ENTRY_TYPES.CODE_ACTION: {
        const codeActionToolNames: string[] = [
          ANTIGRAVITY_TOOL_NAMES.WRITE_TO_FILE,
          ANTIGRAVITY_TOOL_NAMES.REPLACE_FILE_CONTENT,
          ANTIGRAVITY_TOOL_NAMES.MULTI_REPLACE_FILE_CONTENT,
        ];
        return codeActionToolNames.includes(name);
      }
      case ANTIGRAVITY_ENTRY_TYPES.MCP_TOOL:
        return name === ANTIGRAVITY_TOOL_NAMES.CALL_MCP_TOOL;
      case ANTIGRAVITY_ENTRY_TYPES.LIST_RESOURCES:
        return name === ANTIGRAVITY_TOOL_NAMES.LIST_RESOURCES;
      case ANTIGRAVITY_ENTRY_TYPES.READ_RESOURCE:
        return name === ANTIGRAVITY_TOOL_NAMES.READ_RESOURCE;
      case ANTIGRAVITY_ENTRY_TYPES.SEARCH_WEB:
        return name === ANTIGRAVITY_TOOL_NAMES.SEARCH_WEB;
      case ANTIGRAVITY_ENTRY_TYPES.ASK_QUESTION:
        return AntigravityToolEventBuilder.isAskUserQuestionTool(name);
      case ANTIGRAVITY_ENTRY_TYPES.LIST_DIRECTORY:
        return name === ANTIGRAVITY_TOOL_NAMES.LIST_DIR;
      case ANTIGRAVITY_ENTRY_TYPES.GREP_SEARCH:
        return name === ANTIGRAVITY_TOOL_NAMES.GREP_SEARCH;
      case ANTIGRAVITY_WIRE_VALUES.GENERIC:
        // Observed agy output (1.1.12+) types every tool result "GENERIC" —
        // run_command, view_file, write_to_file, grep_search, manage_task,
        // etc. all lose their distinct per-tool type. Type can no longer
        // disambiguate here, so a GENERIC result always matches whatever
        // call is oldest in the pending queue (adjacent-in-file-order
        // pairing, per the class doc on `mapTranscriptRecord`).
        return true;
      default:
        return false;
    }
  }

  private extractTaskId(entry: AntigravityTranscriptEntry): string | undefined {
    const content = typeof entry.content === "string" ? entry.content : "";
    const launch = content.match(/background task with task id:\s*([^\s.]+)/i);
    if (launch) {
      return launch[1];
    }
    const completion = content.match(/Task id\s+"([^"]+)"/i);
    return completion?.[1];
  }

  private trackTranscriptBackgroundState(
    entry: AntigravityTranscriptEntry,
    sessionId: string
  ): void {
    this.resetProviderStateForSession(sessionId);

    if (
      entry.source === ANTIGRAVITY_WIRE_VALUES.MODEL &&
      entry.type === ANTIGRAVITY_WIRE_VALUES.GENERIC &&
      entry.status === ANTIGRAVITY_WIRE_VALUES.RUNNING
    ) {
      const taskId = this.extractTaskId(entry);
      if (taskId) {
        this.backgroundFollowUpState.launch(taskId, { taskId });
      }
      return;
    }

    if (
      entry.source === ANTIGRAVITY_WIRE_VALUES.SYSTEM &&
      entry.type === ANTIGRAVITY_WIRE_VALUES.SYSTEM_MESSAGE &&
      entry.status === ANTIGRAVITY_WIRE_VALUES.DONE
    ) {
      const taskId = this.extractCompletedTaskId(entry);
      if (taskId) {
        this.backgroundFollowUpState.consumeNotification(taskId);
      }
      return;
    }

    if (this.isTerminalPlannerResponse(entry)) {
      this.backgroundFollowUpState.resumedTurnClosed();
    }
  }

  private isTerminalPlannerResponse(
    entry: AntigravityTranscriptEntry
  ): boolean {
    if (
      !this.backgroundFollowUpState.isResumedTurnPending() ||
      entry.source !== ANTIGRAVITY_WIRE_VALUES.MODEL ||
      entry.type !== ANTIGRAVITY_ENTRY_TYPES.PLANNER_RESPONSE ||
      entry.status !== ANTIGRAVITY_WIRE_VALUES.DONE
    ) {
      return false;
    }
    if (entry.tool_calls && entry.tool_calls.length > 0) {
      return false;
    }
    return typeof entry.content === "string" && entry.content.trim().length > 0;
  }

  private extractCompletedTaskId(
    entry: AntigravityTranscriptEntry
  ): string | undefined {
    const content = typeof entry.content === "string" ? entry.content : "";
    const match = content.match(
      /Task id\s+"([^"]+)"\s+(?:finished|failed)\s+with result:/i
    );
    return match?.[1];
  }

  /**
   * See `ILogParser.trackBackgroundWorkState`'s session-reset contract.
   * Antigravity's session-lifecycle boundary is a tracked session-id change
   * rather than an in-stream marker event.
   */
  private resetProviderStateForSession(sessionId: string): void {
    if (this.backgroundStateSessionId === sessionId) {
      return;
    }
    this.backgroundStateSessionId = sessionId;
    this.backgroundFollowUpState.reset();
    this.pendingPlannerToolCalls.length = 0;
  }

  private setCachedSessionId(sessionId: string): void {
    if (this.cachedSessionId === sessionId) {
      return;
    }
    this.cachedSessionId = sessionId;
    this.resetProviderStateForSession(sessionId);
  }

  private getTranscriptTimestamp(entry: AntigravityTranscriptEntry): number {
    if (entry.created_at) {
      const timestamp = new Date(entry.created_at).getTime();
      if (Number.isFinite(timestamp)) {
        return timestamp;
      }
    }
    return Date.now();
  }

  /**
   * Classify a synthetic `user_input` event from the incremental transcript.
   * The transcript's completion/resume marker is a `SYSTEM`/`SYSTEM_MESSAGE`
   * entry (see `hasPendingBackgroundWork`), never `USER_EXPLICIT`/`USER_INPUT`,
   * so the only distinction needed here is against ctrlyoke's own sent prompt.
   */
  override classifyUserEvent(
    event: BaseCliEvent,
    ctx: { dispatchedPromptText?: string }
  ): UserEventClassification {
    const e = event as AntigravityLogEvent;
    if (e.type !== ANTIGRAVITY_LOG_EVENT_TYPES.USER_INPUT) {
      return "other";
    }
    const text = e.line?.trim();
    if (!text) {
      return "other";
    }

    if (ctx.dispatchedPromptText) {
      const normalizedDispatched = this.normalizePromptForMatching(
        ctx.dispatchedPromptText
      );
      const normalizedLogged = this.normalizePromptForMatching(text);
      if (normalizedLogged.includes(normalizedDispatched)) {
        return "injected-prompt";
      }
    }

    return "human-steer";
  }

  override extractUserSteerText(event: BaseCliEvent): string | undefined {
    const e = event as AntigravityLogEvent;
    if (e.type !== ANTIGRAVITY_LOG_EVENT_TYPES.USER_INPUT) {
      return undefined;
    }
    const text = e.line?.trim();
    return text || undefined;
  }

  /**
   * Antigravy's background-task markers live in the **transcript**
   * (`getTranscriptPath`), not the tailed cli log that
   * `trackBackgroundWorkState(event)` would otherwise see — so unlike
   * Claude/Copilot this updates provider-local state while the incremental
   * transcript mapper consumes records. See
   * `dev/implemented/TERMINAL_FOLLOWUP_TRACKING_PLAN.md`, "Antigravity CLI".
   *
   * Rule: pending while any background-task launch (a `MODEL`/`GENERIC`
   * entry with `status: "RUNNING"` — observed agy output always types these
   * "GENERIC", never a per-tool type like "RUN_COMMAND"; the task ID is
   * recovered from the freeform `Tool is running as a background task with
   * task id: <sessionId>/task-N` content) lacks a matching completion/failure
   * `SYSTEM_MESSAGE` (`Task id "<sessionId>/task-N" finished with result:`).
   * Consuming a matching notification also latches
   * the resumed turn until its terminal planner response, so a Stop that raced
   * the catch-up read cannot commit the workflow. New launches remain
   * independent while that resumed turn is active.
   */
  override hasPendingBackgroundWork(): boolean {
    return this.backgroundFollowUpState.isCompletionBlocked();
  }

  override getBackgroundWorkHoldSnapshot(): BackgroundWorkHoldSnapshot {
    return this.backgroundFollowUpState.snapshot();
  }

  async readSessionIdFromLastConversations(
    workspaceRoot: string
  ): Promise<string | undefined> {
    const cachePath = path.join(
      os.homedir(),
      ".gemini",
      "antigravity-cli",
      "cache",
      "last_conversations.json"
    );

    try {
      const content = await fs.promises.readFile(cachePath, "utf8");
      const parsed = JSON.parse(content) as Record<string, string>;
      const normalizedRoot = path.resolve(workspaceRoot);
      const sessionId = parsed[normalizedRoot];
      if (sessionId) {
        this.cachedLastConversationsSessionId = sessionId;
        if (this.cachedSessionId && this.cachedSessionId !== sessionId) {
          this.cachedSessionId = undefined;
        }
        this.resetProviderStateForSession(sessionId);
      }
      return sessionId;
    } catch {
      return undefined;
    }
  }

  private getLogDirectory(): string {
    return path.join(os.homedir(), ".gemini", "antigravity-cli", "log");
  }

  private getBrainDirectory(sessionId: string): string {
    return path.join(
      os.homedir(),
      ".gemini",
      "antigravity-cli",
      "brain",
      sessionId
    );
  }

  private getTranscriptPath(sessionId: string, full: boolean): string {
    return path.join(
      this.getBrainDirectory(sessionId),
      ".system_generated",
      "logs",
      full ? "transcript_full.jsonl" : "transcript.jsonl"
    );
  }

  private getAuthoritativeTranscriptPath(
    sessionId: string
  ): string | undefined {
    const fullPath = this.getTranscriptPath(sessionId, true);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
    const compactPath = this.getTranscriptPath(sessionId, false);
    return fs.existsSync(compactPath) ? compactPath : undefined;
  }

  private unwrapUserRequest(content: string): string {
    const match = content.match(
      /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i
    );
    return (match?.[1] ?? content).trim();
  }

  private extractSessionIdFromLine(line: string): string | undefined {
    const match = line.match(SESSION_ID_REGEX);
    return match?.[1];
  }

  private extractTokenUsage(events: BaseCliEvent[]): TokenUsage | undefined {
    const event = [...(events as AntigravityLogEvent[])]
      .reverse()
      .find(
        (candidate) => typeof candidate.contextWindowUsedTokens === "number"
      );
    const streamJsonUsage = this.getLatestStreamJsonUsage();
    const statuslineUsage = this.latestStatuslineUsage;

    if (!event && !streamJsonUsage && !statuslineUsage) {
      return undefined;
    }

    const currentUsage = event?.currentUsage;
    const outputTokens =
      streamJsonUsage?.outputTokens ??
      statuslineUsage?.outputTokens ??
      currentUsage?.outputTokens ??
      event?.outputTokens ??
      0;
    const inputTokens =
      streamJsonUsage?.inputTokens ??
      statuslineUsage?.inputTokens ??
      currentUsage?.inputTokens ??
      (event?.contextWindowUsedTokens !== undefined
        ? Math.max(event.contextWindowUsedTokens - outputTokens, 0)
        : 0);
    const totalTokens = streamJsonUsage
      ? (streamJsonUsage.totalTokens ?? inputTokens + outputTokens)
      : (statuslineUsage?.totalTokens ?? inputTokens + outputTokens);
    const contextWindowUsedTokens =
      statuslineUsage?.contextWindowUsedTokens ??
      event?.contextWindowUsedTokens;
    const contextWindowSize =
      statuslineUsage?.contextWindowSize ??
      event?.contextWindowSize ??
      (event || streamJsonUsage
        ? getAntigravityContextWindowSize(event?.model ?? this.resolvedModel)
        : undefined);
    return {
      inputTokens,
      outputTokens,
      totalTokens,
      cachedInputTokens:
        streamJsonUsage?.cachedInputTokens ??
        statuslineUsage?.cachedInputTokens ??
        currentUsage?.cacheReadInputTokens,
      cacheCreatedTokens:
        statuslineUsage?.cacheCreatedTokens ??
        currentUsage?.cacheCreationInputTokens,
      reasoningOutputTokens: streamJsonUsage?.reasoningOutputTokens,
      contextWindowUsedTokens,
      contextWindowSize,
      totalConfidence:
        this.latestStreamJsonUsage?.terminalUsage?.totalTokens !== undefined
          ? TOKEN_TOTAL_CONFIDENCE.PROVIDER
          : TOKEN_TOTAL_CONFIDENCE.PARTIAL,
    };
  }

  private getLatestStreamJsonUsage(): AntigravityStreamJsonUsage | undefined {
    const latestStepUsage = this.latestStreamJsonUsage?.latestStepUsage;
    const terminalUsage = this.latestStreamJsonUsage?.terminalUsage;
    if (!latestStepUsage && !terminalUsage) {
      return undefined;
    }
    return { ...latestStepUsage, ...terminalUsage };
  }

  private getSnapshotModel(
    snapshot: AntigravityStatuslineSnapshot
  ): string | undefined {
    if (typeof snapshot.model === "string") {
      return snapshot.model;
    }
    if (snapshot.model && typeof snapshot.model === "object") {
      const id = (snapshot.model as { id?: unknown }).id;
      return typeof id === "string" ? id : undefined;
    }
    return undefined;
  }

  private asFiniteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  }
}
