import type * as fs from "fs";
import type {
  BackgroundWorkHoldData,
  CliEvent,
  CliResult,
  UniversalCliOutput,
} from "../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  FAILURE_KINDS,
  NOTIFICATION_OUTCOME_KINDS,
} from "../../types/DashboardConstants";
import type { FailureKind } from "../../types/CtrlYokeTypes";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { Log } from "../../utils/Log";
import { getTranscriptText } from "../../utils/StepOutputText";
import { CliLogEventPump } from "./shared/CliLogEventPump";
import type { BaseCliEvent, ILogParser } from "./shared/interfaces/ILogParser";
import type {
  INotificationMonitor,
  NotificationResult,
} from "./shared/interfaces/INotificationMonitor";

/** Maximum time (ms) spent draining log entries after completion. */
export const DRAIN_DEADLINE_MS = 2000;
/** Polling interval (ms) between bounded-drain reads. */
export const DRAIN_POLL_INTERVAL_MS = 150;

/**
 * Preserve synthetic events in parser-produced final output.
 *
 * User steers (created by `CliLogEventPump`) and background-work holds
 * (created by the monitor itself) do not come from harness parsers, so a later
 * `extractResponse()` call cannot reconstruct them. Merge the observed events
 * back by timestamp while preserving each source's existing order.
 */
function mergeObservedSyntheticEvents(
  response: UniversalCliOutput,
  observedSyntheticEvents: CliEvent[]
): UniversalCliOutput {
  if (observedSyntheticEvents.length === 0) {
    return response;
  }

  const events = [...response.events];
  for (const steer of observedSyntheticEvents) {
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

/** The message an `{sessionId}-error.json` notification carries, when it carries one. */
function describeHarnessError(
  data: { rawHookData?: { message?: unknown } } | undefined
): string | undefined {
  const message = data?.rawHookData?.message;
  return typeof message === "string" && message ? message : undefined;
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
    onResponseComplete: () => void;
    /** Callback to log the response (respects logRawCliOutput setting) */
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
    const observedSyntheticEvents: CliEvent[] = [];
    const pump = new CliLogEventPump({
      parser,
      model,
      onStreamingEvents: (streamingEvents) => {
        observedSyntheticEvents.push(
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
            ? mergeObservedSyntheticEvents(
                parser.extractResponse(events),
                observedSyntheticEvents
              )
            : undefined;
        const partialText = partialResponse
          ? getTranscriptText(partialResponse.events)
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
        const response = mergeObservedSyntheticEvents(
          parser.extractResponse(events),
          observedSyntheticEvents
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
          await (parser as any).pollOtelContextWindow();
        }
        if (typeof (parser as any).getFinalOtelUsage === "function") {
          const otelUsage = (parser as any).getFinalOtelUsage();
          if (otelUsage) {
            const hasExactContext =
              otelUsage.contextWindowUsedTokens !== undefined &&
              otelUsage.contextWindowSize !== undefined;
            response.metadata.usage = {
              ...response.metadata.usage,
              inputTokens: otelUsage.inputTokens,
              outputTokens: otelUsage.outputTokens,
              totalTokens: otelUsage.totalTokens,
              // Headless JSON token_details is canonical when present. OTel
              // fills only cache fields that headless stdout did not provide.
              ...(response.metadata.usage?.cachedInputTokens !== undefined ||
              otelUsage.cachedInputTokens !== undefined
                ? {
                    cachedInputTokens:
                      response.metadata.usage?.cachedInputTokens ??
                      otelUsage.cachedInputTokens,
                  }
                : {}),
              ...(response.metadata.usage?.cacheCreatedTokens !== undefined ||
              otelUsage.cacheCreatedTokens !== undefined
                ? {
                    cacheCreatedTokens:
                      response.metadata.usage?.cacheCreatedTokens ??
                      otelUsage.cacheCreatedTokens,
                  }
                : {}),
              ...(hasExactContext
                ? {
                    contextWindowUsedTokens: otelUsage.contextWindowUsedTokens,
                    contextWindowSize: otelUsage.contextWindowSize,
                  }
                : {}),
              totalConfidence: otelUsage.totalConfidence,
            };
            contextPatched = hasExactContext;
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
            if (response.metadata.usage) {
              response.metadata.usage.inputTokens = processCtx.used;
              response.metadata.usage.contextWindowUsedTokens = processCtx.used;
              response.metadata.usage.contextWindowSize = processCtx.size;
            } else {
              response.metadata.usage = {
                inputTokens: processCtx.used,
                outputTokens: 0,
                contextWindowUsedTokens: processCtx.used,
                contextWindowSize: processCtx.size,
              };
            }
          }
        }

        const responseText = getTranscriptText(response.events);
        const statistics = parser.formatStatistics(
          response.metadata as unknown as BaseCliEvent
        );

        const cliResult: CliResult = {
          success: true,
          statistics,
          exitCode: 0,
          sessionId: response.metadata.sessionId || sessionId || undefined,
        };

        this.deps.hostCallbacks.logResponse(
          responseText,
          cliResult.statistics
        );

        watcher?.close();
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        if (cancellationInterval) {
          clearInterval(cancellationInterval);
        }
        this.deps.hostCallbacks.onResponseComplete();

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
      // separate "optimistic done" signal is needed. Deliberately unbounded
      // while work is pending: a background test run can legitimately sit
      // silent for far longer than any fixed cap, and committing early is the
      // bug this hold exists to prevent. Cancellation, PTY exit, a harness
      // error, and `maxPromptTimeout` (via `completed`) still release it.
      // ──────────────────────────────────────────────────────
      let holdingForBackgroundWork = false;
      // Resolver for "another log event was just processed while holding" —
      // see the race inside `runBackgroundWorkHold` for why this exists
      // alongside the notification-file wait.
      let onHoldWake: (() => void) | undefined;

      // Tell the user a Stop was absorbed, and what it is waiting on — the
      // hold has no time-based release, so without this a step waiting on a
      // hung background task would look stuck for no visible reason.
      const reportAbsorbedStop = () => {
        const snapshot = parser.getBackgroundWorkHoldSnapshot?.() ?? {
          pendingTasks: [],
          awaitingResumedTurn: false,
        };
        const heldAt = Date.now();
        const holdEvent: CliEvent = {
          type: CLI_EVENT_TYPES.BACKGROUND_WORK_HOLD,
          timestamp: heldAt,
          data: { heldAt, ...snapshot } satisfies BackgroundWorkHoldData,
        };
        observedSyntheticEvents.push(holdEvent);
        this.deps.hostCallbacks.onStreamingEvents([holdEvent]);
      };

      const runBackgroundWorkHold = async (): Promise<void> => {
        holdingForBackgroundWork = true;
        Log.info(
          "[CliLogMonitor] Background task still pending — holding completion until the harness auto-resumes and truly finishes"
        );

        const workspaceRoot = this.deps.runtimeState.getWorkspaceRoot();
        // The single in-flight Stop/error wait. A log-event wake re-checks
        // state without abandoning it, and it is re-armed only once it has
        // settled: an abandoned poller keeps running and can consume (delete)
        // the next Stop file with nobody left to read its result.
        let pendingNotification: Promise<NotificationResult> | undefined;
        // A further Stop arrived during the hold; reported only once the loop
        // condition has confirmed work is still pending (i.e. it was absorbed).
        let stopArrivedDuringHold = false;

        while (!completed && parser.hasPendingBackgroundWork!()) {
          if (!this.deps.notificationMonitor || !workspaceRoot) {
            // No hook to wait on for a re-check — shouldn't happen for a gated
            // harness (they all have notification monitors), but release
            // rather than hold forever with nothing to wait for.
            break;
          }

          if (stopArrivedDuringHold) {
            stopArrivedDuringHold = false;
            reportAbsorbedStop();
          }

          const notifyDir =
            this.deps.notificationMonitor.getNotificationDirectory(
              workspaceRoot
            );
          const monitoringSessionId = this.deps.notificationMonitor
            .supportsSessionIdInFilename
            ? (sessionId ?? undefined)
            : undefined;

          // Race a further Stop/error notification file against the
          // still-active log watcher observing new content. A background
          // task's completion notification can be consumed *mid-turn* with
          // no intervening Stop (see harness-integrations.instructions.md),
          // so the turn that actually clears `hasPendingBackgroundWork()` may
          // never produce a *second* Stop-hook file to wake this loop —
          // without this race the hold would never release even though the
          // watcher (`CliLogEventPump` → `trackBackgroundWorkState`) already
          // observed the closing event.
          pendingNotification ??=
            this.deps.notificationMonitor.monitorForCompletion(
              {
                directory: notifyDir,
                timeoutMs: Number.MAX_SAFE_INTEGER,
                pollMs: 100,
              },
              monitoringSessionId,
              new Date(),
              () =>
                this.deps.runtimeState.isCancelling() ||
                !!this.deps.runtimeState.isPtyTerminated?.() ||
                completed
            );

          const nextLogEvent = new Promise<void>((resolveWake) => {
            onHoldWake = () => resolveWake();
          });

          const winner = await Promise.race([
            pendingNotification.then((result) => ({
              kind: "notification" as const,
              result,
            })),
            nextLogEvent.then(() => ({ kind: "log-event" as const })),
          ]);
          onHoldWake = undefined;

          if (winner.kind === "notification") {
            pendingNotification = undefined;
            if (
              this.deps.notificationMonitor.cleanupNotificationFiles &&
              sessionId
            ) {
              await this.deps.notificationMonitor.cleanupNotificationFiles(
                sessionId,
                notifyDir
              );
            }

            stopArrivedDuringHold = winner.result.completed;
            if (!winner.result.completed) {
              // Cancelled, PTY exited, or errored mid-hold. Do not loop
              // forever — release so the normal cancellation/timeout/exit
              // paths (already in flight if that's what triggered this) or
              // the finalize below can settle the monitor.
              break;
            }
          }

          // Catch up before re-checking, same rationale as handleCompletion's
          // catch-up read — closes the race between a completion signal
          // (Stop file or log content) and the still-active fs.watch callback
          // processing the log content that precedes it.
          try {
            const catchUpEntries = await pump.readNewEntriesSince(
              logPath,
              startTime
            );
            for (const entry of catchUpEntries) {
              processEvent(entry, "background-work hold (catch-up)");
            }
          } catch (error) {
            Log.trace(
              `[CliLogMonitor] Catch-up read during background-work hold failed: ${error}`
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

        Log.info(`[CliLogMonitor] Completion detected via ${source}`);

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
          Log.trace(
            `[CliLogMonitor] Catch-up read before completion check failed: ${error}`
          );
        }

        if (parser.hasPendingBackgroundWork?.()) {
          reportAbsorbedStop();
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

        // Wake a background-work hold as soon as this event's effect on
        // `trackBackgroundWorkState` is applied, so the hold doesn't have to
        // wait for another Stop-hook file that may never arrive — see the
        // race in `runBackgroundWorkHold`.
        if (holdingForBackgroundWork) {
          onHoldWake?.();
        }

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
        Log.warn(`[CliLogMonitor] Failed initial log read: ${error}`);
      }

      if (this.deps.notificationMonitor) {
        const workspaceRoot = this.deps.runtimeState.getWorkspaceRoot();
        if (workspaceRoot) {
          const notifyDir =
            this.deps.notificationMonitor.getNotificationDirectory(
              workspaceRoot
            );

          Log.debug(
            "[CliLogMonitor] Starting notification monitor for completion detection"
          );

          const monitoringSessionId = this.deps.notificationMonitor
            .supportsSessionIdInFilename
            ? (sessionId ?? undefined)
            : undefined;

          if (monitoringSessionId) {
            Log.debug(
              `[CliLogMonitor] Monitoring notification file for session: ${monitoringSessionId}`
            );
          } else {
            Log.debug(
              "[CliLogMonitor] Monitoring notification directory for any new completion file"
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
              } else if (
                result.kind === NOTIFICATION_OUTCOME_KINDS.ERROR &&
                !completed
              ) {
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
                    describeHarnessError(result.data) ||
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
              Log.trace(
                `[CliLogMonitor] Notification monitoring error: ${error}`
              );
            }
          })();
        }
      }

      if (timeoutMs !== undefined) {
        timeoutHandle = setTimeout(() => {
          Log.warn(
            `[CliLogMonitor] Log monitoring timeout after ${timeoutMs}ms`
          );
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
            const ctx = await (parser as any).pollOtelContextWindow();
            if (ctx) {
              this.deps.hostCallbacks.onContextWindowUpdate!(
                ctx.used,
                ctx.size
              );
            }
          })();
        }

        if (this.deps.runtimeState.isCancelling()) {
          Log.info("[CliLogMonitor] Log monitoring cancelled by user");
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
                ? mergeObservedSyntheticEvents(
                    parser.extractResponse(events),
                    observedSyntheticEvents
                  )
                : undefined;
            const partialText = partialResponse
              ? getTranscriptText(partialResponse.events)
              : undefined;
            const effectiveSessionId =
              partialResponse?.metadata.sessionId || sessionId || undefined;

            const partialResult: CliResult | undefined = partialText
              ? {
                  success: false,
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
            `[CliLogMonitor] CLI process exited (code ${ptyExit.exitCode}) before completion — stopping workflow`
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
