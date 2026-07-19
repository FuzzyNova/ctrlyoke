import type * as fs from "fs";
import type { CliEvent, UserSteerData } from "../../../types/CliOutputTypes";
import { CLI_EVENT_TYPES } from "../../../types/DashboardConstants";
import type { BaseCliEvent, ILogParser } from "./interfaces/ILogParser";

export interface CliLogEventPumpDeps {
  /** Harness-specific log parser. */
  parser: ILogParser;
  /** Resolved model ID, used for context-window lookups. */
  model: string;
  /** Callback for streaming structured CliEvents to the output panel. */
  onStreamingEvents: (events: CliEvent[]) => void;
  /** Called when a streaming event reveals updated context window utilization. */
  onContextWindowUpdate?: (used: number, size: number) => void;
  /**
   * The prompt text ctrlyoke is currently dispatching, if any. Used so
   * `classifyUserEvent` can attribute the echoed-back prompt to dispatch rather
   * than misreading it as a human steer. Leave undefined when tailing outside an
   * active dispatch (e.g. `SessionActivityWatcher` after a step has completed).
   */
  dispatchedPromptText?: string;
}

/**
 * Shared log-tailing core reused by `CliLogMonitor` (per-prompt, terminal at Stop)
 * and `SessionActivityWatcher` (longer-lived, tails past Stop for resumed activity
 * and human follow-ups typed into the live TUI).
 *
 * Owns: timestamp-filtered incremental reads, fs.watch wiring, and per-event
 * processing (structured-event streaming, live context-window updates, and
 * user-steer classification/emission). Does NOT own completion detection,
 * draining deadlines, or event history — those stay caller-specific.
 */
export class CliLogEventPump {
  constructor(private readonly deps: CliLogEventPumpDeps) {}

  /**
   * Process a single log event: stream its structured CliEvents, update the
   * context window, and emit a synthetic USER_STEER event when the event is
   * classified as genuine human input.
   */
  processEvent(event: BaseCliEvent): void {
    this.deps.parser.trackBackgroundWorkState?.(event);

    const structuredEvents =
      this.deps.parser.extractStructuredEventsFromEvent(event);

    const steerEvent = this.buildUserSteerEvent(event);
    const allEvents = steerEvent
      ? [...structuredEvents, steerEvent]
      : structuredEvents;

    if (allEvents.length > 0) {
      this.deps.onStreamingEvents(allEvents);
    }

    if (
      this.deps.onContextWindowUpdate &&
      this.deps.parser.extractLiveContextWindow
    ) {
      const ctx = this.deps.parser.extractLiveContextWindow(
        event,
        this.deps.model
      );
      if (ctx) {
        this.deps.onContextWindowUpdate(ctx.used, ctx.size);
      }
    }
  }

  /**
   * Read new log lines since the parser's last read position, filtered to
   * entries at/after `startTime`.
   */
  async readNewEntriesSince(
    logPath: string,
    startTime: Date
  ): Promise<BaseCliEvent[]> {
    const entries = await this.deps.parser.readNewLines(logPath);
    return entries.filter((entry) => {
      const entryTime = this.deps.parser.extractTimestamp?.(entry) ?? null;
      return !(entryTime && entryTime < startTime);
    });
  }

  /**
   * Start watching the log file. The underlying parser already filters
   * callbacks to entries at/after `startTime`.
   */
  watch(
    logPath: string,
    startTime: Date,
    onEntry: (event: BaseCliEvent) => void
  ): fs.FSWatcher {
    return this.deps.parser.watchLogFile(logPath, onEntry, startTime);
  }

  private buildUserSteerEvent(event: BaseCliEvent): CliEvent | undefined {
    if (!this.deps.parser.classifyUserEvent) {
      return undefined;
    }

    const classification = this.deps.parser.classifyUserEvent(event, {
      dispatchedPromptText: this.deps.dispatchedPromptText,
    });
    if (classification !== "human-steer") {
      return undefined;
    }

    const text = this.deps.parser.extractUserSteerText?.(event);
    if (!text) {
      return undefined;
    }

    const timestamp =
      this.deps.parser.extractTimestamp?.(event)?.getTime() ??
      (typeof event.timestamp === "number" ? event.timestamp : Date.now());

    return {
      type: CLI_EVENT_TYPES.USER_STEER,
      timestamp,
      data: { text } as UserSteerData,
    };
  }
}
