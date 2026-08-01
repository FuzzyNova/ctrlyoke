import type { CliEvent } from "../../../types/CliOutputTypes";
import {
  MESSAGE_TYPES,
  SESSION_KINDS,
} from "../../../types/DashboardConstants";
import type { WorkflowContext } from "../../../types/WorkflowContextTypes";
import type { CliProcessManager } from "../../../utils/CliProcessManager";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import { getErrorMessage } from "../../../utils/ErrorUtils";
import { Log } from "../../../utils/Log";
import { CliProviderUtils } from "./CliProviderUtils";
import {
  resolveCliCommand,
  type CliResolvedCommand,
} from "./CliLauncherResolver";
import type { ICliProvider } from "./interfaces/ICliProvider";
import { getPtyProcessManager, ptyPostMessage } from "../PtyProcessManager";
import type { PtyProcessManager, PtySession } from "../PtyProcessManager";
import { CliLogEventPump } from "./CliLogEventPump";
import {
  HeadlessLogTail,
  type HeadlessStreamingSource,
} from "./HeadlessLogTail";

interface CliTransportCoordinatorCommandInfo {
  promptArgument: string;
  cliCommand: string;
}

interface CliTransportCoordinatorRuntimeState {
  getWorkspaceRoot: () => string | undefined;
  getWorkflowName?: () => string | undefined;
  isCancelling: () => boolean;
}

interface CliTransportCoordinatorHostCallbacks {
  onBeforeInteractiveStart: (workflowContext?: WorkflowContext) => void;
  onCommandPrepared: (info: CliTransportCoordinatorCommandInfo) => void;
  onStreamingChunk: (chunk: string) => void;
  onStreamingEvents: (events: CliEvent[]) => void;
  onResponseComplete: (response: string) => void;
  onPtyExit: (session: PtySession, exitCode: number) => void;
  cleanupTempFiles: (tempFilePaths: string[]) => Promise<void>;
}

export interface CliTransportCoordinatorDeps {
  provider: ICliProvider;
  processManager: CliProcessManager;
  resolveCliCommand?: (
    commandName: string,
    args: string[]
  ) => Promise<CliResolvedCommand>;
  runtimeState: CliTransportCoordinatorRuntimeState;
  hostCallbacks: CliTransportCoordinatorHostCallbacks;
  getPtyManager?: () => PtyProcessManager | null;
  postTerminalMessage?: (message: unknown) => void;
}

export interface CliExecutionTransportCoordinator {
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
      headlessLogTail?: HeadlessLogTail;
    }) => Promise<boolean>,
    env?: Record<string, string>,
    source?: HeadlessStreamingSource
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

export class CliTransportCoordinator implements CliExecutionTransportCoordinator {
  private currentPtySession?: PtySession;
  /** ID of the last PTY spawned — persists after currentPtySession is cleared so inject-fallback suppression can find it. */
  private lastPtySessionId?: string;

  constructor(private readonly deps: CliTransportCoordinatorDeps) {}

  async executeStandaloneInteractiveProcess(
    args: string[],
    promptArgument: string,
    tempFilePaths: string[],
    resolvedSessionId?: string
  ): Promise<{ success: boolean; sessionId?: string }> {
    try {
      const interactiveArgs = this.deps.provider.buildInteractiveArgs(
        args,
        promptArgument
      );
      const command = await this.resolveProviderCommand(interactiveArgs);

      this.deps.hostCallbacks.onCommandPrepared({
        promptArgument,
        cliCommand: command.displayCommand,
      });

      const startTime = new Date();
      const workingDir =
        this.deps.runtimeState.getWorkspaceRoot() || process.cwd();
      const interactiveEnv =
        this.deps.provider.getInteractiveSpawnEnv?.() ??
        CliProviderUtils.buildProcessEnv();

      let processExited = false;
      let hookSessionId: string | undefined;

      const spawnPromise = this.deps.processManager
        .spawnInteractive(
          command.command,
          command.args,
          workingDir,
          interactiveEnv,
          command.requiresShellVerbatimArgs
        )
        .finally(() => {
          processExited = true;
        });

      const workspaceRoot = this.deps.runtimeState.getWorkspaceRoot();
      if (
        workspaceRoot &&
        this.deps.provider.config.usesInteractiveNotificationMonitor
      ) {
        const notifyDir =
          this.deps.provider.notificationMonitor.getNotificationDirectory(
            workspaceRoot
          );
        const timeoutMs =
          ConfigurationUtils.getMaxPromptExecutionTimeMs() ?? 3_600_000;

        const monitorPromise = this.deps.provider.notificationMonitor
          .monitorForCompletion(
            { directory: notifyDir, timeoutMs },
            resolvedSessionId,
            startTime,
            () => this.deps.runtimeState.isCancelling() || processExited
          )
          .then((result) => {
            if (result.completed && !processExited) {
              hookSessionId =
                this.deps.provider.notificationMonitor.extractSessionId?.(
                  result.data
                );
              Log.info(
                `✅ Stop hook detected — terminating interactive session` +
                  (hookSessionId ? ` (session: ${hookSessionId})` : "")
              );
              this.deps.processManager.disposeProcess();
            }
          });

        await Promise.all([spawnPromise, monitorPromise]);
      } else {
        await spawnPromise;
      }

      this.deps.hostCallbacks.onResponseComplete("Interactive session ended");
      return { success: true, sessionId: hookSessionId ?? resolvedSessionId };
    } catch (error) {
      throw error;
    } finally {
      await this.deps.hostCallbacks.cleanupTempFiles(tempFilePaths);
    }
  }

  async startInteractiveProcess(
    args: string[],
    promptArgument: string,
    workflowContext?: WorkflowContext,
    env?: Record<string, string>
  ): Promise<void> {
    const interactiveArgs = this.deps.provider.buildInteractiveArgs(
      args,
      promptArgument
    );
    const command = await this.resolveProviderCommand(interactiveArgs);

    this.deps.hostCallbacks.onBeforeInteractiveStart(workflowContext);
    this.deps.hostCallbacks.onCommandPrepared({
      promptArgument,
      cliCommand: command.displayCommand,
    });

    const ptyManager = this.deps.getPtyManager?.() ?? getPtyProcessManager();
    if (ptyManager) {
      const postMessage = this.deps.postTerminalMessage ?? ptyPostMessage;
      const workflowId =
        workflowContext?.instanceId ??
        workflowContext?.filePath ??
        this.deps.runtimeState.getWorkflowName?.() ??
        "unknown";
      const stepMetadata = this.getWorkflowStepMetadata(workflowContext) ?? {
        stepName: "interactive",
        promptNumber: undefined,
      };
      const { stepName, promptNumber } = stepMetadata;
      const cwd = this.deps.runtimeState.getWorkspaceRoot() ?? process.cwd();
      // Provider-level interactive env (e.g. Copilot's OTel export path override,
      // see CopilotCliProvider.getInteractiveSpawnEnv()) must be merged in here too —
      // this is the VS Code PTY spawn path, a separate call site from
      // executeStandaloneInteractiveProcess() above, which already does this.
      const providerEnv = this.deps.provider.getInteractiveSpawnEnv?.();
      const mergedEnv = {
        ...process.env,
        ...providerEnv,
        ...env,
      };
      const preSessionId = `ai-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const harnessId = this.deps.provider.config.harnessId;
      // Peek at the expected controller before spawning so TERMINAL_STARTED carries
      // controllerClientId from the outset. Without this, all observers see undefined
      // and race to claim control, so a random client wins instead of the one that
      // actually triggered the run.
      const controllerClientId = ptyManager.getExpectedController(workflowId);

      postMessage({
        type: MESSAGE_TYPES.TERMINAL_STARTED,
        workflowId,
        sessionId: preSessionId,
        stepName,
        kind: SESSION_KINDS.AI_CLI,
        promptNumber,
        harnessId,
        controllerClientId,
      });

      let session: PtySession;
      try {
        session = ptyManager.spawnPty({
          workflowId,
          stepName,
          kind: SESSION_KINDS.AI_CLI,
          promptNumber,
          harnessId,
          sessionId: preSessionId,
          command: command.command,
          // A verbatim payload must reach node-pty as a single pre-escaped
          // string, not an array — see SpawnPtyOptions.args.
          args: command.requiresShellVerbatimArgs
            ? command.args.join(" ")
            : command.args,
          cwd,
          env: mergedEnv,
          onData: (ptySession, chunk) => {
            postMessage({
              type: MESSAGE_TYPES.TERMINAL_OUTPUT,
              workflowId: ptySession.workflowId,
              sessionId: ptySession.id,
              data: chunk,
            });
          },
          onExit: (ptySession, exitCode) => {
            postMessage({
              type: MESSAGE_TYPES.TERMINAL_ENDED,
              workflowId: ptySession.workflowId,
              sessionId: ptySession.id,
              kind: ptySession.kind,
              exitCode,
            });
            if (this.currentPtySession === ptySession) {
              this.currentPtySession = undefined;
            }
            this.deps.hostCallbacks.onPtyExit(ptySession, exitCode);
          },
        });
      } catch (error) {
        const message = getErrorMessage(error);
        Log.warn(`Failed to start embedded terminal: ${message}`);
        postMessage({
          type: MESSAGE_TYPES.TERMINAL_OUTPUT,
          workflowId,
          sessionId: preSessionId,
          data: `${message}\r\n`,
        });
        postMessage({
          type: MESSAGE_TYPES.TERMINAL_ENDED,
          workflowId,
          sessionId: preSessionId,
          kind: SESSION_KINDS.AI_CLI,
          exitCode: 1,
        });
        throw error;
      }

      this.lastPtySessionId = session.id;
      this.currentPtySession = session;
      Log.info(
        `🖥️ PTY session spawned: "${stepName}" (${session.id.slice(0, 8)}) workflowId=inst:${workflowId.slice(0, 8)}`
      );
    }
  }

  /**
   * Refresh the active PTY's display metadata when inject mode submits another
   * workflow step into the same terminal instead of spawning a new session.
   */
  updateCurrentPtySessionMetadata(workflowContext?: WorkflowContext): boolean {
    if (!this.currentPtySession || !workflowContext) {
      return false;
    }

    const metadata = this.getWorkflowStepMetadata(workflowContext);
    if (!metadata) {
      return false;
    }

    this.currentPtySession.stepName = metadata.stepName;
    this.currentPtySession.promptNumber = metadata.promptNumber;

    const postMessage = this.deps.postTerminalMessage ?? ptyPostMessage;
    postMessage({
      type: MESSAGE_TYPES.TERMINAL_STARTED,
      workflowId: this.currentPtySession.workflowId,
      sessionId: this.currentPtySession.id,
      stepName: metadata.stepName,
      kind: this.currentPtySession.kind,
      promptNumber: metadata.promptNumber,
      harnessId: this.currentPtySession.harnessId,
      shellKind: this.currentPtySession.shellKind,
      controllerClientId: this.currentPtySession.controllerClientId,
    });

    Log.debug(
      `[inject] refreshed PTY session metadata: session=${this.currentPtySession.id.slice(0, 8)} step="${metadata.stepName}"`
    );
    return true;
  }

  async executeHeadless(
    args: string[],
    promptArgument: string,
    tempFilePaths: string[],
    executeCallback: (result: {
      stdout: string;
      stderr: string;
      exitCode: number;
      headlessLogTail?: HeadlessLogTail;
    }) => Promise<boolean>,
    env?: Record<string, string>,
    source?: HeadlessStreamingSource
  ): Promise<boolean> {
    try {
      if (tempFilePaths.length > 0) {
        Log.info(
          `🚀 Starting headless mode with ${tempFilePaths.length} file(s)`
        );
      } else {
        Log.info("🚀 Starting headless mode with direct prompt (fast path)");
      }

      const headlessArgs = this.deps.provider.buildHeadlessArgs(
        args,
        promptArgument
      );
      const command = await this.resolveProviderCommand(headlessArgs);

      this.deps.hostCallbacks.onCommandPrepared({
        promptArgument,
        cliCommand: command.displayCommand,
      });

      const shouldStream =
        this.deps.provider.config.shouldStreamHeadlessOutput || !!source;
      const stdoutEventPump =
        source?.mode === "stdout"
          ? new CliLogEventPump({
              parser: source.parser,
              model: source.model ?? "",
              onStreamingEvents: this.deps.hostCallbacks.onStreamingEvents,
            })
          : undefined;

      if (source?.logTail) {
        await source.logTail.start();
      }

      const result = await this.spawnProcess(command.command, command.args, {
        timeout: ConfigurationUtils.getMaxPromptExecutionTimeMs(),
        env,
        windowsVerbatimArguments: command.requiresShellVerbatimArgs,
        onStdout: shouldStream
          ? (chunk) => {
              if (ConfigurationUtils.shouldLogRawCliOutput()) {
                Log.debug(
                  `[${this.deps.provider.config.displayName} RAW OUTPUT]: ${chunk}`
                );
              }

              if (source?.mode === "log" && source.logTail) {
                source.logTail.onStdoutChunk(chunk);
              } else if (source?.mode === "stdout" && stdoutEventPump) {
                const events = source.parseStdout?.(chunk) ?? [];
                for (const event of events) {
                  stdoutEventPump.processEvent(event);
                }
              } else {
                this.deps.hostCallbacks.onStreamingChunk(chunk);
              }
            }
          : undefined,
      });

      if (source?.logTail) {
        await source.logTail.finish();
      }

      if (this.deps.runtimeState.isCancelling()) {
        Log.info("⏹️ Prompt execution cancelled by user");
        await executeCallback(
          source?.logTail
            ? { ...result, headlessLogTail: source.logTail }
            : result
        );
        return false;
      }

      return await executeCallback(
        source?.logTail
          ? { ...result, headlessLogTail: source.logTail }
          : result
      );
    } catch (error) {
      if (source?.logTail) {
        await source.logTail.finish();
      }
      Log.error("❌ Headless execution error", error);
      return false;
    } finally {
      await this.deps.hostCallbacks.cleanupTempFiles(tempFilePaths);
    }
  }

  /**
   * Write text directly into the currently active PTY session.
   * Used by inject mode to submit follow-up prompts without restarting the TUI.
   * @returns true if the write succeeded, false if no PTY session is active.
   */
  writeToCurrentPtySession(text: string): boolean {
    if (!this.currentPtySession) {
      return false;
    }
    const ptyManager = this.deps.getPtyManager?.() ?? getPtyProcessManager();
    if (!ptyManager) {
      return false;
    }
    ptyManager.writeToSession(this.currentPtySession.id, text);
    return true;
  }

  /**
   * Store the inject context (log path + AI session ID) on the currently active PTY session.
   * Called by CliExecutionRunner after session startup so the context survives integration
   * lifecycle changes and can be retrieved on workflow resume.
   */
  hasLivePtySession(): boolean {
    return this.currentPtySession !== undefined;
  }

  /**
   * Returns the ID of the last PTY session that was spawned, even if it has since
   * exited and currentPtySession was cleared. Used by inject-fallback logic to
   * suppress the stale exit event from the abandoned PTY.
   */
  getLastPtySessionId(): string | undefined {
    return this.currentPtySession?.id ?? this.lastPtySessionId;
  }

  /**
   * Kill the active embedded AI CLI PTY without treating it as a user cancel.
   * Used when a later prompt resumes the same AI session in headless mode; the
   * headless process must be the only live owner of that session.
   */
  async terminateCurrentPtySession(
    reason: string
  ): Promise<string | undefined> {
    if (!this.currentPtySession) {
      return undefined;
    }

    const sessionId = this.currentPtySession.id;
    const ptySession = this.currentPtySession;
    this.currentPtySession = undefined; // clear immediately so no other code touches it during the wait
    Log.info(
      `🛑 Terminating PTY session ${sessionId.slice(0, 8)} before ${reason}`
    );
    const ptyManager = this.deps.getPtyManager?.() ?? getPtyProcessManager();
    if (ptyManager) {
      await ptyManager.gracefulKillAiCliSession(sessionId);
    } else {
      ptySession.pty.write("\x03");
      ptySession.pty.write("\x03");
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      ptySession.pty.kill();
    }
    return sessionId;
  }

  closeTerminal(): void {
    if (!this.currentPtySession) {
      return;
    }

    const sessionId = this.currentPtySession.id;
    const ptySession = this.currentPtySession;
    this.currentPtySession = undefined; // clear immediately so inject mode won't see a stale session
    const ptyManager = this.deps.getPtyManager?.() ?? getPtyProcessManager();
    // Fire-and-forget: send Ctrl+C and schedule the kill — callers are sync so we can't await here.
    if (ptyManager) {
      void ptyManager.gracefulKillAiCliSession(sessionId);
    } else {
      ptySession.pty.write("\x03");
      ptySession.pty.write("\x03");
      setTimeout(() => ptySession.pty.kill(), 500);
    }
  }

  async cancel(): Promise<boolean> {
    if (this.currentPtySession) {
      const ptyManager = this.deps.getPtyManager?.() ?? getPtyProcessManager();
      if (ptyManager) {
        ptyManager.killSession(this.currentPtySession.id);
      }
      this.currentPtySession = undefined;
    }

    if (!this.deps.processManager.isActive()) {
      return false;
    }

    await this.deps.processManager.cancel();
    return true;
  }

  dispose(closeTerminalWhenPromptCompletes: boolean): void {
    if (closeTerminalWhenPromptCompletes) {
      this.closeTerminal();
      this.deps.processManager.dispose();
    } else {
      this.deps.processManager.disposeProcess();
    }
  }

  private async spawnProcess(
    command: string,
    args: string[],
    options: {
      timeout?: number;
      env?: Record<string, string>;
      onStdout?: (chunk: string) => void;
      windowsVerbatimArguments?: boolean;
    } = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const headlessEnvOverrides = this.deps.provider.getHeadlessSpawnEnv?.();
    const baseEnv = {
      ...CliProviderUtils.buildProcessEnv(),
      ...headlessEnvOverrides,
    };
    const env = options.env ? { ...baseEnv, ...options.env } : baseEnv;

    const result = await this.withProcessEnvOverrides(
      headlessEnvOverrides,
      async () =>
        this.deps.processManager.spawn(command, args, {
          cwd: this.deps.runtimeState.getWorkspaceRoot() || "",
          timeout: options.timeout,
          onStdout: options.onStdout,
          shell: false,
          windowsVerbatimArguments: options.windowsVerbatimArguments,
          env,
        })
    );

    Log.info("✅ Process exited - execution complete");
    return result;
  }

  private async withProcessEnvOverrides<T>(
    overrides: NodeJS.ProcessEnv | undefined,
    action: () => Promise<T>
  ): Promise<T> {
    if (!overrides || Object.keys(overrides).length === 0) {
      return action();
    }

    const previousValues = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(overrides)) {
      previousValues.set(key, process.env[key]);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    try {
      return await action();
    } finally {
      for (const [key, value] of previousValues) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }

  private getWorkflowStepMetadata(
    workflowContext?: WorkflowContext
  ): { stepName: string; promptNumber: number } | undefined {
    if (!workflowContext) {
      return undefined;
    }

    const promptNumber = workflowContext.promptIndex + 1;
    return {
      stepName:
        workflowContext.allPrompts[workflowContext.promptIndex]?.name ??
        `Step ${promptNumber}`,
      promptNumber,
    };
  }

  private async resolveProviderCommand(
    args: string[]
  ): Promise<CliResolvedCommand> {
    const resolveCommand = this.deps.resolveCliCommand ?? resolveCliCommand;
    return resolveCommand(this.deps.provider.config.name, args);
  }
}
