import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { CliEvent } from "../../../types/CliOutputTypes";
import { Harness } from "../../../types/FlightPathTypes";
import type { WorkflowContext } from "../../../types/WorkflowContextTypes";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import { getErrorMessage } from "../../../utils/ErrorUtils";
import { CliLogMonitor } from "../CliLogMonitor";
import type { CliExecutionSession } from "./CliExecutionSession";
import type { CliFailureTracker } from "./CliFailureTracker";
import type { CollectedHeadlessResponse } from "./CliResponseCollector";
import type { InteractiveSessionDiscovery } from "./CliInteractiveStartupCoordinator";
import type { ICliProvider } from "./interfaces/ICliProvider";

interface CliExecutionRunnerLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

interface CliExecutionTransportCoordinator {
  executeStandaloneInteractiveProcess(
    args: string[],
    promptArgument: string,
    tempFilePaths: string[],
    resolvedSessionId?: string
  ): Promise<{ success: boolean; sessionId?: string }>;
  startInteractiveProcess(
    args: string[],
    promptArgument: string,
    tempFilePaths: string[],
    workflowContext?: WorkflowContext,
    env?: Record<string, string>
  ): Promise<void>;
  executeHeadless(
    args: string[],
    promptArgument: string,
    tempFilePaths: string[],
    executeCallback: (result: {
      stdout: string;
      stderr: string;
      exitCode: number;
    }) => Promise<boolean>
  ): Promise<boolean>;
}

interface CliInteractiveStartupCoordinatorLike {
  resolveSession(params: {
    promptForDiscovery: string;
    startTime: Date;
    resolvedSessionId?: string;
    runId: string;
  }): Promise<InteractiveSessionDiscovery | null>;
}

interface CliResponseCollectorLike {
  collectHeadlessResponse(params: {
    stdout: string;
    stderr: string;
    exitCode: number;
    promptForSessionLog: string;
    executionStartTime: Date;
    resolvedSessionId?: string;
    label?: string;
  }): Promise<CollectedHeadlessResponse>;
}

export interface CliExecutionRunnerDeps {
  provider: ICliProvider;
  transportCoordinator: CliExecutionTransportCoordinator;
  failureTracker: CliFailureTracker;
  createInteractiveStartupCoordinator: () => CliInteractiveStartupCoordinatorLike;
  createResponseCollector: () => CliResponseCollectorLike;
  cleanupTempFiles: (tempFilePaths: string[]) => Promise<void>;
  getWorkspaceRoot: () => string | undefined;
  getExtensionPath: () => string;
  isVsCodeContext: () => boolean;
  isCancelling: () => boolean;
  onStreamingEvents: (events: CliEvent[]) => void;
  onResponseComplete: (response: string) => void;
  logResponse: (response: string, statistics?: string) => void;
  setFailureReason: (reason: string) => void;
  logger: CliExecutionRunnerLogger;
}

export class CliExecutionRunner {
  constructor(private readonly deps: CliExecutionRunnerDeps) {}

  async executeInteractive(
    session: CliExecutionSession,
    baseArgs: string[]
  ): Promise<boolean> {
    const result = await this.executeInTerminal(baseArgs, session);
    session.setExtractedSessionId(result.sessionId);

    if (
      result.success &&
      !session.effectiveSessionId &&
      this.deps.provider.extractSessionIdFromLogs
    ) {
      const logSessionId = await this.deps.provider.extractSessionIdFromLogs(
        session.promptForSessionLog,
        session.executionStartTime
      );
      if (logSessionId) {
        session.setExtractedSessionId(logSessionId);
        this.deps.logger.debug(
          `📝 Session ID from logs (interactive): ${logSessionId}`
        );
      }
    }

    return result.success;
  }

  async executeHeadless(
    session: CliExecutionSession,
    baseArgs: string[]
  ): Promise<boolean> {
    const responseCallback = this.buildHeadlessResponseCallback(session);

    const executeWithRecovery = async (args: string[]): Promise<boolean> => {
      try {
        return await this.deps.transportCoordinator.executeHeadless(
          args,
          session.promptArgument,
          session.tempFilePaths,
          responseCallback
        );
      } catch (error) {
        if (
          this.deps.provider.responseParser.isRecoverableSessionError?.(error)
        ) {
          const currentHarness =
            session.resolvedProperties?.harness ??
            (this.deps.provider.config.name as Harness);

          if (currentHarness === Harness.ClaudeCli) {
            this.deps.logger.warn(
              `⚠️ Claude CLI rejected session ID "${session.resolvedSessionId}". ` +
                `Retrying without resume flag.`
            );

            const argsWithoutResume = await this.deps.provider.buildCliArgs(
              session.prompt,
              false,
              this.deps.getExtensionPath(),
              this.deps.getWorkspaceRoot() || "",
              undefined,
              session.workflowContext
            );

            const retryCallback = this.buildHeadlessResponseCallback(
              session,
              " (retry)"
            );

            return await this.deps.transportCoordinator.executeHeadless(
              argsWithoutResume,
              session.promptArgument,
              session.tempFilePaths,
              retryCallback
            );
          }
        }

        throw error;
      }
    };

    try {
      return await executeWithRecovery(baseArgs);
    } catch (error) {
      this.deps.logger.error("❌ Headless execution error", error);
      this.deps.setFailureReason(getErrorMessage(error));
      return false;
    }
  }

  private async executeInteractiveCliProcess(
    args: string[],
    session: CliExecutionSession
  ): Promise<{ success: boolean; sessionId?: string }> {
    try {
      if (session.workflowContext && session.workflowContext.promptIndex > 0) {
        this.deps.logger.info(`\n${"─".repeat(52)}`);
        this.deps.logger.info(
          `Prompt ${session.workflowContext.promptIndex + 1} / ${session.workflowContext.allPrompts.length}`
        );
        this.deps.logger.info("\n");
      }

      return await this.deps.transportCoordinator.executeStandaloneInteractiveProcess(
        args,
        session.promptArgument,
        session.tempFilePaths,
        session.resolvedSessionId
      );
    } catch (error) {
      this.deps.logger.error("❌ CLI interactive execution error", error);
      this.deps.setFailureReason(getErrorMessage(error));
      return { success: false };
    }
  }

  private async executeInTerminal(
    args: string[],
    session: CliExecutionSession
  ): Promise<{ success: boolean; sessionId?: string }> {
    if (!this.deps.isVsCodeContext()) {
      return this.executeInteractiveCliProcess(args, session);
    }

    try {
      if (!this.deps.provider.logParser) {
        this.deps.logger.error(
          "❌ Harness does not support log file monitoring"
        );
        return { success: false };
      }

      const startTime = new Date();
      this.deps.logger.debug(
        `⏱️ Recording start time: ${startTime.toISOString()}`
      );

      if (session.resolvedSessionId && this.deps.provider.notificationMonitor) {
        const workspaceRoot = this.deps.getWorkspaceRoot();
        if (workspaceRoot) {
          const notifyDir =
            this.deps.provider.notificationMonitor.getNotificationDirectory(
              workspaceRoot
            );
          const staleStopFile = path.join(
            notifyDir,
            `${session.resolvedSessionId}-stop.json`
          );
          if (fs.existsSync(staleStopFile)) {
            try {
              fs.unlinkSync(staleStopFile);
              this.deps.logger.debug(
                `🧹 Cleaned up stale stop notification for session ${session.resolvedSessionId.substring(0, 8)}`
              );
            } catch {
              // Ignore cleanup failures for stale stop files.
            }
          }
        }
      }

      const runId = crypto.randomUUID();
      const terminalEnv: Record<string, string> = { FLIGHTPATH_RUN_ID: runId };
      if (ConfigurationUtils.isDiagnosticLogsEnabled()) {
        terminalEnv.FLIGHTPATH_DIAGNOSTIC_LOGS = "true";
      }

      const workspaceRoot = this.deps.getWorkspaceRoot();
      if (workspaceRoot && this.deps.provider.notificationMonitor) {
        terminalEnv.FLIGHTPATH_NOTIFY_DIR =
          this.deps.provider.notificationMonitor.getNotificationDirectory(
            workspaceRoot
          );
      }

      await this.deps.transportCoordinator.startInteractiveProcess(
        args,
        session.promptArgument,
        session.tempFilePaths,
        session.workflowContext,
        terminalEnv
      );

      const startupCoordinator =
        this.deps.createInteractiveStartupCoordinator();
      const discovery = await startupCoordinator.resolveSession({
        promptForDiscovery: session.promptForSessionLog,
        startTime,
        resolvedSessionId: session.resolvedSessionId,
        runId,
      });

      if (!discovery) {
        return { success: false };
      }

      return await this.monitorLogFile(discovery.logPath, session, {
        sessionId: discovery.sessionId,
        startTime,
      });
    } catch (error) {
      this.deps.logger.error("❌ Interactive execution error", error);
      this.deps.setFailureReason(getErrorMessage(error));
      throw error;
    } finally {
      await this.deps.cleanupTempFiles(session.tempFilePaths);
    }
  }

  private async monitorLogFile(
    logPath: string,
    session: CliExecutionSession,
    params: { sessionId: string | null; startTime: Date }
  ): Promise<{ success: boolean; sessionId?: string }> {
    const monitor = new CliLogMonitor({
      logParser: this.deps.provider.logParser!,
      notificationMonitor: this.deps.provider.notificationMonitor,
      getWorkspaceRoot: this.deps.getWorkspaceRoot,
      isCancelling: this.deps.isCancelling,
      isPtyTerminated: () => this.deps.failureTracker.getPtyTermination(),
      onStreamingEvents: this.deps.onStreamingEvents,
      onResponseComplete: this.deps.onResponseComplete,
      logResponse: this.deps.logResponse,
    });

    const result = await monitor.monitor(
      logPath,
      params.sessionId,
      params.startTime
    );

    if (result.parsedOutput) {
      session.updateParsedOutput(result.parsedOutput);
    }
    if (result.cliResult) {
      session.updateResult(result.cliResult);
    }

    if (result.processExited) {
      this.deps.setFailureReason(
        this.deps.failureTracker.markCompletionDetectionProcessExit(
          result.processExited.exitCode
        )
      );
    }

    return { success: result.success, sessionId: result.sessionId };
  }

  private buildHeadlessResponseCallback(
    session: CliExecutionSession,
    label: string = ""
  ): (result: {
    stdout: string;
    stderr: string;
    exitCode: number;
  }) => Promise<boolean> {
    const responseCollector = this.deps.createResponseCollector();

    return async (result) => {
      if (ConfigurationUtils.shouldLogRawCliOutput()) {
        this.deps.logger.debug(
          `[${this.deps.provider.config.displayName} FINAL STDOUT${label}]:\n${result.stdout}`
        );
        if (result.stderr) {
          this.deps.logger.debug(
            `[${this.deps.provider.config.displayName} FINAL STDERR${label}]:\n${result.stderr}`
          );
        }
      }

      const collected = await responseCollector.collectHeadlessResponse({
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        promptForSessionLog: session.promptForSessionLog,
        executionStartTime: session.executionStartTime,
        resolvedSessionId: session.resolvedSessionId,
        label,
      });

      session.recordHeadlessResponse(collected);
      return collected.success;
    };
  }
}
