import * as fs from "fs";
import * as path from "path";
import { Log } from "../../../../utils/Log";
import {
  HOOK_EVENT_NAMES,
  NOTIFICATION_HOOK_EVENTS,
  NOTIFICATION_OUTCOME_KINDS,
  STEP_STATUS,
  type NotificationOutcomeKind,
} from "../../../../types/DashboardConstants";
import type {
  HookEvent,
  UserHookConfig,
} from "../../../../types/CtrlYokeTypes";

/**
 * Notification monitoring configuration
 */
export interface NotificationConfig {
  /** Directory to watch for notification files */
  directory: string;

  /** Polling interval in milliseconds (optional) */
  pollMs?: number;

  /** Timeout in milliseconds */
  timeoutMs: number;
}

/**
 * Notification monitoring result
 */
export interface NotificationResult {
  /** Whether completion was detected */
  completed: boolean;

  /** Structured notification outcome when a file was detected */
  kind?: NotificationOutcomeKind;

  /** Error message if monitoring failed */
  error?: string;

  /** Notification data if found */
  data?: any;
}

/** Hook configuration format discriminants returned by notification monitors. */
export const HOOK_CONFIG_TYPES = {
  JSON: "json",
  JSON_STRING: "json-string",
  NONE: "none",
} as const;

/**
 * Hook configuration result (varies by CLI)
 *
 * Different CLIs use different configuration formats:
 * - Copilot: JSON object
 * - Claude: JSON string
 * - Codex: TOML inline string
 */
export type HookConfig =
  | { type: typeof HOOK_CONFIG_TYPES.JSON; config: object } // Copilot/Qwen/Antigravity/Codex: JSON object
  | { type: typeof HOOK_CONFIG_TYPES.JSON_STRING; config: string } // Claude: JSON string
  | { type: typeof HOOK_CONFIG_TYPES.NONE }; // No hook support

/**
 * Notification monitoring interface
 *
 * Each CLI harness implements this to monitor for completion notifications
 * in their specific format (sessionEnd hooks, notify callbacks, etc.)
 */
export interface INotificationMonitor {
  /**
   * Whether this harness includes session IDs in notification filenames.
   *
   * - `true`: Notification files include session ID (e.g., Claude: `{threadId}-stop.json`)
   * - `false`: Notification files use timestamps (wildcard monitoring required)
   *
   * This determines the monitoring mode:
   * - When true: Use specific session monitoring (faster, more reliable)
   * - When false: Use wildcard monitoring (any new file triggers completion)
   */
  readonly supportsSessionIdInFilename: boolean;

  /**
   * Whether this harness fires a SessionStart hook at the beginning of a session.
   *
   * - `true`: waitForSessionStart() will be called to detect session start and extract session ID
   * - `false`: CliIntegration falls through to log file discovery as the session-start proxy
   *
   * Claude and Copilot fire SessionStart hooks; Codex does not.
   */
  readonly supportsSessionStart: boolean;

  /**
   * Monitor for completion notification
   * @param config Monitoring configuration
   * @param sessionId Optional session/thread ID (undefined = wildcard mode)
   * @param startTime Execution start time
   * @param onCancel Cancellation callback
   * @returns Monitoring result
   */
  monitorForCompletion(
    config: NotificationConfig,
    sessionId: string | undefined,
    startTime: Date,
    onCancel?: () => boolean,
    runId?: string
  ): Promise<NotificationResult>;

  /**
   * Build hook/notification configuration
   * @param scriptPath Path to notification handler script
   * @param notifyDir Notification directory
   * @param workspaceRoot Workspace root directory
   * @returns Hook configuration (format varies by CLI)
   */
  buildHookConfig(
    scriptPath: string,
    notifyDir: string,
    workspaceRoot: string,
    userHooks?: UserHookConfig[],
    ctrlyokeEvents?: HookEvent[]
  ): HookConfig;

  /**
   * Get notification directory for this CLI
   * @param workspaceRoot Workspace root
   * @returns Notification directory path
   */
  getNotificationDirectory(workspaceRoot: string): string;

  /**
   * Extract session/thread ID from notification data
   * @param data Notification file content
   * @returns Session ID if found
   */
  extractSessionId?(data: any): string | undefined;

  /**
   * Wait for session start notification and extract session ID
   *
   * This method waits for the SessionStart hook to fire.
   * This is faster and more reliable than searching log files.
   *
   * @param config Monitoring configuration
   * @param startTime Execution start time
   * @param runId Per-run ID set via CTRLYOKE_RUN_ID env var; when provided, the
   *   hook writes {runId}-start.json and this method does a direct lookup instead
   *   of a wildcard scan — eliminating the parallel-workflow race.
   * @param onCancel Cancellation callback
   * @returns NotificationResult with session ID in data.sessionId (if provided by CLI)
   */
  waitForSessionStart?(
    config: NotificationConfig,
    startTime: Date,
    runId?: string,
    onCancel?: () => boolean
  ): Promise<NotificationResult>;

  /**
   * Cleanup notification files after completion or cancellation
   *
   * Called after every run (success, failure, or cancellation) to remove
   * the -start.json, -stop.json, and -error.json files for the session.
   *
   * The stop file may be orphaned when completion is detected via the log file
   * before monitorForCompletion() polls for it (the monitor exits early via the
   * cancel callback and never reads/deletes the stop file).
   *
   * @param sessionId Session ID
   * @param directory Notification directory
   */
  cleanupNotificationFiles?(
    sessionId: string,
    directory: string
  ): Promise<void>;
}

/**
 * Standard notification monitor base class
 *
 * Implements all monitoring logic for harnesses that use the standardized
 * two-file notification format:
 *
 *   {sessionId}-start.json → { hookEvent: "SessionStart", sessionId, status: "started" }
 *   {sessionId}-stop.json  → { hookEvent: "Stop", sessionId, status: "completed" }
 *
 * Currently used by: Copilot CLI, Claude CLI
 *
 * Harnesses with a different format (e.g., Codex: notify-{id}.json) extend this
 * class and override monitorForCompletion() only. The file utilities and other
 * concrete methods remain available.
 *
 * Abstract requirements (must implement in subclass):
 * - buildHookConfig()      — CLI-specific hook registration format
 * - getNotificationDirectory() — CLI-specific notification path
 */
export abstract class NotificationMonitorBase implements INotificationMonitor {
  /**
   * Standard harnesses include session IDs in notification filenames.
   * Override to false for harnesses that use timestamp-based filenames.
   */
  readonly supportsSessionIdInFilename: boolean = true;

  /**
   * Standard harnesses (Claude, Copilot) fire a SessionStart hook.
   * Override to false for harnesses that use log file discovery instead (Codex).
   */
  readonly supportsSessionStart: boolean = true;

  // ── Abstract (CLI-specific) ──────────────────────────────────────────────

  abstract buildHookConfig(
    scriptPath: string,
    notifyDir: string,
    workspaceRoot: string,
    userHooks?: UserHookConfig[],
    ctrlyokeEvents?: HookEvent[]
  ): HookConfig;

  abstract getNotificationDirectory(workspaceRoot: string): string;

  // ── Overridable defaults ──────────────────────────────────────────────────

  /**
   * Hook event names that indicate a session has started.
   *
   * Default: ["SessionStart"] — overridden by harnesses that use a different
   * event as their reliable session-start signal (e.g., Qwen uses UserPromptSubmit
   * because SessionStart fires fire-and-forget and may not complete before the
   * session ends on fast prompts).
   */
  protected getStartHookEvents(): string[] {
    return ["SessionStart"];
  }

  // ── Concrete (shared two-file format) ────────────────────────────────────

  /**
   * Extract session ID from standard notification data.
   */
  extractSessionId(data: any): string | undefined {
    return data?.sessionId;
  }

  /**
   * Monitor for completion via {sessionId}-stop.json with hookEvent: "Stop",
   * or detect a harness failure via {sessionId}-error.json.
   *
   * When sessionId is provided: polls {sessionId}-stop.json directly.
   * When sessionId is undefined, scans newer Stop files. If runId is provided,
   * a file must carry the same runId to keep standalone runs isolated.
   *
   * Deletes the stop file when completion is confirmed.
   */
  async monitorForCompletion(
    config: NotificationConfig,
    sessionId: string | undefined,
    startTime: Date,
    onCancel?: () => boolean,
    runId?: string
  ): Promise<NotificationResult> {
    const pollMs = config.pollMs || 500;

    Log.debug(
      `[NotificationMonitorBase] Monitoring for Stop hook (session: ${sessionId || "wildcard"})`
    );

    while (Date.now() - startTime.getTime() < config.timeoutMs) {
      if (onCancel?.()) {
        Log.debug(
          "[NotificationMonitorBase] Stop hook monitoring stopped (cancelled or already completed)"
        );
        return { completed: false, error: "Execution cancelled" };
      }

      try {
        if (sessionId) {
          const errorFile = path.join(
            config.directory,
            `${sessionId}-error.json`
          );
          if (await this.isFileNewerThan(errorFile, startTime)) {
            const data = await this.readNotificationFile(errorFile);

            if (data?.status === NOTIFICATION_OUTCOME_KINDS.ERROR) {
              Log.warn(
                `[NotificationMonitorBase] Harness error detected via notification hook (session: ${sessionId})`
              );
              try {
                fs.unlinkSync(errorFile);
                Log.trace(
                  "[NotificationMonitorBase] Cleaned up error notification file"
                );
              } catch (error) {
                Log.trace(
                  `[NotificationMonitorBase] Failed to cleanup error file: ${error}`
                );
              }
              return {
                completed: false,
                kind: NOTIFICATION_OUTCOME_KINDS.ERROR,
                error: "Harness reported an error",
                data,
              };
            }
          }

          const stopFile = path.join(
            config.directory,
            `${sessionId}-stop.json`
          );
          if (await this.isFileNewerThan(stopFile, startTime)) {
            const data = await this.readNotificationFile(stopFile);

            if (
              data?.hookEvent === NOTIFICATION_HOOK_EVENTS.STOP &&
              data?.status === STEP_STATUS.COMPLETED
            ) {
              Log.info(
                `[NotificationMonitorBase] Completion detected via Stop hook (session: ${sessionId})`
              );
              try {
                fs.unlinkSync(stopFile);
                Log.trace(
                  "[NotificationMonitorBase] Cleaned up Stop notification file"
                );
              } catch (error) {
                Log.trace(
                  `[NotificationMonitorBase] Failed to cleanup Stop file: ${error}`
                );
              }
              return { completed: true, kind: "completion", data };
            }
          }
        } else {
          const errorFiles = await this.findNotificationFiles(
            config.directory,
            /-error\.json$/
          );

          for (const file of errorFiles) {
            if (await this.isFileNewerThan(file, startTime)) {
              const data = await this.readNotificationFile(file);

              if (data?.status === NOTIFICATION_OUTCOME_KINDS.ERROR) {
                Log.warn(
                  `[NotificationMonitorBase] Harness error detected via notification hook (file: ${file})`
                );
                try {
                  fs.unlinkSync(file);
                  Log.trace(
                    "[NotificationMonitorBase] Cleaned up error notification file"
                  );
                } catch (error) {
                  Log.trace(
                    `[NotificationMonitorBase] Failed to cleanup error file: ${error}`
                  );
                }
                return {
                  completed: false,
                  kind: NOTIFICATION_OUTCOME_KINDS.ERROR,
                  error: "Harness reported an error",
                  data,
                };
              }
            }
          }

          const files = await this.findNotificationFiles(
            config.directory,
            /-stop\.json$/
          );

          for (const file of files) {
            if (await this.isFileNewerThan(file, startTime)) {
              const data = await this.readNotificationFile(file);

              if (
                data?.hookEvent === NOTIFICATION_HOOK_EVENTS.STOP &&
                data?.status === STEP_STATUS.COMPLETED &&
                (!runId || data?.runId === runId)
              ) {
                Log.info(
                  `[NotificationMonitorBase] Completion detected via Stop hook (file: ${file})`
                );
                try {
                  fs.unlinkSync(file);
                  Log.trace(
                    "[NotificationMonitorBase] Cleaned up Stop notification file"
                  );
                } catch (error) {
                  Log.trace(
                    `[NotificationMonitorBase] Failed to cleanup Stop file: ${error}`
                  );
                }
                return { completed: true, kind: "completion", data };
              }
            }
          }
        }
      } catch (error) {
        Log.trace(
          `[NotificationMonitorBase] Stop notification check error: ${error}`
        );
      }

      await this.delay(pollMs);
    }

    Log.warn(`[NotificationMonitorBase] Stop hook monitoring timed out`);
    return {
      completed: false,
      error: "Timeout waiting for Stop hook notification",
    };
  }

  /**
   * Wait for session start via {sessionId}-start.json with hookEvent: "SessionStart".
   *
   * Scans for any *-start.json file newer than startTime.
   * Does NOT delete the file — cleanupNotificationFiles() removes both start
   * and stop files after the run completes or is cancelled.
   *
   * Returns the full notification data; callers use data.sessionId.
   */
  async waitForSessionStart(
    config: NotificationConfig,
    startTime: Date,
    runId?: string,
    onCancel?: () => boolean
  ): Promise<NotificationResult> {
    const pollMs = config.pollMs || 100;

    Log.debug(
      `[NotificationMonitorBase] Waiting for SessionStart notification (timeout: ${config.timeoutMs}ms, runId: ${runId ?? "none"})`
    );

    while (Date.now() - startTime.getTime() < config.timeoutMs) {
      if (onCancel?.()) {
        Log.debug("[NotificationMonitorBase] SessionStart wait cancelled");
        return { completed: false, error: "User cancelled execution" };
      }

      if (runId) {
        // Direct lookup — no wildcard scan, no parallel-workflow race.
        // The hook wrote {runId}-start.json because CTRLYOKE_RUN_ID was set in its env.
        const file = path.join(config.directory, `${runId}-start.json`);
        if (await this.isFileNewerThan(file, startTime)) {
          const data = await this.readNotificationFile(file);

          if (
            this.getStartHookEvents().includes(data?.hookEvent) &&
            data?.sessionId
          ) {
            Log.trace(
              `[NotificationMonitorBase] Found session-start notification (${data.hookEvent}): ${data.sessionId}`
            );
            // Delete immediately — this file belongs exclusively to this run
            try {
              fs.unlinkSync(file);
              Log.trace(
                "[NotificationMonitorBase] Cleaned up run-scoped SessionStart notification file"
              );
            } catch (error) {
              Log.trace(
                `[NotificationMonitorBase] Failed to cleanup SessionStart file: ${error}`
              );
            }
            return { completed: true, data };
          }
        }
      } else {
        // Wildcard scan — fallback path for harnesses that don't set CTRLYOKE_RUN_ID.
        // isFileNewerThan guards against stale files but parallel-workflow safety
        // depends on non-overlapping start times.
        const files = await this.findNotificationFiles(
          config.directory,
          /-start\.json$/
        );

        for (const file of files) {
          if (await this.isFileNewerThan(file, startTime)) {
            const data = await this.readNotificationFile(file);

            if (
              this.getStartHookEvents().includes(data?.hookEvent) &&
              data?.sessionId
            ) {
              Log.trace(
                `[NotificationMonitorBase] Found session-start notification (${data.hookEvent}): ${data.sessionId}`
              );
              // NOTE: Do NOT delete here — cleanupNotificationFiles() removes both
              // start and stop files after the run, keeping parallel workflows safe
              // (two concurrent workflows must each be able to read their own start file)
              return { completed: true, data };
            }
          }
        }
      }

      await this.delay(pollMs);
    }

    Log.warn("[NotificationMonitorBase] SessionStart wait timeout");
    return {
      completed: false,
      error: "Timeout waiting for SessionStart notification",
    };
  }

  /**
   * Cleanup notification files after session completion or cancellation.
   *
   * Deletes the start, stop, and error files for the given session. The start file
   * is normally deleted immediately by waitForSessionStart(), but may linger if
   * the session aborted early. The stop file may be orphaned if completion was
   * detected via the log file before monitorForCompletion() polled for it.
   */
  async cleanupNotificationFiles(
    sessionId: string,
    directory: string
  ): Promise<void> {
    for (const suffix of ["-start.json", "-stop.json", "-error.json"]) {
      const file = path.join(directory, `${sessionId}${suffix}`);
      try {
        fs.unlinkSync(file);
        Log.trace(
          `[NotificationMonitorBase] Cleaned up notification file: ${path.basename(file)}`
        );
      } catch {
        // Ignore — file may not exist (already deleted or never created)
      }
    }
  }

  // ── Protected helpers ────────────────────────────────────────────────────

  /**
   * Base64-encodes the permissionRequest hook command so it can be safely passed
   * as a CLI argument. Returns undefined when no permissionRequest hook is configured.
   */
  protected encodePermissionRequestHook(
    userHooks: UserHookConfig[] | undefined
  ): string | undefined {
    const hook = userHooks?.find(
      (h) => h.event === HOOK_EVENT_NAMES.PERMISSION_REQUEST
    );
    return hook
      ? Buffer.from(hook.command, "utf8").toString("base64")
      : undefined;
  }

  /**
   * Builds the hooks record for harnesses that use a command-style hook entry
   * format. By default each entry is `{ hooks: [{ type: "command", command: "..." }] }`
   * (Claude); pass `buildHookGroup` to customize the entry shape (e.g.
   * Codex's matcher-based `{ matcher, hooks: [...] }` via `createCodexCommandHookGroup`).
   *
   * Handles:
   *   - Main ctrlyoke event hooks (with optional permissionRequest encoding)
   *   - Appending user-defined hooks (skipping permissionRequest if already registered)
   *
   * Returns the hooks record; callers serialize it as json-string or json.
   */
  protected buildCommandHooks(
    command: string,
    eventMap: Partial<Record<HookEvent, string>>,
    selectedEvents: string[],
    userHooks: UserHookConfig[] | undefined,
    encodedDecisionHook: string | undefined,
    buildHookGroup: (
      nativeEvent: string,
      command: string
    ) => Record<string, unknown> = (_nativeEvent, cmd) => ({
      hooks: [{ type: "command", command: cmd }],
    })
  ): Record<string, unknown[]> {
    const hooks: Record<string, unknown[]> = {};

    for (const event of selectedEvents) {
      const nativeEvent = eventMap[event as HookEvent];
      if (!nativeEvent) continue;
      const eventCommand =
        event === HOOK_EVENT_NAMES.PERMISSION_REQUEST && encodedDecisionHook
          ? `${command} "${encodedDecisionHook}"`
          : command;
      hooks[nativeEvent] = [buildHookGroup(nativeEvent, eventCommand)];
    }

    if (userHooks) {
      for (const uh of userHooks) {
        if (
          uh.event === HOOK_EVENT_NAMES.PERMISSION_REQUEST &&
          selectedEvents.includes(HOOK_EVENT_NAMES.PERMISSION_REQUEST)
        ) {
          continue;
        }
        const nativeEvent = eventMap[uh.event];
        if (!nativeEvent) continue;
        if (!hooks[nativeEvent]) hooks[nativeEvent] = [];
        hooks[nativeEvent].push(buildHookGroup(nativeEvent, uh.command));
      }
    }

    return hooks;
  }

  /**
   * Simple delay utility
   */
  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Read and parse a JSON notification file WITHOUT deleting it.
   * Returns null if the file doesn't exist or contains invalid JSON.
   */
  protected async readNotificationFile(filePath: string): Promise<any | null> {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Find notification files matching a pattern in a directory.
   * Returns empty array if the directory doesn't exist or is unreadable.
   */
  protected async findNotificationFiles(
    directory: string,
    pattern: RegExp
  ): Promise<string[]> {
    try {
      const files = fs.readdirSync(directory);
      return files
        .filter((file) => pattern.test(file))
        .map((file) => path.join(directory, file));
    } catch {
      return [];
    }
  }

  /**
   * Check if a notification file was modified after the given start time.
   */
  protected async isFileNewerThan(
    filePath: string,
    startTime: Date
  ): Promise<boolean> {
    try {
      const stats = fs.statSync(filePath);
      return stats.mtime > startTime;
    } catch {
      return false;
    }
  }
}
