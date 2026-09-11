import type { ILogParser } from "./interfaces/ILogParser";
import type { INotificationMonitor } from "./interfaces/INotificationMonitor";
import type { InteractiveAbortState } from "./CliFailureTracker";
import { INTERACTIVE_ABORT_KINDS } from "../../../types/DashboardConstants";
import { Log } from "../../../utils/Log";

const DEFAULT_SESSION_START_SOFT_TIMEOUT_MS = 60_000;
const DEFAULT_SESSION_START_HARD_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_SESSION_START_POLL_MS = 100;
const DEFAULT_LATE_START_RECOVERY_POLL_MS = 1_000;
const INTERACTIVE_WAIT_ABORTED = Symbol("interactiveWaitAborted");

export interface InteractiveSessionDiscovery {
  logPath: string;
  sessionId: string | null;
}

export interface CliInteractiveStartupTimeouts {
  sessionStartSoftTimeoutMs?: number;
  sessionStartHardTimeoutMs?: number;
  sessionStartPollMs?: number;
  lateStartRecoveryPollMs?: number;
}

export interface CliInteractiveStartupCoordinatorDeps {
  logParser: ILogParser;
  notificationMonitor: INotificationMonitor;
  getWorkspaceRoot: () => string | undefined;
  getAbortState: () => InteractiveAbortState | null;
  markProcessExitDuringStage: (stage: string, exitCode: number) => string;
  setFailureReason: (reason: string) => void;
  startupTimeouts?: CliInteractiveStartupTimeouts;
}

export class CliInteractiveStartupCoordinator {
  constructor(private readonly deps: CliInteractiveStartupCoordinatorDeps) {}

  async resolveSession(params: {
    promptForDiscovery: string;
    startTime: Date;
    resolvedSessionId?: string;
    runId: string;
  }): Promise<InteractiveSessionDiscovery | null> {
    if (params.resolvedSessionId) {
      return await this.resolveResumedSession({
        promptForDiscovery: params.promptForDiscovery,
        startTime: params.startTime,
        resolvedSessionId: params.resolvedSessionId,
      });
    }

    if (this.deps.notificationMonitor.supportsSessionStart) {
      return await this.resolveWithSessionStart(params);
    }

    return await this.resolveWithoutSessionStart(params);
  }

  private async resolveResumedSession(params: {
    promptForDiscovery: string;
    startTime: Date;
    resolvedSessionId: string;
  }): Promise<InteractiveSessionDiscovery | null> {
    Log.debug(
      `[CliInteractiveStartupCoordinator] Resuming session ${params.resolvedSessionId} - discovering log file directly...`
    );

    const discovery = await this.discoverAndExtractSession(
      params.promptForDiscovery,
      params.startTime,
      params.resolvedSessionId,
      "Log file not found for resumed session"
    );

    if (!discovery) {
      if (
        this.handleInteractiveStartupAbort(
          "discovering the resumed session log"
        )
      ) {
        return null;
      }

      Log.error(
        `[CliInteractiveStartupCoordinator] Could not find log file for resumed session ${params.resolvedSessionId}\n` +
          `   The session may have been deleted or never existed.\n` +
          `   To fix: Remove the sessionId property to start a new session.`
      );
      return null;
    }

    Log.info(
      `[CliInteractiveStartupCoordinator] Found log file for resumed session: ${discovery.logPath}`
    );

    this.deps.logParser.seekToEnd?.(discovery.logPath);
    return discovery;
  }

  private async resolveWithSessionStart(params: {
    promptForDiscovery: string;
    startTime: Date;
    runId: string;
  }): Promise<InteractiveSessionDiscovery | null> {
    Log.info(
      "[CliInteractiveStartupCoordinator] Waiting for SessionStart hook and log file creation..."
    );

    const workspaceRoot = this.deps.getWorkspaceRoot();
    if (!workspaceRoot) {
      Log.error(
        "[CliInteractiveStartupCoordinator] No workspace root for session start monitoring"
      );
      return null;
    }

    const notifyDir =
      this.deps.notificationMonitor.getNotificationDirectory(workspaceRoot);
    const timeouts = this.getStartupTimeouts();

    const startResult = await this.deps.notificationMonitor
      .waitForSessionStart!(
      {
        directory: notifyDir,
        timeoutMs: timeouts.sessionStartSoftTimeoutMs,
        pollMs: timeouts.sessionStartPollMs,
      },
      params.startTime,
      params.runId,
      () => this.deps.getAbortState() !== null
    );

    if (!startResult.completed) {
      if (this.handleInteractiveStartupAbort("waiting for SessionStart hook")) {
        return null;
      }

      Log.warn(
        `[CliInteractiveStartupCoordinator] SessionStart hook did not arrive within ${timeouts.sessionStartSoftTimeoutMs}ms: ` +
          `${startResult.error || "still waiting"}`
      );
      Log.info(
        `[CliInteractiveStartupCoordinator] Keeping interactive startup alive and polling for a delayed session log ` +
          `for up to ${timeouts.sessionStartHardTimeoutMs}ms total`
      );
      const recovered = await this.recoverFromLateInteractiveStartup({
        promptForDiscovery: params.promptForDiscovery,
        startTime: params.startTime,
      });
      if (recovered) {
        return recovered;
      }

      if (
        this.handleInteractiveStartupAbort(
          "waiting for delayed interactive startup recovery"
        )
      ) {
        return null;
      }

      const timeoutReason =
        `Timed out waiting for interactive session startup after ` +
        `${timeouts.sessionStartHardTimeoutMs}ms`;
      Log.error(`[CliInteractiveStartupCoordinator] ${timeoutReason}`);
      this.deps.setFailureReason(timeoutReason);
      return null;
    }

    const hookSessionId = startResult.data?.sessionId || null;

    if (hookSessionId) {
      Log.debug(
        `[CliInteractiveStartupCoordinator] SessionStart hook provided session ID: ${hookSessionId}`
      );
    } else {
      Log.debug(
        "[CliInteractiveStartupCoordinator] SessionStart hook confirmed (session ID not provided by CLI)"
      );
      Log.debug(
        "[CliInteractiveStartupCoordinator] Discovering session log file via prompt text matching..."
      );
    }

    const discovery = await this.discoverAndExtractSession(
      params.promptForDiscovery,
      params.startTime,
      hookSessionId,
      undefined
    );

    if (discovery) {
      Log.info(
        `[CliInteractiveStartupCoordinator] Found session log: ${discovery.logPath}`
      );
      return discovery;
    }

    if (
      this.handleInteractiveStartupAbort(
        "discovering the session log after SessionStart"
      )
    ) {
      return null;
    }

    Log.info(
      `[CliInteractiveStartupCoordinator] Session start confirmed${hookSessionId ? ` for ${hookSessionId}` : ""}, but the session log is not ready yet; polling for up to ${timeouts.sessionStartHardTimeoutMs}ms total`
    );

    const recovered = await this.recoverFromLateInteractiveStartup({
      promptForDiscovery: params.promptForDiscovery,
      startTime: params.startTime,
      preferredSessionId: hookSessionId,
    });
    if (recovered) {
      return recovered;
    }

    if (
      this.handleInteractiveStartupAbort(
        "waiting for delayed interactive startup recovery"
      )
    ) {
      return null;
    }

    const timeoutReason =
      `Timed out waiting for interactive session startup after ` +
      `${timeouts.sessionStartHardTimeoutMs}ms`;
    Log.error(`[CliInteractiveStartupCoordinator] ${timeoutReason}`);
    this.deps.setFailureReason(timeoutReason);
    return null;
  }

  private async resolveWithoutSessionStart(params: {
    promptForDiscovery: string;
    startTime: Date;
  }): Promise<InteractiveSessionDiscovery | null> {
    Log.info(
      "[CliInteractiveStartupCoordinator] Discovering session log file (no SessionStart hook)..."
    );

    const discovery = await this.discoverAndExtractSession(
      params.promptForDiscovery,
      params.startTime,
      null,
      undefined
    );

    if (discovery) {
      Log.info(
        `[CliInteractiveStartupCoordinator] Found session log: ${discovery.logPath}`
      );
      return discovery;
    }

    if (this.handleInteractiveStartupAbort("discovering the session log")) {
      return null;
    }

    const timeouts = this.getStartupTimeouts();
    Log.info(
      `[CliInteractiveStartupCoordinator] Session log not found yet; polling for up to ${timeouts.sessionStartHardTimeoutMs}ms total`
    );

    const recovered = await this.recoverFromLateInteractiveStartup({
      promptForDiscovery: params.promptForDiscovery,
      startTime: params.startTime,
    });
    if (recovered) {
      return recovered;
    }

    if (
      this.handleInteractiveStartupAbort(
        "waiting for delayed interactive startup recovery"
      )
    ) {
      return null;
    }

    const timeoutReason =
      `Timed out waiting for interactive session startup after ` +
      `${timeouts.sessionStartHardTimeoutMs}ms`;
    Log.error(`[CliInteractiveStartupCoordinator] ${timeoutReason}`);
    this.deps.setFailureReason(timeoutReason);
    return null;
  }

  private async discoverAndExtractSession(
    promptForDiscovery: string,
    startTime: Date,
    sessionId: string | null,
    errorContext?: string
  ): Promise<InteractiveSessionDiscovery | null> {
    const discoveredLogPath = await this.waitForInteractiveStartupOperation(
      (signal) =>
        this.deps.logParser.discoverSessionLog(
          promptForDiscovery,
          startTime,
          sessionId || undefined,
          signal
        )
    );

    if (discoveredLogPath === INTERACTIVE_WAIT_ABORTED) {
      return null;
    }

    if (!discoveredLogPath) {
      if (errorContext) {
        this.deps.setFailureReason(errorContext);
      }
      return null;
    }

    if (!sessionId) {
      const events = await this.deps.logParser.readNewLines(discoveredLogPath);
      const extractedId = this.deps.logParser.extractSessionId(events);
      if (extractedId) {
        Log.debug(
          `[CliInteractiveStartupCoordinator] Extracted session ID from log: ${extractedId}`
        );
      }
      return { logPath: discoveredLogPath, sessionId: extractedId };
    }

    return { logPath: discoveredLogPath, sessionId };
  }

  private handleInteractiveStartupAbort(stage: string): boolean {
    const abortState = this.deps.getAbortState();
    if (!abortState) {
      return false;
    }

    if (abortState.kind === INTERACTIVE_ABORT_KINDS.USER_CANCELLED) {
      Log.info(
        `[CliInteractiveStartupCoordinator] Interactive execution cancelled while ${stage}`
      );
      return true;
    }

    this.deps.setFailureReason(
      this.deps.markProcessExitDuringStage(stage, abortState.exitCode)
    );
    Log.warn(
      `[CliInteractiveStartupCoordinator] CLI process exited while ${stage} (exit code ${abortState.exitCode})`
    );
    return true;
  }

  private async recoverFromLateInteractiveStartup(params: {
    promptForDiscovery: string;
    startTime: Date;
    preferredSessionId?: string | null;
  }): Promise<InteractiveSessionDiscovery | null> {
    const timeouts = this.getStartupTimeouts();
    const deadlineMs =
      params.startTime.getTime() + timeouts.sessionStartHardTimeoutMs;

    while (Date.now() < deadlineMs) {
      if (
        this.handleInteractiveStartupAbort(
          "waiting for delayed interactive startup recovery"
        )
      ) {
        return null;
      }

      const discovery = await this.discoverAndExtractSession(
        params.promptForDiscovery,
        params.startTime,
        params.preferredSessionId ?? null
      );
      if (discovery) {
        Log.info(
          `[CliInteractiveStartupCoordinator] Recovered interactive startup after SessionStart timeout via session log discovery`
        );
        return discovery;
      }

      if (
        this.handleInteractiveStartupAbort(
          "waiting for delayed interactive startup recovery"
        )
      ) {
        return null;
      }

      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        break;
      }

      const waitResult = await this.waitForInteractiveStartupOperation(
        (signal) =>
          this.delay(
            Math.min(
              timeouts.lateStartRecoveryPollMs,
              Math.max(1, remainingMs)
            ),
            signal
          )
      );
      if (waitResult === INTERACTIVE_WAIT_ABORTED) {
        return null;
      }
    }

    return null;
  }

  private getStartupTimeouts(): Required<CliInteractiveStartupTimeouts> {
    const configuredSoftTimeoutMs =
      this.deps.startupTimeouts?.sessionStartSoftTimeoutMs ??
      DEFAULT_SESSION_START_SOFT_TIMEOUT_MS;
    const sessionStartSoftTimeoutMs = Math.max(1, configuredSoftTimeoutMs);
    const configuredHardTimeoutMs =
      this.deps.startupTimeouts?.sessionStartHardTimeoutMs ??
      DEFAULT_SESSION_START_HARD_TIMEOUT_MS;
    const sessionStartHardTimeoutMs = Math.max(
      sessionStartSoftTimeoutMs,
      configuredHardTimeoutMs
    );

    return {
      sessionStartSoftTimeoutMs,
      sessionStartHardTimeoutMs,
      sessionStartPollMs: Math.max(
        1,
        this.deps.startupTimeouts?.sessionStartPollMs ??
          DEFAULT_SESSION_START_POLL_MS
      ),
      lateStartRecoveryPollMs: Math.max(
        1,
        this.deps.startupTimeouts?.lateStartRecoveryPollMs ??
          DEFAULT_LATE_START_RECOVERY_POLL_MS
      ),
    };
  }

  private async waitForInteractiveStartupOperation<T>(
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T | typeof INTERACTIVE_WAIT_ABORTED> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const abortController = new AbortController();

      const finish = (action: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearInterval(intervalHandle);
        action();
      };

      const intervalHandle = setInterval(() => {
        if (this.deps.getAbortState()) {
          abortController.abort();
          finish(() => resolve(INTERACTIVE_WAIT_ABORTED));
        }
      }, this.getStartupTimeouts().sessionStartPollMs);

      void Promise.resolve()
        .then(() => operation(abortController.signal))
        .then((value) => {
          finish(() => resolve(value));
        })
        .catch((error) => {
          finish(() => reject(error));
        });
    });
  }

  private async delay(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timeoutHandle = setTimeout(finish, ms);
      signal.addEventListener("abort", finish, { once: true });

      if (signal.aborted) {
        finish();
      }
    });
  }
}
