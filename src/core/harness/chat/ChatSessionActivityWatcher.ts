import * as fs from "fs";
import { Log } from "../../../utils/Log";
import type { CliEvent } from "../../../types/CliOutputTypes";
import { ChatSessionParser } from "./ChatSessionParser";

export interface ChatSessionActivityWatcherDeps {
  /** Reused across calls — session cache lives on this instance. */
  parser: ChatSessionParser;
  /** Fired with any resumed activity's CliEvents (including user-steer events). */
  onResumedEvents: (events: CliEvent[]) => void;
  /** Poll cadence. Default 2000ms — relaxed vs. the 500ms live-wait cadence
   *  since this runs indefinitely in the background, not under a user-visible wait. */
  pollIntervalMs?: number;
}

/**
 * Layer 1 (universal) session-activity safety net for Copilot Chat.
 *
 * Keeps polling a chat session file *after* `CopilotChatIntegration.sendPrompt()`
 * has already resolved, so a harness auto-resuming a backgrounded task — or a
 * human typing directly into the still-open chat — is never lost. Mirrors the
 * role of `SessionActivityWatcher` (CLI harnesses), but with a simpler API:
 * Chat has no shared-offset log parser to hand off, and every post-send call
 * already knows the exact index to resume from, so there's no meaningful
 * "start vs resume" split — one `activate()` covers both.
 *
 * Poll-based rather than fs.watch, matching `ChatSessionMonitor`'s own
 * all-polling design (keeps one I/O model in the chat subsystem).
 *
 * **One-reader rule:** `CopilotChatIntegration` must call `pause()` at the top
 * of `sendPrompt()` (the send's own `ChatSessionMonitor.waitForCompletion()`
 * becomes the authoritative reader) and `activate()` again once that send
 * resolves. Because `activate()` always re-seeds the cursors from the send's
 * own final index, anything this watcher later observes is guaranteed to be
 * either a harness auto-resume or genuine human input — never ctrlyoke's own
 * dispatch — so no `dispatchedPromptText`-style filtering is needed here
 * (unlike CLI's `CliLogEventPump`).
 */
export class ChatSessionActivityWatcher {
  private readonly parser: ChatSessionParser;
  private readonly onResumedEvents: (events: CliEvent[]) => void;
  private readonly pollIntervalMs: number;

  private sessionFilePath?: string;
  private lastResponseIndex = -1;
  private steerSeenThroughIndex = -1;
  private lastKnownMtimeMs: number | null = null;
  private timer?: NodeJS.Timeout;

  constructor(deps: ChatSessionActivityWatcherDeps) {
    this.parser = deps.parser;
    this.onResumedEvents = deps.onResumedEvents;
    this.pollIntervalMs = deps.pollIntervalMs ?? 2000;
  }

  /**
   * (Re)seed the watcher at `sessionFilePath` starting just past
   * `seedResponseIndex` (the last request index the just-finished send already
   * accounted for), and (re)start polling. Safe to call repeatedly — each call
   * fully resets cursors, so switching to a new session file (a fresh chat
   * session for the next prompt) just works.
   */
  activate(sessionFilePath: string, seedResponseIndex: number): void {
    this.sessionFilePath = sessionFilePath;
    this.lastResponseIndex = seedResponseIndex;
    this.steerSeenThroughIndex = seedResponseIndex;
    this.lastKnownMtimeMs = null;
    this.scheduleNext();
  }

  /** Stop polling without forgetting cursors — the next send owns reading. */
  pause(): void {
    this.clearTimer();
  }

  /** Stop entirely and forget state — the integration is being disposed. */
  stop(): void {
    this.clearTimer();
    this.sessionFilePath = undefined;
    this.lastResponseIndex = -1;
    this.steerSeenThroughIndex = -1;
    this.lastKnownMtimeMs = null;
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private scheduleNext(): void {
    this.clearTimer();
    this.timer = setTimeout(() => void this.tick(), this.pollIntervalMs);
  }

  private async tick(): Promise<void> {
    const sessionFilePath = this.sessionFilePath;
    if (!sessionFilePath) {
      return;
    }

    try {
      const stat = await fs.promises.stat(sessionFilePath);
      if (stat.mtimeMs !== this.lastKnownMtimeMs) {
        this.lastKnownMtimeMs = stat.mtimeMs;

        const result = this.parser.collectFollowUpActivity(
          sessionFilePath,
          this.lastResponseIndex,
          this.steerSeenThroughIndex
        );
        this.lastResponseIndex = result.lastResponseIndex;
        this.steerSeenThroughIndex = result.steerSeenThroughIndex;

        if (result.events.length > 0) {
          this.onResumedEvents(result.events);
        }
      }
    } catch (error) {
      Log.debug(`[ChatSessionActivityWatcher] Poll failed: ${error}`);
    }

    // Re-check sessionFilePath in case pause()/stop() ran during the await above.
    if (this.sessionFilePath === sessionFilePath) {
      this.scheduleNext();
    }
  }
}
