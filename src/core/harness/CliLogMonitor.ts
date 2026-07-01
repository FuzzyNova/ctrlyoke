import type * as fs from "fs";
import type {
  CliEvent,
  CliResult,
  UniversalCliOutput,
} from "../../types/CliOutputTypes";
import { FAILURE_KINDS } from "../../types/DashboardConstants";
import type { FailureKind } from "../../types/CtrlYokeTypes";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { Log } from "../../utils/Log";
import { extractTextFromEvents } from "./shared/CliResponseTextExtractor";
import type { BaseCliEvent, ILogParser } from "./shared/interfaces/ILogParser";
import type { INotificationMonitor } from "./shared/interfaces/INotificationMonitor";

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
  /** Maximum time (ms) to spend draining remaining log entries after completion signal */
  private static readonly DRAIN_DEADLINE_MS = 2000;
  /** Polling interval (ms) between drain read attempts */
  private static readonly DRAIN_POLL_INTERVAL_MS = 150;
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
    model: string
  ): Promise<LogMonitorResult> {
    const parser = this.deps.logParser;
    parser.setCurrentModel?.(model);
    const events: BaseCliEvent[] = [];
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
          events.length > 0 ? parser.extractResponse(events) : undefined;
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
        (parser as any).extractTimestamp?.(entry) ?? null;

      // ──────────────────────────────────────────────────────
      // Completion handler — single source of truth
      // ──────────────────────────────────────────────────────
      const handleCompletion = async (source: string) => {
        if (completed) {
          return;
        }
        completed = true;

        Log.info(`✅ Completion detected via ${source}`);

        // Drain any remaining log entries before final extraction (race-safe for fast prompts)
        await drainLogEvents();

        const finalEvents = await parser.getFinalEventsOnCompletion(logPath);
        for (const event of finalEvents) {
          const entryTime = getEntryTimestamp(event);
          if (entryTime && entryTime < startTime) {
            continue;
          }
          events.push(event);
          const streamingEvents =
            parser.extractStructuredEventsFromEvent(event);
          if (streamingEvents.length > 0) {
            this.deps.hostCallbacks.onStreamingEvents(streamingEvents);
          }
        }

        // Extract final response from accumulated events
        const response = parser.extractResponse(events);

        // Copilot-specific: augment context window data from the process log.
        // The process log (process-*.log) contains CompactionProcessor lines with
        // accurate context utilization that fires every turn — more reliable than
        // session.truncation events which only appear for long sessions.
        const effectiveSessionId =
          response.metadata.sessionId || sessionId || undefined;
        if (
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
      // Event processor — pushes events and streams content
      // ──────────────────────────────────────────────────────
      const processEvent = (event: BaseCliEvent, source: string) => {
        events.push(event);

        const streamingEvents = parser.extractStructuredEventsFromEvent(event);
        if (streamingEvents.length > 0) {
          this.deps.hostCallbacks.onStreamingEvents(streamingEvents);
        }

        // Extract live context window data if available
        if (
          this.deps.hostCallbacks.onContextWindowUpdate &&
          parser.extractLiveContextWindow
        ) {
          const ctx = parser.extractLiveContextWindow(event, model);
          if (ctx) {
            this.deps.hostCallbacks.onContextWindowUpdate(ctx.used, ctx.size);
          }
        }

        // Check completion via log file — only for harnesses without a notification monitor.
        // When a notification monitor (Stop hook) is active, the hook is authoritative.
        // Log file end_turn events can be intermediate: e.g. Claude ending a turn to wait
        // for a background agent before auto-continuing. The Stop hook correctly does not
        // fire in that case; the log file cannot distinguish intermediate from final stops.
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
          const newEntries = await parser.readNewLines(logPath);
          if (newEntries.length === 0) {
            await new Promise((r) =>
              setTimeout(r, CliLogMonitor.DRAIN_POLL_INTERVAL_MS)
            );
            continue;
          }

          for (const entry of newEntries) {
            const entryTime = getEntryTimestamp(entry);
            if (entryTime && entryTime < startTime) {
              continue;
            }
            processEvent(entry, "log file (drain)");
          }
        }
      };

      // ──────────────────────────────────────────────────────
      // Start log file watcher for streaming content
      // ──────────────────────────────────────────────────────
      watcher = parser.watchLogFile(
        logPath,
        (event) => {
          processEvent(event, "log file");
        },
        startTime
      );

      try {
        const initialEntries = await parser.readNewLines(logPath);
        for (const entry of initialEntries) {
          const entryTime = getEntryTimestamp(entry);
          if (entryTime && entryTime < startTime) {
            continue;
          }
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
        if (this.deps.runtimeState.isCancelling()) {
          Log.info("⏹️ Log monitoring cancelled by user");
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
              const newEntries = await parser.readNewLines(logPath);
              for (const entry of newEntries) {
                const entryTime = getEntryTimestamp(entry);
                if (entryTime && entryTime < startTime) {
                  continue;
                }
                events.push(entry);
              }
            } catch {
              // ignore read errors during cancellation
            }

            const partialResponse =
              events.length > 0 ? parser.extractResponse(events) : undefined;
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
