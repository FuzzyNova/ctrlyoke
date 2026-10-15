import type { CliEvent } from "../../../types/CliOutputTypes";
import {
  EXECUTION_MODES,
  CLI_EVENT_TYPES,
  HEADLESS_SOURCE_MODES,
  MESSAGE_TYPES,
  SESSION_KINDS,
  TERMINAL_END_REASONS,
  TERMINAL_SESSION_STATUS,
  type TerminalEndReason,
} from "../../../types/DashboardConstants";
import type { WorkflowContext } from "../../../types/WorkflowContextTypes";
import type {
  CliProcessManager,
  InteractiveExitResult,
  SpawnResult,
} from "../../../utils/CliProcessManager";
import { CliProcessTimeoutError } from "../../../utils/CliProcessManager";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import { getErrorMessage } from "../../../utils/ErrorUtils";
import { Log } from "../../../utils/Log";
import { CliProviderUtils } from "./CliProviderUtils";
import {
  resolveCliCommand,
  type CliResolvedCommand,
} from "./CliLauncherResolver";
import type { ICliProvider } from "./interfaces/ICliProvider";
import {
  buildTerminalEndedMessage,
  getPtyProcessManager,
  ptyPostMessage,
  toPtySpawnArgs,
} from "../PtyProcessManager";
import type { PtyProcessManager, PtySession } from "../PtyProcessManager";
import type { TerminalStartedMessage } from "../../../types/WebviewMessageTypes";
import { CliLogEventPump } from "./CliLogEventPump";
import { FAILURE_KINDS } from "../../../types/DashboardConstants";
import { CliTransportError } from "./CliTransportError";
import {
  HeadlessLogTail,
  type HeadlessProcessResult,
  type HeadlessStreamingSource,
} from "./HeadlessLogTail";
import { splitCompleteLines } from "../../../utils/TextLines";
import { StreamingSecretRedactor } from "../../../utils/SecretRedactionService";

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
  onResponseComplete: () => void;
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
  resolveSecretEnvironment?: (
    names: readonly string[]
  ) => Promise<Record<string, string>>;
}

/** A harness TUI the standalone CLI launched on the user's own terminal. */
export interface StandaloneInteractiveProcess {
  /** Executable that was launched, for failure messages. */
  readonly command: string;
  /** Settles when the process exits, however it ends. */
  readonly exit: Promise<InteractiveExitResult>;
  /**
   * End the TUI and wait for it to exit, so the terminal is restored before
   * anything else writes to it.
   */
  terminate(): Promise<InteractiveExitResult>;
}

export interface CliExecutionTransportCoordinator {
  startStandaloneInteractiveProcess(
    args: string[],
    promptArgument: string,
    env?: Record<string, string>,
    resolvedCommand?: CliResolvedCommand,
    secretNames?: readonly string[]
  ): Promise<StandaloneInteractiveProcess>;
  startInteractiveProcess(
    args: string[],
    promptArgument: string,
    workflowContext?: WorkflowContext,
    env?: Record<string, string>,
    resolvedCommand?: CliResolvedCommand
  ): Promise<void>;
  executeHeadless(
    args: string[],
    promptArgument: string,
    tempFilePaths: string[],
    executeCallback: (result: HeadlessProcessResult) => Promise<boolean>,
    env?: Record<string, string>,
    source?: HeadlessStreamingSource,
    resolvedCommand?: CliResolvedCommand,
    secretNames?: readonly string[],
    keepTempFiles?: boolean
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
  /**
   * Log tail of the headless run currently in flight. Held so `cancel()` can
   * abort its session-log discovery, which is the one piece of a headless
   * execution that keeps working when there is no process to kill yet.
   */
  private activeHeadlessLogTail?: HeadlessLogTail;

  constructor(private readonly deps: CliTransportCoordinatorDeps) {}

  /**
   * Launch the harness TUI on the user's own terminal (`stdio: "inherit"`) and
   * return without waiting for it. Completion, session-log discovery and
   * response capture belong to the caller, exactly as they do for the VS Code
   * PTY started by `startInteractiveProcess`; only the spawn differs.
   */
  async startStandaloneInteractiveProcess(
    args: string[],
    promptArgument: string,
    env?: Record<string, string>,
    resolvedCommand?: CliResolvedCommand,
    secretNames?: readonly string[]
  ): Promise<StandaloneInteractiveProcess> {
    const command =
      resolvedCommand ??
      (await this.resolveProviderCommand(
        this.deps.provider.buildInteractiveArgs(args, promptArgument)
      ));

    this.deps.hostCallbacks.onCommandPrepared({
      promptArgument,
      cliCommand: command.displayCommand,
    });

    const workingDir =
      this.deps.runtimeState.getWorkspaceRoot() || process.cwd();
    const interactiveEnv =
      this.deps.provider.getInteractiveSpawnEnv?.() ??
      CliProviderUtils.buildProcessEnv();
    const secretEnv = await this.resolveSecretEnvironment(secretNames);

    const exit = this.deps.processManager.spawnInteractive(
      command.command,
      command.args,
      workingDir,
      { ...interactiveEnv, ...env, ...secretEnv },
      command.requiresShellVerbatimArgs
    );

    return {
      command: command.command,
      exit,
      terminate: () => {
        // A no-op once the process has exited on its own.
        this.deps.processManager.disposeProcess();
        return exit;
      },
    };
  }

  async startInteractiveProcess(
    args: string[],
    promptArgument: string,
    workflowContext?: WorkflowContext,
    env?: Record<string, string>,
    resolvedCommand?: CliResolvedCommand
  ): Promise<void> {
    const command =
      resolvedCommand ??
      (await this.resolveProviderCommand(
        this.deps.provider.buildInteractiveArgs(args, promptArgument)
      ));

    this.deps.hostCallbacks.onBeforeInteractiveStart(workflowContext);
    this.deps.hostCallbacks.onCommandPrepared({
      promptArgument,
      cliCommand: command.displayCommand,
    });

    const ptyManager = this.resolvePtyManager();
    if (!ptyManager) {
      // Returning here would leave the step waiting forever on a harness that
      // was never launched, so fail it with a reason instead.
      throw new CliTransportError(
        "Embedded terminal is unavailable: this host never initialized the PTY process manager, so the interactive harness could not be started.",
        FAILURE_KINDS.HARNESS_ERROR
      );
    }
    const postMessage = this.deps.postTerminalMessage ?? ptyPostMessage;
    const workflowId =
      workflowContext?.instanceId ??
      workflowContext?.filePath ??
      this.deps.runtimeState.getWorkflowName?.() ??
      "unknown";
    const stepMetadata = this.getWorkflowStepMetadata(workflowContext) ?? {
      stepName: EXECUTION_MODES.INTERACTIVE,
      stepIndex: -1,
      promptNumber: undefined,
      parallelGroupId: undefined,
    };
    const { stepName, stepIndex, promptNumber, parallelGroupId } = stepMetadata;
    const cwd = this.deps.runtimeState.getWorkspaceRoot() ?? process.cwd();
    // Provider-level interactive env (e.g. Copilot's OTel export path override,
    // see CopilotCliProvider.getInteractiveSpawnEnv()) must be merged in here too —
    // this is the VS Code PTY spawn path, a separate call site from
    // executeStandaloneInteractiveProcess() above, which already does this.
    const providerEnv = this.deps.provider.getInteractiveSpawnEnv?.();
    const secretEnv = await this.resolveSecretEnvironment(
      workflowContext?.resolvedProperties?.secrets ?? []
    );
    const mergedEnv = {
      ...CliProviderUtils.buildProcessEnv(),
      ...providerEnv,
      ...env,
      ...secretEnv,
    };
    const preSessionId = `ai-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const harnessId = this.deps.provider.config.harnessId;
    // Peek at the expected controller before spawning so TERMINAL_STARTED carries
    // controllerClientId from the outset. Without this, all observers see undefined
    // and race to claim control, so a random client wins instead of the one that
    // actually triggered the run.
    const controllerClientId = ptyManager.getExpectedController(workflowId);

    const terminalStartedMessage: TerminalStartedMessage = {
      type: MESSAGE_TYPES.TERMINAL_STARTED,
      workflowId,
      sessionId: preSessionId,
      stepName,
      stepIndex,
      kind: SESSION_KINDS.AI_CLI,
      promptNumber,
      harnessId,
      parallelGroupId,
      controllerClientId,
    };
    postMessage(terminalStartedMessage);

    let session: PtySession;
    try {
      session = await ptyManager.spawnPty({
        workflowId,
        stepName,
        stepIndex,
        kind: SESSION_KINDS.AI_CLI,
        promptNumber,
        harnessId,
        parallelGroupId,
        sessionId: preSessionId,
        command: command.command,
        args: toPtySpawnArgs(
          command.args,
          command.requiresShellVerbatimArgs ?? false
        ),
        cwd,
        env: mergedEnv,
        streamingSecretRedaction: true,
        onData: (ptySession, chunk) => {
          postMessage({
            type: MESSAGE_TYPES.TERMINAL_OUTPUT,
            workflowId: ptySession.workflowId,
            sessionId: ptySession.id,
            data: chunk,
          });
        },
        onExit: (ptySession, exitCode) => {
          postMessage(buildTerminalEndedMessage(ptySession, exitCode));
          if (this.currentPtySession === ptySession) {
            this.currentPtySession = undefined;
          }
          this.deps.hostCallbacks.onPtyExit(ptySession, exitCode);
        },
      });
    } catch (error) {
      const message = getErrorMessage(error);
      Log.warn(
        `[CliTransportCoordinator] Failed to start embedded terminal: ${message}`
      );
      postMessage({
        type: MESSAGE_TYPES.TERMINAL_OUTPUT,
        workflowId,
        sessionId: preSessionId,
        data: `${message}\r\n`,
      });
      postMessage(
        buildTerminalEndedMessage(
          {
            workflowId,
            id: preSessionId,
            kind: SESSION_KINDS.AI_CLI,
            status: TERMINAL_SESSION_STATUS.FAILED,
          },
          1
        )
      );
      throw error;
    }

    this.lastPtySessionId = session.id;
    this.currentPtySession = session;
    Log.info(
      `[CliTransportCoordinator] PTY session spawned: "${stepName}" (${session.id.slice(0, 8)}) workflowId=inst:${workflowId.slice(0, 8)}`
    );
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
    this.currentPtySession.stepIndex = metadata.stepIndex;
    this.currentPtySession.promptNumber = metadata.promptNumber;
    this.currentPtySession.parallelGroupId = metadata.parallelGroupId;

    const postMessage = this.deps.postTerminalMessage ?? ptyPostMessage;
    const terminalStartedMessage: TerminalStartedMessage = {
      type: MESSAGE_TYPES.TERMINAL_STARTED,
      workflowId: this.currentPtySession.workflowId,
      sessionId: this.currentPtySession.id,
      stepName: metadata.stepName,
      stepIndex: metadata.stepIndex,
      kind: this.currentPtySession.kind,
      promptNumber: metadata.promptNumber,
      harnessId: this.currentPtySession.harnessId,
      parallelGroupId: metadata.parallelGroupId,
      shellKind: this.currentPtySession.shellKind,
      controllerClientId: this.currentPtySession.controllerClientId,
    };
    postMessage(terminalStartedMessage);

    Log.debug(
      `[inject] refreshed PTY session metadata: session=${this.currentPtySession.id.slice(0, 8)} step="${metadata.stepName}"`
    );
    return true;
  }

  async executeHeadless(
    args: string[],
    promptArgument: string,
    tempFilePaths: string[],
    executeCallback: (result: HeadlessProcessResult) => Promise<boolean>,
    env?: Record<string, string>,
    source?: HeadlessStreamingSource,
    resolvedCommand?: CliResolvedCommand,
    secretNames?: readonly string[],
    keepTempFiles = false
  ): Promise<boolean> {
    this.activeHeadlessLogTail = source?.logTail;
    try {
      if (tempFilePaths.length > 0) {
        Log.info(
          `[CliTransportCoordinator] Starting headless mode with ${tempFilePaths.length} file(s)`
        );
      } else {
        Log.info(
          "[CliTransportCoordinator] Starting headless mode with direct prompt (fast path)"
        );
      }

      const command =
        resolvedCommand ??
        (await this.resolveProviderCommand(
          this.deps.provider.buildHeadlessArgs(args, promptArgument)
        ));

      this.deps.hostCallbacks.onCommandPrepared({
        promptArgument,
        cliCommand: command.displayCommand,
      });

      const shouldStream =
        this.deps.provider.config.shouldStreamHeadlessOutput || !!source;
      const stdoutEventPump =
        source?.mode === HEADLESS_SOURCE_MODES.STDOUT
          ? new CliLogEventPump({
              parser: source.parser,
              model: source.model ?? "",
              onStreamingEvents: this.deps.hostCallbacks.onStreamingEvents,
              dispatchedPromptText: promptArgument,
            })
          : undefined;
      let pendingStdout = "";

      const processStdoutRecords = (records: readonly string[]): void => {
        if (!stdoutEventPump || !source?.parseStdout) {
          return;
        }

        for (const record of records) {
          const events = source.parseStdout(record);
          for (const event of events) {
            stdoutEventPump.processEvent(event);
          }
        }
      };

      const processStdoutChunk = (chunk: string): void => {
        const result = splitCompleteLines(pendingStdout + chunk);
        pendingStdout = result.remainder;
        processStdoutRecords(result.lines);
      };

      const flushStdout = (): void => {
        if (pendingStdout.length === 0) {
          return;
        }

        const record = pendingStdout;
        pendingStdout = "";
        processStdoutRecords([record]);
      };

      // Structured stdout is reassembled into complete JSONL records before
      // parsing/redaction. Plain live stdout needs stream-aware redaction here.
      const liveOutputRedactor =
        shouldStream && !source?.logTail && !stdoutEventPump
          ? new StreamingSecretRedactor()
          : undefined;

      if (source?.logTail) {
        await source.logTail.start();
      }

      // Last gate before the process exists. A Stop that lands between prompt
      // preparation and here sees no active process, so `cancel()` retires the
      // workflow instance immediately — spawning anyway produces a harness
      // process owned by nobody, which keeps editing the workspace and later
      // delivers its completion to whichever instance happens to be live.
      if (this.deps.runtimeState.isCancelling()) {
        Log.info(
          "[CliTransportCoordinator] Cancelled before spawn — not launching the CLI"
        );
        source?.logTail?.abort();
        await source?.logTail?.finish();
        return false;
      }

      let result: SpawnResult;
      try {
        result = await this.spawnProcess(command.command, command.args, {
          timeout: ConfigurationUtils.getMaxPromptExecutionTimeMs(),
          env,
          secretNames,
          windowsVerbatimArguments: command.requiresShellVerbatimArgs,
          onStdout: shouldStream
            ? (chunk) => {
                if (ConfigurationUtils.shouldLogRawCliOutput()) {
                  Log.trace(
                    `[${this.deps.provider.config.displayName} RAW OUTPUT]: ${chunk}`
                  );
                }

                if (
                  source?.mode === HEADLESS_SOURCE_MODES.LOG &&
                  source.logTail
                ) {
                  source.logTail.onStdoutChunk(chunk);
                } else if (
                  source?.mode === HEADLESS_SOURCE_MODES.STDOUT &&
                  stdoutEventPump
                ) {
                  processStdoutChunk(chunk);
                } else {
                  const safeChunk = liveOutputRedactor
                    ? liveOutputRedactor.push(chunk)
                    : chunk;
                  if (safeChunk) {
                    this.deps.hostCallbacks.onStreamingEvents([
                      {
                        type: CLI_EVENT_TYPES.TEXT,
                        data: { text: safeChunk },
                      },
                    ]);
                  }
                }
              }
            : undefined,
        });
      } finally {
        const tail = liveOutputRedactor?.flush();
        if (tail) {
          this.deps.hostCallbacks.onStreamingEvents([
            {
              type: CLI_EVENT_TYPES.TEXT,
              data: { text: tail },
            },
          ]);
        }
      }

      // A process may finish with one valid record that has no trailing line
      // break. Emit it before any completion callback or log-tail finalization.
      flushStdout();

      if (source?.logTail) {
        await source.logTail.finish();
      }

      if (this.deps.runtimeState.isCancelling()) {
        Log.info(
          "[CliTransportCoordinator] Prompt execution cancelled by user"
        );
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
      if (error instanceof CliTransportError) {
        throw error;
      }
      Log.error("[CliTransportCoordinator] Headless execution error", error);
      return false;
    } finally {
      this.activeHeadlessLogTail = undefined;
      if (!keepTempFiles) {
        await this.deps.hostCallbacks.cleanupTempFiles(tempFilePaths);
      }
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
    const ptyManager = this.resolvePtyManager();
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
      `[CliTransportCoordinator] Terminating PTY session ${sessionId.slice(0, 8)} before ${reason}`
    );
    const ptyManager = this.resolvePtyManager();
    if (ptyManager) {
      await ptyManager.gracefulKillAiCliSession(
        sessionId,
        TERMINAL_END_REASONS.SUPERSEDED
      );
    } else {
      ptySession.markEnding(TERMINAL_END_REASONS.SUPERSEDED);
      ptySession.pty.write("\x03");
      ptySession.pty.write("\x03");
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      ptySession.pty.kill();
    }
    return sessionId;
  }

  closeTerminal(reason: TerminalEndReason): void {
    if (!this.currentPtySession) {
      return;
    }

    const sessionId = this.currentPtySession.id;
    const ptySession = this.currentPtySession;
    this.currentPtySession = undefined; // clear immediately so inject mode won't see a stale session
    const ptyManager = this.resolvePtyManager();
    // Fire-and-forget: send Ctrl+C and schedule the kill — callers are sync so we can't await here.
    if (ptyManager) {
      void ptyManager.gracefulKillAiCliSession(sessionId, reason);
    } else {
      ptySession.markEnding(reason);
      ptySession.pty.write("\x03");
      ptySession.pty.write("\x03");
      setTimeout(() => ptySession.pty.kill(), 500);
    }
  }

  async cancel(): Promise<boolean> {
    // Abort first and unconditionally: session-log discovery is the one part of
    // a headless run that is already working before the process exists, and it
    // outlives the instance that owns it if nothing stops it. The return value
    // still reports only on the process, because the caller uses it to decide
    // whether to wait for a process-exit handler that will never fire here.
    this.activeHeadlessLogTail?.abort();

    if (this.currentPtySession) {
      const ptyManager = this.resolvePtyManager();
      if (ptyManager) {
        ptyManager.killSession(
          this.currentPtySession.id,
          TERMINAL_END_REASONS.STOPPED
        );
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
      this.closeTerminal(TERMINAL_END_REASONS.STEP_COMPLETE);
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
      secretNames?: readonly string[];
      onStdout?: (chunk: string) => void;
      windowsVerbatimArguments?: boolean;
    } = {}
  ): Promise<SpawnResult> {
    const headlessEnvOverrides = this.deps.provider.getHeadlessSpawnEnv?.();
    const baseEnv = {
      ...CliProviderUtils.buildProcessEnv(),
      ...headlessEnvOverrides,
    };
    const secretEnv = await this.resolveSecretEnvironment(
      options.secretNames ?? []
    );
    const env = { ...baseEnv, ...options.env, ...secretEnv };

    let result: SpawnResult;
    try {
      result = await this.deps.processManager.spawn(command, args, {
        cwd: this.deps.runtimeState.getWorkspaceRoot() || "",
        timeout: options.timeout,
        onStdout: options.onStdout,
        shell: false,
        windowsVerbatimArguments: options.windowsVerbatimArguments,
        env,
      });
    } catch (error) {
      if (error instanceof CliProcessTimeoutError) {
        throw new CliTransportError(
          `Prompt execution timed out after ${error.timeoutMs}ms`,
          FAILURE_KINDS.TIMEOUT,
          { cause: error }
        );
      }
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        throw new CliTransportError(
          `Harness CLI could not be started: ${getErrorMessage(error)}`,
          FAILURE_KINDS.HARNESS_NOT_INSTALLED,
          { cause: error }
        );
      }
      throw error;
    }

    Log.info("[CliTransportCoordinator] Process exited - execution complete");
    return result;
  }

  private async resolveSecretEnvironment(
    names: readonly string[] | undefined
  ): Promise<Record<string, string>> {
    return (await this.deps.resolveSecretEnvironment?.(names ?? [])) ?? {};
  }

  /**
   * An injected getter is authoritative, including when it returns null, so a
   * host (or test) can state that it has no embedded terminal support.
   */
  private resolvePtyManager(): PtyProcessManager | null {
    return this.deps.getPtyManager
      ? this.deps.getPtyManager()
      : getPtyProcessManager();
  }

  private getWorkflowStepMetadata(workflowContext?: WorkflowContext):
    | {
        stepName: string;
        stepIndex: number;
        promptNumber: number;
        parallelGroupId?: string;
      }
    | undefined {
    if (!workflowContext) {
      return undefined;
    }

    const promptNumber = workflowContext.promptIndex + 1;
    const parallelGroupId = workflowContext.workflowFile?.parallelGroups?.find(
      (group) =>
        workflowContext.promptIndex >= group.startIndex &&
        workflowContext.promptIndex <= group.endIndex
    )?.id;
    return {
      stepName:
        workflowContext.allPrompts[workflowContext.promptIndex]?.name ??
        `Step ${promptNumber}`,
      stepIndex:
        workflowContext.terminalStepIndex ?? workflowContext.promptIndex,
      promptNumber,
      parallelGroupId,
    };
  }

  private async resolveProviderCommand(
    args: string[]
  ): Promise<CliResolvedCommand> {
    const resolveCommand = this.deps.resolveCliCommand ?? resolveCliCommand;
    return resolveCommand(this.deps.provider.config.name, args);
  }
}
