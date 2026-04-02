import type * as vscode from "vscode";
import type { CliEvent } from "../../../types/CliOutputTypes";
import { MESSAGE_TYPES } from "../../../types/DashboardConstants";
import type { WorkflowContext } from "../../../types/WorkflowContextTypes";
import type { CliProcessManager } from "../../../utils/CliProcessManager";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import { Log } from "../../../utils/Log";
import { CliProviderUtils } from "./CliProviderUtils";
import type { ICliProvider } from "./interfaces/ICliProvider";
import {
  getPtyProcessManager,
  ptyPostMessage,
  resolveWindowsShell,
} from "../PtyProcessManager";
import type { PtyProcessManager, PtySession } from "../PtyProcessManager";

interface CliTransportCoordinatorCommandInfo {
  promptArgument: string;
  cliCommand: string;
}

interface CliTransportCoordinatorRuntimeState {
  getWorkspaceRoot: () => string | undefined;
  getTerminalName: () => string;
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
  runtimeState: CliTransportCoordinatorRuntimeState;
  hostCallbacks: CliTransportCoordinatorHostCallbacks;
  getPtyManager?: () => PtyProcessManager | null;
  postTerminalMessage?: (message: unknown) => void;
}

export class CliTransportCoordinator {
  private currentExecution?: vscode.TerminalShellExecution;
  private currentPtySession?: PtySession;

  constructor(private readonly deps: CliTransportCoordinatorDeps) {}

  async executeStandaloneInteractiveProcess(
    args: string[],
    promptArgument: string,
    tempFilePaths: string[],
    resolvedSessionId?: string
  ): Promise<{ success: boolean; sessionId?: string }> {
    try {
      const tuiCommand = this.deps.provider.buildInteractiveTuiCommand(
        args,
        promptArgument
      );
      const commandStr = String(tuiCommand).replace(/\s+/g, " ").trim();

      this.deps.hostCallbacks.onCommandPrepared({
        promptArgument,
        cliCommand: commandStr,
      });

      const startTime = new Date();
      const workingDir = this.deps.runtimeState.getWorkspaceRoot() || process.cwd();
      const interactiveEnv =
        this.deps.provider.getInteractiveSpawnEnv?.() ??
        CliProviderUtils.buildProcessEnv();

      let processExited = false;
      let hookSessionId: string | undefined;

      const spawnPromise = this.deps.processManager
        .spawnInteractive(commandStr, workingDir, interactiveEnv)
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
    tempFilePaths: string[],
    workflowContext?: WorkflowContext,
    env?: Record<string, string>
  ): Promise<void> {
    const tuiCommand = this.deps.provider.buildInteractiveTuiCommand(
      args,
      promptArgument
    );
    const commandStr = String(tuiCommand).replace(/\s+/g, " ").trim();

    this.deps.hostCallbacks.onBeforeInteractiveStart(workflowContext);
    this.deps.hostCallbacks.onCommandPrepared({
      promptArgument,
      cliCommand: commandStr,
    });

    const ptyManager = this.deps.getPtyManager?.() ?? getPtyProcessManager();
    if (ptyManager) {
      const postMessage = this.deps.postTerminalMessage ?? ptyPostMessage;
      const workflowId =
        workflowContext?.instanceId ??
        workflowContext?.filePath ??
        this.deps.runtimeState.getWorkflowName?.() ??
        "unknown";
      const stepName = workflowContext
        ? (workflowContext.allPrompts[workflowContext.promptIndex]?.name ??
          `Step ${workflowContext.promptIndex + 1}`)
        : "interactive";
      const shell =
        process.platform === "win32"
          ? resolveWindowsShell()
          : (process.env.SHELL ?? "/bin/bash");
      const shellArgs =
        process.platform === "win32"
          ? ["-NoProfile", "-Command", String(tuiCommand)]
          : ["-c", String(tuiCommand)];
      const cwd = this.deps.runtimeState.getWorkspaceRoot() ?? process.cwd();
      const mergedEnv = env ? { ...process.env, ...env } : process.env;
      const promptNumber = workflowContext
        ? workflowContext.promptIndex + 1
        : undefined;
      const preSessionId = `ai-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      postMessage({
        type: MESSAGE_TYPES.TERMINAL_STARTED,
        workflowId,
        sessionId: preSessionId,
        stepName,
        kind: "ai-cli",
        promptNumber,
      });

      const session = ptyManager.spawnPty({
        workflowId,
        stepName,
        kind: "ai-cli",
        promptNumber,
        sessionId: preSessionId,
        command: shell,
        args: shellArgs,
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

      this.currentPtySession = session;
      Log.info(
        `🖥️ PTY session spawned: "${stepName}" (${session.id.slice(0, 8)}) workflowId=inst:${workflowId.slice(0, 8)}`
      );
      return;
    }

    const terminal = await this.createFreshTerminal(env);
    Log.info(`🖥️ Opened terminal: "${this.deps.runtimeState.getTerminalName()}"`);
    if (tempFilePaths.length > 0) {
      Log.debug(
        `📁 Interactive mode using ${tempFilePaths.length} temp file(s)`
      );
    }
    terminal.show();

    this.deps.hostCallbacks.onStreamingChunk(
      "📺 Interactive mode: Output is streaming to the VS Code terminal.\n" +
        "   View the terminal for real-time output.\n\n"
    );

    const shellIntegration =
      await this.deps.processManager.waitForShellIntegration(terminal);
    this.currentExecution = shellIntegration.executeCommand(tuiCommand);
  }

  async executeHeadless(
    args: string[],
    promptArgument: string,
    tempFilePaths: string[],
    executeCallback: (result: {
      stdout: string;
      stderr: string;
      exitCode: number;
    }) => Promise<boolean>
  ): Promise<boolean> {
    try {
      if (tempFilePaths.length > 0) {
        Log.info(
          `🚀 Starting headless mode with ${tempFilePaths.length} file(s)`
        );
      } else {
        Log.info("🚀 Starting headless mode with direct prompt (fast path)");
      }

      const shellSafePrompt = promptArgument.replace(/[\r\n]+/g, " ");
      const headlessArgs = this.deps.provider.buildHeadlessArgs(
        args,
        shellSafePrompt
      );
      const displayCommand = `${this.deps.provider.config.name} ${headlessArgs.join(" ")}`;

      this.deps.hostCallbacks.onCommandPrepared({
        promptArgument,
        cliCommand: displayCommand,
      });

      const shouldStream = this.deps.provider.config.shouldStreamHeadlessOutput;
      const streamState = new Map<string, any>();
      const result = await this.spawnProcess(
        this.deps.provider.config.name,
        headlessArgs,
        {
          timeout: ConfigurationUtils.getMaxPromptExecutionTimeMs(),
          onStdout: shouldStream
            ? (chunk) => {
                if (ConfigurationUtils.shouldLogRawCliOutput()) {
                  Log.debug(
                    `[${this.deps.provider.config.displayName} RAW OUTPUT]: ${chunk}`
                  );
                }

                if (this.deps.provider.responseParser.processStreamingChunk) {
                  const processedChunk =
                    this.deps.provider.responseParser.processStreamingChunk(
                      chunk,
                      streamState
                    );
                  if (processedChunk !== undefined) {
                    if (Array.isArray(processedChunk)) {
                      this.deps.hostCallbacks.onStreamingEvents(processedChunk);
                    } else {
                      this.deps.hostCallbacks.onStreamingChunk(processedChunk);
                    }
                  }
                } else {
                  this.deps.hostCallbacks.onStreamingChunk(chunk);
                }
              }
            : undefined,
        }
      );

      if (this.deps.runtimeState.isCancelling()) {
        Log.info("⏹️ Prompt execution cancelled by user");
        return false;
      }

      return await executeCallback(result);
    } catch (error) {
      Log.error("❌ Headless execution error", error);
      return false;
    } finally {
      await this.deps.hostCallbacks.cleanupTempFiles(tempFilePaths);
    }
  }

  closeTerminal(): void {
    this.deps.processManager.disposeTerminal();
    this.currentExecution = undefined;
  }

  async cancel(): Promise<boolean> {
    if (this.currentPtySession) {
      const ptyManager = this.deps.getPtyManager?.() ?? getPtyProcessManager();
      if (ptyManager) {
        ptyManager.killSession(this.currentPtySession.id);
      }
      this.currentPtySession = undefined;
    }

    const hasActiveProcess =
      !!this.currentExecution || this.deps.processManager.isActive();
    if (!hasActiveProcess) {
      return false;
    }

    await this.deps.processManager.cancel(this.currentExecution);
    this.currentExecution = undefined;
    return true;
  }

  dispose(closeTerminalWhenPromptCompletes: boolean): void {
    if (closeTerminalWhenPromptCompletes) {
      this.deps.processManager.dispose();
    } else {
      this.deps.processManager.disposeProcess();
    }
    this.currentExecution = undefined;
    this.currentPtySession = undefined;
  }

  private async createFreshTerminal(
    env?: Record<string, string>
  ): Promise<vscode.Terminal> {
    this.disposeTerminalIfExists();
    return await this.deps.processManager.createTerminal(
      this.deps.runtimeState.getTerminalName(),
      this.deps.runtimeState.getWorkspaceRoot(),
      env
    );
  }

  private disposeTerminalIfExists(): void {
    const hasTerminal = !!this.deps.processManager.getTerminal();
    if (hasTerminal) {
      Log.info(
        `🗑️ Closing previous terminal before starting next prompt (was: "${this.deps.runtimeState.getTerminalName()}")`
      );
    } else {
      Log.debug(
        "🗑️ disposeTerminalIfExists: no terminal open, nothing to close"
      );
    }
    this.deps.processManager.disposeTerminal();
    this.currentExecution = undefined;
  }

  private async spawnProcess(
    command: string,
    args: string[],
    options: {
      timeout?: number;
      onStdout?: (chunk: string) => void;
    } = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const shell = process.platform === "win32" ? resolveWindowsShell() : true;
    const env = CliProviderUtils.buildProcessEnv();

    const result = await this.deps.processManager.spawn(command, args, {
      cwd: this.deps.runtimeState.getWorkspaceRoot() || "",
      timeout: options.timeout,
      onStdout: options.onStdout,
      shell,
      env,
    });

    Log.info("✅ Process exited - execution complete");
    return result;
  }
}
