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
  UniversalCliOutput,
} from "../../../types/CliOutputTypes";

interface AntigravityLogEvent extends BaseCliEvent {
  type:
    | "session.created"
    | "response.completed"
    | "log.line"
    | "response.text";
  line: string;
  sessionId?: string;
}

const SESSION_ID_REGEX =
  /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

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
        event.type === "response.text" || event.type === "log.line"
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

    return {
      events: outputEvents,
      metadata: {
        harness: HARNESS_IDS.ANTIGRAVITY_CLI,
        sessionId: this.extractSessionId(events) ?? undefined,
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

  formatStatistics(metadata: BaseCliEvent): string {
    const parts = this.buildCommonStatisticsParts(metadata, 8, "...");
    return parts.join(" | ");
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

  private extractSessionIdFromLine(line: string): string | undefined {
    const match = line.match(SESSION_ID_REGEX);
    return match?.[1];
  }
}
