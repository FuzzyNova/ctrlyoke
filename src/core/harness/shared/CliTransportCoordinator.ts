import { randomUUID } from "crypto";
import type { CliEvent } from "../../../types/CliOutputTypes";
import type {
  HeadlessControlTargetMessage,
  TerminalStartedMessage,
} from "../../../types/WebviewMessageTypes";
import {
  EXECUTION_MODES,
  CLI_EVENT_TYPES,
  HEADLESS_PROMPT_DELIVERIES,
  HEADLESS_STEER_DELIVERIES,
  HEADLESS_CONTROL_OBSERVATION_KINDS,
  HEADLESS_SOURCE_MODES,
  HEADLESS_APPROVAL_DEFAULT_TIMEOUT_SEC,
  HEADLESS_APPROVAL_DENIAL_MESSAGE,
  HEADLESS_APPROVAL_NO_DASHBOARD_MESSAGE,
  HEADLESS_APPROVAL_POLICIES,
  HEADLESS_APPROVAL_SESSION_CLOSED_MESSAGE,
  HEADLESS_MODEL_QUESTION_DENIAL_MESSAGE,
  MESSAGE_TYPES,
  SESSION_KINDS,
  TERMINAL_END_REASONS,
  TERMINAL_SESSION_STATUS,
  type TerminalEndReason,
  type HarnessId,
  type ApprovalDecision,
  type HeadlessApprovalPolicy,
  USER_STEER_ATTRIBUTIONS,
  NODE_ERROR_CODES,
  FAILURE_SOURCES,
} from "../../../types/DashboardConstants";
import type { WorkflowContext } from "../../../types/WorkflowContextTypes";
import type {
  CliProcessManager,
  InteractiveExitResult,
  SpawnResult,
} from "../../../utils/CliProcessManager";
import { CliProcessTimeoutError } from "../../../utils/CliProcessManager";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import { getErrorMessage, hasErrnoCode } from "../../../utils/ErrorUtils";
import { Log } from "../../../utils/Log";
import { HarnessAdapterUtils } from "./HarnessAdapterUtils";
import {
  resolveCliCommand,
  type CliResolvedCommand,
} from "./CliLauncherResolver";
import type { IHarnessAdapter } from "./interfaces/IHarnessAdapter";
import {
  buildTerminalEndedMessage,
  buildTerminalStartedMessage,
  buildTerminalRemovedMessage,
  getPtyProcessManager,
  ptyPostMessage,
  toPtySpawnArgs,
} from "../PtyProcessManager";
import type { PtyProcessManager, PtySession } from "../PtyProcessManager";
import { CliLogEventPump } from "./CliLogEventPump";
import { FAILURE_KINDS } from "../../../types/DashboardConstants";
import { CliTransportError } from "./CliTransportError";
import {
  HeadlessLogTail,
  type HeadlessProcessResult,
  type HeadlessStreamingSource,
} from "./HeadlessLogTail";
import { splitCompleteLines } from "../../../utils/TextLines";
import {
  secretRedactionService,
  StreamingSecretRedactor,
} from "../../../utils/SecretRedactionService";
import { AsyncMutex } from "./AsyncMutex";
import {
  type ControlObservation,
  type HeadlessApprovalExecutionContext,
  type HeadlessControlChannelContext,
  type ControlWriter,
  type IHeadlessControlChannel,
} from "./IHeadlessControlChannel";
import type { Writable } from "stream";
import { APPROVAL_DECISIONS } from "../../../types/DashboardConstants";

const MAX_HEADLESS_APPROVAL_INPUT_SUMMARY_LENGTH = 2_000;

function summarizeHeadlessApprovalInput(input: unknown): string {
  const serialized =
    typeof input === "string"
      ? input
      : (JSON.stringify(input) ?? String(input));
  const redacted = secretRedactionService.redactText(serialized);
  if (redacted.length <= MAX_HEADLESS_APPROVAL_INPUT_SUMMARY_LENGTH) {
    return redacted;
  }
  return `${redacted.slice(0, MAX_HEADLESS_APPROVAL_INPUT_SUMMARY_LENGTH - 1)}…`;
}

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
  onHeadlessControlTarget?: (target: HeadlessControlTargetMessage) => void;
}

export interface CliTransportCoordinatorDeps {
  provider: IHarnessAdapter;
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
    keepTempFiles?: boolean,
    controlTarget?: HeadlessControlTargetContext,
    approvalContext?: HeadlessApprovalExecutionContext,
    controlContext?: HeadlessControlChannelContext
  ): Promise<boolean>;
  /** Write text to the currently active PTY session. Returns false if no session is active. */
  writeToCurrentPtySession(text: string): boolean;
  /** Refresh display metadata for the current PTY session when it is reused by terminal reuse. */
  updateCurrentPtySessionMetadata?(workflowContext?: WorkflowContext): boolean;
  /**
   * Terminate the current PTY when another execution mode needs exclusive
   * ownership of the same AI session.
   */
  terminateCurrentPtySession?(
    reason: string,
    options?: TerminatePtySessionOptions
  ): Promise<string | undefined>;
}

export interface HeadlessControlTargetContext {
  workflowId: string;
  stepIndex: number;
  harnessId: HarnessId;
}

export interface TerminatePtySessionOptions {
  /**
   * Also drop the terminal's tab. Set when the process about to replace it
   * continues the same AI session, so the conversation is not shown twice.
   */
  removeTerminalTab?: boolean;
}

export class CliTransportCoordinator implements CliExecutionTransportCoordinator {
  private currentPtySession?: PtySession;
  /** ID of the last PTY spawned — persists after currentPtySession is cleared so reuse-fallback suppression can find it. */
  private lastPtySessionId?: string;
  /**
   * Log tail of the headless run currently in flight. Held so `cancel()` can
   * abort its session-log discovery, which is the one piece of a headless
   * execution that keeps working when there is no process to kill yet.
   */
  private activeHeadlessLogTail?: HeadlessLogTail;
  private activeHeadlessControlChannel?: IHeadlessControlChannel;
  private activeHeadlessControlClose?: () => Promise<void>;
  private activeHeadlessControlSessionId?: string;
  private activeHeadlessControlSend?: (text: string) => Promise<boolean>;
  private activeHeadlessControlInterrupt?: () => Promise<boolean>;
  /** The open steer target last published to dashboards, for reconnect replay. */
  private activeHeadlessControlTarget?: HeadlessControlTargetMessage;

  constructor(private readonly deps: CliTransportCoordinatorDeps) {}

  getHeadlessControlSessionId(): string | undefined {
    return this.activeHeadlessControlSessionId;
  }

  getOpenHeadlessControlTarget(): HeadlessControlTargetMessage | undefined {
    return this.activeHeadlessControlTarget;
  }

  sendHeadlessUserMessage(sessionId: string, text: string): Promise<boolean> {
    if (
      this.activeHeadlessControlSessionId !== sessionId ||
      this.activeHeadlessControlChannel?.supportsSteering === false
    ) {
      return Promise.resolve(false);
    }
    return this.activeHeadlessControlSend?.(text) ?? Promise.resolve(false);
  }

  async interruptHeadlessTurn(sessionId: string): Promise<boolean> {
    if (this.activeHeadlessControlSessionId !== sessionId) {
      return false;
    }

    return this.activeHeadlessControlInterrupt?.() ?? false;
  }

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
      HarnessAdapterUtils.buildProcessEnv();
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
        FAILURE_KINDS.HARNESS_ERROR,
        undefined,
        FAILURE_SOURCES.SPAWN
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
    // see CopilotHarnessAdapter.getInteractiveSpawnEnv()) must be merged in here too —
    // this is the VS Code PTY spawn path, a separate call site from
    // executeStandaloneInteractiveProcess() above, which already does this.
    const providerEnv = this.deps.provider.getInteractiveSpawnEnv?.();
    const secretEnv = await this.resolveSecretEnvironment(
      workflowContext?.resolvedProperties?.secrets ?? []
    );
    const mergedEnv = {
      ...HarnessAdapterUtils.buildProcessEnv(),
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
   * Refresh the active PTY's display metadata when terminal reuse submits another
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
    const terminalStartedMessage = buildTerminalStartedMessage(
      this.currentPtySession
    );
    postMessage(terminalStartedMessage);

    Log.debug(
      `[reuse] refreshed PTY session metadata: session=${this.currentPtySession.id.slice(0, 8)} step="${metadata.stepName}"`
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
    keepTempFiles = false,
    controlTarget?: HeadlessControlTargetContext,
    approvalContext?: HeadlessApprovalExecutionContext,
    controlContext?: HeadlessControlChannelContext
  ): Promise<boolean> {
    this.activeHeadlessLogTail = source?.logTail;
    let closeControlChannelForRun: (() => Promise<void>) | undefined;
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
      const controlChannel =
        await this.deps.provider.createHeadlessControlChannel?.(
          promptArgument,
          {
            approvalPolicy:
              approvalContext?.approvalPolicy ??
              HEADLESS_APPROVAL_POLICIES.DENY,
            approvalTimeoutMs:
              approvalContext?.approvalTimeoutMs ??
              HEADLESS_APPROVAL_DEFAULT_TIMEOUT_SEC * 1000,
            useApprovalControl: approvalContext?.useApprovalControl ?? false,
            context: {
              ...controlContext,
              launchArgs: args,
              workspaceRoot:
                controlContext?.workspaceRoot ??
                this.deps.runtimeState.getWorkspaceRoot(),
              onSessionId: (sessionId) =>
                source?.logTail?.setResolvedSessionId(sessionId),
            },
          }
        );
      approvalContext?.onPermissionWarning?.(
        approvalContext.useApprovalControl === true &&
          controlChannel?.answersApprovalRequests === true,
        approvalContext.requestApproval !== undefined,
        approvalContext.suppressPermissionWarning === true
      );
      const approvalPolicy: HeadlessApprovalPolicy =
        approvalContext?.useApprovalControl
          ? approvalContext.approvalPolicy
          : HEADLESS_APPROVAL_POLICIES.DENY;
      const controlSessionId = controlChannel ? randomUUID() : undefined;
      const targetBase =
        controlChannel &&
        controlChannel.supportsSteering !== false &&
        controlSessionId &&
        controlTarget
          ? {
              workflowId: controlTarget.workflowId,
              controlSessionId,
              stepIndex: controlTarget.stepIndex,
              harnessId: controlTarget.harnessId,
              steerDelivery: controlChannel.steerDelivery,
              canInterruptTurn: controlChannel.interrupt !== undefined,
            }
          : undefined;
      const controlArgs = controlChannel?.spawnShape.args ?? [];
      const replaceSpawnArgs = controlChannel?.spawnShape.replaceArgs === true;
      const spawnCommand = replaceSpawnArgs
        ? await this.resolveProviderCommand([...controlArgs])
        : command;
      const spawnArgs = replaceSpawnArgs
        ? [...spawnCommand.args]
        : [...command.args, ...controlArgs];

      this.deps.hostCallbacks.onCommandPrepared({
        promptArgument,
        cliCommand: replaceSpawnArgs
          ? spawnCommand.displayCommand
          : controlArgs.length
            ? `${command.displayCommand} ${controlArgs.join(" ")}`
            : command.displayCommand,
      });

      const shouldStream =
        this.deps.provider.config.shouldStreamHeadlessOutput ||
        !!source ||
        !!controlChannel;
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
      let pendingControlStdout = "";
      const controlMutex = controlChannel ? new AsyncMutex() : undefined;
      let controlWriter: ControlWriter | undefined;
      let controlReady: Promise<void> | undefined;
      let controlClosed = false;
      let controlClosing = false;
      let controlClosePromise: Promise<void> | undefined;
      let controlOperations = Promise.resolve();
      let publishedControlTarget = false;
      let controlTurnActive = false;
      let interruptedTurnCompleted = false;
      const approvalAbortController = new AbortController();
      const pendingApprovalResponses = new Set<Promise<void>>();
      const injectedSteers = new Set<symbol>();
      const queuedSteersSubmittedDuringTurn: symbol[] = [];
      const queuedSteersAwaitingTurn: symbol[] = [];

      const hasOutstandingSteers = (): boolean =>
        injectedSteers.size > 0 ||
        queuedSteersSubmittedDuringTurn.length > 0 ||
        queuedSteersAwaitingTurn.length > 0;

      const reserveSteer = (): (() => void) => {
        if (
          controlChannel?.steerDelivery === HEADLESS_STEER_DELIVERIES.INJECT
        ) {
          const reservation = Symbol("injected-steer");
          injectedSteers.add(reservation);
          const wasTurnActive = controlTurnActive;
          if (!controlTurnActive) controlTurnActive = true;
          return () => {
            injectedSteers.delete(reservation);
            if (!wasTurnActive && injectedSteers.size === 0) {
              controlTurnActive = false;
            }
          };
        }

        const reservation = Symbol("queued-steer");
        if (controlTurnActive) {
          queuedSteersSubmittedDuringTurn.push(reservation);
        } else {
          queuedSteersAwaitingTurn.push(reservation);
          controlTurnActive = true;
        }
        return () => {
          const submittedIndex =
            queuedSteersSubmittedDuringTurn.indexOf(reservation);
          if (submittedIndex !== -1) {
            queuedSteersSubmittedDuringTurn.splice(submittedIndex, 1);
          }
          const queuedIndex = queuedSteersAwaitingTurn.indexOf(reservation);
          if (queuedIndex !== -1) {
            queuedSteersAwaitingTurn.splice(queuedIndex, 1);
            controlTurnActive =
              queuedSteersAwaitingTurn.length > 0 ||
              queuedSteersSubmittedDuringTurn.length > 0;
          }
        };
      };

      const updateSteerStateAtTurnEnd = (): void => {
        if (
          controlChannel?.steerDelivery === HEADLESS_STEER_DELIVERIES.INJECT
        ) {
          injectedSteers.clear();
          controlTurnActive = false;
          return;
        }

        queuedSteersAwaitingTurn.shift();
        queuedSteersAwaitingTurn.push(
          ...queuedSteersSubmittedDuringTurn.splice(0)
        );
        controlTurnActive = queuedSteersAwaitingTurn.length > 0;
      };

      const withControlLock = async (operation: () => Promise<void>) => {
        if (!controlMutex) return;
        await controlMutex.acquire();
        try {
          await operation();
        } finally {
          controlMutex.release();
        }
      };

      const closeControlChannel = (): Promise<void> => {
        if (controlClosePromise) return controlClosePromise;
        if (!controlChannel || controlClosed) return Promise.resolve();
        controlClosing = true;
        controlClosePromise = (async () => {
          approvalAbortController.abort();
          while (pendingApprovalResponses.size > 0) {
            await Promise.allSettled([...pendingApprovalResponses]);
          }
          controlClosed = true;
          await controlWriter?.end();
          await withControlLock(async () => {
            controlChannel.close();
          });
          if (this.activeHeadlessControlChannel === controlChannel) {
            this.activeHeadlessControlChannel = undefined;
            this.activeHeadlessControlClose = undefined;
            this.activeHeadlessControlSessionId = undefined;
            this.activeHeadlessControlSend = undefined;
            this.activeHeadlessControlInterrupt = undefined;
          }
          if (
            this.activeHeadlessControlTarget?.controlSessionId ===
            controlSessionId
          ) {
            this.activeHeadlessControlTarget = undefined;
          }
          if (targetBase && publishedControlTarget) {
            this.deps.hostCallbacks.onHeadlessControlTarget?.({
              type: MESSAGE_TYPES.HEADLESS_CONTROL_TARGET_CHANGED,
              ...targetBase,
              isOpen: false,
            });
          }
        })();
        return controlClosePromise;
      };
      closeControlChannelForRun = closeControlChannel;

      const enqueueControlOperation = (
        operation: () => Promise<void>
      ): void => {
        controlOperations = controlOperations
          .then(operation)
          .catch((error: unknown) => {
            Log.warn(
              `[CliTransportCoordinator] Headless control operation failed: ${getErrorMessage(error)}`
            );
          });
      };

      // A headless step ends at its turn boundary. Background work the model
      // left running is not awaited: closing stdin ends the process, and the
      // response collector records any unfinished task as abandoned.
      const closeAfterTurnEnd = (): void => {
        if (hasOutstandingSteers()) return;
        enqueueControlOperation(closeControlChannel);
      };

      const processControlObservations = (
        observations: readonly ControlObservation[]
      ): void => {
        if (!controlChannel) return;
        for (const observation of observations) {
          if (
            observation.kind ===
            HEADLESS_CONTROL_OBSERVATION_KINDS.APPROVAL_REQUEST
          ) {
            const response = (async (): Promise<void> => {
              let resolution: { decision: ApprovalDecision; message?: string };
              if (controlClosing) {
                resolution = {
                  decision: APPROVAL_DECISIONS.DENY,
                  message: HEADLESS_APPROVAL_SESSION_CLOSED_MESSAGE,
                };
              } else if (
                !controlTarget ||
                !controlSessionId ||
                !approvalContext?.requestApproval
              ) {
                resolution = {
                  decision: APPROVAL_DECISIONS.DENY,
                  message:
                    approvalPolicy === HEADLESS_APPROVAL_POLICIES.ASK
                      ? HEADLESS_APPROVAL_NO_DASHBOARD_MESSAGE
                      : HEADLESS_APPROVAL_DENIAL_MESSAGE,
                };
              } else {
                try {
                  resolution = await approvalContext.requestApproval(
                    {
                      policy: approvalPolicy,
                      workflowId: controlTarget.workflowId,
                      controlSessionId,
                      stepIndex: controlTarget.stepIndex,
                      harnessId: controlTarget.harnessId,
                      requestId: observation.requestId,
                      toolName: observation.toolName,
                      inputSummary: summarizeHeadlessApprovalInput(
                        observation.input
                      ),
                      timeoutMs:
                        approvalContext.approvalTimeoutMs ??
                        HEADLESS_APPROVAL_DEFAULT_TIMEOUT_SEC * 1000,
                    },
                    approvalAbortController.signal
                  );
                } catch (error) {
                  Log.warn(
                    `[CliTransportCoordinator] Headless approval policy failed: ${getErrorMessage(error)}`
                  );
                  resolution = {
                    decision: APPROVAL_DECISIONS.DENY,
                    message: HEADLESS_APPROVAL_DENIAL_MESSAGE,
                  };
                }
              }
              await controlChannel.answerApproval(
                observation.requestId,
                resolution.decision,
                resolution.message
              );
            })();
            pendingApprovalResponses.add(response);
            void response.then(
              () => pendingApprovalResponses.delete(response),
              (error: unknown) => {
                pendingApprovalResponses.delete(response);
                Log.warn(
                  `[CliTransportCoordinator] Could not answer headless approval: ${getErrorMessage(error)}`
                );
              }
            );
          } else if (
            observation.kind ===
            HEADLESS_CONTROL_OBSERVATION_KINDS.MODEL_QUESTION
          ) {
            const response = controlChannel.answerApproval(
              observation.requestId,
              APPROVAL_DECISIONS.DENY,
              HEADLESS_MODEL_QUESTION_DENIAL_MESSAGE
            );
            pendingApprovalResponses.add(response);
            void response.then(
              () => pendingApprovalResponses.delete(response),
              (error: unknown) => {
                pendingApprovalResponses.delete(response);
                Log.warn(
                  `[CliTransportCoordinator] Could not reject headless model question: ${getErrorMessage(error)}`
                );
              }
            );
          } else if (
            observation.kind === HEADLESS_CONTROL_OBSERVATION_KINDS.TURN_END
          ) {
            interruptedTurnCompleted = observation.interrupted === true;
            updateSteerStateAtTurnEnd();
            closeAfterTurnEnd();
          }
        }
      };

      const observeControlRecord = (record: string): void => {
        if (!controlChannel) return;
        let value: unknown = record;
        try {
          value = JSON.parse(record) as unknown;
        } catch {
          // Providers may ignore malformed records; still expose each JSONL line.
        }
        processControlObservations(controlChannel.observe(value));
      };

      const processControlStdoutChunk = (chunk: string): void => {
        if (controlChannel?.observeStdoutChunk) {
          processControlObservations(controlChannel.observeStdoutChunk(chunk));
          return;
        }
        const result = splitCompleteLines(pendingControlStdout + chunk);
        pendingControlStdout = result.remainder;
        for (const record of result.lines) observeControlRecord(record);
      };

      const flushControlStdout = (): void => {
        if (controlChannel?.flushStdout) {
          processControlObservations(controlChannel.flushStdout());
        }
        if (!pendingControlStdout) return;
        const record = pendingControlStdout;
        pendingControlStdout = "";
        observeControlRecord(record);
      };

      const createControlWriter = (writer: Writable): ControlWriter => {
        let stdinEnded = false;
        return {
          write: (text) =>
            withControlLock(
              () =>
                new Promise<void>((resolve, reject) => {
                  writer.write(text, "utf8", (error?: Error | null) => {
                    if (error) reject(error);
                    else resolve();
                  });
                })
            ),
          end: () =>
            withControlLock(() => {
              if (stdinEnded) return Promise.resolve();
              stdinEnded = true;
              return new Promise<void>((resolve) => {
                writer.end(resolve);
              });
            }),
        };
      };

      if (controlChannel) {
        this.activeHeadlessControlChannel = controlChannel;
        this.activeHeadlessControlClose = closeControlChannel;
      }

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

      if (
        source?.logTail &&
        controlChannel?.startLogTailAfterChannelStart !== true
      ) {
        await source.logTail.start();
      } else if (source?.mode === HEADLESS_SOURCE_MODES.STDOUT) {
        source.parser
          .getSubagentFollower?.()
          ?.start(this.deps.hostCallbacks.onStreamingEvents);
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
        const promptTimeoutMs =
          ConfigurationUtils.getMaxPromptExecutionTimeMs();
        result = await this.spawnProcess(spawnCommand.command, spawnArgs, {
          timeout: promptTimeoutMs,
          env: {
            ...env,
            ...(controlChannel?.spawnShape.env as
              Record<string, string> | undefined),
          },
          secretNames,
          stdinText:
            !controlChannel &&
            this.deps.provider.config.headlessPromptDelivery ===
              HEADLESS_PROMPT_DELIVERIES.STDIN
              ? promptArgument
              : undefined,
          onStdinReady: controlChannel
            ? (writer) => {
                controlWriter = createControlWriter(writer);
                controlReady = (async () => {
                  if (controlClosed) return;
                  await controlChannel.start(
                    controlWriter!,
                    processControlObservations
                  );
                  if (controlClosed) return;
                  if (
                    controlChannel.startLogTailAfterChannelStart &&
                    source?.logTail
                  ) {
                    await source.logTail.start();
                  }
                  if (controlClosed) return;
                  controlTurnActive = true;
                  await controlChannel.sendUserMessage(promptArgument);
                  if (controlClosed || !controlSessionId) return;
                  this.activeHeadlessControlSessionId = controlSessionId;
                  this.activeHeadlessControlSend = async (text) => {
                    if (
                      controlClosed ||
                      this.activeHeadlessControlChannel !== controlChannel ||
                      this.activeHeadlessControlSessionId !== controlSessionId
                    ) {
                      return false;
                    }
                    const releaseReservation = reserveSteer();
                    source?.logTail?.registerDispatchedUserMessage(text);
                    stdoutEventPump?.registerDispatchedUserMessage(text);
                    try {
                      await controlChannel.sendUserMessage(text);
                    } catch (error) {
                      releaseReservation();
                      source?.logTail?.discardDispatchedUserMessage(text);
                      stdoutEventPump?.discardDispatchedUserMessage(text);
                      throw error;
                    }
                    this.deps.hostCallbacks.onStreamingEvents([
                      {
                        type: CLI_EVENT_TYPES.USER_STEER,
                        timestamp: Date.now(),
                        data: {
                          text,
                          attribution: USER_STEER_ATTRIBUTIONS.USER,
                        },
                      },
                    ]);
                    return true;
                  };
                  const interrupt =
                    controlChannel.interrupt?.bind(controlChannel);
                  this.activeHeadlessControlInterrupt = interrupt
                    ? async () => {
                        if (
                          controlClosed ||
                          this.activeHeadlessControlChannel !==
                            controlChannel ||
                          this.activeHeadlessControlSessionId !==
                            controlSessionId
                        ) {
                          return false;
                        }
                        await interrupt();
                        return true;
                      }
                    : undefined;
                  if (targetBase) {
                    const openTarget: HeadlessControlTargetMessage = {
                      type: MESSAGE_TYPES.HEADLESS_CONTROL_TARGET_CHANGED,
                      ...targetBase,
                      isOpen: true,
                    };
                    this.activeHeadlessControlTarget = openTarget;
                    this.deps.hostCallbacks.onHeadlessControlTarget?.(
                      openTarget
                    );
                    publishedControlTarget = true;
                  }
                })().catch(async (error: unknown) => {
                  await closeControlChannel();
                  if (error instanceof CliTransportError) {
                    // A failed protocol handshake must fail the step promptly,
                    // even when the child stays alive waiting for stdin input.
                    await this.deps.processManager.cancel();
                  }
                  throw error;
                });
                // Awaited after the process exits; mark it handled now so a
                // handshake failure is not reported as an unhandled rejection
                // while the spawn is still settling.
                controlReady.catch(() => undefined);
              }
            : undefined,
          windowsVerbatimArguments: spawnCommand.requiresShellVerbatimArgs,
          onStdout: shouldStream
            ? (chunk) => {
                if (ConfigurationUtils.shouldLogRawCliOutput()) {
                  Log.trace(
                    `[${this.deps.provider.config.displayName} RAW OUTPUT]: ${chunk}`
                  );
                }

                if (controlChannel) {
                  processControlStdoutChunk(chunk);
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
        await controlReady;
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
      flushControlStdout();
      await controlOperations;

      if (source?.logTail) {
        await source.logTail.finish();
      }

      if (this.deps.runtimeState.isCancelling()) {
        Log.info(
          "[CliTransportCoordinator] Prompt execution cancelled by user"
        );
        await executeCallback(
          this.withHeadlessControlOutcome(
            result,
            source?.logTail,
            interruptedTurnCompleted
          )
        );
        return false;
      }

      return await executeCallback(
        this.withHeadlessControlOutcome(
          result,
          source?.logTail,
          interruptedTurnCompleted
        )
      );
    } catch (error) {
      await closeControlChannelForRun?.();
      if (source?.logTail) {
        await source.logTail.finish();
      }
      if (error instanceof CliTransportError) {
        throw error;
      }
      Log.error("[CliTransportCoordinator] Headless execution error", error);
      return false;
    } finally {
      await closeControlChannelForRun?.();
      this.activeHeadlessLogTail = undefined;
      source?.parser.getSubagentFollower?.()?.stop();
      if (!keepTempFiles) {
        await this.deps.hostCallbacks.cleanupTempFiles(tempFilePaths);
      }
    }
  }

  private withHeadlessControlOutcome(
    result: HeadlessProcessResult,
    logTail: HeadlessLogTail | undefined,
    interrupted: boolean
  ): HeadlessProcessResult {
    return {
      ...result,
      ...(logTail ? { headlessLogTail: logTail } : {}),
      ...(interrupted ? { interrupted: true } : {}),
    };
  }

  /**
   * Write text directly into the currently active PTY session.
   * Used by terminal reuse to submit follow-up prompts without restarting the TUI.
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
   * Store the running-terminal context (log path + AI session ID) on the currently active PTY session.
   * Called by CliExecutionRunner after session startup so the context survives integration
   * lifecycle changes and can be retrieved on workflow resume.
   */
  hasLivePtySession(): boolean {
    return this.currentPtySession !== undefined;
  }

  /**
   * Returns the ID of the last PTY session that was spawned, even if it has since
   * exited and currentPtySession was cleared. Used by reuse-fallback logic to
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
    reason: string,
    options: TerminatePtySessionOptions = {}
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
    if (options.removeTerminalTab) {
      ptyManager?.forgetTab(sessionId);
      const postMessage = this.deps.postTerminalMessage ?? ptyPostMessage;
      postMessage(
        buildTerminalRemovedMessage(ptySession.workflowId, sessionId)
      );
    }
    return sessionId;
  }

  closeTerminal(reason: TerminalEndReason): void {
    if (!this.currentPtySession) {
      return;
    }

    const sessionId = this.currentPtySession.id;
    const ptySession = this.currentPtySession;
    this.currentPtySession = undefined; // clear immediately so terminal reuse won't see a stale session
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
    await this.activeHeadlessControlClose?.();

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
      stdinText?: string;
      onStdinReady?: (writer: Writable) => void;
      windowsVerbatimArguments?: boolean;
    } = {}
  ): Promise<SpawnResult> {
    const headlessEnvOverrides = this.deps.provider.getHeadlessSpawnEnv?.();
    const baseEnv = {
      ...HarnessAdapterUtils.buildProcessEnv(),
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
        stdinText: options.stdinText,
        onStdinReady: options.onStdinReady,
        shell: false,
        windowsVerbatimArguments: options.windowsVerbatimArguments,
        env,
      });
    } catch (error) {
      if (error instanceof CliProcessTimeoutError) {
        throw new CliTransportError(
          `Prompt execution timed out after ${error.timeoutMs}ms`,
          FAILURE_KINDS.TIMEOUT,
          { cause: error },
          FAILURE_SOURCES.TIMEOUT
        );
      }
      if (hasErrnoCode(error, NODE_ERROR_CODES.ENOENT)) {
        throw new CliTransportError(
          `Harness CLI could not be started: ${getErrorMessage(error)}`,
          FAILURE_KINDS.HARNESS_NOT_INSTALLED,
          { cause: error },
          FAILURE_SOURCES.SPAWN
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
