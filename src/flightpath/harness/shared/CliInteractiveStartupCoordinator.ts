import type { ILogParser } from "./interfaces/ILogParser";
import type { INotificationMonitor } from "./interfaces/INotificationMonitor";
import type { InteractiveAbortState } from "./CliFailureTracker";
import { INTERACTIVE_ABORT_KINDS } from "../../../types/DashboardConstants";
import { Log } from "../../../utils/Log";

const SESSION_START_TIMEOUT_MS = 60_000;
const SESSION_START_POLL_MS = 100;
const INTERACTIVE_WAIT_ABORTED = Symbol("interactiveWaitAborted");

export interface InteractiveSessionDiscovery {
  logPath: string;
  sessionId: string | null;
}

export interface CliInteractiveStartupCoordinatorDeps {
  logParser: ILogParser;
  notificationMonitor: INotificationMonitor;
  getWorkspaceRoot: () => string | undefined;
  getAbortState: () => InteractiveAbortState | null;
  markProcessExitDuringStage: (stage: string, exitCode: number) => string;
  setFailureReason: (reason: string) => void;
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
      `🔄 Resuming session ${params.resolvedSessionId} - discovering log file directly...`
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
        `❌ Could not find log file for resumed session ${params.resolvedSessionId}\n` +
          `   The session may have been deleted or never existed.\n` +
          `   To fix: Remove the sessionId property to start a new session.`
      );
      return null;
    }

    Log.info(`✅ Found log file for resumed session: ${discovery.logPath}`);

    this.deps.logParser.seekToEnd?.(discovery.logPath);
    return discovery;
  }

  private async resolveWithSessionStart(params: {
    promptForDiscovery: string;
    startTime: Date;
    runId: string;
  }): Promise<InteractiveSessionDiscovery | null> {
    Log.info("🔍 Waiting for SessionStart hook and log file creation...");

    const workspaceRoot = this.deps.getWorkspaceRoot();
    if (!workspaceRoot) {
      Log.error("❌ No workspace root for session start monitoring");
      return null;
    }

    const notifyDir =
      this.deps.notificationMonitor.getNotificationDirectory(workspaceRoot);

    const startResult = await this.deps.notificationMonitor
      .waitForSessionStart!(
      {
        directory: notifyDir,
        timeoutMs: SESSION_START_TIMEOUT_MS,
        pollMs: SESSION_START_POLL_MS,
      },
      params.startTime,
      params.runId,
      () => this.deps.getAbortState() !== null
    );

    if (!startResult.completed) {
      if (this.handleInteractiveStartupAbort("waiting for SessionStart hook")) {
        return null;
      }

      Log.error(
        `❌ SessionStart hook timeout: ${startResult.error || "Unknown error"}`
      );
      this.deps.setFailureReason(
        startResult.error || "SessionStart hook timeout"
      );
      return null;
    }

    const hookSessionId = startResult.data?.sessionId || null;

    if (hookSessionId) {
      Log.debug(`✅ SessionStart hook provided session ID: ${hookSessionId}`);
    } else {
      Log.debug(
        "✅ SessionStart hook confirmed (session ID not provided by CLI)"
      );
      Log.debug("🔍 Discovering session log file via prompt text matching...");
    }

    const discovery = await this.discoverAndExtractSession(
      params.promptForDiscovery,
      params.startTime,
      hookSessionId,
      hookSessionId
        ? "Log file not found after SessionStart"
        : "Session log not found"
    );

    if (!discovery) {
      if (
        this.handleInteractiveStartupAbort(
          "discovering the session log after SessionStart"
        )
      ) {
        return null;
      }

      if (hookSessionId) {
        Log.error(
          `❌ Could not find log file for session ${hookSessionId} - this should not happen!`
        );
      } else {
        Log.error(
          "❌ Could not discover session log - no matching prompt found"
        );
      }
      return null;
    }

    Log.info(`✅ Found session log: ${discovery.logPath}`);
    return discovery;
  }

  private async resolveWithoutSessionStart(params: {
    promptForDiscovery: string;
    startTime: Date;
  }): Promise<InteractiveSessionDiscovery | null> {
    Log.info("🔍 Discovering session log file (no SessionStart hook)...");

    const discovery = await this.discoverAndExtractSession(
      params.promptForDiscovery,
      params.startTime,
      null,
      "Session log not found"
    );

    if (!discovery) {
      if (this.handleInteractiveStartupAbort("discovering the session log")) {
        return null;
      }

      Log.error("❌ Could not discover session log - no matching prompt found");
      return null;
    }

    Log.info(`✅ Found session log: ${discovery.logPath}`);
    return discovery;
  }

  private async discoverAndExtractSession(
    promptForDiscovery: string,
    startTime: Date,
    sessionId: string | null,
    errorContext: string
  ): Promise<InteractiveSessionDiscovery | null> {
    const discoveredLogPath = await this.waitForInteractiveStartupOperation(
      this.deps.logParser.discoverSessionLog(
        promptForDiscovery,
        startTime,
        sessionId || undefined
      )
    );

    if (discoveredLogPath === INTERACTIVE_WAIT_ABORTED) {
      return null;
    }

    if (!discoveredLogPath) {
      this.deps.setFailureReason(errorContext);
      return null;
    }

    if (!sessionId) {
      const events = await this.deps.logParser.readNewLines(discoveredLogPath);
      const extractedId = this.deps.logParser.extractSessionId(events);
      if (extractedId) {
        Log.debug(`💾 Extracted session ID from log: ${extractedId}`);
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
      Log.info(`⏹️ Interactive execution cancelled while ${stage}`);
      return true;
    }

    this.deps.setFailureReason(
      this.deps.markProcessExitDuringStage(stage, abortState.exitCode)
    );
    Log.warn(
      `⚠️ CLI process exited while ${stage} (exit code ${abortState.exitCode})`
    );
    return true;
  }

  private async waitForInteractiveStartupOperation<T>(
    operation: Promise<T>
  ): Promise<T | typeof INTERACTIVE_WAIT_ABORTED> {
    return new Promise((resolve, reject) => {
      let settled = false;

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
          finish(() => resolve(INTERACTIVE_WAIT_ABORTED));
        }
      }, SESSION_START_POLL_MS);

      void operation
        .then((value) => {
          finish(() => resolve(value));
        })
        .catch((error) => {
          finish(() => reject(error));
        });
    });
  }
}
