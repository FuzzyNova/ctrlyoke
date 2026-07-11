import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { BaseLogParser } from "../shared/BaseLogParser";
import { BaseCliEvent, ILogParser } from "../shared/interfaces/ILogParser";
import {
  CLI_EVENT_TYPES,
  HARNESS_IDS,
} from "../../../types/DashboardConstants";
import {
  CliEvent,
  TextData,
  TokenUsage,
  UniversalCliOutput,
} from "../../../types/CliOutputTypes";
import { getAntigravityContextWindowSize } from "../../../utils/ModelConstants";

interface AntigravityLogEvent extends BaseCliEvent {
  type:
    | "session.created"
    | "response.completed"
    | "log.line"
    | "response.text";
  line: string;
  sessionId?: string;
  timestamp?: number;
  model?: string;
  contextWindowUsedTokens?: number;
  contextWindowSize?: number;
  outputTokens?: number;
}

const SESSION_ID_REGEX =
  /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
const TRANSCRIPT_READ_ATTEMPTS = 8;
const TRANSCRIPT_READ_DELAY_MS = 150;

interface AntigravityTranscriptEntry {
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: unknown;
}

export class AntigravityLogParser
  extends BaseLogParser
  implements ILogParser
{
  private cachedSessionId?: string;
  private cachedLastConversationsSessionId?: string;

  override async readNewLines(filePath: string): Promise<BaseCliEvent[]> {
    try {
      if (!fs.existsSync(filePath)) {
        return [];
      }

      const stats = fs.statSync(filePath);
      const currentSize = stats.size;
      if (currentSize < this.lastReadPosition) {
        this.lastReadPosition = 0;
      }
      if (currentSize === this.lastReadPosition) {
        return [];
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

      return events;
    } catch {
      return [];
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
    const candidates = this.findModifiedSessionLogs(this.getLogDirectory(), startTime, {
      filter: (fileName) => /^cli-\d{8}_\d{6}\.log$/.test(fileName),
    });

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
      this.cachedSessionId ??
      this.cachedLastConversationsSessionId ??
      null
    );
  }

  extractContentFromEvent(event: BaseCliEvent): string | undefined {
    if (event.type === "response.text") {
      return String((event as AntigravityLogEvent).line ?? "");
    }
    return undefined;
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

    const transcriptPath = this.getTranscriptPath(sessionId, true);
    const compactTranscriptPath = this.getTranscriptPath(sessionId, false);

    for (let attempt = 0; attempt < TRANSCRIPT_READ_ATTEMPTS; attempt += 1) {
      const event =
        this.readLatestResponseFromTranscript(transcriptPath, sessionId) ??
        this.readLatestResponseFromTranscript(compactTranscriptPath, sessionId);
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
    return (
      this.hasPendingTaskInTranscript(this.getTranscriptPath(sessionId, true)) ||
      this.hasPendingTaskInTranscript(this.getTranscriptPath(sessionId, false))
    );
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
          entry = JSON.parse(line) as AntigravityTranscriptEntry;
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

        const entry = JSON.parse(line) as AntigravityTranscriptEntry;
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
        (candidate) =>
          typeof candidate.contextWindowUsedTokens === "number"
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
