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
  isAntigravityTranscriptEntry,
} from "./AntigravityTranscriptTypes";
import {
  AntigravityTranscriptReader,
  AntigravityTranscriptRecord,
} from "./AntigravityTranscriptReader";

interface AntigravityLogEvent extends BaseCliEvent {
  type:
    | "session.created"
    | "response.completed"
    | "log.line"
    | "response.text"
    | "user_input"
    | "transcript.planner"
    | "transcript.checkpoint"
    | "transcript.error";
  line: string;
  sessionId?: string;
  timestamp?: number;
  eventId?: string;
  transcriptEntry?: AntigravityTranscriptEntry;
  thinking?: string;
  plannerToolCalls?: AntigravityTranscriptEntry["tool_calls"];
  model?: string;
  contextWindowUsedTokens?: number;
  contextWindowSize?: number;
  outputTokens?: number;
}

const SESSION_ID_REGEX =
  /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
const TRANSCRIPT_READ_ATTEMPTS = 8;
const TRANSCRIPT_READ_DELAY_MS = 150;

export class AntigravityLogParser extends BaseLogParser implements ILogParser {
  private cachedSessionId?: string;
  private cachedLastConversationsSessionId?: string;
  private readonly transcriptReader = new AntigravityTranscriptReader();

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
          this.cachedSessionId = sessionId;
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
      return [...events, ...transcriptEvents];
    } catch {
      return await this.readNewTranscriptEvents();
    }
  }

  extractResponse(events: BaseCliEvent[]): UniversalCliOutput {
    const text = events
      .map((event) =>
        event.type === "response.text"
          ? String((event as AntigravityLogEvent).line ?? "")
          : ""
      )
      .filter(Boolean)
      .join("\n")
      .trim();

    const outputEvents: CliEvent[] = text
      ? [
          {
            type: CLI_EVENT_TYPES.TEXT,
            timestamp: Date.now(),
            data: { text } as TextData,
          },
        ]
      : [];

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

  override async getFinalEventsOnCompletion(
    _logPath: string
  ): Promise<BaseCliEvent[]> {
    const sessionId =
      this.cachedSessionId ?? this.cachedLastConversationsSessionId;
    if (!sessionId) {
      return [];
    }

    const transcriptPath = this.getAuthoritativeTranscriptPath(sessionId);
    if (!transcriptPath) {
      return [];
    }

    for (let attempt = 0; attempt < TRANSCRIPT_READ_ATTEMPTS; attempt += 1) {
      const event = this.readLatestResponseFromTranscript(
        transcriptPath,
        sessionId
      );
      if (event) {
        return [event];
      }

      await new Promise((resolve) =>
        setTimeout(resolve, TRANSCRIPT_READ_DELAY_MS)
      );
    }

    return [];
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
    const transcriptPath = this.getAuthoritativeTranscriptPath(sessionId);
    if (!transcriptPath) {
      return [];
    }
    const records = await this.transcriptReader.readRecords(transcriptPath);
    return records.flatMap((record) =>
      this.mapTranscriptRecord(record, sessionId)
    );
  }

  private mapTranscriptRecord(
    record: AntigravityTranscriptRecord,
    sessionId: string
  ): AntigravityLogEvent[] {
    const { entry, eventId } = record;
    if (entry.status !== "DONE") {
      return [];
    }

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
      if (!text && !thinking && !entry.tool_calls?.length) {
        return [];
      }
      return [
        {
          type: "transcript.planner",
          line: text,
          thinking: thinking || undefined,
          plannerToolCalls: entry.tool_calls,
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
   * Classify a synthetic `user_input` event (see `readNewUserSteerEvents`).
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
   * Claude/Copilot this reads the transcript directly on demand instead of
   * tracking incremental cli-log state. See
   * `dev/backlog/TERMINAL_FOLLOWUP_TRACKING_PLAN.md`, "Antigravity CLI — CONFIRMED".
   *
   * Rule: pending iff any `RUN_COMMAND` background-task launch (`Tool is
   * running as a background task with task id: <sessionId>/task-N`) lacks a
   * matching completion `SYSTEM_MESSAGE` (`Task id "<sessionId>/task-N"
   * finished with result:`). Safe as "any launched, not just most-recent" —
   * each background task gets its own monotonic task-N id and (for any
   * terminating command) its own completion message, so there is no
   * superseded/"zombie" case observed in the investigated sample. If one
   * ever surfaces, fall back to Claude's most-recent-launch rule instead.
   */
  override hasPendingBackgroundWork(): boolean {
    const sessionId =
      this.cachedSessionId ?? this.cachedLastConversationsSessionId;
    if (!sessionId) {
      return false;
    }
    const transcriptPath = this.getAuthoritativeTranscriptPath(sessionId);
    return transcriptPath
      ? this.hasPendingTaskInTranscript(transcriptPath)
      : false;
  }

  private hasPendingTaskInTranscript(transcriptPath: string): boolean {
    try {
      if (!fs.existsSync(transcriptPath)) {
        return false;
      }

      const launchedTaskIds = new Set<string>();
      const finishedTaskIds = new Set<string>();
      const content = fs.readFileSync(transcriptPath, "utf8");

      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }

        let entry: AntigravityTranscriptEntry;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!isAntigravityTranscriptEntry(parsed)) {
            continue;
          }
          entry = parsed;
        } catch {
          continue;
        }
        if (typeof entry.content !== "string") {
          continue;
        }

        if (entry.source === "MODEL" && entry.type === "RUN_COMMAND") {
          const match = entry.content.match(
            /background task with task id:\s*(\S+?)[.\s]*$/m
          );
          if (match) {
            launchedTaskIds.add(match[1]);
          }
        }

        if (entry.source === "SYSTEM" && entry.type === "SYSTEM_MESSAGE") {
          const match = entry.content.match(
            /Task id "([^"]+)" finished with result/
          );
          if (match) {
            finishedTaskIds.add(match[1]);
          }
        }
      }

      for (const taskId of launchedTaskIds) {
        if (!finishedTaskIds.has(taskId)) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
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

  private readLatestResponseFromTranscript(
    transcriptPath: string,
    sessionId: string
  ): AntigravityLogEvent | undefined {
    try {
      if (!fs.existsSync(transcriptPath)) {
        return undefined;
      }

      const content = fs.readFileSync(transcriptPath, "utf8");
      let latest: AntigravityLogEvent | undefined;

      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }

        const parsed: unknown = JSON.parse(line);
        if (!isAntigravityTranscriptEntry(parsed)) {
          continue;
        }
        const entry = parsed;
        if (
          entry.source !== "MODEL" ||
          entry.type !== "PLANNER_RESPONSE" ||
          entry.status !== "DONE" ||
          typeof entry.content !== "string" ||
          entry.content.trim().length === 0
        ) {
          continue;
        }

        latest = {
          type: "response.text",
          line: entry.content.trim(),
          sessionId,
          timestamp: entry.created_at
            ? new Date(entry.created_at).getTime()
            : Date.now(),
          model: this.resolvedModel || undefined,
        };
      }

      return latest;
    } catch {
      return undefined;
    }
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
