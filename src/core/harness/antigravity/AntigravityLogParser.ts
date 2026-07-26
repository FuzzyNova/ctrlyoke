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
} from "../../../types/DashboardConstants";
import {
  CliEvent,
  CompactionData,
  ThinkingBlock,
  TextData,
  TokenUsage,
  UniversalCliOutput,
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
import { BackgroundFollowUpState } from "../shared/BackgroundFollowUpState";

interface AntigravityLogEvent extends BaseCliEvent {
  type:
    | "session.created"
    | "response.completed"
    | "log.line"
    | "response.text"
    | "user_input"
    | "transcript.planner"
    | "transcript.tool"
    | "transcript.checkpoint"
    | "transcript.error";
  line: string;
  sessionId?: string;
  timestamp?: number;
  eventId?: string;
  transcriptEntry?: AntigravityTranscriptEntry;
  thinking?: string;
  plannerToolCalls?: AntigravityTranscriptEntry["tool_calls"];
  toolCall?: AntigravityPlannerToolCall;
  resultEntry?: AntigravityTranscriptEntry;
  taskId?: string;
  model?: string;
  contextWindowUsedTokens?: number;
  contextWindowSize?: number;
  outputTokens?: number;
}

const SESSION_ID_REGEX =
  /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

interface PendingPlannerToolCall {
  call: AntigravityPlannerToolCall;
  plannerEventId: string;
  timestamp: number;
}

export class AntigravityLogParser extends BaseLogParser implements ILogParser {
  private cachedSessionId?: string;
  private cachedLastConversationsSessionId?: string;
  private readonly transcriptReader = new AntigravityTranscriptReader();
  private readonly pendingPlannerToolCalls: PendingPlannerToolCall[] = [];
  /** Background follow-up state; transcript recognition remains provider-specific. */
  private readonly backgroundFollowUpState = new BackgroundFollowUpState({
    staleStopGuardChecks: 2,
  });
  private backgroundStateSessionId?: string;

  override async readNewLines(filePath: string): Promise<BaseCliEvent[]> {
    // The transcript is polled after the Go log so a session discovered on this
    // read can seed the authoritative transcript path; early-return and catch
    // paths below still poll it when the Go log has nothing new to report.
    try {
      if (!fs.existsSync(filePath)) {
        return await this.readNewTranscriptEvents();
      }

      const stats = fs.statSync(filePath);
      const currentSize = stats.size;
      if (currentSize < this.lastReadPosition) {
        this.lastReadPosition = 0;
      }
      if (currentSize === this.lastReadPosition) {
        return await this.readNewTranscriptEvents();
      }

      const buffer = Buffer.alloc(currentSize - this.lastReadPosition);
      const fd = fs.openSync(filePath, "r");
      try {
        fs.readSync(fd, buffer, 0, buffer.length, this.lastReadPosition);
      } finally {
        fs.closeSync(fd);
      }
      this.lastReadPosition = currentSize;

      const events: AntigravityLogEvent[] = [];
      for (const rawLine of buffer.toString("utf8").split(/\r?\n/)) {
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
            type: "session.created",
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
            type: "response.completed",
            line,
            sessionId,
          });
          continue;
        }

        events.push({
          type: "log.line",
          line,
          sessionId,
        });
      }

      const transcriptEvents = await this.readNewTranscriptEvents();
      const completionEvents = events.filter(
        (event) => event.type === "response.completed"
      );
      const nonCompletionEvents = events.filter(
        (event) => event.type !== "response.completed"
      );
      return [...nonCompletionEvents, ...transcriptEvents, ...completionEvents];
    } catch {
      return await this.readNewTranscriptEvents();
    }
  }

  extractResponse(events: BaseCliEvent[]): UniversalCliOutput {
    const outputEvents = events.flatMap((event) =>
      this.extractStructuredEventsFromEvent(event)
    );
    const unmatchedEvents = this.pendingPlannerToolCalls.map((pending) =>
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
    return event.type === "response.completed";
  }

  async discoverSessionLog(
    _promptText: string,
    startTime: Date,
    sessionId?: string
  ): Promise<string | null> {
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
    if (event.type === "response.text" || event.type === "transcript.error") {
      return String((event as AntigravityLogEvent).line ?? "");
    }
    return undefined;
  }

  override extractStructuredEventsFromEvent(event: BaseCliEvent): CliEvent[] {
    const antigravityEvent = event as AntigravityLogEvent;
    const timestamp = antigravityEvent.timestamp ?? Date.now();

    if (antigravityEvent.type === "transcript.planner") {
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
      return structuredEvents;
    }

    if (
      antigravityEvent.type === "transcript.tool" &&
      antigravityEvent.resultEntry
    ) {
      return AntigravityToolEventBuilder.build({
        call: antigravityEvent.toolCall,
        result: antigravityEvent.resultEntry,
        timestamp,
        eventId: antigravityEvent.eventId,
        taskId: antigravityEvent.taskId,
      });
    }

    if (antigravityEvent.type === "transcript.checkpoint") {
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
   * Only reached when `readNewLines` runs, which is itself only triggered by
   * `fs.watch` activity on the tailed cli log (see class doc — this parser
   * does not override `watchLogFile`). A steer typed while the cli log is
   * otherwise quiet is picked up on the next cli-log write rather than
   * instantly; a dedicated transcript poll would close that gap but hasn't
   * been needed for the confirmed background-task-hold scenario.
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
    const events: AntigravityLogEvent[] = [];
    for (const record of records) {
      events.push(...this.mapTranscriptRecord(record, sessionId));
    }
    return events;
  }

  private mapTranscriptRecord(
    record: AntigravityTranscriptRecord,
    sessionId: string
  ): AntigravityLogEvent[] {
    const { entry, eventId } = record;
    const isBackgroundLaunch =
      entry.source === "MODEL" &&
      entry.type === "RUN_COMMAND" &&
      entry.status === "RUNNING";
    const isGenericRunning =
      entry.source === "MODEL" &&
      entry.type === "GENERIC" &&
      entry.status === "RUNNING";
    if (entry.status !== "DONE" && !isBackgroundLaunch && !isGenericRunning) {
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

    if (entry.source === "USER_EXPLICIT" && entry.type === "USER_INPUT") {
      if (typeof entry.content !== "string") {
        return [];
      }
      const text = this.unwrapUserRequest(entry.content);
      return text ? [{ type: "user_input", line: text, ...base }] : [];
    }

    if (entry.source === "MODEL" && entry.type === "PLANNER_RESPONSE") {
      const text =
        typeof entry.content === "string" ? entry.content.trim() : "";
      const thinking = entry.thinking?.trim() ?? "";
      const plannerToolCalls = entry.tool_calls ?? [];
      for (const call of plannerToolCalls) {
        this.pendingPlannerToolCalls.push({
          call,
          plannerEventId: eventId,
          timestamp,
        });
      }
      if (!text && !thinking && !entry.tool_calls?.length) {
        return [];
      }
      return [
        {
          type: "transcript.planner",
          line: text,
          thinking: thinking || undefined,
          plannerToolCalls,
          ...base,
        },
      ];
    }

    if (entry.source === "MODEL" && this.isToolResultEntry(entry)) {
      const call = this.takePlannerCallForResult(entry);
      return [
        {
          type: "transcript.tool",
          line: typeof entry.content === "string" ? entry.content : "",
          toolCall: call?.call,
          resultEntry: entry,
          taskId: this.extractTaskId(entry),
          ...base,
        },
      ];
    }

    if (entry.source === "SYSTEM" && entry.type === "SYSTEM_MESSAGE") {
      return [
        {
          type: "transcript.tool",
          line: typeof entry.content === "string" ? entry.content : "",
          resultEntry: entry,
          taskId: this.extractTaskId(entry),
          ...base,
        },
      ];
    }

    if (entry.source === "SYSTEM" && entry.type === "CHECKPOINT") {
      return [
        {
          type: "transcript.checkpoint",
          line: typeof entry.content === "string" ? entry.content : "",
          ...base,
        },
      ];
    }

    if (
      entry.source === "SYSTEM" &&
      (entry.type === "ERROR_MESSAGE" || entry.type.includes("CANCEL"))
    ) {
      if (typeof entry.content !== "string" || !entry.content.trim()) {
        return [];
      }
      return [
        {
          type: "transcript.error",
          line: entry.content.trim(),
          ...base,
        },
      ];
    }

    return [];
  }

  private isToolResultEntry(entry: AntigravityTranscriptEntry): boolean {
    return [
      "RUN_COMMAND",
      "VIEW_FILE",
      "CODE_ACTION",
      "GENERIC",
      "LIST_DIRECTORY",
      "GREP_SEARCH",
      "MCP_TOOL",
      "LIST_RESOURCES",
      "READ_RESOURCE",
      "SEARCH_WEB",
    ].includes(entry.type);
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
      case "RUN_COMMAND":
        return name === "run_command";
      case "VIEW_FILE":
        return name === "view_file";
      case "CODE_ACTION":
        return [
          "write_to_file",
          "replace_file_content",
          "multi_replace_file_content",
        ].includes(name);
      case "MCP_TOOL":
        return name === "call_mcp_tool";
      case "LIST_RESOURCES":
        return name === "list_resources";
      case "READ_RESOURCE":
        return name === "read_resource";
      case "SEARCH_WEB":
        return name === "search_web";
      case "LIST_DIRECTORY":
        return name === "list_dir";
      case "GREP_SEARCH":
        return name === "grep_search";
      case "GENERIC":
        return ![
          "run_command",
          "view_file",
          "write_to_file",
          "replace_file_content",
          "multi_replace_file_content",
          "list_resources",
          "read_resource",
          "search_web",
          "list_dir",
          "grep_search",
        ].includes(name);
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
      entry.source === "MODEL" &&
      entry.type === "RUN_COMMAND" &&
      entry.status === "RUNNING"
    ) {
      const taskId = this.extractTaskId(entry);
      if (taskId) {
        this.backgroundFollowUpState.launch(taskId);
      }
      return;
    }

    if (
      entry.source === "SYSTEM" &&
      entry.type === "SYSTEM_MESSAGE" &&
      entry.status === "DONE"
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
      entry.source !== "MODEL" ||
      entry.type !== "PLANNER_RESPONSE" ||
      entry.status !== "DONE"
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
   * so the only distinction needed here is against ctrlyoke's own injected prompt.
   */
  override classifyUserEvent(
    event: BaseCliEvent,
    ctx: { dispatchedPromptText?: string }
  ): UserEventClassification {
    const e = event as AntigravityLogEvent;
    if (e.type !== "user_input") {
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
    if (e.type !== "user_input") {
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
   * Rule: pending while any `RUN_COMMAND` background-task launch (`Tool is
   * running as a background task with task id: <sessionId>/task-N`) lacks a
   * matching completion/failure `SYSTEM_MESSAGE` (`Task id "<sessionId>/task-N"
   * finished with result:`). Consuming a matching notification also latches
   * the resumed turn until its terminal planner response, so a Stop that raced
   * the catch-up read cannot commit the workflow. New launches remain
   * independent while that resumed turn is active.
   */
  override hasPendingBackgroundWork(): boolean {
    return this.backgroundFollowUpState.isCompletionBlocked();
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
    if (!event) {
      return undefined;
    }

    const outputTokens = event.outputTokens ?? 0;
    const contextWindowSize =
      event.contextWindowSize ??
      getAntigravityContextWindowSize(event.model ?? this.resolvedModel);
    const inputTokens = Math.max(
      event.contextWindowUsedTokens! - outputTokens,
      0
    );
    return {
      inputTokens,
      outputTokens,
      totalTokens: event.contextWindowUsedTokens!,
      contextWindowUsedTokens: event.contextWindowUsedTokens,
      contextWindowSize,
    };
  }
}
