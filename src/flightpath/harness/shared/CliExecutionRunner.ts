import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { CliEvent } from "../../../types/CliOutputTypes";
import { Harness } from "../../../types/FlightPathTypes";
import type { WorkflowContext } from "../../../types/WorkflowContextTypes";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import { getErrorMessage } from "../../../utils/ErrorUtils";
import { Log } from "../../../utils/Log";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";
import { CliLogMonitor } from "../CliLogMonitor";
import type { CliExecutionSession } from "./CliExecutionSession";
import type { CliFailureTracker } from "./CliFailureTracker";
import type { CollectedHeadlessResponse } from "./CliResponseCollector";
import type { InteractiveSessionDiscovery } from "./CliInteractiveStartupCoordinator";
import type { ICliProvider } from "./interfaces/ICliProvider";

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
  /** Write text to the currently active PTY session. Returns false if no session is active. */
  writeToCurrentPtySession(text: string): boolean;
  /** Refresh display metadata for the current PTY session when it is reused by inject mode. */
  updateCurrentPtySessionMetadata?(workflowContext?: WorkflowContext): boolean;
  /**
   * Terminate the current PTY when another execution mode needs exclusive
   * ownership of the same AI session.
   */
  terminateCurrentPtySession?(reason: string): Promise<string | undefined>;
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
  factories: {
    createInteractiveStartupCoordinator: () => CliInteractiveStartupCoordinatorLike;
    createResponseCollector: () => CliResponseCollectorLike;
    cleanupTempFiles: (tempFilePaths: string[]) => Promise<void>;
  };
  runtimeState: {
    getWorkspaceRoot: () => string | undefined;
    getExtensionPath: () => string;
    isVsCodeContext: () => boolean;
    isCancelling: () => boolean;
    setFailureReason: (reason: string) => void;
  };
  hostCallbacks: {
    onStreamingEvents: (events: CliEvent[]) => void;
    onResponseComplete: (response: string) => void;
    logResponse: (response: string, statistics?: string) => void;
    onContextWindowUpdate?: (used: number, size: number) => void;
  };
}

/** State captured after a successful interactive execution, used by inject mode. */
export interface InteractiveInjectContext {
  /** Absolute path to the session log file being monitored. */
  logPath: string;
  /** Claude / AI session ID (null if not yet extracted). */
  sessionId: string | null;
  /**
   * The resolved properties used when the process was spawned.
   * Inject mode compares these against the next prompt's resolved properties to
   * detect incompatible spawn-time config changes (model, permissions, hooks, etc.)
   * that would require a fresh process instead.
   */
  spawnedWith?: ResolvedProperties;
  /** The resolved session ID that was passed to the initial spawn (may differ from sessionId). */
  spawnedWithSessionId?: string;
}

export class CliExecutionRunner {
  /**
   * Context from the most recent successful interactive execution.
   * Set after `executeInTerminal` succeeds and cleared on reset/cancel.
   * When inject mode is active, the next prompt reuses this instead of spawning
   * a fresh PTY session.
   */
  private lastInteractiveContext?: InteractiveInjectContext;

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
        Log.debug(`📝 Session ID from logs (interactive): ${logSessionId}`);
      }
    }

    return result.success;
  }

  /**
   * Returns true when there is a previous interactive context available for inject mode.
   * Callers should also check `getLastInteractiveContext()` to verify spawn-arg compatibility.
   */
  hasInteractiveContext(): boolean {
    return this.lastInteractiveContext !== undefined;
  }

  /**
   * Returns the context captured from the most recent successful interactive execution,
   * or undefined if no prior interactive execution has completed.
   */
  getLastInteractiveContext(): InteractiveInjectContext | undefined {
    return this.lastInteractiveContext;
  }

  /**
   * Clear the retained interactive context after its PTY has been intentionally
   * retired. Without this, a later run can incorrectly believe inject mode is
   * still available.
   */
  clearInteractiveContext(): void {
    this.lastInteractiveContext = undefined;
  }

  /**
   * Execute the next prompt by injecting it into the already-running PTY session.
   *
   * Inject mode skips PTY spawn and SessionStart waiting. It writes the prepared
   * prompt text directly into the TUI (as if the user typed it and pressed Enter),
   * then monitors the existing log file from the current time forward.
   *
   * Prerequisites: `hasInteractiveContext()` must return true and the PTY session
   * from the prior prompt must still be running.
   *
   * @returns `{ injected: false }` when the PTY is unavailable (caller should fall back).
   *          `{ injected: true, success }` when the inject and monitoring completed.
   */
  async executeInteractiveInject(
    session: CliExecutionSession
  ): Promise<{ injected: false } | { injected: true; success: boolean }> {
    if (!this.lastInteractiveContext) {
      Log.warn(
        "⚠️ Inject mode: no previous interactive context — PTY may not be running"
      );
      return { injected: false };
    }

    const startTime = new Date();

    // Submit the prepared prompt text to the running TUI.
    // Some TUIs (Copilot CLI confirmed) use focus tracking and only activate their
    // keyboard input handler after receiving the "focus-in" VT sequence (ESC [ I = \x1b[I).
    // Without it, the text and Enter are silently ignored even though the PTY write succeeds.
    // Prepending \x1b[I tells the TUI it has focus, enabling input acceptance.
    // TUIs that don't use focus tracking (Claude CLI) safely ignore the sequence.
    // "\r" (CR, 0x0D) is the submit key — same byte xterm.js sends when Enter is pressed.
    // "\n" (LF) acts as a newline in multi-line input boxes, NOT submit.
    // Send focus-in first, then wait a tick for the TUI to switch its input mode,
    // send the text, wait another tick, then send Enter. If control/input bytes
    // arrive in the same PTY write some TUIs treat CR as a literal newline
    // instead of the submit key.
    const focusIn = "\x1b[I";
    const submit = "\r";
    Log.debug(
      `[inject] writing focus-in, text, then submit to PTY: ${JSON.stringify([focusIn, session.promptArgument, submit])} hex=${Buffer.from(focusIn + session.promptArgument + submit).toString("hex")}`
    );
    const focused =
      this.deps.transportCoordinator.writeToCurrentPtySession(focusIn);
    if (!focused) {
      Log.warn("⚠️ Inject mode: PTY session not active — TUI may have exited");
      return { injected: false };
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const promptWritten =
      this.deps.transportCoordinator.writeToCurrentPtySession(
        session.promptArgument
      );

    if (!promptWritten) {
      Log.warn("⚠️ Inject mode: PTY session not active — TUI may have exited");
      return { injected: false };
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    const submitWritten =
      this.deps.transportCoordinator.writeToCurrentPtySession(submit);

    if (!submitWritten) {
      Log.warn("⚠️ Inject mode: PTY session not active — TUI may have exited");
      return { injected: false };
    }

    // Yield to the event loop so any pending PTY exit events from the prior prompt
    // can propagate before we commit to monitoring. Without this yield, writeToCurrentPtySession
    // can return true (currentPtySession is still set) even when the process has already
    // exited but its onExit callback hasn't fired yet. A single await tick is enough —
    // PTY onExit callbacks are macrotasks that fire in the next event loop iteration.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    if (this.deps.failureTracker.getPtyTermination()) {
      Log.warn(
        "⚠️ Inject mode: PTY process exited immediately after write — TUI does not support injection (prompt sent to dead process). Falling back to restart mode."
      );
      return { injected: false };
    }

    this.deps.transportCoordinator.updateCurrentPtySessionMetadata?.(
      session.workflowContext
    );

    Log.info(
      `🔤 Injected prompt into existing PTY session (${session.promptArgument.length} chars)`
    );

    try {
      const result = await this.monitorLogFile(
        this.lastInteractiveContext.logPath,
        session,
        {
          sessionId: this.lastInteractiveContext.sessionId,
          startTime,
        }
      );

      session.setExtractedSessionId(
        result.sessionId ?? this.lastInteractiveContext.sessionId ?? undefined
      );

      // Propagate any updated session ID into the inject context for the next prompt.
      if (result.sessionId) {
        this.lastInteractiveContext.sessionId = result.sessionId;
      }

      return { injected: true, success: result.success };
    } finally {
      await this.deps.factories.cleanupTempFiles(session.tempFilePaths);
    }
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
            (this.deps.provider.config.harnessId as Harness);

          if (currentHarness === Harness.ClaudeCli) {
            Log.warn(
              `⚠️ Claude CLI rejected session ID "${session.resolvedSessionId}". ` +
                `Retrying without resume flag.`
            );

            const argsWithoutResume = await this.deps.provider.buildCliArgs(
              session.prompt,
              false,
              this.deps.runtimeState.getExtensionPath(),
              this.deps.runtimeState.getWorkspaceRoot() || "",
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
      Log.error("❌ Headless execution error", error);
      this.deps.runtimeState.setFailureReason(getErrorMessage(error));
      return false;
    }
  }

  private async executeInteractiveCliProcess(
    args: string[],
    session: CliExecutionSession
  ): Promise<{ success: boolean; sessionId?: string }> {
    try {
      if (session.workflowContext && session.workflowContext.promptIndex > 0) {
        Log.info(`\n${"─".repeat(52)}`);
        Log.info(
          `Prompt ${session.workflowContext.promptIndex + 1} / ${session.workflowContext.allPrompts.length}`
        );
        Log.info("\n");
      }

      return await this.deps.transportCoordinator.executeStandaloneInteractiveProcess(
        args,
        session.promptArgument,
        session.tempFilePaths,
        session.resolvedSessionId
      );
    } catch (error) {
      Log.error("❌ CLI interactive execution error", error);
      this.deps.runtimeState.setFailureReason(getErrorMessage(error));
      return { success: false };
    }
  }

  private async executeInTerminal(
    args: string[],
    session: CliExecutionSession
  ): Promise<{ success: boolean; sessionId?: string }> {
    if (!this.deps.runtimeState.isVsCodeContext()) {
      return this.executeInteractiveCliProcess(args, session);
    }

    try {
      if (!this.deps.provider.logParser) {
        Log.error("❌ Harness does not support log file monitoring");
        return { success: false };
      }

      const startTime = new Date();
      Log.debug(`⏱️ Recording start time: ${startTime.toISOString()}`);

      if (session.resolvedSessionId && this.deps.provider.notificationMonitor) {
        const workspaceRoot = this.deps.runtimeState.getWorkspaceRoot();
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
              Log.debug(
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

      const workspaceRoot = this.deps.runtimeState.getWorkspaceRoot();
      if (workspaceRoot && this.deps.provider.notificationMonitor) {
        terminalEnv.FLIGHTPATH_NOTIFY_DIR =
          this.deps.provider.notificationMonitor.getNotificationDirectory(
            workspaceRoot
          );
      }

      await this.deps.transportCoordinator.startInteractiveProcess(
        args,
        session.promptArgument,
        session.workflowContext,
        terminalEnv
      );

      const startupCoordinator =
        this.deps.factories.createInteractiveStartupCoordinator();
      const discovery = await startupCoordinator.resolveSession({
        promptForDiscovery: session.promptForSessionLog,
        startTime,
        resolvedSessionId: session.resolvedSessionId,
        runId,
      });

      if (!discovery) {
        return { success: false };
      }

      // Capture context for potential inject-mode follow-up prompts.
      this.lastInteractiveContext = {
        logPath: discovery.logPath,
        sessionId: discovery.sessionId,
        spawnedWith: session.resolvedProperties,
        spawnedWithSessionId: session.resolvedSessionId,
      };

      const result = await this.monitorLogFile(discovery.logPath, session, {
        sessionId: discovery.sessionId,
        startTime,
      });

      // Keep lastInteractiveContext in sync with the latest session ID in case
      // the log monitor extracted a new one during this run.
      if (result.sessionId) {
        this.lastInteractiveContext.sessionId = result.sessionId;
      }

      return result;
    } catch (error) {
      Log.error("❌ Interactive execution error", error);
      this.deps.runtimeState.setFailureReason(getErrorMessage(error));
      throw error;
    } finally {
      await this.deps.factories.cleanupTempFiles(session.tempFilePaths);
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
      runtimeState: {
        getWorkspaceRoot: this.deps.runtimeState.getWorkspaceRoot,
        isCancelling: this.deps.runtimeState.isCancelling,
        isPtyTerminated: () => this.deps.failureTracker.getPtyTermination(),
      },
      hostCallbacks: this.deps.hostCallbacks,
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
      this.deps.runtimeState.setFailureReason(
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
    const responseCollector = this.deps.factories.createResponseCollector();

    return async (result) => {
      if (ConfigurationUtils.shouldLogRawCliOutput()) {
        Log.debug(
          `[${this.deps.provider.config.displayName} FINAL STDOUT${label}]:\n${result.stdout}`
        );
        if (result.stderr) {
          Log.debug(
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
      if (!collected.success) {
        this.deps.runtimeState.setFailureReason(
          collected.cliResult.error || "Headless CLI execution failed"
        );
      }
      return collected.success;
    };
  }
}
