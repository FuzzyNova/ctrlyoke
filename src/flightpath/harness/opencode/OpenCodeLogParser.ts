import * as path from "path";
import * as os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { EventEmitter } from "events";
import type * as fs from "fs";
import { BaseLogParser } from "../shared/BaseLogParser";
import { BaseCliEvent } from "../shared/interfaces/ILogParser";
import { UniversalCliOutput, CliEvent, TokenUsage } from "../../../types/CliOutputTypes";
import { CLI_EVENT_TYPES } from "../../../types/DashboardConstants";
import { Log } from "../../../utils/Log";

const execAsync = promisify(exec);

/** Polling interval (ms) between `opencode export` calls in interactive mode */
const EXPORT_POLL_INTERVAL_MS = 1000;

/**
 * Minimal fs.FSWatcher shim backed by a polling interval.
 *
 * CliLogMonitor only needs close() and EventEmitter methods (on/off/emit).
 * This shim satisfies the fs.FSWatcher interface without touching the file system.
 */
class PollingWatcher extends EventEmitter implements fs.FSWatcher {
  private readonly _cleanup: () => void;

  constructor(cleanup: () => void) {
    super();
    this._cleanup = cleanup;
  }

  close(): void {
    this._cleanup();
    this.emit("close");
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

// ──────────────────────────────────────────────────────────────────
// Local type aliases for the opencode export JSON structure
// ──────────────────────────────────────────────────────────────────

interface OpenCodeExport {
  info: { id: string; [key: string]: unknown };
  messages: OpenCodeExportMessage[];
}

interface OpenCodeExportMessage {
  info: {
    role: string;
    time?: { created?: number; completed?: number };
    [key: string]: unknown;
  };
  parts: OpenCodeExportPart[];
}

interface OpenCodeExportPart {
  type: string;
  id: string;
  sessionID: string;
  messageID: string;
  [key: string]: unknown;
}

/**
 * OpenCode CLI Log Parser
 *
 * OpenCode does not write session log files like Copilot or Claude.
 * Instead, this parser polls `opencode export <sessionId>` on a fixed interval
 * and converts the returned JSON into JSONL-style BaseCliEvents — matching the
 * same event shape produced by `opencode run --format json`.
 *
 * The "log path" passed through CliIntegration and CliLogMonitor is the session
 * ID itself (e.g. `ses_340325359ffejJqLbgD9CkEEq3`), obtained from the
 * OpenCodeNotificationMonitor completion plugin.
 *
 * Flow:
 *   discoverSessionLog(...)       → returns sessionId (or null if unknown)
 *   watchLogFile(sessionId, ...)  → polls opencode export, emits new events
 *   readNewLines(sessionId)       → single export call, returns new events
 *   isComplete(event)             → detects step_finish with reason === "stop"
 *   extractResponse(events)       → assembles UniversalCliOutput from events
 */
export class OpenCodeLogParser extends BaseLogParser {
  /** Part IDs already emitted — prevents re-emitting on re-poll */
  private readonly seenPartIds = new Set<string>();

  /**
   * Returns the context window size (in tokens) for the current model.
   * Injected from OpenCodeCliProvider so parsers don't call the CLI themselves.
   */
  private readonly contextWindowSizeFn: () => number | undefined;

  constructor(contextWindowSizeFn: () => number | undefined = () => undefined) {
    super();
    this.contextWindowSizeFn = contextWindowSizeFn;
  }

  // ──────────────────────────────────────────────────────────────────
  // ILogParser contract
  // ──────────────────────────────────────────────────────────────────

  /**
   * For OpenCode, the "log path" is the session ID.
   * Session IDs arrive via the notification monitor plugin.
   * If no session ID is available, returns null (monitoring cannot proceed).
   */
  discoverSessionLog(
    _promptText: string,
    _startTime: Date,
    sessionId?: string
  ): Promise<string | null> {
    return Promise.resolve(sessionId ?? null);
  }

  /**
   * Override: instead of reading a file, call `opencode export <sessionId>`
   * and return any parts not yet emitted.
   *
   * @param sessionId The "log path" — actually the session ID for this harness
   */
  async readNewLines(sessionId: string): Promise<BaseCliEvent[]> {
    return this.fetchNewEvents(sessionId);
  }

  /**
   * Override: set up a polling interval that calls `opencode export <sessionId>`
   * instead of watching a file with fs.watch.
   *
   * @param sessionId The "log path" — actually the session ID for this harness
   * @param callback  Called for each new BaseCliEvent
   * @param startTime Only emit events with timestamps >= startTime
   * @returns A PollingWatcher (implements fs.FSWatcher); call .close() to stop
   */
  watchLogFile(
    sessionId: string,
    callback: (entry: BaseCliEvent) => void,
    startTime: Date
  ): fs.FSWatcher {
    const interval = setInterval(async () => {
      try {
        const newEvents = await this.fetchNewEvents(sessionId);
        for (const event of newEvents) {
          const entryTime = this.extractTimestamp(event);
          if (entryTime && entryTime < startTime) {
            continue;
          }
          callback(event);
        }
      } catch (error) {
        Log.debug(`[OpenCodeLogParser] Export poll error: ${error}`);
      }
    }, EXPORT_POLL_INTERVAL_MS);

    return new PollingWatcher(() => clearInterval(interval));
  }

  /**
   * A session is complete when a step_finish event carries reason === "stop".
   * This mirrors the final event emitted by `opencode run --format json`.
   */
  isComplete(event: BaseCliEvent): boolean {
    return (
      event.type === "step_finish" &&
      (event as Record<string, any>).part?.reason === "stop"
    );
  }

  extractSessionId(events: BaseCliEvent[]): string | null {
    for (const event of events) {
      const sessionID = (event as Record<string, any>).sessionID;
      if (typeof sessionID === "string") {
        return sessionID;
      }
    }
    return null;
  }

  extractContentFromEvent(event: BaseCliEvent): string | undefined {
    if (event.type !== "text") {
      return undefined;
    }
    return (event as Record<string, any>).part?.text as string | undefined;
  }

  extractResponse(events: BaseCliEvent[]): UniversalCliOutput {
    const cliEvents: CliEvent[] = [];
    let sessionId: string | undefined;
    const tokenUsage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    let lastStepTotal: number | undefined;

    for (const event of events) {
      const e = event as Record<string, any>;

      if (typeof e.sessionID === "string" && !sessionId) {
        sessionId = e.sessionID;
      }

      switch (event.type) {
        case "text": {
          const text = e.part?.text as string | undefined;
          if (text) {
            cliEvents.push({
              type: CLI_EVENT_TYPES.TEXT,
              timestamp: e.timestamp as number | undefined,
              data: { text },
            });
          }
          break;
        }
        case "tool_use": {
          const part = e.part as Record<string, any> | undefined;
          if (part) {
            const toolEvent = this.mapToolPartToCliEvent(
              e.timestamp as number | undefined,
              part
            );
            if (toolEvent) {
              cliEvents.push(toolEvent);
            }
          }
          break;
        }
        case "step_finish": {
          const tokens = e.part?.tokens as Record<string, any> | undefined;
          if (tokens) {
            tokenUsage.inputTokens =
              (tokenUsage.inputTokens ?? 0) + ((tokens.input as number) ?? 0);
            tokenUsage.outputTokens =
              (tokenUsage.outputTokens ?? 0) +
              ((tokens.output as number) ?? 0);
            tokenUsage.totalTokens =
              (tokenUsage.totalTokens ?? 0) +
              ((tokens.input as number) ?? 0) +
              ((tokens.output as number) ?? 0);
            if (tokens.cache?.read) {
              tokenUsage.cachedInputTokens =
                (tokenUsage.cachedInputTokens ?? 0) +
                (tokens.cache.read as number);
            }
            // tokens.total = full context occupancy for this step; track the last value.
            if (typeof tokens.total === "number") {
              lastStepTotal = tokens.total as number;
            }
          }
          break;
        }
      }
    }

    if (lastStepTotal !== undefined) {
      tokenUsage.contextWindowUsedTokens = lastStepTotal;
    }
    const contextWindowSize = this.contextWindowSizeFn();
    if (contextWindowSize !== undefined) {
      tokenUsage.contextWindowSize = contextWindowSize;
    }

    return {
      events: cliEvents,
      metadata: { sessionId, usage: tokenUsage },
    };
  }

  formatStatistics(metadata: BaseCliEvent): string {
    const parts = this.buildCommonStatisticsParts(metadata, 8, "...");
    return parts.join(" | ");
  }

  getLogDirectory(): string {
    return path.join(os.homedir(), ".config", "opencode", "logs");
  }

  // ──────────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────────

  /**
   * Run `opencode export <sessionId>` and return only parts not yet seen.
   * Updates seenPartIds so repeated calls are incremental.
   */
  private async fetchNewEvents(sessionId: string): Promise<BaseCliEvent[]> {
    try {
      const { stdout } = await execAsync(`opencode export ${sessionId}`, {
        timeout: 10000,
      });
      const exportData = JSON.parse(stdout) as OpenCodeExport;
      return this.extractNewEventsFromExport(exportData);
    } catch (error) {
      Log.debug(`[OpenCodeLogParser] opencode export failed: ${error}`);
      return [];
    }
  }

  /**
   * Walk export messages in chronological order and emit events for
   * any parts not already tracked in seenPartIds.
   */
  private extractNewEventsFromExport(
    exportData: OpenCodeExport
  ): BaseCliEvent[] {
    const newEvents: BaseCliEvent[] = [];

    for (const message of exportData.messages) {
      // Only assistant messages contain displayable events
      if (message.info.role !== "assistant") {
        continue;
      }

      const messageTimestamp = message.info.time?.created ?? Date.now();

      for (const part of message.parts) {
        if (this.seenPartIds.has(part.id)) {
          continue;
        }
        this.seenPartIds.add(part.id);

        const event = this.convertPartToEvent(part, messageTimestamp);
        if (event) {
          newEvents.push(event);
        }
      }
    }

    return newEvents;
  }

  /**
   * Convert an opencode export part to a JSONL-style BaseCliEvent.
   *
   * The resulting event shape matches what `opencode run --format json` emits,
   * so extractResponse / isComplete / extractContentFromEvent work uniformly
   * for both headless (streaming) and interactive (export-polled) modes.
   *
   * Part type mapping:
   *   step-start  → step_start
   *   step-finish → step_finish  (carries reason + tokens)
   *   text        → text         (carries part.text)
   *   tool        → tool_use     (carries part.tool + part.state)
   *   reasoning   → (skipped)
   *   patch       → (skipped)
   */
  private convertPartToEvent(
    part: OpenCodeExportPart,
    messageTimestamp: number
  ): BaseCliEvent | null {
    const { sessionID } = part;

    switch (part.type) {
      case "step-start":
        return { type: "step_start", sessionID, timestamp: messageTimestamp, part };

      case "step-finish":
        return {
          type: "step_finish",
          sessionID,
          timestamp: messageTimestamp,
          part: {
            reason: (part as any).reason,
            tokens: (part as any).tokens,
          },
        };

      case "text":
        return {
          type: "text",
          sessionID,
          timestamp: (part as any).time?.start ?? messageTimestamp,
          part: { text: (part as any).text },
        };

      case "tool":
        return {
          type: "tool_use",
          sessionID,
          timestamp: (part as any).state?.time?.start ?? messageTimestamp,
          part: {
            tool: (part as any).tool,
            callID: (part as any).callID,
            state: (part as any).state,
          },
        };

      default:
        return null;
    }
  }

  /**
   * Map a tool_use part to a CliEvent for display.
   * Handles the opencode tool names (read, write, edit, bash) and their
   * camelCase input field names (filePath vs file_path).
   */
  private mapToolPartToCliEvent(
    timestamp: number | undefined,
    part: Record<string, any>
  ): CliEvent | undefined {
    const toolName = part.tool as string | undefined;
    if (!toolName) {
      return undefined;
    }

    const input = part.state?.input ?? {};
    const output = part.state?.output ?? "";
    const isCompleted = part.state?.status === "completed";

    switch (toolName) {
      case "bash":
        return {
          type: CLI_EVENT_TYPES.BASH_COMMAND,
          timestamp,
          data: {
            command: input.command ?? "",
            output: typeof output === "string" ? output : JSON.stringify(output),
            exitCode: part.state?.metadata?.exit,
          },
        };

      case "write":
        return {
          type: CLI_EVENT_TYPES.FILE_WRITE,
          timestamp,
          data: {
            path: input.filePath ?? input.path ?? input.file_path ?? "",
            content: input.content ?? "",
          },
        };

      case "edit": {
        const filediff = part.state?.metadata?.filediff;
        return {
          type: CLI_EVENT_TYPES.FILE_EDIT,
          timestamp,
          data: {
            path: input.filePath ?? input.path ?? input.file_path ?? "",
            oldContent: filediff?.before ?? input.oldString ?? "",
            newContent: filediff?.after ?? input.newString ?? "",
            originalFile: filediff?.before,
            success: isCompleted,
          },
        };
      }

      case "read":
        return {
          type: CLI_EVENT_TYPES.FILE_READ,
          timestamp,
          data: {
            path: input.filePath ?? input.path ?? input.file_path ?? "",
          },
        };

      default:
        return {
          type: CLI_EVENT_TYPES.TOOL_CALL,
          timestamp,
          data: {
            name: toolName,
            parameters: input as Record<string, unknown>,
            result: isCompleted
              ? {
                  success: true,
                  output:
                    typeof output === "string" ? output : JSON.stringify(output),
                }
              : undefined,
          },
        };
    }
  }
}
