import type { CliEvent } from "../../types/CliOutputTypes";
import { Log } from "../../utils/Log";
import { CliLogEventPump } from "./shared/CliLogEventPump";
import type { ILogParser } from "./shared/interfaces/ILogParser";

export interface SessionActivityWatcherDeps {
  /** Same `ILogParser` instance the just-finished `CliLogMonitor` used, so its
   *  internal read offset is already caught up — no offset hand-off needed. */
  parser: ILogParser;
  /** Resolved model ID, used for context-window lookups. */
  model: string;
  /** Fired with any resumed activity's CliEvents (including user-steer events). */
  onResumedEvents: (events: CliEvent[]) => void;
  onContextWindowUpdate?: (used: number, size: number) => void;
}

/**
 * Layer 1 (universal) session-activity safety net.
 *
 * Keeps tailing a harness's live session log *after* the per-prompt `CliLogMonitor`
 * has already resolved and torn down, so a harness auto-resuming a backgrounded task
 * — or a human typing directly into the still-open TUI — is never lost.
 *
 * Owned and lifecycle-managed by `CliIntegration`. Deliberately dumb: it has no
 * notion of completion, workflow state, or step targets — it only tails and
 * forwards. Attribution (which step this activity belongs to) is left to
 * `WorkflowInstance`, which is the layer that actually owns queue/step state.
 *
 * **One-reader rule:** `CliIntegration` must call `pause()` before dispatching a
 * new prompt (the next prompt's own `CliLogMonitor` becomes the authoritative
 * reader) and `resume()` once that prompt's monitor has resolved and the PTY is
 * still alive. Both share the same `ILogParser` instance, so no read-offset
 * hand-off is required either way.
 */
export class SessionActivityWatcher {
  private readonly pump: CliLogEventPump;
  private watcher?: ReturnType<CliLogEventPump["watch"]>;
  private logPath?: string;
  private paused = false;

  constructor(deps: SessionActivityWatcherDeps) {
    this.pump = new CliLogEventPump({
      parser: deps.parser,
      model: deps.model,
      onStreamingEvents: deps.onResumedEvents,
      onContextWindowUpdate: deps.onContextWindowUpdate,
      // No active dispatch while this watcher runs — every `user` event is
      // either a genuine human steer or a harness resume signal, never
      // ctrlyoke's own injected prompt (that case is only ever observed by
      // the per-prompt CliLogMonitor, which is paused/resumed around this).
      dispatchedPromptText: undefined,
    });
  }

  /** Start tailing `logPath` from wherever the shared parser instance last left off. */
  start(logPath: string): void {
    this.logPath = logPath;
    this.paused = false;
    void this.attach();
  }

  /** Stop watching without forgetting the log path — the next prompt owns reading. */
  pause(): void {
    this.paused = true;
    this.detach();
  }

  /** Resume watching after the authoritative reader (the next prompt's monitor) is done. */
  resume(): void {
    if (!this.logPath) {
      return;
    }
    this.paused = false;
    void this.attach();
  }

  /** Stop entirely — the underlying PTY/session is gone. */
  stop(): void {
    this.paused = true;
    this.detach();
    this.logPath = undefined;
  }

  private detach(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }

  private async attach(): Promise<void> {
    if (!this.logPath || this.paused) {
      return;
    }
    const logPath = this.logPath;

    this.detach();
    this.watcher = this.pump.watch(logPath, new Date(0), (event) => {
      this.pump.processEvent(event);
    });

    // Catch up on anything written between the last authoritative read and this
    // watcher re-attaching — mirrors CliLogMonitor's own initial-read-after-watch
    // pattern so a write landing in that narrow window isn't missed until the
    // next unrelated change event.
    try {
      const catchUpEntries = await this.pump.readNewEntriesSince(
        logPath,
        new Date(0)
      );
      for (const event of catchUpEntries) {
        this.pump.processEvent(event);
      }
    } catch (error) {
      Log.debug(`[SessionActivityWatcher] Catch-up read failed: ${error}`);
    }
  }
}
