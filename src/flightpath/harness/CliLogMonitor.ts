import type * as fs from "fs";
import type { CliResult, UniversalCliOutput } from "../../types/CliOutputTypes";
import { CLI_EVENT_TYPES } from "../../types/DashboardConstants";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { Log } from "../../utils/Log";
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
  /** Returns the workspace root path (needed for notification directory resolution) */
  getWorkspaceRoot: () => string | undefined;
  /** Returns true when the user has requested cancellation */
  isCancelling: () => boolean;
  /** Callback for streaming text chunks to output panel */
  onStreamingChunk: (chunk: string) => void;
  /** Callback fired when the full response is complete */
  onResponseComplete: (message: string) => void;
  /** Callback to log the response (respects showCliOutput setting) */
  logResponse: (response: string, statistics?: string) => void;
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

  private readonly deps: LogMonitorDependencies;

  constructor(deps: LogMonitorDependencies) {
    this.deps = deps;
  }

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
    startTime: Date
  ): Promise<LogMonitorResult> {
    const parser = this.deps.logParser;
    const events: BaseCliEvent[] = [];
    // undefined means unlimited (-1 setting) — no timeout will be set
    const timeoutMs = ConfigurationUtils.getMaxPromptExecutionTimeMs();

    return new Promise(async (resolve, reject) => {
      let completed = false;
      let draining = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let cancellationInterval: NodeJS.Timeout | undefined;

      // Delegate timestamp extraction to BaseLogParser via the parser instance
      const getEntryTimestamp = (entry: BaseCliEvent): Date | null =>
        (parser as any).extractTimestamp?.(entry) ?? null;

      // ──────────────────────────────────────────────────────
      // Completion handler — single source of truth
      // ──────────────────────────────────────────────────────
      const handleCompletion = async (source: string) => {
        if (completed) {
          return; // Already completed
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
          const content = parser.extractContentFromEvent(event);
          if (content) {
            this.deps.onStreamingChunk(content);
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
            if (response.metadata.usage) {
              response.metadata.usage.contextWindowUsedTokens = processCtx.used;
              response.metadata.usage.contextWindowSize = processCtx.size;
            } else {
              response.metadata.usage = {
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
                contextWindowUsedTokens: processCtx.used,
                contextWindowSize: processCtx.size,
              };
            }
          }
        }

        // Extract text from events for legacy response field
        const responseText = CliLogMonitor.extractTextFromEvents(response);

        // Format statistics
        const statistics = parser.formatStatistics(
          response.metadata as unknown as BaseCliEvent
        );

        // Build CLI result
        const cliResult: CliResult = {
          success: true,
          response: responseText,
          statistics,
          exitCode: 0,
          sessionId: response.metadata.sessionId || sessionId || undefined,
        };

        this.deps.logResponse(cliResult.response, cliResult.statistics);

        // Cleanup
        watcher.close();
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        if (cancellationInterval) {
          clearInterval(cancellationInterval);
        }
        this.deps.onResponseComplete("Response complete");

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

        // Stream content to output window (delegates to harness's log parser)
        const content = parser.extractContentFromEvent(event);
        if (content) {
          this.deps.onStreamingChunk(content);
        }

        // Check completion via log file (fallback for harnesses without notification monitor)
        if (!completed && parser.isComplete(event)) {
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
      const watcher: fs.FSWatcher = parser.watchLogFile(
        logPath,
        (event) => {
          processEvent(event, "log file");
        },
        startTime
      );

      // Initial read to capture events written before watcher setup (fast prompts)
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

      // ──────────────────────────────────────────────────────
      // Notification monitor (parallel completion detection)
      // ──────────────────────────────────────────────────────
      if (this.deps.notificationMonitor) {
        const workspaceRoot = this.deps.getWorkspaceRoot();
        if (workspaceRoot) {
          const notifyDir =
            this.deps.notificationMonitor.getNotificationDirectory(
              workspaceRoot
            );

          Log.debug(
            `🔔 Starting notification monitor for completion detection`
          );

          // Determine monitoring mode:
          // - If harness supports session IDs in notification filenames, use specific session monitoring
          // - Otherwise (like Copilot), use wildcard mode (undefined sessionId)
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
              `📋 Monitoring notification directory for any new completion file`
            );
          }

          // Launch harness-specific notification monitoring in parallel
          // (each harness knows its own file naming conventions)
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
                  () => this.deps.isCancelling() || completed
                );

              if (result.completed && !completed) {
                // Cleanup any remaining notification files (provider-specific)
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
              }
            } catch (error) {
              Log.debug(`Notification monitoring error: ${error}`);
            }
          })();
        }
      }

      // ──────────────────────────────────────────────────────
      // Timeout handling (skipped when user sets unlimited / -1)
      // ──────────────────────────────────────────────────────
      if (timeoutMs !== undefined) {
        timeoutHandle = setTimeout(() => {
          Log.warn(`⚠️ Log monitoring timeout after ${timeoutMs}ms`);
          watcher.close();
          reject(new Error("Log monitoring timeout"));
        }, timeoutMs);
      }

      // ──────────────────────────────────────────────────────
      // Cancellation handling
      // ──────────────────────────────────────────────────────
      cancellationInterval = setInterval(() => {
        if (this.deps.isCancelling()) {
          Log.info("⏹️ Log monitoring cancelled by user");
          if (cancellationInterval) {
            clearInterval(cancellationInterval);
          }
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
          watcher.close();
          resolve({ success: false });
        }
      }, CliLogMonitor.CANCELLATION_CHECK_INTERVAL_MS);
    });
  }

  // ============================================================
  // STATIC UTILITIES
  // ============================================================

  /**
   * Extract text content from a UniversalCliOutput's events array.
   * Concatenates all text events to form the complete response text.
   *
   * Used by both interactive (log monitoring) and headless execution paths
   * to convert structured events into a legacy response string.
   *
   * @param output Structured CLI output with events array
   * @returns Concatenated text content from all TEXT events
   */
  static extractTextFromEvents(output: UniversalCliOutput): string {
    const textParts: string[] = [];
    for (const event of output.events) {
      if (
        event.type === CLI_EVENT_TYPES.TEXT &&
        event.data &&
        "text" in event.data
      ) {
        textParts.push(event.data.text);
      }
    }
    return textParts.join("");
  }
}
