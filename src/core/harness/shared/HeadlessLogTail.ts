import type { CliEvent } from "../../../types/CliOutputTypes";
import {
  HEADLESS_SOURCE_MODES,
  type HeadlessSourceMode,
} from "../../../types/DashboardConstants";
import { Log } from "../../../utils/Log";
import { splitCompleteLines } from "../../../utils/TextLines";
import { DRAIN_DEADLINE_MS, DRAIN_POLL_INTERVAL_MS } from "../CliLogMonitor";
import { CliLogEventPump } from "./CliLogEventPump";
import type { ICliProvider } from "./interfaces/ICliProvider";
import type { BaseCliEvent, ILogParser } from "./interfaces/ILogParser";

/** Default idle poll interval for log growth while stdout is quiet. */
const HEADLESS_LOG_TAIL_POLL_INTERVAL_MS = 750;

export interface HeadlessLogTailOptions {
  parser: ILogParser;
  promptText: string;
  startTime: Date;
  resolvedSessionId?: string;
  workspaceRoot?: string;
  model?: string;
  extractSessionIdFromStdout?: (chunk: string) => string | undefined;
  /** Provider-specific enrichment observer; never affects source selection. */
  onStdoutChunkObserved?: (chunk: string) => void;
  /** Called once stdout has ended, so the observer can flush a partial record. */
  onStdoutEnded?: () => void;
  extractSessionIdFromLogs?: (
    promptText: string,
    startTime: Date,
    workspaceRoot?: string
  ) => Promise<string | undefined>;
  onStreamingEvents: (events: CliEvent[]) => void;
  onContextWindowUpdate?: (used: number, size: number) => void;
  /** Test seam; production uses the shared bounded-drain constants. */
  idlePollIntervalMs?: number;
  /** Test seam; production uses the shared bounded-drain constants. */
  drainDeadlineMs?: number;
  /** Test seam; production uses the shared bounded-drain constants. */
  drainPollIntervalMs?: number;
}

export interface HeadlessLogTailResult {
  events: BaseCliEvent[];
  sessionId?: string;
  logPath?: string;
}

/**
 * One headless CLI invocation's terminal state, as it travels from the
 * transport coordinator to the response collector.
 *
 * Single source for the shape: `CliTransportCoordinator` produces it,
 * `CliExecutionRunner` forwards it, and `CliResponseCollector` classifies it.
 * Re-declaring it at each hop lets a field be added in one place and silently
 * dropped in transit at the next.
 */
export interface HeadlessProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /**
   * Signal that terminated the process, when it was killed rather than exiting
   * on its own. Present means `exitCode` is synthetic and says nothing about
   * why the run ended.
   */
  terminationSignal?: NodeJS.Signals;
  headlessLogTail?: HeadlessLogTail;
}

/** Source selected by the runner for a migrated headless harness. */
export interface HeadlessStreamingSource {
  parser: ILogParser;
  mode: HeadlessSourceMode;
  /**
   * Parse one complete stdout record. CliTransportCoordinator owns buffering
   * transport chunks before invoking this pure provider hook.
   */
  parseStdout?: (record: string) => BaseCliEvent[];
  logTail?: HeadlessLogTail;
  model?: string;
}

/** Provider members that determine which stream feeds headless events. */
export type HeadlessSourceModeProvider = Pick<
  ICliProvider,
  "headlessSource" | "parseHeadlessStdout" | "extractSessionIdFromStdout"
>;

/**
 * Resolve a provider's headless event source.
 *
 * Single source of truth for the mode decision: the live streaming path and the
 * final-output path must agree, or a harness would stream one mapping and
 * report another. An explicit `headlessSource` always wins so a provider that
 * implements both hooks can still pin itself to the log.
 */
export function resolveHeadlessSourceMode(
  provider: HeadlessSourceModeProvider
): HeadlessSourceMode | undefined {
  if (provider.headlessSource) {
    return provider.headlessSource;
  }
  if (provider.parseHeadlessStdout) {
    return HEADLESS_SOURCE_MODES.STDOUT;
  }
  return provider.extractSessionIdFromStdout
    ? HEADLESS_SOURCE_MODES.LOG
    : undefined;
}

/**
 * Tails a headless harness's session log while stdout supplies the clock.
 *
 * Headless completion is owned by process exit, so this class intentionally
 * has no completion detection, notification monitor, or background-work hold.
 * Each stdout chunk queues one position-tracked log read. A low-frequency idle
 * poll catches log writes during long tool calls, and finish() performs the
 * same bounded drain used by the interactive log monitor.
 */
export class HeadlessLogTail {
  private readonly pump: CliLogEventPump;
  private readonly events: BaseCliEvent[] = [];
  private readonly startTime: Date;
  private readonly idlePollIntervalMs: number;
  private readonly drainDeadlineMs: number;
  private readonly drainPollIntervalMs: number;
  private sessionId?: string;
  private stdoutRemainder = "";
  private logPath?: string;
  private pollHandle?: NodeJS.Timeout;
  private pendingWork: Promise<void> = Promise.resolve();
  private started = false;
  private finished = false;
  /**
   * Cancels the parser's in-flight session-log discovery. Discovery retries for
   * minutes by design (a harness writes its log asynchronously after launch),
   * so nothing else can bound it.
   */
  private discoveryAbort = new AbortController();
  /** True once `abort()` ran, distinguishing a cancelled run from a normal exit. */
  private aborted = false;

  constructor(private readonly options: HeadlessLogTailOptions) {
    this.startTime = options.startTime;
    this.sessionId = options.resolvedSessionId;
    this.idlePollIntervalMs =
      options.idlePollIntervalMs ?? HEADLESS_LOG_TAIL_POLL_INTERVAL_MS;
    this.drainDeadlineMs = options.drainDeadlineMs ?? DRAIN_DEADLINE_MS;
    this.drainPollIntervalMs =
      options.drainPollIntervalMs ?? DRAIN_POLL_INTERVAL_MS;
    this.pump = new CliLogEventPump({
      parser: options.parser,
      model: options.model ?? "",
      onStreamingEvents: options.onStreamingEvents,
      onContextWindowUpdate: options.onContextWindowUpdate,
    });
  }

  /** Start idle polling and perform an initial discovery/read attempt. */
  async start(): Promise<void> {
    if (this.started || this.finished) {
      return;
    }
    this.started = true;
    this.pollHandle = setInterval(() => {
      void this.enqueueTick("idle poll");
    }, this.idlePollIntervalMs);

    // Never resolve a session ID before the process spawns. Two distinct
    // failure modes make pre-spawn resolution wrong, so the rule is uniform:
    // Codex's stdout ID does not exist yet and its discovery helper retries for
    // several seconds, delaying the launch of the very stream this tails; and a
    // provider log lookup can only see the *previous* run in this workspace
    // (Antigravity's `last_conversations.json` cache is keyed by workspace root
    // with no timestamp), which would latch a stale session for the whole run.
    // Ticks are driven post-spawn by stdout and the idle poll, so the only
    // initial read worth attempting is one where the caller already supplied
    // the session ID.
    //
    // That read is deliberately *not* awaited. A resumed session's log can only
    // be touched once the harness relaunches, and Codex's discovery helper
    // insists the file's mtime be newer than `startTime` — so a pre-spawn read
    // polls itself out over the parser's full retry budget (~3 minutes
    // observed) while the caller waits to spawn the very process that would
    // satisfy it. Firing it here lets the queued tick win the moment the log
    // appears, without the spawn waiting on it.
    if (this.sessionId) {
      void this.enqueueTick("initial read");
    }
  }

  /**
   * Cancel session-log discovery and stop polling, permanently.
   *
   * Called when the run this tails is abandoned (user Stop). Without it a
   * cancelled run's discovery keeps retrying long after the workflow instance
   * has been retired, and `finish()` would block on that retry budget before
   * it could report anything.
   */
  abort(): void {
    if (this.aborted) {
      return;
    }
    this.aborted = true;
    this.discoveryAbort.abort();
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = undefined;
    }
    Log.debug("[HeadlessLogTail] Session-log discovery aborted");
  }

  /** Queue a stdout clock tick. Safe to call from a synchronous stream callback. */
  onStdoutChunk(chunk: string): void {
    if (this.finished) {
      return;
    }

    try {
      // Unlike session-ID capture, this observer remains active after a
      // session ID is known so it can see the terminal usage event too.
      this.options.onStdoutChunkObserved?.(chunk);
    } catch (error) {
      Log.trace(`[HeadlessLogTail] stdout observer failed: ${String(error)}`);
    }

    void this.enqueueTick(HEADLESS_SOURCE_MODES.STDOUT, chunk);
  }

  /** Stop polling, drain the log, and return the accumulated raw log events. */
  async finish(): Promise<HeadlessLogTailResult> {
    if (this.finished) {
      return this.getResult();
    }
    this.finished = true;
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = undefined;
    }

    // Unwind any discovery still retrying against a pre-exit deadline before
    // waiting on it. A process that died before its log was ever written would
    // otherwise hold this await for the parser's whole retry budget.
    this.discoveryAbort.abort();
    await this.pendingWork;

    // A final stdout record may be unterminated. onStdoutChunk() cannot queue
    // this flush because finish() marks the tail finished before waiting for
    // pending work, so capture it directly before post-exit discovery.
    if (!this.sessionId && this.stdoutRemainder.length > 0) {
      const remainder = this.stdoutRemainder;
      this.stdoutRemainder = "";
      this.captureSessionId(remainder);
    }
    try {
      this.options.onStdoutEnded?.();
    } catch (error) {
      Log.trace(
        `[HeadlessLogTail] stdout end observer failed: ${String(error)}`
      );
    }

    // The post-exit read gets a fresh budget: the log is now written, so
    // retrying is exactly the right thing — unless the run was abandoned, in
    // which case nobody is waiting for its output.
    if (!this.aborted) {
      this.discoveryAbort = new AbortController();
      await this.enqueueTick("post-exit discovery");
    }
    if (this.logPath) {
      await this.drain();
    }
    return this.getResult();
  }

  getEvents(): BaseCliEvent[] {
    return [...this.events];
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  getResult(): HeadlessLogTailResult {
    return {
      events: this.getEvents(),
      sessionId: this.sessionId,
      logPath: this.logPath,
    };
  }

  private enqueueTick(source: string, stdoutChunk?: string): Promise<void> {
    const work = this.pendingWork.then(async () => {
      if (stdoutChunk && !this.sessionId) {
        this.captureSessionId(stdoutChunk);
      }
      await this.readTick(source);
    });
    this.pendingWork = work.catch((error) => {
      Log.trace(`[HeadlessLogTail] ${source} tick failed: ${String(error)}`);
    });
    return this.pendingWork;
  }

  private captureSessionId(chunk: string): void {
    const extractor = this.options.extractSessionIdFromStdout;
    if (!extractor) {
      return;
    }

    const combined = this.stdoutRemainder + chunk;
    try {
      const sessionId = extractor(combined);
      if (sessionId) {
        this.sessionId = sessionId;
        this.stdoutRemainder = "";
        Log.debug(`[HeadlessLogTail] Session ID from stdout: ${sessionId}`);
        return;
      }
    } catch (error) {
      Log.trace(
        `[HeadlessLogTail] stdout session-ID extraction failed: ${String(error)}`
      );
    }

    this.stdoutRemainder = splitCompleteLines(combined).remainder;
  }

  private async readTick(source: string): Promise<void> {
    await this.discoverLog();
    if (!this.logPath) {
      return;
    }

    try {
      const entries = await this.pump.readNewEntriesSince(
        this.logPath,
        this.startTime
      );
      this.processEntries(entries, source);
    } catch (error) {
      Log.trace(`[HeadlessLogTail] Log read failed: ${String(error)}`);
    }
  }

  private async discoverLog(): Promise<void> {
    if (this.logPath || this.aborted) {
      return;
    }

    if (!this.sessionId && this.options.extractSessionIdFromLogs) {
      try {
        this.sessionId =
          (await this.options.extractSessionIdFromLogs(
            this.options.promptText,
            this.startTime,
            this.options.workspaceRoot
          )) ?? undefined;
        if (this.sessionId) {
          Log.debug(
            `[HeadlessLogTail] Session ID from logs: ${this.sessionId}`
          );
        }
      } catch (error) {
        Log.trace(
          `[HeadlessLogTail] Log session-ID discovery failed: ${String(error)}`
        );
      }
    }

    try {
      // The signal is what bounds discovery: every parser honours it inside its
      // retry loop, so a cancelled run stops polling instead of retrying its
      // way past the workflow it belonged to.
      this.logPath =
        (await this.options.parser.discoverSessionLog(
          this.options.promptText,
          this.startTime,
          this.sessionId,
          this.discoveryAbort.signal
        )) ?? undefined;
      if (this.logPath) {
        Log.debug(`[HeadlessLogTail] Session log discovered: ${this.logPath}`);
      }
    } catch (error) {
      Log.trace(
        `[HeadlessLogTail] Session-log discovery failed: ${String(error)}`
      );
    }
  }

  private processEntries(entries: BaseCliEvent[], source: string): void {
    for (const entry of entries) {
      this.events.push(entry);
      this.pump.processEvent(entry);
      if (!this.sessionId) {
        this.sessionId =
          this.options.parser.extractSessionId(this.events) ?? undefined;
      }
    }
    if (entries.length > 0) {
      Log.trace(
        `[HeadlessLogTail] Processed ${entries.length} log event(s) from ${source}`
      );
    }
  }

  private async drain(): Promise<void> {
    const deadline = Date.now() + this.drainDeadlineMs;
    while (Date.now() < deadline) {
      if (!this.logPath) {
        return;
      }
      try {
        const entries = await this.pump.readNewEntriesSince(
          this.logPath,
          this.startTime
        );
        this.processEntries(entries, "post-exit drain");
      } catch (error) {
        Log.trace(`[HeadlessLogTail] Drain read failed: ${String(error)}`);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, this.drainPollIntervalMs)
      );
    }
  }
}
