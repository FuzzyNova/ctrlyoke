import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { CliEvent } from "../../../types/CliOutputTypes";
import {
  FAILURE_KINDS,
  CTRLYOKE_ENV_VARS,
  HARNESS_IDS,
  HEADLESS_SOURCE_MODES,
  INTERACTIVE_TERMINAL_MODES,
  type InteractiveTerminalMode,
} from "../../../types/DashboardConstants";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import { getErrorMessage } from "../../../utils/ErrorUtils";
import { Log } from "../../../utils/Log";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";
import { CliLogMonitor } from "../CliLogMonitor";
import type { CliExecutionSession } from "./CliExecutionSession";
import type { CliFailureTracker } from "./CliFailureTracker";
import type { CollectedHeadlessResponse } from "./CliResponseCollector";
import {
  HeadlessLogTail,
  resolveHeadlessSourceMode,
  type HeadlessProcessResult,
  type HeadlessStreamingSource,
} from "./HeadlessLogTail";
import type { InteractiveSessionDiscovery } from "./CliInteractiveStartupCoordinator";
import type { ICliProvider } from "./interfaces/ICliProvider";
import { HookEventMonitor } from "./HookEventMonitor";
import type { CtrlYokeNotificationEvent } from "../../../ui/notifications/CompletionNotificationFactory";
import { configService } from "../../../config/CtrlYokeConfigService";
import type {
  CliExecutionTransportCoordinator,
  StandaloneInteractiveProcess,
} from "./CliTransportCoordinator";
import type { InteractiveExitResult } from "../../../utils/CliProcessManager";
import type { CliResolvedCommand } from "./CliLauncherResolver";
import { AsyncMutex } from "./AsyncMutex";
import { CliTransportError } from "./CliTransportError";

interface CliInteractiveStartupCoordinatorLike {
  resolveSession(params: {
    promptForDiscovery: string;
    startTime: Date;
    resolvedSessionId?: string;
    runId: string;
  }): Promise<InteractiveSessionDiscovery | null>;
}

interface CliResponseCollectorLike {
  collectHeadlessResponse(
    params: HeadlessProcessResult & {
      promptForSessionLog: string;
      executionStartTime: Date;
      resolvedSessionId?: string;
      label?: string;
      model?: string;
      workspaceRoot?: string;
    }
  ): Promise<CollectedHeadlessResponse>;
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
    getWorkspaceRoots?: () => readonly string[];
    getApprovedExternalRoots?: () => readonly string[];
    getExtensionPath: () => string;
    interactiveTerminal: InteractiveTerminalMode;
    isCancelling: () => boolean;
    setFailureReason: (reason: string) => void;
  };
  hostCallbacks: {
    onStreamingEvents: (events: CliEvent[]) => void;
    onResponseComplete: (response: string) => void;
    logResponse: (response: string, statistics?: string) => void;
    onContextWindowUpdate?: (used: number, size: number) => void;
    onNotificationEvent?: (event: CtrlYokeNotificationEvent) => void;
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
  private static readonly INJECT_FOCUS_PULSE_COUNT = 2;
  private static readonly INJECT_PROMPT_CHUNK_SIZE = 256;
  private static readonly INJECT_FOCUS_SETTLE_DELAY_MS = 50;
  private static readonly INJECT_CHUNK_DELAY_MS = 20;
  private static readonly INJECT_PRE_SUBMIT_DELAY_MS = 200;
  private static readonly INJECT_SUBMIT_PULSE_COUNT = 2;
  private static readonly INJECT_SUBMIT_DELAY_MS = 75;

  /**
   * Context from the most recent successful interactive execution.
   * Set after `executeInTerminal` succeeds and cleared on reset/cancel.
   * When inject mode is active, the next prompt reuses this instead of spawning
   * a fresh PTY session.
   */
  private lastInteractiveContext?: InteractiveInjectContext;
  private readonly persistedSessionIds = new WeakMap<
    CliExecutionSession,
    string
  >();
  /** Serializes complete turn writes for the PTY owned by this runner. */
  private readonly turnWriteMutex = new AsyncMutex();

  constructor(private readonly deps: CliExecutionRunnerDeps) {}

  async executeInteractive(
    session: CliExecutionSession,
    baseArgs: string[],
    resolvedCommand?: CliResolvedCommand
  ): Promise<boolean> {
    const result = await this.executeInTerminal(
      baseArgs,
      session,
      resolvedCommand
    );
    await this.persistResolvedSessionId(session, result.sessionId);

    if (
      result.success &&
      !session.effectiveSessionId &&
      this.deps.provider.extractSessionIdFromLogs
    ) {
      const logSessionId = await this.deps.provider.extractSessionIdFromLogs(
        session.promptForSessionLog,
        session.executionStartTime,
        this.deps.runtimeState.getWorkspaceRoot()
      );
      if (logSessionId) {
        await this.persistResolvedSessionId(session, logSessionId);
        Log.debug(
          `[CliExecutionRunner] Session ID from logs (interactive): ${logSessionId}`
        );
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
        "[CliExecutionRunner] Inject mode: no previous interactive context — PTY may not be running"
      );
      return { injected: false };
    }

    const startTime = new Date();

    const written = await this.writeTurnToLivePty(session.promptArgument);
    if (!written) {
      return { injected: false };
    }

    this.deps.transportCoordinator.updateCurrentPtySessionMetadata?.(
      session.workflowContext
    );

    Log.info(
      `[CliExecutionRunner] Injected prompt into existing PTY session (${session.promptArgument.length} chars)`
    );

    try {
      await this.persistResolvedSessionId(
        session,
        this.lastInteractiveContext.sessionId ?? undefined
      );
      const result = await this.monitorLogFile(
        this.lastInteractiveContext.logPath,
        session,
        {
          sessionId: this.lastInteractiveContext.sessionId,
          startTime,
        }
      );

      await this.persistResolvedSessionId(
        session,
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

  /**
   * Write a complete prompt turn to the currently active interactive PTY.
   *
   * The mutex covers the complete focus, prompt, submit, and termination-check
   * sequence so concurrent callers cannot interleave input chunks.
   */
  async writeTurnToLivePty(text: string): Promise<boolean> {
    await this.turnWriteMutex.acquire();
    try {
      // Some TUIs (Copilot CLI confirmed) use focus tracking and only activate their
      // keyboard input handler after receiving the "focus-in" VT sequence (ESC [ I = \x1b[I).
      // Without it, the text and Enter are silently ignored even though the PTY write succeeds.
      // Prepending \x1b[I tells the TUI it has focus, enabling input acceptance.
      // TUIs that don't use focus tracking (Claude CLI) safely ignore the sequence.
      // "\r" (CR, 0x0D) is the submit key — same byte xterm.js sends when Enter is pressed.
      // "\n" (LF) acts as a newline in multi-line input boxes, NOT submit.
      // Send focus-in twice, then stream the prompt in smaller chunks so an idling
      // TUI has multiple chances to attach its input handler before the full prompt
      // arrives. Finally, send Enter twice because duplicate submits are benign
      // while an occasional dropped submit is not.
      const focusIn = "\x1b[I";
      const submit = "\r";
      const promptChunks = this.chunkInjectPrompt(
        text,
        CliExecutionRunner.INJECT_PROMPT_CHUNK_SIZE
      );
      Log.trace(
        `[inject] writing focus-in pulses, ${promptChunks.length} prompt chunk(s), then submit pulses to PTY: ${JSON.stringify([focusIn, ...promptChunks, submit, submit])} hex=${Buffer.from(focusIn.repeat(CliExecutionRunner.INJECT_FOCUS_PULSE_COUNT) + text + submit.repeat(CliExecutionRunner.INJECT_SUBMIT_PULSE_COUNT)).toString("hex")}`
      );

      for (
        let pulse = 0;
        pulse < CliExecutionRunner.INJECT_FOCUS_PULSE_COUNT;
        pulse += 1
      ) {
        const focused =
          this.deps.transportCoordinator.writeToCurrentPtySession(focusIn);
        if (!focused) {
          Log.warn(
            "[CliExecutionRunner] Inject mode: PTY session not active — TUI may have exited"
          );
          return false;
        }
        await this.delay(CliExecutionRunner.INJECT_FOCUS_SETTLE_DELAY_MS);
      }

      for (const chunk of promptChunks) {
        const promptWritten =
          this.deps.transportCoordinator.writeToCurrentPtySession(chunk);
        if (!promptWritten) {
          Log.warn(
            "[CliExecutionRunner] Inject mode: PTY session not active — TUI may have exited"
          );
          return false;
        }
        await this.delay(CliExecutionRunner.INJECT_CHUNK_DELAY_MS);
      }

      await this.delay(CliExecutionRunner.INJECT_PRE_SUBMIT_DELAY_MS);

      for (
        let pulse = 0;
        pulse < CliExecutionRunner.INJECT_SUBMIT_PULSE_COUNT;
        pulse += 1
      ) {
        const submitWritten =
          this.deps.transportCoordinator.writeToCurrentPtySession(submit);

        if (!submitWritten) {
          Log.warn(
            "[CliExecutionRunner] Inject mode: PTY session not active — TUI may have exited"
          );
          return false;
        }

        if (pulse < CliExecutionRunner.INJECT_SUBMIT_PULSE_COUNT - 1) {
          await this.delay(CliExecutionRunner.INJECT_SUBMIT_DELAY_MS);
        }
      }

      // Yield to the event loop so any pending PTY exit events from the prior prompt
      // can propagate before we commit to monitoring. Without this yield, writeToCurrentPtySession
      // can return true (currentPtySession is still set) even when the process has already
      // exited but its onExit callback hasn't fired yet. A single await tick is enough —
      // PTY onExit callbacks are macrotasks that fire in the next event loop iteration.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      if (this.deps.failureTracker.getPtyTermination()) {
        Log.warn(
          "[CliExecutionRunner] Inject mode: PTY process exited immediately after write — TUI does not support injection (prompt sent to dead process). Falling back to restart mode."
        );
        return false;
      }

      return true;
    } finally {
      this.turnWriteMutex.release();
    }
  }

  async executeHeadless(
    session: CliExecutionSession,
    baseArgs: string[],
    resolvedCommand?: CliResolvedCommand
  ): Promise<boolean> {
    const source = this.createHeadlessStreamingSource(session);
    const responseCallback = this.buildHeadlessResponseCallback(
      session,
      "",
      source?.logTail
    );
    const {
      runId,
      notifyDir,
      env: headlessEnv,
    } = this.buildHarnessProcessEnv(session);

    const hookMonitor =
      notifyDir && this.deps.hostCallbacks.onNotificationEvent
        ? new HookEventMonitor({
            runId,
            notifyDir,
            onEvent: (event) =>
              this.deps.hostCallbacks.onNotificationEvent!(event),
          })
        : null;
    hookMonitor?.start();

    const executeWithRecovery = async (
      args: string[],
      activeSource: HeadlessStreamingSource | undefined,
      activeCallback: (result: {
        stdout: string;
        stderr: string;
        exitCode: number;
        headlessLogTail?: HeadlessLogTail;
      }) => Promise<boolean>,
      command?: CliResolvedCommand
    ): Promise<boolean> => {
      try {
        return await this.deps.transportCoordinator.executeHeadless(
          args,
          session.promptArgument,
          session.tempFilePaths,
          activeCallback,
          headlessEnv,
          activeSource,
          command,
          session.resolvedProperties?.secrets
        );
      } catch (error) {
        if (this.deps.provider.isRecoverableSessionError?.(error) ?? false) {
          const currentHarness =
            session.resolvedProperties?.harness ??
            this.deps.provider.config.harnessId;

          if (currentHarness === HARNESS_IDS.CLAUDE_CLI) {
            Log.warn(
              `[CliExecutionRunner] Claude CLI rejected session ID "${session.resolvedSessionId}". ` +
                `Retrying without resume flag.`
            );

            const argsWithoutResume = await this.deps.provider.buildCliArgs(
              session.prompt,
              false,
              this.deps.runtimeState.getExtensionPath(),
              this.deps.runtimeState.getWorkspaceRoot() || "",
              undefined,
              session.workflowContext,
              this.deps.runtimeState.getWorkspaceRoots?.(),
              this.deps.runtimeState.getApprovedExternalRoots?.()
            );

            const retryCallback = this.buildHeadlessResponseCallback(
              session,
              " (retry)",
              undefined
            );

            const retrySource = this.createHeadlessStreamingSource(session);

            return await this.deps.transportCoordinator.executeHeadless(
              argsWithoutResume,
              session.promptArgument,
              session.tempFilePaths,
              retryCallback,
              headlessEnv,
              retrySource,
              undefined,
              session.resolvedProperties?.secrets
            );
          }
        }

        throw error;
      }
    };

    try {
      const success = await executeWithRecovery(
        baseArgs,
        source,
        responseCallback,
        resolvedCommand
      );
      hookMonitor?.stop();
      if (!success && this.deps.runtimeState.isCancelling()) {
        this.deps.runtimeState.setFailureReason("Stopped by user");
      }
      return success;
    } catch (error) {
      hookMonitor?.stop();
      if (
        error instanceof CliTransportError &&
        error.failureKind === FAILURE_KINDS.HARNESS_NOT_INSTALLED
      ) {
        session.updateFailure(error.failureKind, error.message);
        this.deps.runtimeState.setFailureReason(
          this.deps.failureTracker.markHarnessNotInstalled(error.message)
        );
        return false;
      }
      Log.error("[CliExecutionRunner] Headless execution error", error);
      this.deps.runtimeState.setFailureReason(getErrorMessage(error));
      return false;
    }
  }

  /**
   * Environment every harness process gets, whichever transport launches it.
   * Harnesses whose completion hook reads its notification directory from the
   * environment (the OpenCode plugin) cannot signal completion without
   * `CTRLYOKE_NOTIFY_DIR`, so a transport that omits it waits forever.
   */
  private buildHarnessProcessEnv(session: CliExecutionSession): {
    runId: string;
    notifyDir: string | undefined;
    env: Record<string, string>;
  } {
    const runId = crypto.randomUUID();
    const env: Record<string, string> = {
      CTRLYOKE_RUN_ID: runId,
      ...this.buildHookEnvVars(session),
      ...this.buildHookProcessEnv(session),
    };
    const workingFilePath = session.workflowContext?.workingFilePath;
    if (workingFilePath) {
      env[CTRLYOKE_ENV_VARS.WORKING_FILE] = workingFilePath.replace(/\\/g, "/");
    }
    if (ConfigurationUtils.isDiagnosticLogsEnabled()) {
      env.CTRLYOKE_DIAGNOSTIC_LOGS = "true";
    }
    const workspaceRoot = this.deps.runtimeState.getWorkspaceRoot();
    const notifyDir =
      workspaceRoot && this.deps.provider.notificationMonitor
        ? this.deps.provider.notificationMonitor.getNotificationDirectory(
            workspaceRoot
          )
        : undefined;
    if (notifyDir) {
      env.CTRLYOKE_NOTIFY_DIR = notifyDir;
    }
    return { runId, notifyDir, env };
  }

  private buildHookEnvVars(
    session: CliExecutionSession
  ): Record<string, string> {
    const settings = configService.getAll().notifications;
    const hookEvents = settings.events.hookEvents;
    const enabledEvents = Object.entries(hookEvents)
      .filter(([, enabled]) => enabled)
      .map(([event]) => event);

    const ctx = session.workflowContext;
    const env: Record<string, string> = {};
    if (enabledEvents.length > 0) {
      env.CTRLYOKE_NOTIFY_HOOK_EVENTS = enabledEvents.join(",");
    }

    if (ctx?.instanceId) {
      env.CTRLYOKE_WORKFLOW_ID = ctx.instanceId;
    }
    if (ctx?.workflowName) {
      env.CTRLYOKE_WORKFLOW_NAME = ctx.workflowName;
    }
    if (ctx !== undefined) {
      env.CTRLYOKE_PROMPT_INDEX = String(ctx.promptIndex);
      const promptName = ctx.allPrompts[ctx.promptIndex]?.name;
      if (promptName) {
        env.CTRLYOKE_PROMPT_NAME = promptName;
      }
      const parallelGroupId = ctx.workflowFile?.parallelGroups?.find(
        (group) =>
          ctx.promptIndex >= group.startIndex &&
          ctx.promptIndex <= group.endIndex
      )?.id;
      if (parallelGroupId) {
        env.CTRLYOKE_PARALLEL_GROUP_ID = parallelGroupId;
      }
    }
    const workspaceRoot = this.deps.runtimeState.getWorkspaceRoot();
    if (workspaceRoot) {
      env.CTRLYOKE_WORKSPACE_ROOT = workspaceRoot;
    }
    const harnessId = this.deps.provider.config.harnessId;
    if (harnessId) {
      env.CTRLYOKE_HARNESS_ID = harnessId;
    }
    return env;
  }

  private buildHookProcessEnv(
    session: CliExecutionSession
  ): Record<string, string> {
    return Object.fromEntries(
      (session.resolvedProperties?.hooks ?? []).flatMap((hook) =>
        Object.entries(hook.env ?? {})
      )
    );
  }

  /**
   * Run one interactive turn. The two hosts differ only in how the harness TUI
   * is launched: VS Code spawns it in an embedded PTY, the standalone CLI hands
   * it the user's own terminal. Everything after the spawn (session-log
   * discovery, session-ID persistence, and `CliLogMonitor`, which owns
   * completion, the streamed events, the response and usage) is shared, so a
   * CLI-run interactive step records the same attempt the dashboard does.
   */
  private async executeInTerminal(
    args: string[],
    session: CliExecutionSession,
    resolvedCommand?: CliResolvedCommand
  ): Promise<{ success: boolean; sessionId?: string }> {
    const usesInheritedStdio =
      this.deps.runtimeState.interactiveTerminal ===
      INTERACTIVE_TERMINAL_MODES.INHERIT_STDIO;

    // Hoisted so the `finally` block below can always stop it — an exception
    // thrown between start() and the previous inline stop() calls (e.g. from
    // startInteractiveProcess or resolveSession) used to leak this interval
    // forever, since the catch block never reached hookMonitor.stop().
    let hookMonitor: HookEventMonitor | null = null;
    let standaloneProcess: StandaloneInteractiveProcess | undefined;

    try {
      if (!this.deps.provider.logParser) {
        Log.error(
          "[CliExecutionRunner] Harness does not support log file monitoring"
        );
        return { success: false };
      }

      const startTime = new Date();
      Log.trace(
        `[CliExecutionRunner] Recording start time: ${startTime.toISOString()}`
      );

      this.removeStaleStopNotification(session);

      const {
        runId,
        notifyDir,
        env: terminalEnv,
      } = this.buildHarnessProcessEnv(session);

      hookMonitor =
        notifyDir && this.deps.hostCallbacks.onNotificationEvent
          ? new HookEventMonitor({
              runId,
              notifyDir,
              onEvent: (event) =>
                this.deps.hostCallbacks.onNotificationEvent!(event),
            })
          : null;
      hookMonitor?.start();

      if (usesInheritedStdio) {
        standaloneProcess =
          await this.deps.transportCoordinator.startStandaloneInteractiveProcess(
            args,
            session.promptArgument,
            terminalEnv,
            resolvedCommand,
            session.resolvedProperties?.secrets
          );
        // The VS Code PTY reports its exit through CliIntegration's
        // `onPtyExit`; an inherited process reports it here. Either way the
        // failure tracker is what stops discovery and log monitoring when the
        // TUI ends before signalling completion. A kill ctrlyoke requested is
        // a teardown, not an exit to react to.
        void standaloneProcess.exit.then((exit) => {
          if (!exit.terminatedByManager) {
            this.deps.failureTracker.capturePtyExit(exit.exitCode ?? -1, []);
          }
        });
      } else {
        await this.deps.transportCoordinator.startInteractiveProcess(
          args,
          session.promptArgument,
          session.workflowContext,
          terminalEnv,
          resolvedCommand
        );
      }

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

      // Capture context for potential inject-mode follow-up prompts. A
      // standalone TUI is ended after every turn, so it leaves nothing to
      // inject into.
      const injectContext: InteractiveInjectContext | undefined =
        usesInheritedStdio
          ? undefined
          : {
              logPath: discovery.logPath,
              sessionId: discovery.sessionId,
              spawnedWith: session.resolvedProperties,
              spawnedWithSessionId: session.resolvedSessionId,
            };
      this.lastInteractiveContext = injectContext;

      await this.persistResolvedSessionId(
        session,
        discovery.sessionId ?? undefined
      );

      const result = await this.monitorLogFile(discovery.logPath, session, {
        sessionId: discovery.sessionId,
        startTime,
      });

      // Keep the inject context in sync with the latest session ID in case
      // the log monitor extracted a new one during this run.
      if (injectContext && result.sessionId) {
        injectContext.sessionId = result.sessionId;
      }

      return result;
    } catch (error) {
      Log.error("[CliExecutionRunner] Interactive execution error", error);
      this.deps.runtimeState.setFailureReason(getErrorMessage(error));
      if (usesInheritedStdio) {
        return { success: false };
      }
      throw error;
    } finally {
      hookMonitor?.stop();
      if (standaloneProcess) {
        // The stop hook ends the turn, not the TUI. End it here and wait, so
        // the terminal is the CLI's again before the next step writes to it.
        this.reportStandaloneLaunchFailure(
          session,
          standaloneProcess.command,
          await standaloneProcess.terminate()
        );
      }
      await this.deps.factories.cleanupTempFiles(session.tempFilePaths);
    }
  }

  /**
   * A harness that could not be launched at all (spawn `ENOENT`) reaches
   * discovery as a bare process exit. Name the real cause instead, as headless
   * execution does.
   */
  private reportStandaloneLaunchFailure(
    session: CliExecutionSession,
    command: string,
    exit: InteractiveExitResult
  ): void {
    if (exit.error === undefined || exit.terminatedByManager) {
      return;
    }
    const message = `${command} could not be started: ${exit.error}`;
    session.updateFailure(FAILURE_KINDS.HARNESS_NOT_INSTALLED, message);
    this.deps.runtimeState.setFailureReason(
      this.deps.failureTracker.markHarnessNotInstalled(message)
    );
  }

  /**
   * A resumed session's previous stop notification would otherwise read as
   * this turn's completion as soon as monitoring starts.
   */
  private removeStaleStopNotification(session: CliExecutionSession): void {
    if (!session.resolvedSessionId || !this.deps.provider.notificationMonitor) {
      return;
    }
    const workspaceRoot = this.deps.runtimeState.getWorkspaceRoot();
    if (!workspaceRoot) {
      return;
    }
    const staleStopFile = path.join(
      this.deps.provider.notificationMonitor.getNotificationDirectory(
        workspaceRoot
      ),
      `${session.resolvedSessionId}-stop.json`
    );
    if (!fs.existsSync(staleStopFile)) {
      return;
    }
    try {
      fs.unlinkSync(staleStopFile);
      Log.trace(
        `[CliExecutionRunner] Cleaned up stale stop notification for session ${session.resolvedSessionId.substring(0, 8)}`
      );
    } catch {
      // Ignore cleanup failures for stale stop files.
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
      params.startTime,
      session.resolvedProperties?.model ?? "",
      session.promptArgument
    );

    if (result.parsedOutput) {
      session.updateParsedOutput(result.parsedOutput);
    }
    if (result.cliResult) {
      session.updateResult(result.cliResult);
    }
    if (result.failureKind || result.failureMessage) {
      session.updateFailure(result.failureKind, result.failureMessage);
    }

    await this.persistResolvedSessionId(session, result.sessionId);

    if (result.failureKind === FAILURE_KINDS.PROCESS_EXIT) {
      const exitCode = result.processExited?.exitCode ?? -1;
      this.deps.runtimeState.setFailureReason(
        this.deps.failureTracker.markProcessExit(
          exitCode,
          result.failureMessage ??
            `CLI process exited unexpectedly (exit code ${exitCode})`
        )
      );
    } else if (result.failureKind === FAILURE_KINDS.HARNESS_ERROR) {
      this.deps.runtimeState.setFailureReason(
        this.deps.failureTracker.markHarnessError(
          result.failureMessage ?? "Harness reported an error"
        )
      );
    } else if (result.failureKind === FAILURE_KINDS.TIMEOUT) {
      this.deps.runtimeState.setFailureReason(
        this.deps.failureTracker.markTimeout(
          result.failureMessage ?? "Log monitoring timeout"
        )
      );
    } else if (result.failureKind === FAILURE_KINDS.UNKNOWN) {
      this.deps.runtimeState.setFailureReason(
        this.deps.failureTracker.markUnknownFailure(
          result.failureMessage ?? "CLI execution failed"
        )
      );
    }

    return { success: result.success, sessionId: result.sessionId };
  }

  private buildHeadlessResponseCallback(
    session: CliExecutionSession,
    label: string = "",
    headlessLogTail?: HeadlessLogTail
  ): (result: HeadlessProcessResult) => Promise<boolean> {
    const responseCollector = this.deps.factories.createResponseCollector();

    return async (result) => {
      if (ConfigurationUtils.shouldLogRawCliOutput()) {
        Log.trace(
          `[${this.deps.provider.config.displayName} FINAL STDOUT${label}]:\n${result.stdout}`
        );
        if (result.stderr) {
          Log.trace(
            `[${this.deps.provider.config.displayName} FINAL STDERR${label}]:\n${result.stderr}`
          );
        }
      }

      const collected = await responseCollector.collectHeadlessResponse({
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        terminationSignal: result.terminationSignal,
        promptForSessionLog: session.promptForSessionLog,
        executionStartTime: session.executionStartTime,
        resolvedSessionId: session.resolvedSessionId,
        label,
        model: session.resolvedProperties?.model ?? "",
        workspaceRoot: this.deps.runtimeState.getWorkspaceRoot(),
        headlessLogTail: result.headlessLogTail ?? headlessLogTail,
      });

      session.recordHeadlessResponse(collected);
      await this.persistResolvedSessionId(
        session,
        collected.extractedSessionId ??
          collected.parsedOutput?.metadata.sessionId
      );
      if (!collected.success) {
        if (collected.failureKind === FAILURE_KINDS.PROCESS_EXIT) {
          this.deps.runtimeState.setFailureReason(
            this.deps.failureTracker.markProcessExit(
              result.exitCode,
              collected.failureMessage ||
                collected.cliResult.error ||
                `Process exited with code ${result.exitCode}`
            )
          );
        } else if (collected.failureKind === FAILURE_KINDS.HARNESS_ERROR) {
          this.deps.runtimeState.setFailureReason(
            this.deps.failureTracker.markHarnessError(
              collected.failureMessage ||
                collected.cliResult.error ||
                "Harness reported an error"
            )
          );
        } else if (collected.failureKind === FAILURE_KINDS.TIMEOUT) {
          this.deps.runtimeState.setFailureReason(
            this.deps.failureTracker.markTimeout(
              collected.failureMessage ||
                collected.cliResult.error ||
                "Headless CLI execution timed out"
            )
          );
        } else if (collected.failureKind === FAILURE_KINDS.USER_CANCELLED) {
          this.deps.runtimeState.setFailureReason(
            this.deps.failureTracker.markUserCancelled(
              collected.failureMessage ||
                collected.cliResult.error ||
                "Harness process was terminated"
            )
          );
        } else if (collected.failureKind === FAILURE_KINDS.UNKNOWN) {
          this.deps.runtimeState.setFailureReason(
            this.deps.failureTracker.markUnknownFailure(
              collected.failureMessage ||
                collected.cliResult.error ||
                "Headless CLI execution failed"
            )
          );
        } else if (result.exitCode !== 0) {
          this.deps.runtimeState.setFailureReason(
            this.deps.failureTracker.markProcessExit(
              result.exitCode,
              collected.failureMessage ||
                collected.cliResult.error ||
                `Process exited with code ${result.exitCode}`
            )
          );
        } else {
          this.deps.runtimeState.setFailureReason(
            this.deps.failureTracker.markUnknownFailure(
              collected.failureMessage ||
                collected.cliResult.error ||
                "Headless CLI execution failed"
            )
          );
        }
      }
      return collected.success;
    };
  }

  private createHeadlessStreamingSource(
    session: CliExecutionSession
  ): HeadlessStreamingSource | undefined {
    const parser = this.deps.provider.logParser;
    const mode = resolveHeadlessSourceMode(this.deps.provider);
    if (!parser || !mode) {
      return undefined;
    }

    const model = session.resolvedProperties?.model ?? "";
    if (
      mode === HEADLESS_SOURCE_MODES.STDOUT &&
      this.deps.provider.parseHeadlessStdout
    ) {
      return {
        parser,
        mode,
        parseStdout: this.deps.provider.parseHeadlessStdout.bind(
          this.deps.provider
        ),
        model,
      };
    }

    if (mode === HEADLESS_SOURCE_MODES.LOG) {
      return {
        parser,
        mode,
        model,
        logTail: new HeadlessLogTail({
          parser,
          promptText: session.promptForSessionLog,
          startTime: session.executionStartTime,
          resolvedSessionId: session.resolvedSessionId,
          workspaceRoot: this.deps.runtimeState.getWorkspaceRoot(),
          model,
          extractSessionIdFromStdout:
            this.deps.provider.extractSessionIdFromStdout?.bind(
              this.deps.provider
            ),
          onStdoutChunkObserved: this.deps.provider.observeHeadlessStdout?.bind(
            this.deps.provider
          ),
          onStdoutEnded: this.deps.provider.finishHeadlessStdout?.bind(
            this.deps.provider
          ),
          extractSessionIdFromLogs:
            this.deps.provider.extractSessionIdFromLogs?.bind(
              this.deps.provider
            ),
          onStreamingEvents: this.deps.hostCallbacks.onStreamingEvents,
          onContextWindowUpdate: this.deps.hostCallbacks.onContextWindowUpdate,
        }),
      };
    }

    return undefined;
  }

  private chunkInjectPrompt(prompt: string, chunkSize: number): string[] {
    if (prompt.length <= chunkSize) {
      return [prompt];
    }

    const chunks: string[] = [];
    for (let index = 0; index < prompt.length; index += chunkSize) {
      chunks.push(prompt.slice(index, index + chunkSize));
    }
    return chunks;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private async persistResolvedSessionId(
    session: CliExecutionSession,
    sessionId: string | undefined
  ): Promise<void> {
    if (!sessionId) {
      return;
    }

    session.setExtractedSessionId(sessionId);
    if (this.persistedSessionIds.get(session) === sessionId) {
      return;
    }

    const context = session.workflowContext;
    const persistence = context?.workingFilePersistence;
    if (context && persistence?.persistSessionId) {
      try {
        await persistence.persistSessionId(context.promptIndex, sessionId);
        Log.debug(
          `[CliExecutionRunner] Persisted live session ID: ${sessionId}`
        );
      } catch (error) {
        Log.warn(
          `[CliExecutionRunner] Failed to persist live session ID ${sessionId}:`,
          error
        );
        return;
      }
    }
    this.persistedSessionIds.set(session, sessionId);
  }
}
