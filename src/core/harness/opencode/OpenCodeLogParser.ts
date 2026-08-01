import { execFile } from "child_process";
import { promisify } from "util";
import type * as fs from "fs";
import { BaseLogParser } from "../shared/BaseLogParser";
import {
  BaseCliEvent,
  UserEventClassification,
} from "../shared/interfaces/ILogParser";
import {
  UniversalCliOutput,
  CliEvent,
  TokenUsage,
  CompactionData,
} from "../../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  COMPACTION_TRIGGERS,
  CALLER_TYPES,
} from "../../../types/DashboardConstants";
import {
  mapOpenCodeToolPartToCliEvent,
  accumulateOpenCodeStepTokens,
} from "./OpenCodeEventMapper";
import { Log } from "../../../utils/Log";
import { resolveCliCommand } from "../shared/CliLauncherResolver";
import { PollingFsWatcher } from "../shared/FsWatcherHandles";

const execFileAsync = promisify(execFile);

/** Polling interval (ms) between `opencode export` calls in interactive mode */
const EXPORT_POLL_INTERVAL_MS = 1000;

type OpenCodeExportRunner = (sessionId: string) => Promise<string>;

/**
 * Run OpenCode's export command through the same platform-aware launcher used
 * to spawn the interactive TUI. On Windows, calling a bare `opencode` through
 * a shell depends on the extension host's PATH, which may not include npm's
 * shim directory even when the TUI itself launched successfully.
 */
async function runOpenCodeExport(sessionId: string): Promise<string> {
  const command = await resolveCliCommand("opencode", ["export", sessionId]);
  const { stdout } = await execFileAsync(command.command, command.args, {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
    windowsVerbatimArguments: command.requiresShellVerbatimArgs,
  });
  return stdout;
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

  constructor(
    contextWindowSizeFn: () => number | undefined = () => undefined,
    private readonly runExport: OpenCodeExportRunner = runOpenCodeExport
  ) {
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
    sessionId?: string,
    signal?: AbortSignal
  ): Promise<string | null> {
    return Promise.resolve(signal?.aborted ? null : (sessionId ?? null));
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
   * @returns A PollingFsWatcher (implements fs.FSWatcher); call .close() to stop
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

    return new PollingFsWatcher(interval);
  }

  /** Running total from the most recent step_finish token event — updated in extractLiveContextWindow. */
  private liveLastStepTotal: number | undefined;

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

  override extractLiveContextWindow(
    event: BaseCliEvent,
    _modelId: string
  ): { used: number; size: number } | null {
    if (event.type === "step_finish") {
      const tokens = (event as Record<string, any>).part?.tokens as
        | Record<string, any>
        | undefined;
      if (tokens !== undefined) {
        const total =
          typeof tokens.total === "number" ? tokens.total : undefined;
        if (total !== undefined) {
          this.liveLastStepTotal = total;
        }
      }
    }
    const size = this.contextWindowSizeFn();
    if (
      this.liveLastStepTotal !== undefined &&
      this.liveLastStepTotal > 0 &&
      size
    ) {
      return { used: this.liveLastStepTotal, size };
    }
    return null;
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

  /**
   * Classify a synthetic `user_text` event (see `extractNewEventsFromExport`,
   * which emits these for `user`-role message text parts — a shape OpenCode's
   * export never mixes with tool results or resume signals, so the only
   * distinction needed is against ctrlyoke's own injected prompt).
   */
  override classifyUserEvent(
    event: BaseCliEvent,
    ctx: { dispatchedPromptText?: string }
  ): UserEventClassification {
    if (event.type !== "user_text") {
      return "other";
    }
    const text = (
      (event as Record<string, any>).text as string | undefined
    )?.trim();
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
      if (normalizedLogged.includes(normalizedDispatched)) {
        return "injected-prompt";
      }
    }

    return "human-steer";
  }

  override extractUserSteerText(event: BaseCliEvent): string | undefined {
    if (event.type !== "user_text") {
      return undefined;
    }
    const text = (
      (event as Record<string, any>).text as string | undefined
    )?.trim();
    return text || undefined;
  }

  extractContentFromEvent(event: BaseCliEvent): string | undefined {
    if (event.type !== "text") {
      return undefined;
    }
    return (event as Record<string, any>).part?.text as string | undefined;
  }

  /**
   * Extract structured CliEvents from a single OpenCode log event for streaming.
   *
   * OpenCode events are already strongly typed by `convertPartToEvent`, so this
   * mirrors the `extractResponse` switch exactly but for a single event:
   * - `text`               → TEXT CliEvent
   * - `thinking`           → THINKING CliEvent
   * - `tool_use`           → semantic INITIATED event via mapOpenCodeToolPartToCliEvent
   *
   * step_start and step_finish carry no displayable content and produce no events.
   */
  extractStructuredEventsFromEvent(event: BaseCliEvent): CliEvent[] {
    const e = event as Record<string, any>;
    const cliEvents: CliEvent[] = [];
    const timestamp = e.timestamp as number | undefined;

    switch (event.type) {
      case "text": {
        const text = e.part?.text as string | undefined;
        if (text) {
          cliEvents.push({
            type: CLI_EVENT_TYPES.TEXT,
            timestamp,
            data: { text },
          });
        }
        break;
      }
      case CLI_EVENT_TYPES.THINKING: {
        const text = e.part?.text as string | undefined;
        if (text) {
          cliEvents.push({
            type: CLI_EVENT_TYPES.THINKING,
            timestamp,
            data: { text },
          });
        }
        break;
      }
      case "tool_use": {
        const part = e.part as Record<string, any> | undefined;
        if (part) {
          const toolEvent = mapOpenCodeToolPartToCliEvent(timestamp, part);
          if (toolEvent) {
            cliEvents.push(toolEvent);
          }
        }
        break;
      }
      case "compaction": {
        // Context was compacted to free up the context window
        cliEvents.push({
          type: CLI_EVENT_TYPES.COMPACTION,
          timestamp,
          data: {
            trigger:
              e.part?.auto === false
                ? COMPACTION_TRIGGERS.MANUAL
                : COMPACTION_TRIGGERS.AUTO,
            overflow: e.part?.overflow,
          } as CompactionData,
        });
        break;
      }
      case "subtask": {
        // A subagent was spawned via the task tool — show as a generic tool call
        const desc = e.part?.description as string | undefined;
        const agent = e.part?.agent as string | undefined;
        cliEvents.push({
          type: CLI_EVENT_TYPES.TOOL_CALL,
          timestamp,
          callerType: CALLER_TYPES.DIRECT,
          data: {
            name: "task",
            parameters: {
              description: desc,
              agent,
              model: e.part?.model,
            },
          },
        });
        break;
      }
      case "retry": {
        // Retry attempt — surface as text so the user sees it
        const attempt = e.part?.attempt as number | undefined;
        const errMsg = e.part?.error as string | undefined;
        const text = errMsg
          ? `\u26a0\ufe0f Retry attempt ${attempt ?? ""}: ${errMsg}`
          : `\u26a0\ufe0f Retry attempt ${attempt ?? ""}`;
        cliEvents.push({
          type: CLI_EVENT_TYPES.TEXT,
          timestamp,
          data: { text },
        });
        break;
      }
    }

    return cliEvents;
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
        case CLI_EVENT_TYPES.THINKING: {
          const text = e.part?.text as string | undefined;
          if (text) {
            cliEvents.push({
              type: CLI_EVENT_TYPES.THINKING,
              timestamp: e.timestamp as number | undefined,
              data: { text },
            });
          }
          break;
        }
        case "tool_use": {
          const part = e.part as Record<string, any> | undefined;
          if (part) {
            const toolEvent = mapOpenCodeToolPartToCliEvent(
              e.timestamp as number | undefined,
              part
            );
            if (toolEvent) {
              cliEvents.push(toolEvent);
            }
          }
          break;
        }
        case "compaction": {
          cliEvents.push({
            type: CLI_EVENT_TYPES.COMPACTION,
            timestamp: e.timestamp as number | undefined,
            data: {
              trigger:
                e.part?.auto === false
                  ? COMPACTION_TRIGGERS.MANUAL
                  : COMPACTION_TRIGGERS.AUTO,
              overflow: e.part?.overflow,
            } as CompactionData,
          });
          break;
        }
        case "subtask": {
          cliEvents.push({
            type: CLI_EVENT_TYPES.TOOL_CALL,
            timestamp: e.timestamp as number | undefined,
            callerType: CALLER_TYPES.DIRECT,
            data: {
              name: "task",
              parameters: {
                description: e.part?.description,
                agent: e.part?.agent,
                model: e.part?.model,
              },
            },
          });
          break;
        }
        case "retry": {
          const attempt = e.part?.attempt as number | undefined;
          const errMsg = e.part?.error as string | undefined;
          const text = errMsg
            ? `\u26a0\ufe0f Retry attempt ${attempt ?? ""}: ${errMsg}`
            : `\u26a0\ufe0f Retry attempt ${attempt ?? ""}`;
          cliEvents.push({
            type: CLI_EVENT_TYPES.TEXT,
            timestamp: e.timestamp as number | undefined,
            data: { text },
          });
          break;
        }
        case "step_finish": {
          const tokens = e.part?.tokens as Record<string, any> | undefined;
          if (tokens) {
            const stepTotal = accumulateOpenCodeStepTokens(tokens, tokenUsage);
            if (stepTotal !== undefined) lastStepTotal = stepTotal;
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

  async getFinalEventsOnCompletion(sessionId: string): Promise<BaseCliEvent[]> {
    return this.fetchNewEvents(sessionId);
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
      const stdout = await this.runExport(sessionId);
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
   *
   * Parts are only marked seen once they are in a final/completed state.
   * OpenCode writes parts incrementally (same ID, status pending → completed),
   * so a part polled while still running would have empty input/text.
   * Skipping incomplete parts lets the next poll pick them up when finished.
   */
  private extractNewEventsFromExport(
    exportData: OpenCodeExport
  ): BaseCliEvent[] {
    const newEvents: BaseCliEvent[] = [];

    for (const message of exportData.messages) {
      const messageTimestamp = message.info.time?.created ?? Date.now();

      // User messages carry no displayable AI output, but their `text` parts
      // are candidate user-steer events (ctrlyoke's own injected prompt, or a
      // genuine follow-up typed into the live TUI) — see classifyUserEvent.
      // Unlike assistant parts, user text is already final the moment it
      // appears in the export, so isPartCompleted's streaming check doesn't apply.
      if (message.info.role === "user") {
        for (const part of message.parts) {
          if (this.seenPartIds.has(part.id) || part.type !== "text") {
            continue;
          }
          this.seenPartIds.add(part.id);
          const text = (part as any).text as string | undefined;
          if (text && text.trim()) {
            newEvents.push({
              type: "user_text",
              sessionID: part.sessionID,
              timestamp: (part as any).time?.start ?? messageTimestamp,
              text: text.trim(),
            });
          }
        }
        continue;
      }

      // Only assistant messages contain displayable AI-output events
      if (message.info.role !== "assistant") {
        continue;
      }

      for (const part of message.parts) {
        if (this.seenPartIds.has(part.id)) {
          continue;
        }

        // Skip parts that are still in-progress so we don't capture partial data.
        // They will be picked up on the next poll once finalized.
        if (!this.isPartCompleted(part)) {
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
   * Returns true when a part has reached its final state and its data is safe
   * to capture. OpenCode updates parts in-place as they progress, so we must
   * wait for completion before recording to avoid empty/partial fields.
   */
  private isPartCompleted(part: OpenCodeExportPart): boolean {
    const p = part as any;
    switch (part.type) {
      case "tool":
        // Tool parts transition through "pending" → "completed"; only emit when done.
        return p.state?.status === "completed";
      case "text":
      case "reasoning":
        // Text/reasoning parts are finalized when time.end is set.
        return p.time?.end !== undefined;
      default:
        // step-start, step-finish, patch, etc. are atomic and always final.
        return true;
    }
  }

  /**
   * Convert an opencode export part to a JSONL-style BaseCliEvent.
   *
   * The resulting event shape matches what `opencode run --format json` emits,
   * so extractResponse / isComplete / extractContentFromEvent work uniformly
   * for both headless (streaming) and interactive (export-polled) modes.
   *
   * Part type mapping:
   *   step-start   → step_start
   *   step-finish  → step_finish  (carries reason + tokens)
   *   text         → text         (carries part.text)
   *   tool         → tool_use     (carries part.tool + part.state)
   *   reasoning    → thinking     (carries part.text — extended thinking content)
   *   compaction   → compaction   (carries auto + overflow flags)
   *   subtask      → subtask      (carries description + agent + model)
   *   retry        → retry        (carries attempt + error message)
   *   patch        → (skipped)
   *   snapshot     → (skipped)
   *   file         → (skipped — user file attachments, not AI output)
   *   agent        → (skipped — internal routing metadata)
   */
  private convertPartToEvent(
    part: OpenCodeExportPart,
    messageTimestamp: number
  ): BaseCliEvent | null {
    const { sessionID } = part;

    switch (part.type) {
      case "step-start":
        return {
          type: "step_start",
          sessionID,
          timestamp: messageTimestamp,
          part,
        };

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

      case "reasoning":
        return {
          type: CLI_EVENT_TYPES.THINKING,
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

      case "compaction":
        // Context was compacted to free up the context window
        return {
          type: "compaction",
          sessionID,
          timestamp: messageTimestamp,
          part: {
            auto: (part as any).auto,
            overflow: (part as any).overflow,
          },
        };

      case "subtask":
        // A subagent was spawned via the task tool
        return {
          type: "subtask",
          sessionID,
          timestamp: messageTimestamp,
          part: {
            description: (part as any).description,
            agent: (part as any).agent,
            model: (part as any).model,
            prompt: (part as any).prompt,
          },
        };

      case "retry":
        // Retry attempt — surface as a visible event
        return {
          type: "retry",
          sessionID,
          timestamp: (part as any).time?.created ?? messageTimestamp,
          part: {
            attempt: (part as any).attempt,
            error: (part as any).error,
          },
        };

      default:
        return null;
    }
  }
}
