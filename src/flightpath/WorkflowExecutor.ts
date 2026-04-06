import * as path from "path";
import { PlatformAdapter } from "../platform/PlatformAdapter";
import {
  PromptStep,
  ScriptStep,
  WorkflowStep,
  isScriptStep,
  McpServerConfig,
  DynamicQueueConfig,
  FinalPromptRuntimeState,
  EXECUTION_STATES,
  Harness,
  type WorkflowAttemptTarget,
} from "../types/FlightPathTypes";
import type { FlightPathMcpServerProvider } from "../ui/FlightPathMcpServerProvider";
import { WorkflowContext } from "../types/WorkflowContextTypes";
import {
  STEP_STATUS,
  STATUS_MESSAGE_SEVERITY,
  FINAL_PROMPT_PHASES,
} from "../types/DashboardConstants";
import { PromptQueue } from "./PromptQueue";
import { HarnessIntegration } from "./HarnessIntegration";
import {
  EndConditionHandler,
  SendRetryPromptCallback,
} from "./EndConditionHandler";
import { EndConditionEvaluator } from "./EndConditionEvaluator";
import { Log } from "../utils/Log";
import { PropertyResolver } from "../utils/PropertyResolver";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { VarSubstitutor } from "../utils/VarSubstitutor";
import {
  CliOutputFormatter,
  DashboardOutput,
} from "./harness/shared/CliOutputFormatter";
import { OutputHistoryManager } from "./orchestration/OutputHistoryManager";
import { CliEvent } from "../types/WebviewMessageTypes";
import {
  WorkspaceSnapshotService,
  RawWorkspaceState,
} from "../utils/WorkspaceSnapshotService";
import {
  WorkspaceSnapshot,
  OutputExecutionTarget,
} from "../types/OutputHistoryTypes";
import type { IDashboardSink } from "../types/IDashboardSink";

export interface WorkflowExecutionContext {
  workspaceFolderPath: string | undefined;
  currentPromptFilePath: string | undefined;
  dashboardProvider?: IDashboardSink;
  shouldShowCliCommand: boolean;
  showCliOutput: boolean;
  dynamicQueueConfig: DynamicQueueConfig;
  getIntegrationForPrompt: (
    prompt: PromptStep,
    harnessOverride?: Harness
  ) => HarnessIntegration;
  historyFilePath: string;
  workingFilePath?: string;
  instanceTag?: string;
  /** Workflow instance UUID — used as the PTY workflowId so terminal sessions
   *  are keyed by the same ID the webview uses for activeWorkflowId. */
  instanceId?: string;
  onStatusMessage?: (
    stepIndex: number,
    message: string,
    severity: string
  ) => void;
  outputHistoryManager?: OutputHistoryManager;
  /**
   * Always-on callback to capture the init state for a queue step's output (called even when
   * the workflow is inactive/backgrounded). Used to buffer output for replay when switching
   * back to this workflow instance.
   */
  captureOutputInit?: (
    stepIndex: number,
    prompt: string,
    cliCommand: string | undefined,
    workingDirectory: string | undefined,
    timestampMs: number,
    attemptIndex: number,
    rawTextOutput?: boolean
  ) => void;
  /** Always-on chunk buffer for queue steps — enables output replay on workflow switch. */
  captureChunk?: (stepIndex: number, chunk: string) => void;
  /** Always-on completed-output capture for queue steps — enables replay on workflow switch. */
  captureCompletedOutput?: (stepIndex: number, output: any) => void;
  /** Always-on structured event buffer for queue steps — enables replay on workflow switch. */
  captureEvents?: (stepIndex: number, events: CliEvent[]) => void;
  /** Mirror of captureOutputInit for finalPrompt loops, keyed by loopIndex. */
  captureFinalPromptOutputInit?: (
    loopIndex: number,
    prompt: string,
    cliCommand: string | undefined,
    workingDirectory: string | undefined,
    timestampMs: number,
    attemptIndex: number,
    rawTextOutput?: boolean
  ) => void;
  captureFinalPromptChunk?: (loopIndex: number, chunk: string) => void;
  captureFinalPromptEvents?: (loopIndex: number, events: CliEvent[]) => void;
  captureFinalPromptCompletedOutput?: (loopIndex: number, output: any) => void;
  onFinalPromptStatusMessage?: (
    loopIndex: number,
    message: string,
    severity: string
  ) => void;
  /** WorkspaceSnapshotService instance — shared across the workflow run */
  snapshotService?: WorkspaceSnapshotService;
  /** Callback to emit live snapshot data to the webview after a prompt completes */
  onSnapshotCaptured?: (
    target: ExecutionTarget,
    snapshot: WorkspaceSnapshot
  ) => void;
  /** MCP server provider for injecting user-defined MCP servers into VS Code's MCP subsystem (chat harness only) */
  mcpServerProvider?: FlightPathMcpServerProvider;
}

type ExecutionTarget = WorkflowAttemptTarget;

/**
 * Drives the sequential execution loop for a FlightPath workflow.
 *
 * The outer loop has two phases:
 *   1. **Queue phase** — drains normal prompts via `promptQueue.hasNext()`.
 *   2. **finalPrompt phase** — runs the orchestrator gate once the queue is empty.
 *      If the gate appends new prompts, the outer loop repeats
 *      (queue → finalPrompt → queue → …).
 *
 * Pause/resume is implemented by holding the response promise until
 * `resumePendingResponse()` is called by `WorkflowOrchestrator`.
 */
export class WorkflowExecutor {
  private pendingResponseResolver: ((text: string) => void) | null = null;
  private pendingResponseText: string | null = null;
  private isWaitingForResponse: boolean = false;

  constructor(
    private readonly promptQueue: PromptQueue,
    private readonly endConditionHandler: EndConditionHandler,
    private readonly endConditionEvaluator: EndConditionEvaluator,
    private readonly platform: PlatformAdapter
  ) {}

  private getRuntime() {
    return this.promptQueue.getRuntimeStateMachine();
  }

  /**
   * Execute the workflow. Supports resume from a paused or previously-stopped
   * run — the queue's `currentIndex` and `finalPromptRuntime` phase are both
   * restored from the working file before this is called, so the loop picks up
   * exactly where it left off.
   */
  async execute(
    defaultIntegration: HarnessIntegration,
    context: WorkflowExecutionContext
  ): Promise<void> {
    this.clearPendingState();

    const runtime = this.promptQueue.getRuntimeStateMachine();
    if (runtime.startExecution()) {
      await this.promptQueue.commitRuntimeTransition();
    }
    if (runtime.startExecutionTimer()) {
      await this.promptQueue.commitRuntimeTransition({
        persist: false,
        emitStateChange: false,
      });
    }

    await this.showDashboard();

    this.logWorkflowStart(
      context,
      defaultIntegration,
      this.promptQueue.getProgress().total
    );

    let snapshotStrategy: "git" | "filesystem" | undefined;
    if (context.snapshotService && context.workspaceFolderPath) {
      try {
        snapshotStrategy = await context.snapshotService.selectStrategy(
          context.workspaceFolderPath
        );
      } catch {
        // ignore — snapshots unavailable
      }
    }

    const getFinalStep = () => this.promptQueue.getWorkflowFile().finalStep;

    const initialFinalPrompt = getFinalStep();

    if (initialFinalPrompt && !this.promptQueue.getFinalPromptRuntime()) {
      await this.setFinalPromptRuntime(context, {
        phase: FINAL_PROMPT_PHASES.QUEUE,
        loopCount: 0,
      });
    } else if (initialFinalPrompt) {
      const runtime = this.promptQueue.getFinalPromptRuntime();
      context.dashboardProvider?.updateFinalPromptStatus(
        runtime?.status ?? null,
        runtime?.loopCount ?? 0,
        runtime?.phase ?? null
      );
    } else {
      context.dashboardProvider?.updateFinalPromptStatus(null, 0, null);
    }

    let runFinalPromptFirst =
      !!initialFinalPrompt &&
      this.promptQueue.getFinalPromptRuntime()?.phase ===
        FINAL_PROMPT_PHASES.FINAL_PROMPT;

    while (true) {
      if (!runFinalPromptFirst) {
        while (this.promptQueue.hasNext()) {
          const state = this.promptQueue.getState();
          const target: ExecutionTarget = {
            kind: FINAL_PROMPT_PHASES.QUEUE,
            stepIndex: state.currentIndex,
          };
          const prompt = state.steps[state.currentIndex];

          let beforeState: RawWorkspaceState | undefined;
          if (
            context.snapshotService &&
            context.workspaceFolderPath &&
            snapshotStrategy
          ) {
            try {
              beforeState = await context.snapshotService.captureWorkspaceState(
                context.workspaceFolderPath,
                snapshotStrategy
              );
            } catch {
              // ignore
            }
          }

          const shouldContinue = await this.executeSinglePrompt(
            target,
            prompt,
            context
          );

          if (
            beforeState &&
            context.snapshotService &&
            context.workspaceFolderPath &&
            snapshotStrategy
          ) {
            try {
              await this.captureAndEmitSnapshot(
                target,
                beforeState,
                snapshotStrategy,
                context
              );
            } catch (e) {
              Log.warn("Failed to capture workspace snapshot:", e);
            }
          }

          if (!shouldContinue) {
            break;
          }
        }
      }

      runFinalPromptFirst = false;

      const statusAfterQueue = runtime.status;
      if (statusAfterQueue !== EXECUTION_STATES.RUNNING) {
        break;
      }

      const currentFinalPrompt = getFinalStep();
      if (!currentFinalPrompt) {
        break;
      }

      // Initialize runtime if a final prompt was added after execution started
      if (!this.promptQueue.getFinalPromptRuntime()) {
        await this.setFinalPromptRuntime(context, {
          phase: FINAL_PROMPT_PHASES.QUEUE,
          loopCount: 0,
        });
      }

      const finalPromptRuntime = this.promptQueue.getFinalPromptRuntime();
      const loopIndex = finalPromptRuntime?.loopCount ?? 0;
      const queueSizeBefore = this.promptQueue.getState().steps.length;

      await this.setFinalPromptRuntime(context, {
        phase: FINAL_PROMPT_PHASES.FINAL_PROMPT,
        loopCount: loopIndex,
        status: STEP_STATUS.RUNNING,
        startedAt: Date.now(),
      });

      let finalBeforeState: RawWorkspaceState | undefined;
      if (
        context.snapshotService &&
        context.workspaceFolderPath &&
        snapshotStrategy
      ) {
        try {
          finalBeforeState =
            await context.snapshotService.captureWorkspaceState(
              context.workspaceFolderPath,
              snapshotStrategy
            );
        } catch {
          // ignore
        }
      }

      const finalTarget: ExecutionTarget = {
        kind: FINAL_PROMPT_PHASES.FINAL_PROMPT,
        loopIndex,
      };
      const shouldContinue = await this.executeSinglePrompt(
        finalTarget,
        currentFinalPrompt,
        context
      );

      if (
        finalBeforeState &&
        context.snapshotService &&
        context.workspaceFolderPath &&
        snapshotStrategy
      ) {
        try {
          await this.captureAndEmitSnapshot(
            finalTarget,
            finalBeforeState,
            snapshotStrategy,
            context
          );
        } catch (e) {
          Log.warn("Failed to capture workspace snapshot:", e);
        }
      }

      if (!shouldContinue) {
        await this.persistInterruptedFinalPromptRuntime(context);
        break;
      }

      const statusAfterFinal = runtime.status;
      if (statusAfterFinal !== EXECUTION_STATES.RUNNING) {
        await this.persistInterruptedFinalPromptRuntime(context);
        break;
      }

      const queueSizeAfter = this.promptQueue.getState().steps.length;
      if (queueSizeAfter > queueSizeBefore) {
        const hitQueueSizeLimit = await this.checkQueueSizeLimit(
          context.dynamicQueueConfig,
          queueSizeAfter
        );
        if (hitQueueSizeLimit) {
          break;
        }

        await this.setFinalPromptRuntime(context, {
          phase: FINAL_PROMPT_PHASES.QUEUE,
          loopCount: loopIndex + 1,
          status: STEP_STATUS.COMPLETED,
          startedAt:
            this.promptQueue.getFinalPromptRuntime()?.startedAt ?? Date.now(),
          completedAt: Date.now(),
        });

        continue;
      }

      await this.setFinalPromptRuntime(context, {
        phase: FINAL_PROMPT_PHASES.FINAL_PROMPT,
        loopCount: loopIndex,
        status: STEP_STATUS.COMPLETED,
        startedAt: this.promptQueue.getFinalPromptRuntime()?.startedAt,
        completedAt: Date.now(),
      });

      break;
    }

    Log.info("Workflow execution complete");
    await this.finalizeWorkflowExecution();
    this.logWorkflowCompletion(context, this.promptQueue.getProgress().total);
  }

  private async executeSinglePrompt(
    target: ExecutionTarget,
    step: WorkflowStep,
    context: WorkflowExecutionContext
  ): Promise<boolean> {
    const state = this.promptQueue.getState();
    const runtime = this.getRuntime();
    const currentStatus = runtime.status;

    if (currentStatus === EXECUTION_STATES.PAUSED) {
      Log.info("Workflow paused before executing next prompt");
      return false;
    }
    if (
      currentStatus === EXECUTION_STATES.STOPPED ||
      currentStatus === EXECUTION_STATES.CANCELLING
    ) {
      Log.info("Workflow stopped before executing next prompt");
      return false;
    }

    const progress = this.promptQueue.getProgress();
    const guardIndex =
      target.kind === FINAL_PROMPT_PHASES.QUEUE
        ? target.stepIndex
        : state.currentIndex;
    const shouldStopForTime = await this.checkExecutionTimeLimit(
      context.dynamicQueueConfig,
      guardIndex,
      progress.total
    );
    if (shouldStopForTime) {
      return false;
    }

    // Route script steps directly — no AI harness interaction needed
    if (isScriptStep(step)) {
      const stepIndex =
        target.kind === FINAL_PROMPT_PHASES.QUEUE ? target.stepIndex : -1;
      return this.executeScriptStep(step, stepIndex, context, target);
    }

    let prompt: PromptStep = step as PromptStep;
    const workflowFile = this.promptQueue.getWorkflowFile();
    let resolvedProperties = PropertyResolver.resolve(prompt, workflowFile);

    // Apply {{var}} substitution when the workflow has vars defined.
    const vars = workflowFile.vars;
    if (vars && Object.keys(vars).length > 0) {
      resolvedProperties = VarSubstitutor.applyToResolvedProperties(
        resolvedProperties,
        vars
      );
      if (prompt.prompt) {
        // Substitute on a local copy so the working file is not mutated.
        prompt = {
          ...prompt,
          prompt: VarSubstitutor.applyToPromptText(prompt.prompt, vars),
        };
      }
    }

    const integration = context.getIntegrationForPrompt(
      prompt,
      resolvedProperties.harness
    );

    // Inject user-defined MCP servers for Copilot Chat prompts.
    // CLI harnesses handle this via --mcp-config flags in CliProviderUtils.
    const isChatHarness =
      resolvedProperties.harness === Harness.CopilotChat ||
      (!resolvedProperties.harness &&
        integration.getIntegrationMode() === Harness.CopilotChat);
    let didSetMcpServers = false;
    if (isChatHarness && context.mcpServerProvider) {
      const mcpServers = resolvedProperties.mcpServers ?? [];
      const userServers = mcpServers.filter(
        (s): s is McpServerConfig => typeof s === "object"
      );
      if (userServers.length > 0) {
        context.mcpServerProvider.setActiveServers(userServers);
        didSetMcpServers = true;
        Log.debug(
          `🔧 Injected ${userServers.length} user MCP server(s) for chat prompt`
        );
      }
    }

    if (target.kind === FINAL_PROMPT_PHASES.QUEUE) {
      this.updateDashboardForPromptStart(context, prompt, target.stepIndex);
      integration.setWorkflowProgress(target.stepIndex + 1, progress.total);
      Log.info(`Executing prompt ${target.stepIndex + 1}/${progress.total}`);
    } else {
      Log.info(`Executing finalPrompt loop ${target.loopIndex + 1}`);
    }

    const legacyStepIndex = this.getLegacyStepIndex(target);
    const sendPromptIndex =
      target.kind === FINAL_PROMPT_PHASES.QUEUE
        ? target.stepIndex
        : state.steps.length;

    const result = await this.executeWithStreaming(
      prompt,
      integration,
      context,
      target,
      target.kind === FINAL_PROMPT_PHASES.QUEUE ? legacyStepIndex : undefined,
      0,
      {
        promptIndex: sendPromptIndex,
        allPrompts: state.steps,
        filePath: context.currentPromptFilePath,
        workflowName: this.promptQueue.getState().workflowName,
        instanceId: context.instanceId,
        workingFilePath: context.workingFilePath,
        resolvedProperties,
        workflowFile,
        workingFilePersistence: this.promptQueue,
        getFinalPromptResponseTexts: () =>
          this.promptQueue.getFinalPromptResponseTexts(),
        finalPromptSessionId: workflowFile.finalStep?._runtime?.sessionId as
          | string
          | undefined,
      },
      async () => {
        if (target.kind === FINAL_PROMPT_PHASES.QUEUE) {
          await this.promptQueue.markCurrentAsSent();
        }
        this.isWaitingForResponse = true;
      }
    );

    // Clear injected MCP servers after the chat prompt completes (or fails)
    if (didSetMcpServers && context.mcpServerProvider) {
      context.mcpServerProvider.setActiveServers([]);
    }

    if (!result) {
      return this.handlePromptSendFailure(
        integration,
        context,
        target,
        prompt,
        legacyStepIndex,
        0
      );
    }

    const { responseText, duration } = result;

    // Store response text for priorContext injection in subsequent prompts.
    if (target.kind === FINAL_PROMPT_PHASES.QUEUE) {
      // Queue steps: store on _runtime for "all" / "previous" / array-index access
      if (!prompt._runtime) {
        prompt._runtime = { startedAt: Date.now() };
      }
      prompt._runtime.responseText = responseText;
      await this.promptQueue.persistRuntimeMetadata(target.stepIndex, {
        responseText,
      });
    } else {
      // finalPrompt loops: store indexed by loopIndex for "finalPromptAll" / "finalPromptPrevious"
      await this.promptQueue.storeFinalPromptResponseText(
        target.loopIndex,
        responseText
      );
    }

    await this.updateDashboardWithResponse(
      context,
      integration,
      target,
      target.kind === FINAL_PROMPT_PHASES.QUEUE ? legacyStepIndex : undefined,
      prompt,
      responseText,
      duration
    );

    // Use the resolved end condition (handles workflow-level inheritance via PropertyResolver)
    // rather than reading prompt.endCondition directly, which misses workflow-level defaults.
    const resolvedEndCondition = resolvedProperties.endCondition;
    const promptForEval =
      resolvedEndCondition && resolvedEndCondition !== prompt.endCondition
        ? { ...prompt, endCondition: resolvedEndCondition }
        : prompt;

    if (resolvedEndCondition) {
      const shouldContinue = await this.evaluateEndCondition(
        promptForEval,
        integration,
        context,
        target,
        target.kind === FINAL_PROMPT_PHASES.QUEUE ? legacyStepIndex : undefined,
        0,
        duration,
        vars && Object.keys(vars).length > 0 ? vars : undefined
      );

      if (!shouldContinue) {
        Log.info("Workflow stopped due to end condition failure");
        if (runtime.status === EXECUTION_STATES.RUNNING) {
          this.promptQueue.finalizeFailedInFlightPrompt();
          runtime.fail();
          await this.promptQueue.commitRuntimeTransition();
        }
        return false;
      }

      if (
        target.kind === FINAL_PROMPT_PHASES.QUEUE &&
        context.dashboardProvider
      ) {
        context.dashboardProvider.updateStepStatus(legacyStepIndex, {
          state: STEP_STATUS.COMPLETED,
          duration,
        });
      }
    } else {
      runtime.completeAttempt(target, 0);
      if (
        target.kind === FINAL_PROMPT_PHASES.QUEUE &&
        context.dashboardProvider
      ) {
        context.dashboardProvider.updateStepStatus(legacyStepIndex, {
          state: STEP_STATUS.COMPLETED,
          duration,
        });
      }
    }

    if (target.kind === FINAL_PROMPT_PHASES.QUEUE) {
      await this.promptQueue.completeCurrentAndMoveNext();

      if (context.dashboardProvider) {
        const live = this.promptQueue.getProgress();
        context.dashboardProvider.updateProgress(live.current, live.total);
      }

      if (runtime.status === EXECUTION_STATES.PAUSED) {
        Log.info("Workflow paused");
        return false;
      }
    }

    return true;
  }

  /**
   * Execute a script step — runs a shell command with no AI harness interaction.
   *
   * @param step      The ScriptStep to execute
   * @param stepIndex The queue step index (use -1 for finalStep)
   * @param context   Workflow execution context
   * @param target    Execution target for status machine tracking
   * @returns true to continue the workflow, false to stop
   */
  private async executeScriptStep(
    step: ScriptStep,
    stepIndex: number,
    context: WorkflowExecutionContext,
    target: ExecutionTarget
  ): Promise<boolean> {
    const runtime = this.getRuntime();
    const stepLabel = step.name ?? step.script.split(/\s+/)[0];
    Log.info(`Executing script step: ${stepLabel}`);

    // Mark step as running in the dashboard
    if (context.dashboardProvider && stepIndex >= 0) {
      context.dashboardProvider.updateStepStatus(stepIndex, {
        state: STEP_STATUS.RUNNING,
      });
    }

    // Record startedAt on the step's _runtime
    await this.promptQueue.persistRuntimeMetadata(
      stepIndex >= 0 ? stepIndex : this.promptQueue.getState().currentIndex,
      { startedAt: Date.now() }
    );

    // Begin attempt in the state machine
    const attemptIndex = 0;
    runtime.beginAttempt(target, attemptIndex, Date.now());

    // Build a minimal EndCondition to reuse EndConditionEvaluator's script runner
    const timeout =
      step.timeout != null
        ? step.timeout * 1000
        : ConfigurationUtils.getScriptTimeoutMs();

    const evalResult = await this.endConditionEvaluator.evaluateCondition(
      {
        script: step.script,
        returns: "0",
        compareSource: "exitCode",
        timeout: timeout,
      },
      context.workspaceFolderPath,
      this.promptQueue.getWorkflowFile().vars
    );

    const succeeded = evalResult.exitCode === 0;

    // Send script output to the dashboard as a CliOutput with source: "script"
    // so the UI renders it with terminal formatting (whitespace preserved, exit code summary).
    const rawOutput = [evalResult.stdout, evalResult.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();

    // Strip ANSI escape codes — script processes (npm, node, etc.) emit colour codes
    // that are unreadable as literal characters in the output panel.
    const outputText = rawOutput.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");

    const legacyStepIndex = this.getLegacyStepIndex(target);
    const scriptCliOutput = {
      prompt: step.script,
      response: outputText,
      elapsed: evalResult.duration / 1000,
      isStreaming: false,
      source: "script" as const,
      exitCode: evalResult.exitCode ?? (succeeded ? 0 : 1),
      timestampMs: Date.now(),
      cliCommand: step.script,
      workingDirectory: context.workspaceFolderPath,
    };

    if (context.dashboardProvider && legacyStepIndex >= 0) {
      context.dashboardProvider.updateCliOutput(
        legacyStepIndex,
        scriptCliOutput
      );
    }

    // Capture for output history replay (same pattern as updateDashboardWithResponse)
    if (legacyStepIndex >= 0) {
      context.captureCompletedOutput?.(legacyStepIndex, scriptCliOutput);
    }

    if (context.historyFilePath && context.outputHistoryManager) {
      await context.outputHistoryManager
        .saveExecutionOutput(
          context.historyFilePath,
          this.toOutputExecutionTarget(target),
          [scriptCliOutput]
        )
        .catch((err) =>
          Log.warn("Failed to save script step output to history:", err)
        );
    }

    if (evalResult.timeout) {
      await this.trackStatusMessage(
        context,
        target,
        `Script step timed out after ${timeout}ms`,
        STATUS_MESSAGE_SEVERITY.ERROR
      );
    }

    const continueOnFailure = step.continueOnFailure ?? false;
    const shouldContinue = succeeded || continueOnFailure;
    const terminalStatus = succeeded
      ? STEP_STATUS.COMPLETED
      : continueOnFailure
        ? STEP_STATUS.COMPLETED
        : STEP_STATUS.FAILED;

    if (!succeeded && !continueOnFailure) {
      Log.error(
        `Script step failed (exit code ${evalResult.exitCode}): ${stepLabel}`
      );
    } else if (!succeeded && continueOnFailure) {
      Log.warn(
        `Script step failed but continueOnFailure=true, continuing: ${stepLabel}`
      );
    }

    // Complete or fail the attempt in the state machine
    if (shouldContinue) {
      runtime.completeAttempt(target, attemptIndex);
    } else {
      runtime.failAttempt(
        target,
        attemptIndex,
        `Script exited with code ${evalResult.exitCode}`
      );
    }

    // Update dashboard step status
    if (context.dashboardProvider && stepIndex >= 0) {
      context.dashboardProvider.updateStepStatus(stepIndex, {
        state: terminalStatus,
        duration: evalResult.duration / 1000,
      });
    }

    if (target.kind === FINAL_PROMPT_PHASES.QUEUE) {
      if (shouldContinue) {
        await this.promptQueue.completeCurrentAndMoveNext();
        if (context.dashboardProvider) {
          const live = this.promptQueue.getProgress();
          context.dashboardProvider.updateProgress(live.current, live.total);
        }
      } else {
        this.promptQueue.finalizeFailedInFlightPrompt(
          `Script exited with code ${evalResult.exitCode}`
        );
        runtime.fail();
        await this.promptQueue.commitRuntimeTransition();
      }

      if (runtime.status === EXECUTION_STATES.PAUSED) {
        Log.info("Workflow paused after script step");
        return false;
      }
    }

    return shouldContinue;
  }

  private getAttemptStartedAt(target: ExecutionTarget): number | undefined {
    return this.promptQueue.getRuntimeStateMachine().getAttempt(target)
      ?.startedAt;
  }

  private async captureAndEmitSnapshot(
    target: ExecutionTarget,
    beforeState: RawWorkspaceState,
    strategy: "git" | "filesystem",
    context: WorkflowExecutionContext
  ): Promise<void> {
    if (!context.snapshotService || !context.workspaceFolderPath) {
      return;
    }

    const afterState = await context.snapshotService.captureWorkspaceState(
      context.workspaceFolderPath,
      strategy
    );

    const changedFiles = await context.snapshotService.computeSnapshotChanges(
      beforeState,
      afterState,
      context.workspaceFolderPath
    );

    const snapshot: WorkspaceSnapshot = {
      capturedAt: Date.now(),
      strategy,
      changedFiles,
    };

    context.onSnapshotCaptured?.(target, snapshot);

    if (context.historyFilePath && context.outputHistoryManager) {
      await context.outputHistoryManager.saveSnapshotForTarget(
        context.historyFilePath,
        this.toOutputExecutionTarget(target),
        snapshot
      );
    }
  }

  private toOutputExecutionTarget(
    target: ExecutionTarget
  ): OutputExecutionTarget {
    return target.kind === FINAL_PROMPT_PHASES.QUEUE
      ? { kind: FINAL_PROMPT_PHASES.QUEUE, stepIndex: target.stepIndex }
      : { kind: FINAL_PROMPT_PHASES.FINAL_PROMPT, loopIndex: target.loopIndex };
  }

  /**
   * Maps an ExecutionTarget to the signed integer index expected by legacy
   * dashboard/CLI callers. Queue steps use their zero-based stepIndex;
   * finalPrompt loops use negative values (-(loopIndex+1)) so they never
   * collide with queue indices and callers can detect them with `< 0`.
   */
  private getLegacyStepIndex(target: ExecutionTarget): number {
    return target.kind === FINAL_PROMPT_PHASES.QUEUE
      ? target.stepIndex
      : -(target.loopIndex + 1);
  }

  private describeExecutionTarget(target: ExecutionTarget): string {
    return target.kind === FINAL_PROMPT_PHASES.QUEUE
      ? `queue prompt ${target.stepIndex + 1}`
      : `finalPrompt loop ${target.loopIndex + 1}`;
  }

  private async persistInterruptedFinalPromptRuntime(
    context: WorkflowExecutionContext
  ): Promise<void> {
    const runtime = this.promptQueue.getFinalPromptRuntime();
    if (!runtime) {
      return;
    }

    const executionState = this.getRuntime().status;
    const status =
      executionState === EXECUTION_STATES.ERROR
        ? STEP_STATUS.FAILED
        : executionState === EXECUTION_STATES.STOPPED ||
            executionState === EXECUTION_STATES.CANCELLING
          ? STEP_STATUS.CANCELLED
          : (runtime.status ?? STEP_STATUS.RUNNING);

    await this.setFinalPromptRuntime(context, {
      ...runtime,
      phase: FINAL_PROMPT_PHASES.FINAL_PROMPT,
      status,
      ...(executionState === EXECUTION_STATES.ERROR ||
      executionState === EXECUTION_STATES.STOPPED ||
      executionState === EXECUTION_STATES.CANCELLING
        ? { completedAt: Date.now() }
        : {}),
    });
  }

  private async trackStatusMessage(
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    message: string,
    severity: string = STATUS_MESSAGE_SEVERITY.INFO,
    timestampMs?: number
  ): Promise<void> {
    const legacyStepIndex = this.getLegacyStepIndex(target);

    // Queue steps keep non-negative indices; finalPrompt loops use negative
    // legacy indices (-(loopIndex+1)) to avoid collisions with queue steps.
    context.dashboardProvider?.updateStatusMessage(
      legacyStepIndex,
      message,
      severity as any
    );
    if (target.kind === FINAL_PROMPT_PHASES.QUEUE) {
      context.onStatusMessage?.(target.stepIndex, message, severity);
    } else {
      context.onFinalPromptStatusMessage?.(target.loopIndex, message, severity);
      // Backward-compatible channel used by CLI renderers and existing listeners.
      context.onStatusMessage?.(legacyStepIndex, message, severity);
    }

    const statusMessage = {
      message,
      severity: severity as any,
      timestamp: timestampMs ?? Date.now(),
    };

    if (context.historyFilePath && context.outputHistoryManager) {
      await context.outputHistoryManager
        .appendStatusMessage(
          context.historyFilePath,
          this.toOutputExecutionTarget(target),
          statusMessage
        )
        .catch((err) =>
          Log.warn("Failed to append status message to history:", err)
        );
    }
  }

  private async evaluateEndCondition(
    prompt: PromptStep,
    integration: HarnessIntegration,
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    legacyStepIndex: number | undefined,
    attemptIndex: number,
    duration: number,
    vars?: Record<string, string>
  ): Promise<boolean> {
    Log.debug(
      `Evaluating end condition for ${this.describeExecutionTarget(target)}...`
    );

    if (!prompt.endCondition?.script) {
      Log.error(
        `End condition for ${this.describeExecutionTarget(target)} is missing required 'script' property`
      );
      await this.trackStatusMessage(
        context,
        target,
        "End condition failed: Missing script property",
        STATUS_MESSAGE_SEVERITY.ERROR
      );

      this.promptQueue
        .getRuntimeStateMachine()
        .failAttempt(
          target,
          attemptIndex,
          "End condition missing required 'script' property"
        );

      if (context.dashboardProvider && legacyStepIndex !== undefined) {
        context.dashboardProvider.updateStepStatus(legacyStepIndex, {
          state: STEP_STATUS.FAILED,
          message: "End condition missing required 'script' property",
          duration,
        });
      }

      return false;
    }

    const scriptName =
      prompt.endCondition.script.split(/[\\/]/).pop() ||
      prompt.endCondition.script;
    await this.trackStatusMessage(
      context,
      target,
      `Evaluating end condition: Running ${scriptName}`
    );

    const evaluationResult = await this.endConditionEvaluator.evaluateCondition(
      prompt.endCondition,
      context.workspaceFolderPath,
      vars
    );

    {
      const resultStatus = evaluationResult.success ? "Passed" : "Failed";
      const severity = evaluationResult.success
        ? STATUS_MESSAGE_SEVERITY.INFO
        : STATUS_MESSAGE_SEVERITY.ERROR;
      const output = evaluationResult.error
        ? evaluationResult.error
        : evaluationResult.stdout.trim();
      await this.trackStatusMessage(
        context,
        target,
        `End condition ${resultStatus} - Output: ${output}`,
        severity
      );
    }

    const retryContext = {
      integration,
      totalSteps: this.promptQueue.getState().steps.length,
      workspaceFolderPath: context.workspaceFolderPath,
      currentPromptFilePath: context.currentPromptFilePath,
      runtime: this.promptQueue.getRuntimeStateMachine(),
      attemptTarget: target,
      attemptIndex,
    };

    const sendRetryPromptCallback = this.createSendRetryPromptCallback(
      integration,
      context,
      target,
      legacyStepIndex
    );

    const result = await this.endConditionHandler.handleEndConditionResult(
      prompt,
      evaluationResult,
      retryContext,
      sendRetryPromptCallback
    );

    if (!result.shouldContinue) {
      if (context.dashboardProvider && legacyStepIndex !== undefined) {
        context.dashboardProvider.updateStepStatus(legacyStepIndex, {
          state: STEP_STATUS.FAILED,
          message: result.failureReason || "End condition failed",
          duration,
          endConditionResult: evaluationResult,
        });
      }
    }

    return result.shouldContinue;
  }

  /**
   * Waits for the integration to fire `onResponseComplete`.
   *
   * If the workflow is paused at the moment the response arrives, the resolver
   * is parked in `pendingResponseResolver` and the promise stays open until
   * `resumePendingResponse()` is called.
   *
   * There is intentionally no per-prompt timeout here. Complex prompts (large
   * refactors, full audits) can legitimately run for hours. The workflow-level
   * `maxWorkflowExecutionTime` setting guards against runaway workflows, and
   * users can stop manually at any time.
   */
  private async waitForResponseComplete(
    _prompt: PromptStep,
    integration: HarnessIntegration
  ): Promise<string> {
    return new Promise<string>((resolve) => {
      let responseHandled = false;

      const disposable = integration.onResponseComplete(
        async (responseText: string) => {
          if (responseHandled) {
            return;
          }
          responseHandled = true;
          disposable.dispose();

          if (this.getRuntime().status === EXECUTION_STATES.PAUSED) {
            this.pendingResponseResolver = resolve;
            this.pendingResponseText = responseText;
            this.isWaitingForResponse = false;
            return;
          }

          this.isWaitingForResponse = false;
          resolve(responseText);
        }
      );
    });
  }

  /**
   * Sends a prompt and manages the full streaming lifecycle: dashboard init,
   * listener setup and teardown, and response-completion waiting.
   *
   * Used by both the main execution loop (`attemptIndex = 0`) and retry
   * callbacks (`attemptIndex = N`).
   *
   * @param onPromptSent Optional async callback invoked after a successful send
   *   but *before* awaiting the response. Use for queue bookkeeping that must
   *   happen in that specific window (e.g. `markCurrentAsSent`,
   *   `isWaitingForResponse = true`).
   * @returns `{ responseText, duration }` on success, `null` if `sendPrompt`
   *   returns false.
   */
  private async executeWithStreaming(
    promptStep: PromptStep,
    integration: HarnessIntegration,
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    legacyStepIndex: number | undefined,
    attemptIndex: number,
    sendOptions: WorkflowContext,
    onPromptSent?: () => Promise<void>
  ): Promise<{ responseText: string; duration: number } | null> {
    const runtime = this.promptQueue.getRuntimeStateMachine();
    const attempt = runtime.beginAttempt(target, attemptIndex, Date.now());
    const startTime = Date.now();

    const initTimestampMs = attempt.startedAt;
    const rawTextOutput = integration.rawTextOutput || undefined;

    if (target.kind === FINAL_PROMPT_PHASES.QUEUE) {
      if (context.dashboardProvider && legacyStepIndex !== undefined) {
        context.dashboardProvider.updateCliStreamingChunk(legacyStepIndex, "");
        context.dashboardProvider.updateCliOutput(legacyStepIndex, {
          prompt: promptStep.prompt,
          response: "",
          elapsed: 0,
          tokens: undefined,
          isStreaming: true,
          cliCommand: undefined,
          workingDirectory: context.workspaceFolderPath,
          timestampMs: initTimestampMs,
          attemptIndex,
          rawTextOutput,
        });
      }

      if (legacyStepIndex !== undefined) {
        context.captureOutputInit?.(
          legacyStepIndex,
          promptStep.prompt,
          undefined,
          context.workspaceFolderPath,
          initTimestampMs,
          attemptIndex,
          rawTextOutput
        );
      }
    } else {
      context.dashboardProvider?.updateFinalPromptOutput(target.loopIndex, {
        prompt: promptStep.prompt,
        response: "",
        elapsed: 0,
        tokens: undefined,
        isStreaming: true,
        cliCommand: undefined,
        workingDirectory: context.workspaceFolderPath,
        timestampMs: initTimestampMs,
        attemptIndex,
        rawTextOutput,
      });
      context.captureFinalPromptOutputInit?.(
        target.loopIndex,
        promptStep.prompt,
        undefined,
        context.workspaceFolderPath,
        initTimestampMs,
        attemptIndex,
        rawTextOutput
      );
    }

    const responsePromise = this.waitForResponseComplete(
      promptStep,
      integration
    );

    let streamingDisposable: { dispose(): void } | undefined;
    let structuredStreamingDisposable: { dispose(): void } | undefined;
    let promptReadyDisposable: { dispose(): void } | undefined;

    promptReadyDisposable = integration.onPromptReady((data) => {
      const cliCommand = context.shouldShowCliCommand
        ? data.cliCommand
        : undefined;

      if (target.kind === FINAL_PROMPT_PHASES.QUEUE) {
        if (context.dashboardProvider && legacyStepIndex !== undefined) {
          context.dashboardProvider.updateCliOutput(legacyStepIndex, {
            prompt: promptStep.prompt,
            response: "",
            elapsed: 0,
            tokens: undefined,
            isStreaming: true,
            cliCommand,
            workingDirectory: context.workspaceFolderPath,
            timestampMs: initTimestampMs,
            attemptIndex,
            rawTextOutput,
          });
        }

        if (legacyStepIndex !== undefined) {
          context.captureOutputInit?.(
            legacyStepIndex,
            promptStep.prompt,
            cliCommand,
            context.workspaceFolderPath,
            initTimestampMs,
            attemptIndex,
            rawTextOutput
          );
        }
      } else {
        context.dashboardProvider?.updateFinalPromptOutput(target.loopIndex, {
          prompt: promptStep.prompt,
          response: "",
          elapsed: 0,
          tokens: undefined,
          isStreaming: true,
          cliCommand,
          workingDirectory: context.workspaceFolderPath,
          timestampMs: initTimestampMs,
          attemptIndex,
          rawTextOutput,
        });

        context.captureFinalPromptOutputInit?.(
          target.loopIndex,
          promptStep.prompt,
          cliCommand,
          context.workspaceFolderPath,
          initTimestampMs,
          attemptIndex,
          rawTextOutput
        );
      }
    });

    streamingDisposable = integration.onStreamingChunk((chunk) => {
      if (
        target.kind === FINAL_PROMPT_PHASES.QUEUE &&
        legacyStepIndex !== undefined
      ) {
        context.captureChunk?.(legacyStepIndex, chunk);
        context.dashboardProvider?.updateCliStreamingChunk(
          legacyStepIndex,
          chunk
        );
      } else if (target.kind === FINAL_PROMPT_PHASES.FINAL_PROMPT) {
        context.captureFinalPromptChunk?.(target.loopIndex, chunk);
        context.dashboardProvider?.updateFinalPromptStreamingChunk(
          target.loopIndex,
          chunk
        );
      }
    });

    structuredStreamingDisposable = integration.onStreamingEvents((events) => {
      if (
        target.kind === FINAL_PROMPT_PHASES.QUEUE &&
        legacyStepIndex !== undefined
      ) {
        context.captureEvents?.(legacyStepIndex, events);
        context.dashboardProvider?.updateCliStreamingEvents(
          legacyStepIndex,
          events
        );
      } else if (target.kind === FINAL_PROMPT_PHASES.FINAL_PROMPT) {
        context.captureFinalPromptEvents?.(target.loopIndex, events);
        context.dashboardProvider?.updateFinalPromptStreamingEvents(
          target.loopIndex,
          events
        );
      }
    });

    const disposeListeners = () => {
      streamingDisposable?.dispose();
      structuredStreamingDisposable?.dispose();
      promptReadyDisposable?.dispose();
    };

    const success = await integration.sendPrompt(promptStep, true, sendOptions);
    if (!success) {
      disposeListeners();
      return null;
    }

    if (onPromptSent) {
      await onPromptSent();
    }

    const responseText = await responsePromise;
    disposeListeners();

    const duration = parseFloat(((Date.now() - startTime) / 1000).toFixed(1));
    return { responseText, duration };
  }

  /**
   * Builds the retry-prompt callback passed to `EndConditionHandler`.
   *
   * Note: `EndConditionHandler` calls `incrementRetryCount()` on the queue
   * *before* invoking this callback, so `getCurrentRetryCount()` already
   * reflects the current attempt number when the callback fires.
   */
  private createSendRetryPromptCallback(
    integration: HarnessIntegration,
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    legacyStepIndex: number | undefined
  ): SendRetryPromptCallback {
    return async (
      retryPromptStep: PromptStep,
      currentIndex: number,
      retryAttemptIndex: number
    ): Promise<string | null> => {
      const state = this.promptQueue.getState();
      const workflowFile = this.promptQueue.getWorkflowFile();
      const resolvedProperties = PropertyResolver.resolve(
        retryPromptStep,
        workflowFile
      );

      const result = await this.executeWithStreaming(
        retryPromptStep,
        integration,
        context,
        target,
        target.kind === FINAL_PROMPT_PHASES.QUEUE ? legacyStepIndex : undefined,
        retryAttemptIndex,
        {
          promptIndex: currentIndex,
          allPrompts: state.steps,
          filePath: context.currentPromptFilePath,
          workflowName: this.promptQueue.getState().workflowName,
          instanceId: context.instanceId,
          workingFilePath: context.workingFilePath,
          resolvedProperties: { ...resolvedProperties, resumeSession: true },
          workflowFile,
          workingFilePersistence: this.promptQueue,
          getFinalPromptResponseTexts: () =>
            this.promptQueue.getFinalPromptResponseTexts(),
          finalPromptSessionId: workflowFile.finalStep?._runtime?.sessionId as
            | string
            | undefined,
        }
      );

      if (!result) {
        await this.handlePromptSendFailure(
          integration,
          context,
          target,
          retryPromptStep,
          legacyStepIndex ?? this.getLegacyStepIndex(target),
          retryAttemptIndex
        );
        return null;
      }

      await this.updateDashboardWithResponse(
        context,
        integration,
        target,
        target.kind === FINAL_PROMPT_PHASES.QUEUE ? legacyStepIndex : undefined,
        retryPromptStep,
        result.responseText,
        result.duration,
        retryAttemptIndex
      );

      return result.responseText;
    };
  }

  clearPendingState(): void {
    this.pendingResponseResolver = null;
    this.pendingResponseText = null;
    this.isWaitingForResponse = false;
  }

  hasPendingResponse(): boolean {
    return (
      this.pendingResponseResolver !== null && this.pendingResponseText !== null
    );
  }

  isAwaitingResponse(): boolean {
    return this.isWaitingForResponse;
  }

  /** Called by `WorkflowOrchestrator.resume()` when there is a held response. */
  resumePendingResponse(): void {
    if (this.pendingResponseResolver && this.pendingResponseText !== null) {
      const resolver = this.pendingResponseResolver;
      const responseText = this.pendingResponseText;

      this.pendingResponseResolver = null;
      this.pendingResponseText = null;

      resolver(responseText);
    }
  }

  private logWorkflowStart(
    context: WorkflowExecutionContext,
    integration: HarnessIntegration,
    totalSteps: number
  ): void {
    if (!context.showCliOutput) {
      return;
    }

    const tag = context.instanceTag ? `${context.instanceTag} ` : "";
    const workflowName = path.basename(
      context.currentPromptFilePath ?? "unknown"
    );
    Log.info(
      `${tag}Workflow started - ${workflowName}, ${totalSteps} step(s), harness: ${integration.getStatus().strategy}`
    );
  }

  private logWorkflowCompletion(
    context: WorkflowExecutionContext,
    totalSteps: number
  ): void {
    if (!context.showCliOutput) {
      return;
    }

    const tag = context.instanceTag ? `${context.instanceTag} ` : "";
    const workflowName = path.basename(
      context.currentPromptFilePath ?? "unknown"
    );
    const completedCount = this.promptQueue.getCompletedCount();
    Log.info(
      `${tag}Workflow complete - ${workflowName}, ${completedCount}/${totalSteps} steps completed`
    );
  }

  private async showDashboard(): Promise<void> {
    try {
      this.platform.focusDashboard?.();
    } catch (error) {
      Log.error("Could not focus dashboard panel:", error);
    }
  }

  private async checkExecutionTimeLimit(
    dynamicConfig: DynamicQueueConfig,
    currentIndex: number,
    totalSteps: number
  ): Promise<boolean> {
    const maxTimeSec = dynamicConfig.maxWorkflowExecutionTime;
    const unlimitedWorkflow = dynamicConfig.unlimitedMode || maxTimeSec === -1;

    if (unlimitedWorkflow) {
      return false;
    }

    const elapsedMs = this.getRuntime().getActiveExecutionTime();
    const elapsedSec = Math.floor(elapsedMs / 1000);

    if (elapsedSec >= maxTimeSec) {
      const completedCount = this.promptQueue.getCompletedCount();
      const remainingCount = totalSteps - currentIndex;

      const message = `Workflow stopped - Maximum execution time reached (${elapsedSec}s / ${maxTimeSec}s).\nCompleted ${completedCount} of ${totalSteps} steps. ${remainingCount} steps remaining in queue.`;

      this.platform.warn(message);
      Log.trace(`⏱️ ${message}`);

      this.promptQueue.getRuntimeStateMachine().fail();
      await this.promptQueue.commitRuntimeTransition();
      return true;
    }

    return false;
  }

  private async checkQueueSizeLimit(
    dynamicConfig: DynamicQueueConfig,
    totalSteps: number
  ): Promise<boolean> {
    if (dynamicConfig.unlimitedMode || dynamicConfig.maxQueueSize <= 0) {
      return false;
    }

    if (totalSteps <= dynamicConfig.maxQueueSize) {
      return false;
    }

    const message = `Workflow stopped - Maximum queue size reached (${totalSteps}/${dynamicConfig.maxQueueSize}).`;
    this.platform.warn(message);
    Log.trace(`📏 ${message}`);
    this.promptQueue.getRuntimeStateMachine().fail();
    await this.promptQueue.commitRuntimeTransition();
    return true;
  }

  private updateDashboardForPromptStart(
    context: WorkflowExecutionContext,
    _step: WorkflowStep,
    currentIndex: number
  ): void {
    if (!context.dashboardProvider) {
      return;
    }

    context.dashboardProvider.updateStepStatus(currentIndex, {
      state: STEP_STATUS.RUNNING,
    });
  }

  private async handlePromptSendFailure(
    integration: HarnessIntegration,
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    prompt: PromptStep,
    legacyStepIndex: number,
    attemptIndex: number
  ): Promise<boolean> {
    const runtime = this.getRuntime();
    if (runtime.stopped) {
      // Workflow was stopped by the user. Flush whatever partial output is available
      // so the history file is not empty and the user can resume from the stopped state.
      const failureOutput = integration.getLastFailureOutput?.();
      const failureReason =
        integration.getLastFailureReason() || "Workflow stopped by user";
      const attemptTimestampMs = this.getAttemptStartedAt(target) ?? Date.now();

      const stoppedOutput = {
        prompt: prompt.prompt,
        response: failureOutput ?? "",
        isStreaming: false,
        elapsed: 0,
        tokens: undefined,
        cliCommand: context.shouldShowCliCommand
          ? integration.getLastCliCommand()
          : undefined,
        workingDirectory: context.workspaceFolderPath,
        timestampMs: attemptTimestampMs,
        attemptIndex,
        rawTextOutput:
          failureOutput !== undefined
            ? true
            : integration.rawTextOutput || undefined,
        errorMessage: failureReason,
      };

      if (context.dashboardProvider && legacyStepIndex >= 0) {
        context.dashboardProvider.updateCliOutput(
          legacyStepIndex,
          stoppedOutput
        );
      } else if (
        context.dashboardProvider &&
        target.kind === FINAL_PROMPT_PHASES.FINAL_PROMPT
      ) {
        context.dashboardProvider.updateFinalPromptOutput(
          target.loopIndex,
          stoppedOutput
        );
      }

      if (legacyStepIndex >= 0) {
        context.captureCompletedOutput?.(legacyStepIndex, stoppedOutput);
      } else if (target.kind === FINAL_PROMPT_PHASES.FINAL_PROMPT) {
        context.captureFinalPromptCompletedOutput?.(
          target.loopIndex,
          stoppedOutput
        );
      }

      if (context.historyFilePath && context.outputHistoryManager) {
        await context.outputHistoryManager
          .saveExecutionOutput(
            context.historyFilePath,
            this.toOutputExecutionTarget(target),
            [stoppedOutput]
          )
          .catch((err) =>
            Log.warn("Failed to save stopped-by-user output to history:", err)
          );
      }

      return false;
    }

    if (integration.wasLastFailureUserCancellation()) {
      const failureReason = integration.getLastFailureReason();
      runtime.cancelAttempt(target, attemptIndex, failureReason);
      this.promptQueue.markInFlightPromptCancelled();
      if (runtime.requestStop()) {
        await this.promptQueue.commitRuntimeTransition({ persist: false });
      }
      return false;
    }

    // CLI process exited before completion (Ctrl+C, crash, SIGKILL).
    // All CLI harnesses are TUIs that stay open between prompts — any process
    // exit before a Stop hook or log-based completion is abnormal.
    // Treat like a stop: show warning, stop queue, don't mark as errored.
    if (integration.wasLastFailureProcessExit()) {
      const failureReason = integration.getLastFailureReason();
      const failureOutput = integration.getLastFailureOutput?.();
      const attemptTimestampMs = this.getAttemptStartedAt(target) ?? Date.now();
      const warningTimestampMs = Math.max(Date.now(), attemptTimestampMs + 1);
      const warningMessage = `Process exited unexpectedly — workflow stopped. ${failureReason}`;
      Log.warn(
        `⚠️ CLI process exited before completion — stopping workflow: ${failureReason}`
      );

      runtime.cancelAttempt(target, attemptIndex, failureReason);

      await this.trackStatusMessage(
        context,
        target,
        warningMessage,
        STATUS_MESSAGE_SEVERITY.WARNING,
        warningTimestampMs
      );

      const processExitOutput = {
        prompt: prompt.prompt,
        response: failureOutput ?? "",
        isStreaming: false,
        elapsed: 0,
        tokens: undefined,
        cliCommand: context.shouldShowCliCommand
          ? integration.getLastCliCommand()
          : undefined,
        workingDirectory: context.workspaceFolderPath,
        timestampMs: attemptTimestampMs,
        attemptIndex,
        rawTextOutput:
          failureOutput !== undefined
            ? true
            : integration.rawTextOutput || undefined,
        errorMessage: failureReason,
      };

      if (context.dashboardProvider && legacyStepIndex >= 0) {
        context.dashboardProvider.updateCliOutput(
          legacyStepIndex,
          processExitOutput
        );
      } else if (
        context.dashboardProvider &&
        target.kind === FINAL_PROMPT_PHASES.FINAL_PROMPT
      ) {
        context.dashboardProvider.updateFinalPromptOutput(
          target.loopIndex,
          processExitOutput
        );
      }

      if (legacyStepIndex >= 0) {
        context.captureCompletedOutput?.(legacyStepIndex, processExitOutput);
      } else if (target.kind === FINAL_PROMPT_PHASES.FINAL_PROMPT) {
        context.captureFinalPromptCompletedOutput?.(
          target.loopIndex,
          processExitOutput
        );
      }

      if (context.historyFilePath && context.outputHistoryManager) {
        await context.outputHistoryManager
          .saveExecutionOutput(
            context.historyFilePath,
            this.toOutputExecutionTarget(target),
            [processExitOutput]
          )
          .catch((err) =>
            Log.warn("Failed to save process-exit output to history:", err)
          );
      }

      this.promptQueue.markInFlightPromptCancelled();
      if (runtime.requestStop()) {
        await this.promptQueue.commitRuntimeTransition({ persist: false });
      }
      if (runtime.confirmStopped()) {
        this.promptQueue.finalizeCancelledPromptAfterStop();
        await this.promptQueue.commitRuntimeTransition();
      }
      return false;
    }

    const failureReason = integration.getLastFailureReason();
    const stepLabel =
      legacyStepIndex >= 0
        ? `prompt ${legacyStepIndex + 1}`
        : `finalPrompt loop ${Math.abs(legacyStepIndex)}`;
    this.platform.error(`Failed to execute ${stepLabel}: ${failureReason}`);

    // Send FAILED status before markErrored() so the step icon updates
    // before the execution state transitions to ERROR (separate postMessages
    // arrive in the same render cycle this way).
    if (context.dashboardProvider && legacyStepIndex >= 0) {
      context.dashboardProvider.updateStepStatus(legacyStepIndex, {
        state: STEP_STATUS.FAILED,
        message: failureReason,
      });
    }

    runtime.failAttempt(target, attemptIndex, failureReason);
    this.promptQueue.finalizeFailedInFlightPrompt(failureReason);
    runtime.fail();
    await this.promptQueue.commitRuntimeTransition();

    // Write a final (non-streaming) error CLI output so the failure is visible
    // in the dashboard and persisted to history. This replaces the initial
    // isStreaming:true output that was set up before sendPrompt was called.
    const errorCliOutput = {
      prompt: prompt.prompt,
      response: "",
      isStreaming: false,
      elapsed: 0,
      tokens: undefined,
      cliCommand: context.shouldShowCliCommand
        ? integration.getLastCliCommand()
        : undefined,
      workingDirectory: context.workspaceFolderPath,
      timestampMs: this.getAttemptStartedAt(target) ?? Date.now(),
      attemptIndex,
      rawTextOutput: integration.rawTextOutput || undefined,
      errorMessage: failureReason,
    };

    if (context.dashboardProvider && legacyStepIndex >= 0) {
      context.dashboardProvider.updateCliOutput(
        legacyStepIndex,
        errorCliOutput
      );
    } else if (
      context.dashboardProvider &&
      target.kind === FINAL_PROMPT_PHASES.FINAL_PROMPT
    ) {
      context.dashboardProvider.updateFinalPromptOutput(
        target.loopIndex,
        errorCliOutput
      );
    }

    if (legacyStepIndex >= 0) {
      context.captureCompletedOutput?.(legacyStepIndex, errorCliOutput);
    } else if (target.kind === FINAL_PROMPT_PHASES.FINAL_PROMPT) {
      context.captureFinalPromptCompletedOutput?.(
        target.loopIndex,
        errorCliOutput
      );
    }

    if (context.historyFilePath && context.outputHistoryManager) {
      await context.outputHistoryManager
        .saveExecutionOutput(
          context.historyFilePath,
          this.toOutputExecutionTarget(target),
          [errorCliOutput]
        )
        .catch((err) =>
          Log.warn("Failed to save error output to history:", err)
        );
    }

    return false;
  }

  private async updateDashboardWithResponse(
    context: WorkflowExecutionContext,
    integration: HarnessIntegration,
    target: ExecutionTarget,
    legacyStepIndex: number | undefined,
    prompt: PromptStep,
    responseText: string,
    duration: number,
    attemptIndex: number = 0
  ): Promise<void> {
    const parsedOutput = integration.getLastParsedOutput?.();
    let structured: DashboardOutput | undefined;
    if (parsedOutput) {
      structured = CliOutputFormatter.toDashboardFormat(parsedOutput);
    }

    let tokens:
      | {
          prompt: number;
          completion: number;
          cached?: number;
          cacheCreated?: number;
          contextWindowUsed?: number;
          contextWindowSize?: number;
        }
      | undefined;

    if (parsedOutput?.metadata.usage) {
      const u = parsedOutput.metadata.usage;
      tokens = {
        prompt: u.inputTokens,
        completion: u.outputTokens,
        cached: u.cachedInputTokens,
        cacheCreated: u.cacheCreatedTokens,
        contextWindowUsed: u.contextWindowUsedTokens,
        contextWindowSize: u.contextWindowSize,
      };
    } else {
      const lastResult = integration.getLastResult();
      if (lastResult?.statistics) {
        tokens = integration.parseTokenCounts(lastResult.statistics);
      }
    }

    const cliCommand = context.shouldShowCliCommand
      ? integration.getLastCliCommand()
      : undefined;

    const cliOutputObj = {
      prompt: prompt.prompt,
      response: responseText,
      structured,
      elapsed: duration,
      tokens,
      isStreaming: false,
      cliCommand,
      workingDirectory: context.workspaceFolderPath,
      timestampMs: this.getAttemptStartedAt(target) ?? Date.now(),
      attemptIndex,
      rawTextOutput: integration.rawTextOutput || undefined,
    };

    if (context.dashboardProvider && legacyStepIndex !== undefined) {
      context.dashboardProvider.updateCliOutput(legacyStepIndex, cliOutputObj);
    } else if (
      context.dashboardProvider &&
      target.kind === FINAL_PROMPT_PHASES.FINAL_PROMPT
    ) {
      context.dashboardProvider.updateFinalPromptOutput(
        target.loopIndex,
        cliOutputObj
      );
    }
    if (legacyStepIndex !== undefined) {
      context.captureCompletedOutput?.(legacyStepIndex, cliOutputObj);
    } else if (target.kind === FINAL_PROMPT_PHASES.FINAL_PROMPT) {
      context.captureFinalPromptCompletedOutput?.(
        target.loopIndex,
        cliOutputObj
      );
    }

    if (context.historyFilePath && context.outputHistoryManager) {
      await context.outputHistoryManager
        .saveExecutionOutput(
          context.historyFilePath,
          this.toOutputExecutionTarget(target),
          [cliOutputObj]
        )
        .catch((err) =>
          Log.warn("Failed to save step output to history:", err)
        );
    }
  }

  private async finalizeWorkflowExecution(): Promise<void> {
    const finalState = this.getRuntime().status;
    if (
      finalState !== EXECUTION_STATES.PAUSED &&
      finalState !== EXECUTION_STATES.STOPPED &&
      finalState !== EXECUTION_STATES.CANCELLING &&
      finalState !== EXECUTION_STATES.ERROR
    ) {
      this.getRuntime().complete();
      await this.promptQueue.commitRuntimeTransition();
    }
  }

  private async setFinalPromptRuntime(
    context: WorkflowExecutionContext,
    runtime: FinalPromptRuntimeState
  ): Promise<void> {
    await this.promptQueue.setFinalPromptRuntime(runtime);
    context.dashboardProvider?.updateFinalPromptStatus(
      runtime.status ?? null,
      runtime.loopCount,
      runtime.phase
    );
  }
}
