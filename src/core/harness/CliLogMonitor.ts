import type * as fs from "fs";
import type {
  CliEvent,
  CliResult,
  UniversalCliOutput,
} from "../../types/CliOutputTypes";
import { CLI_EVENT_TYPES, FAILURE_KINDS } from "../../types/DashboardConstants";
import type { FailureKind } from "../../types/CtrlYokeTypes";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { Log } from "../../utils/Log";
import { extractTextFromEvents } from "./shared/CliResponseTextExtractor";
import { CliLogEventPump } from "./shared/CliLogEventPump";
import type { BaseCliEvent, ILogParser } from "./shared/interfaces/ILogParser";
import type { INotificationMonitor } from "./shared/interfaces/INotificationMonitor";

/** Maximum time (ms) spent draining log entries after completion. */
export const DRAIN_DEADLINE_MS = 2000;
/** Polling interval (ms) between bounded-drain reads. */
export const DRAIN_POLL_INTERVAL_MS = 150;

/**
 * Preserve synthetic user-steer events in parser-produced final output.
 *
 * User steers are created by `CliLogEventPump`, not by harness parsers, so a
 * later `extractResponse()` call cannot reconstruct them. Merge the observed
 * events back by timestamp while preserving each source's existing order.
 */
function mergeObservedUserSteers(
  response: UniversalCliOutput,
  observedUserSteers: CliEvent[]
): UniversalCliOutput {
  if (observedUserSteers.length === 0) {
    return response;
  }

  const events = [...response.events];
  for (const steer of observedUserSteers) {
    const insertAt =
      steer.timestamp === undefined
        ? -1
        : events.findIndex(
            (event) =>
              event.timestamp !== undefined &&
              event.timestamp > steer.timestamp!
          );
    if (insertAt === -1) {
      events.push(steer);
    } else {
      events.splice(insertAt, 0, steer);
    }
  }

  return { ...response, events };
}

/**
 * Result of log file monitoring.
 * Returned by `CliLogMonitor.monitor()` after completion or failure.
 */
export interface LogMonitorResult {
  /** Whether the monitored prompt completed successfully */
  success: boolean;
  /** Session ID extracted from log events (for conversation continuity) */
  sessionId?: string;
  /** Structured parsed output (tool calls, thinking blocks, events) */
  parsedOutput?: UniversalCliOutput;
  /** Legacy CLI result (response text, statistics, exit code) */
  cliResult?: CliResult;
  /** Structured prompt failure classification when monitoring ended unsuccessfully */
  failureKind?: FailureKind;
  /** Human-readable failure message captured at the monitor boundary */
  failureMessage?: string;
  /** Set when monitoring ended because the CLI process exited before completion was detected.
   *  All CLI harnesses are TUIs that stay open between prompts, so any process exit
   *  before a Stop hook or log-based completion event is abnormal (Ctrl+C, crash, SIGKILL). */
  processExited?: { exitCode: number };
  /** Set when monitoring ended because the maxPromptTimeout elapsed. Partial output (if any)
   *  is captured in parsedOutput/cliResult so it can be saved before the error is re-thrown. */
  timedOut?: boolean;
}

/**
 * Dependencies required by CliLogMonitor.
 * Passed via constructor to keep the monitor loosely coupled from CliIntegration.
 */
export interface LogMonitorDependencies {
  /** Harness-specific log parser (parses events, extracts sessions, detects completion) */
  logParser: ILogParser;
  /** Optional notification monitor for hook-based completion detection (Claude, Codex) */
  notificationMonitor?: INotificationMonitor;
  runtimeState: {
    /** Returns the workspace root path (needed for notification directory resolution) */
    getWorkspaceRoot: () => string | undefined;
    /** Returns true when the user has requested cancellation */
    isCancelling: () => boolean;
    /** Returns exit code when the PTY/terminal process has terminated, null if still running.
     *  All CLI harnesses are TUIs that stay open between prompts — any process exit before
     *  completion detection is abnormal. The log monitor drains remaining events and stops. */
    isPtyTerminated?: () => { exitCode: number } | null;
  };
  hostCallbacks: {
    /** Callback for streaming structured CliEvents to the output panel */
    onStreamingEvents: (events: CliEvent[]) => void;
    /** Callback fired when the full response is complete */
    onResponseComplete: (message: string) => void;
    /** Callback to log the response (respects showCliOutput setting) */
    logResponse: (response: string, statistics?: string) => void;
    /** Called when a streaming event reveals updated context window utilization */
    onContextWindowUpdate?: (used: number, size: number) => void;
  };
}

/**
 * Monitors CLI log files for streaming content and completion events.
 *
 * Extracted from CliIntegration to provide a focused, single-responsibility class
 * for log file monitoring and event processing. Works with any CLI harness via
 * the ILogParser interface (composition pattern).
 *
 * **Monitoring strategy:**
 * 1. Start fs.watch on the session log file for streaming content
 * 2. Process events as they appear (stream text to output panel)
 * 3. Detect completion via:
 *    - Log event (parser.isComplete) — works for all harnesses
 *    - Notification/hook file (INotificationMonitor) — Claude, Codex
 * 4. Drain remaining log entries after completion signal
 * 5. Extract final response from accumulated events
 *
 * **Thread safety:** Only one monitor should be active per CliIntegration instance.
 * The cancellation callback allows external abort.
 */
export class CliLogMonitor {
  /** Kept as class properties for existing test seams; values are single-sourced above. */
  private static readonly DRAIN_DEADLINE_MS = DRAIN_DEADLINE_MS;
  private static readonly DRAIN_POLL_INTERVAL_MS = DRAIN_POLL_INTERVAL_MS;
  /** Interval (ms) for checking user cancellation during monitoring */
  private static readonly CANCELLATION_CHECK_INTERVAL_MS = 100;

  constructor(private readonly deps: LogMonitorDependencies) {}

  /**
   * Monitor a log file for completion, streaming events as they arrive.
   *
   * For harnesses with notification monitors (Claude, Codex), monitors both:
   * - Log file for streaming content
   * - Notification file for completion signal
   *
   * For harnesses without notification monitors, relies on
   * log file completion detection only.
   *
   * @param logPath Absolute path to log file
   * @param sessionId Session ID (if already extracted, e.g. from SessionStart hook)
   * @param startTime Execution start time (filters out old log entries)
   * @returns Promise with success flag, sessionId, parsed output, and CLI result
   */
  async monitor(
    logPath: string,
    sessionId: string | null,
    startTime: Date,
    model: string,
    dispatchedPromptText?: string
  ): Promise<LogMonitorResult> {
    const parser = this.deps.logParser;
    parser.setCurrentModel?.(model);
    const events: BaseCliEvent[] = [];
    const observedUserSteers: CliEvent[] = [];
    const pump = new CliLogEventPump({
      parser,
      model,
      onStreamingEvents: (streamingEvents) => {
        observedUserSteers.push(
          ...streamingEvents.filter(
            (event) => event.type === CLI_EVENT_TYPES.USER_STEER
          )
        );
        this.deps.hostCallbacks.onStreamingEvents(streamingEvents);
      },
      onContextWindowUpdate: this.deps.hostCallbacks.onContextWindowUpdate,
      dispatchedPromptText,
    });
    // undefined means unlimited (-1 setting) — no timeout will be set
    const timeoutMs = ConfigurationUtils.getMaxPromptExecutionTimeMs();

    return new Promise(async (resolve) => {
      let completed = false;
      let draining = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let cancellationInterval: NodeJS.Timeout | undefined;
      let watcher: fs.FSWatcher | undefined;

      const resolveFailure = async (params: {
        failureKind: FailureKind;
        failureMessage: string;
        exitCode?: number;
        timedOut?: boolean;
        sessionIdOverride?: string;
      }) => {
        // Marks the monitor settled so a background-work hold in progress
        // (see runBackgroundWorkHold) sees it on its next poll and releases
        // instead of racing this resolve() with its own later one.
        completed = true;
        if (cancellationInterval) {
          clearInterval(cancellationInterval);
        }
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        watcher?.close();

        try {
          await drainLogEvents();
        } catch {
          // ignore drain failures during failure finalization
        }

        const partialResponse =
          events.length > 0
            ? mergeObservedUserSteers(
                parser.extractResponse(events),
                observedUserSteers
              )
            : undefined;
        const partialText = partialResponse
          ? extractTextFromEvents(partialResponse)
          : undefined;
        const effectiveSessionId =
          params.sessionIdOverride ??
          partialResponse?.metadata.sessionId ??
          sessionId ??
          undefined;

        const partialResult: CliResult | undefined =
          partialText || params.failureMessage
            ? {
                success: false,
                response: partialText || params.failureMessage,
                statistics: "",
                exitCode: params.exitCode ?? -1,
                sessionId: effectiveSessionId,
                error: params.failureMessage,
              }
            : undefined;

        resolve({
          success: false,
          sessionId: effectiveSessionId,
          parsedOutput: partialResponse,
          cliResult: partialResult,
          failureKind: params.failureKind,
          failureMessage: params.failureMessage,
          timedOut: params.timedOut,
          processExited:
            params.exitCode !== undefined
              ? { exitCode: params.exitCode }
              : undefined,
        });
      };

      // Delegate timestamp extraction to BaseLogParser via the parser instance
      const getEntryTimestamp = (entry: BaseCliEvent): Date | null =>
        parser.extractTimestamp?.(entry) ?? null;

      // ──────────────────────────────────────────────────────
      // Completion finalization — single source of truth once genuinely done
      // ──────────────────────────────────────────────────────
      const finalizeCompletion = async () => {
        completed = true;

        // Drain any remaining log entries before final extraction (race-safe for fast prompts)
        await drainLogEvents();

        const finalEvents = await parser.getFinalEventsOnCompletion(logPath);
        for (const event of finalEvents) {
          const entryTime = getEntryTimestamp(event);
          if (entryTime && entryTime < startTime) {
            continue;
          }
          processEvent(event, "completion final events");
        }

        // Extract final response from accumulated events
        const response = mergeObservedUserSteers(
          parser.extractResponse(events),
          observedUserSteers
        );

        // Copilot-specific: patch in context-window usage from whichever source is
        // available, most-reliable first:
        // 1. OpenTelemetry chat spans (live, per-turn — see pollOtelContextWindow()).
        //    One last catch-up poll here covers spans written between the last
        //    interval tick and completion.
        // 2. Process log CompactionProcessor lines — legacy fallback, rarely fires
        //    on current Copilot CLI versions but kept in case OTel is unavailable.
        const effectiveSessionId =
          response.metadata.sessionId || sessionId || undefined;

        let contextPatched = false;
        if (typeof (parser as any).pollOtelContextWindow === "function") {
          await (parser as any).pollOtelContextWindow(model);
        }
        if (typeof (parser as any).getFinalOtelUsage === "function") {
          const otelUsage = (parser as any).getFinalOtelUsage();
          if (otelUsage) {
            const existingOutputTokens =
              response.metadata.usage?.outputTokens ?? 0;
            response.metadata.usage = {
              ...response.metadata.usage,
              inputTokens: otelUsage.inputTokens,
              outputTokens: existingOutputTokens,
              totalTokens: otelUsage.inputTokens + existingOutputTokens,
              contextWindowUsedTokens: otelUsage.contextWindowUsedTokens,
              contextWindowSize: otelUsage.contextWindowSize,
            };
            contextPatched = true;
          }
        }

        if (
          !contextPatched &&
          effectiveSessionId &&
          typeof (parser as any).extractContextFromProcessLog === "function"
        ) {
          const processCtx = await (parser as any).extractContextFromProcessLog(
            effectiveSessionId
          );
          if (processCtx) {
            const existingOutputTokens =
              response.metadata.usage?.outputTokens ?? 0;
            if (response.metadata.usage) {
              response.metadata.usage.inputTokens = processCtx.used;
              response.metadata.usage.totalTokens =
                processCtx.used + existingOutputTokens;
              response.metadata.usage.contextWindowUsedTokens = processCtx.used;
              response.metadata.usage.contextWindowSize = processCtx.size;
            } else {
              response.metadata.usage = {
                inputTokens: processCtx.used,
                outputTokens: 0,
                totalTokens: processCtx.used,
                contextWindowUsedTokens: processCtx.used,
                contextWindowSize: processCtx.size,
              };
            }
          }
        }

        const responseText = extractTextFromEvents(response);
        const statistics = parser.formatStatistics(
          response.metadata as unknown as BaseCliEvent
        );

        const cliResult: CliResult = {
          success: true,
          response: responseText,
          statistics,
          exitCode: 0,
          sessionId: response.metadata.sessionId || sessionId || undefined,
        };

        this.deps.hostCallbacks.logResponse(
          cliResult.response,
          cliResult.statistics
        );

        watcher?.close();
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        if (cancellationInterval) {
          clearInterval(cancellationInterval);
        }
        this.deps.hostCallbacks.onResponseComplete(cliResult.response);

        resolve({
          success: true,
          sessionId: cliResult.sessionId,
          parsedOutput: response,
          cliResult,
        });
      };

      // ──────────────────────────────────────────────────────
      // Background-work hold (Layer 2 signal-gated completion) — see
      // ILogParser.hasPendingBackgroundWork. Keeps the log watcher and
      // notification monitor active past the first Stop and re-checks at
      // each subsequent Stop, so control flow never commits while the
      // harness is expected to auto-resume the same session. The still-active
      // log watcher (never closed during a hold) keeps trackBackgroundWorkState
      // current and keeps streaming resumed output live the whole time — no
      // separate "optimistic done" signal is needed. Bounded by an idle
      // backstop so a background task that never reports completion (an
      // abandoned task, a long-lived dev server) can't hold a workflow forever.
      // ──────────────────────────────────────────────────────
      let holdingForBackgroundWork = false;

      const runBackgroundWorkHold = async (): Promise<void> => {
        holdingForBackgroundWork = true;
        Log.info(
          "⏸️ Background task still pending — holding completion until the harness auto-resumes and truly finishes"
        );

        const workspaceRoot = this.deps.runtimeState.getWorkspaceRoot();
        const backstopMs = ConfigurationUtils.getBackgroundWorkIdleBackstopMs();
        const holdStarted = Date.now();

        while (!completed && parser.hasPendingBackgroundWork!()) {
          if (!this.deps.notificationMonitor || !workspaceRoot) {
            // No hook to wait on for a re-check — shouldn't happen for a gated
            // harness (they all have notification monitors), but release
            // rather than hold forever with nothing to wait for.
            break;
          }

          const remaining = backstopMs - (Date.now() - holdStarted);
          if (remaining <= 0) {
            Log.warn(
              `⏱️ Background-work hold backstop (${backstopMs}ms) elapsed with no confirmed idle — committing anyway`
            );
            break;
          }

          const notifyDir =
            this.deps.notificationMonitor.getNotificationDirectory(
              workspaceRoot
            );
          const monitoringSessionId = this.deps.notificationMonitor
            .supportsSessionIdInFilename
            ? (sessionId ?? undefined)
            : undefined;

          const result =
            await this.deps.notificationMonitor.monitorForCompletion(
              { directory: notifyDir, timeoutMs: remaining, pollMs: 100 },
              monitoringSessionId,
              new Date(),
              () =>
                this.deps.runtimeState.isCancelling() ||
                !!this.deps.runtimeState.isPtyTerminated?.() ||
                completed
            );

          if (
            this.deps.notificationMonitor.cleanupNotificationFiles &&
            sessionId
          ) {
            await this.deps.notificationMonitor.cleanupNotificationFiles(
              sessionId,
              notifyDir
            );
          }

          if (!result.completed) {
            // Timed out, cancelled, or errored mid-hold. Do not loop forever —
            // release so the normal cancellation/timeout/exit paths (already
            // in flight if that's what triggered this) or the finalize below
            // can settle the monitor.
            break;
          }

          // Catch up before re-checking, same rationale as handleCompletion's
          // catch-up read — closes the race between the Stop file appearing
          // and the still-active fs.watch callback processing the log content
          // that precedes it.
          try {
            const catchUpEntries = await pump.readNewEntriesSince(
              logPath,
              startTime
            );
            for (const entry of catchUpEntries) {
              processEvent(entry, "background-work hold (catch-up)");
            }
          } catch (error) {
            Log.debug(
              `⚠️ Catch-up read during background-work hold failed: ${error}`
            );
          }
          // Loop again — the while condition re-checks hasPendingBackgroundWork().
        }

        holdingForBackgroundWork = false;
        if (!completed) {
          await finalizeCompletion();
        }
      };

      // ──────────────────────────────────────────────────────
      // Completion handler — entry point for both log-based and hook-based
      // signals. Finalizes immediately unless the harness reports a pending
      // background task, in which case it hands off to the hold above.
      // ──────────────────────────────────────────────────────
      const handleCompletion = async (source: string) => {
        if (completed || holdingForBackgroundWork) {
          return;
        }

        Log.info(`✅ Completion detected via ${source}`);

        // Catch up on any log content written just before this signal arrived,
        // so hasPendingBackgroundWork() below reflects the latest launch/notify
        // state (a lightweight one-off read, distinct from the one-shot
        // drainLogEvents() below that finalizeCompletion still owns).
        try {
          const catchUpEntries = await pump.readNewEntriesSince(
            logPath,
            startTime
          );
          for (const entry of catchUpEntries) {
            processEvent(entry, `${source} (catch-up)`);
          }
        } catch (error) {
          Log.debug(
            `⚠️ Catch-up read before completion check failed: ${error}`
          );
        }

        if (parser.hasPendingBackgroundWork?.()) {
          void runBackgroundWorkHold();
          return;
        }

        await finalizeCompletion();
      };

      // ──────────────────────────────────────────────────────
      // Event processor — pushes events and streams content
      // ──────────────────────────────────────────────────────
      const processEvent = (event: BaseCliEvent, source: string) => {
        events.push(event);
        pump.processEvent(event);

        // Check completion via log file — only for harnesses without a notification monitor.
        // When a notification monitor (Stop hook) is active, the hook is authoritative.
        // Log file end_turn events can be intermediate: e.g. Claude ending a turn to wait
        // for a background agent before auto-continuing. Claude also fires the Stop hook
        // for that intermediate turn; the parser's background-work state gates completion.
        if (
          !completed &&
          !this.deps.notificationMonitor &&
          parser.isComplete(event)
        ) {
          void handleCompletion(source);
        }
      };

      // ──────────────────────────────────────────────────────
      // Drain helper — reads remaining events after completion signal
      // ──────────────────────────────────────────────────────
      const drainLogEvents = async (): Promise<void> => {
        if (draining) {
          return;
        }
        draining = true;

        const deadline = Date.now() + CliLogMonitor.DRAIN_DEADLINE_MS;
        while (Date.now() < deadline) {
          const newEntries = await pump.readNewEntriesSince(logPath, startTime);
          if (newEntries.length === 0) {
            await new Promise((r) =>
              setTimeout(r, CliLogMonitor.DRAIN_POLL_INTERVAL_MS)
            );
            continue;
          }

          for (const entry of newEntries) {
            processEvent(entry, "log file (drain)");
          }
        }
      };

      // ──────────────────────────────────────────────────────
      // Start log file watcher for streaming content
      // ──────────────────────────────────────────────────────
      watcher = pump.watch(logPath, startTime, (event) => {
        processEvent(event, "log file");
      });

      try {
        const initialEntries = await pump.readNewEntriesSince(
          logPath,
          startTime
        );
        for (const entry of initialEntries) {
          processEvent(entry, "log file (initial)");
        }
      } catch (error) {
        Log.warn(`⚠️ Failed initial log read: ${error}`);
      }

      if (this.deps.notificationMonitor) {
        const workspaceRoot = this.deps.runtimeState.getWorkspaceRoot();
        if (workspaceRoot) {
          const notifyDir =
            this.deps.notificationMonitor.getNotificationDirectory(
              workspaceRoot
            );

          Log.debug(
            "🔔 Starting notification monitor for completion detection"
          );

          const monitoringSessionId = this.deps.notificationMonitor
            .supportsSessionIdInFilename
            ? (sessionId ?? undefined)
            : undefined;

          if (monitoringSessionId) {
            Log.debug(
              `📋 Monitoring notification file for session: ${monitoringSessionId}`
            );
          } else {
            Log.debug(
              "📋 Monitoring notification directory for any new completion file"
            );
          }

          void (async () => {
            try {
              const result =
                await this.deps.notificationMonitor!.monitorForCompletion(
                  {
                    directory: notifyDir,
                    timeoutMs: timeoutMs ?? Number.MAX_SAFE_INTEGER,
                    pollMs: 100,
                  },
                  monitoringSessionId,
                  startTime,
                  () =>
                    this.deps.runtimeState.isCancelling() ||
                    !!this.deps.runtimeState.isPtyTerminated?.() ||
                    completed
                );

              if (result.completed && !completed) {
                if (
                  this.deps.notificationMonitor!.cleanupNotificationFiles &&
                  sessionId
                ) {
                  await this.deps.notificationMonitor!.cleanupNotificationFiles(
                    sessionId,
                    notifyDir
                  );
                }

                void handleCompletion("Stop hook");
              } else if (result.kind === "error" && !completed) {
                if (
                  this.deps.notificationMonitor!.cleanupNotificationFiles &&
                  sessionId
                ) {
                  await this.deps.notificationMonitor!.cleanupNotificationFiles(
                    sessionId,
                    notifyDir
                  );
                }

                const sessionIdFromNotification =
                  this.deps.notificationMonitor!.extractSessionId?.(
                    result.data
                  );

                await resolveFailure({
                  failureKind: FAILURE_KINDS.HARNESS_ERROR,
                  failureMessage:
                    result.error ||
                    "Harness reported an error before completion",
                  sessionIdOverride: sessionIdFromNotification,
                });
              } else if (
                !result.completed &&
                sessionId &&
                this.deps.notificationMonitor!.cleanupNotificationFiles
              ) {
                await this.deps.notificationMonitor!.cleanupNotificationFiles(
                  sessionId,
                  notifyDir
                );
              }
            } catch (error) {
              Log.debug(`Notification monitoring error: ${error}`);
            }
          })();
        }
      }

      if (timeoutMs !== undefined) {
        timeoutHandle = setTimeout(() => {
          Log.warn(`⚠️ Log monitoring timeout after ${timeoutMs}ms`);
          void resolveFailure({
            failureKind: FAILURE_KINDS.TIMEOUT,
            failureMessage: "Log monitoring timeout",
            timedOut: true,
          });
        }, timeoutMs);
      }

      cancellationInterval = setInterval(() => {
        // Copilot-specific: poll the OTel export file for new chat spans on the same
        // cadence as cancellation checks. This is the only live, per-turn context-window
        // signal Copilot CLI 1.0.x still provides (see pollOtelContextWindow() for why) —
        // it isn't tied to the main log's fs.watch since it tails a separate file.
        if (
          !completed &&
          this.deps.hostCallbacks.onContextWindowUpdate &&
          typeof (parser as any).pollOtelContextWindow === "function"
        ) {
          void (async () => {
            const ctx = await (parser as any).pollOtelContextWindow(model);
            if (ctx) {
              this.deps.hostCallbacks.onContextWindowUpdate!(
                ctx.used,
                ctx.size
              );
            }
          })();
        }

        if (this.deps.runtimeState.isCancelling()) {
          Log.info("⏹️ Log monitoring cancelled by user");
          // Same as resolveFailure — unblocks a background-work hold in progress.
          completed = true;
          if (cancellationInterval) {
            clearInterval(cancellationInterval);
          }
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
          watcher?.close();
          // Flush any remaining log events and extract partial output so the
          // stopped step shows what the AI had produced up to cancellation.
          void (async () => {
            try {
              const newEntries = await pump.readNewEntriesSince(
                logPath,
                startTime
              );
              for (const entry of newEntries) {
                processEvent(entry, "cancellation catch-up");
              }
            } catch {
              // ignore read errors during cancellation
            }

            const partialResponse =
              events.length > 0
                ? mergeObservedUserSteers(
                    parser.extractResponse(events),
                    observedUserSteers
                  )
                : undefined;
            const partialText = partialResponse
              ? extractTextFromEvents(partialResponse)
              : undefined;
            const effectiveSessionId =
              partialResponse?.metadata.sessionId || sessionId || undefined;

            const partialResult: CliResult | undefined = partialText
              ? {
                  success: false,
                  response: partialText,
                  statistics: "",
                  exitCode: -1,
                  sessionId: effectiveSessionId,
                }
              : undefined;

            resolve({
              success: false,
              sessionId: sessionId || undefined,
              parsedOutput: partialResponse,
              cliResult: partialResult,
            });
          })();
          return;
        }
        const ptyExit = this.deps.runtimeState.isPtyTerminated?.();
        if (ptyExit) {
          if (cancellationInterval) {
            clearInterval(cancellationInterval);
          }
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
          watcher?.close();

          Log.warn(
            `⚠️ CLI process exited (code ${ptyExit.exitCode}) before completion — stopping workflow`
          );
          void resolveFailure({
            failureKind: FAILURE_KINDS.PROCESS_EXIT,
            failureMessage: `CLI process exited unexpectedly (exit code ${ptyExit.exitCode})`,
            exitCode: ptyExit.exitCode,
          });
        }
      }, CliLogMonitor.CANCELLATION_CHECK_INTERVAL_MS);
    });
  }
}
