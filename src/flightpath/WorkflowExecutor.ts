import * as path from "path";
import { PlatformAdapter } from "../platform/PlatformAdapter";
import {
  PromptStep,
  ScriptStep,
  WorkflowStep,
  isScriptStep,
  McpServerConfig,
  DynamicQueueConfig,
  FinalStepRuntimeState,
  EXECUTION_STATES,
  Harness,
  type WorkflowAttemptTarget,
  type PreConditionAction,
} from "../types/FlightPathTypes";
import type { FlightPathMcpServerProvider } from "../ui/FlightPathMcpServerProvider";
import { WorkflowContext } from "../types/WorkflowContextTypes";
import {
  EXECUTION_MODES,
  STEP_STATUS,
  STATUS_MESSAGE_SEVERITY,
  FINAL_STEP_PHASES,
  STEP_TYPES,
  CONDITION_ACTIONS,
  COMPARE_SOURCES,
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
import { CliEvent, CliOutput } from "../types/WebviewMessageTypes";
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
  /** Snapshot of in-flight queue output already sent to the dashboard. */
  getBufferedOutput?: (stepIndex: number) => CliOutput | undefined;
  /** Mirror of captureOutputInit for finalStep loops, keyed by loopIndex. */
  captureFinalStepOutputInit?: (
    loopIndex: number,
    prompt: string,
    cliCommand: string | undefined,
    workingDirectory: string | undefined,
    timestampMs: number,
    attemptIndex: number,
    rawTextOutput?: boolean
  ) => void;
  captureFinalStepChunk?: (loopIndex: number, chunk: string) => void;
  captureFinalStepEvents?: (loopIndex: number, events: CliEvent[]) => void;
  captureFinalStepCompletedOutput?: (loopIndex: number, output: any) => void;
  /** Snapshot of in-flight finalStep output already sent to the dashboard. */
  getFinalStepBufferedOutput?: (loopIndex: number) => CliOutput | undefined;
  onFinalStepStatusMessage?: (
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
  /**
   * Spawn a PTY session for interactive script execution.
   * Wraps the script in a shell so PTY interactive input works correctly.
   * Sends TERMINAL_STARTED / TERMINAL_OUTPUT / TERMINAL_ENDED to the webview and
   * resolves with the process exit code when the PTY exits.
   * Only available when running inside the VS Code extension (not CLI mode).
   */
  spawnScriptPty?: (options: {
    /** Human-readable step label shown in the terminal tab header. */
    stepName: string;
    /** Signed step index used as the CLI output slot. */
    stepIndex: number;
    /** Raw script string from the step definition (e.g. ".flightpath/scripts/check.py arg"). */
    script: string;
    /** Working directory for the script process. */
    cwd: string;
    /** Called for each output chunk — used to stream text to the CliOutput panel. */
    onOutput: (chunk: string) => void;
  }) => Promise<number>;
}

type ExecutionTarget = WorkflowAttemptTarget;

/**
 * Drives the sequential execution loop for a FlightPath workflow.
 *
 * The outer loop has two phases:
 *   1. **Queue phase** — drains normal prompts via `promptQueue.hasNext()`.
 *   2. **finalStep phase** — runs the orchestrator gate once the queue is empty.
 *      If the gate appends new prompts, the outer loop repeats
 *      (queue → finalStep → queue → …).
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
   * run — the queue's `currentIndex` and `finalStepRuntime` phase are both
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

    const initialFinalStep = getFinalStep();

    if (initialFinalStep && !this.promptQueue.getFinalStepRuntime()) {
      await this.setFinalStepRuntime(context, {
        phase: FINAL_STEP_PHASES.QUEUE,
        loopCount: 0,
      });
    } else if (initialFinalStep) {
      const runtime = this.promptQueue.getFinalStepRuntime();
      context.dashboardProvider?.updateFinalStepStatus(
        runtime?.status ?? null,
        runtime?.loopCount ?? 0,
        runtime?.phase ?? null
      );
    } else {
      context.dashboardProvider?.updateFinalStepStatus(null, 0, null);
    }

    // Only skip the queue drain and go straight to the finalStep when resuming
    // a run that was interrupted mid-finalStep AND there are no pending queue
    // items waiting to run. If there are pending items (e.g. an ephemeral
    // prompt was appended to a completed workflow), drain the queue first so
    // the new prompts are not skipped.
    let runFinalStepFirst =
      !!initialFinalStep &&
      this.promptQueue.getFinalStepRuntime()?.phase ===
        FINAL_STEP_PHASES.FINAL_STEP &&
      !this.promptQueue.hasNext();

    while (true) {
      if (!runFinalStepFirst) {
        while (this.promptQueue.hasNext()) {
          const state = this.promptQueue.getState();
          const target: ExecutionTarget = {
            kind: FINAL_STEP_PHASES.QUEUE,
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

      runFinalStepFirst = false;

      const statusAfterQueue = runtime.status;
      if (statusAfterQueue !== EXECUTION_STATES.RUNNING) {
        break;
      }

      const currentFinalStep = getFinalStep();
      if (!currentFinalStep) {
        break;
      }

      // Initialize runtime if a final step was added after execution started
      if (!this.promptQueue.getFinalStepRuntime()) {
        await this.setFinalStepRuntime(context, {
          phase: FINAL_STEP_PHASES.QUEUE,
          loopCount: 0,
        });
      }

      const finalStepRuntime = this.promptQueue.getFinalStepRuntime();
      const loopIndex = finalStepRuntime?.loopCount ?? 0;
      const queueSizeBefore = this.promptQueue.getState().steps.length;

      await this.setFinalStepRuntime(context, {
        phase: FINAL_STEP_PHASES.FINAL_STEP,
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
        kind: FINAL_STEP_PHASES.FINAL_STEP,
        loopIndex,
      };
      const shouldContinue = await this.executeSinglePrompt(
        finalTarget,
        currentFinalStep,
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
        await this.persistInterruptedFinalStepRuntime(context);
        break;
      }

      const statusAfterFinal = runtime.status;
      if (statusAfterFinal !== EXECUTION_STATES.RUNNING) {
        await this.persistInterruptedFinalStepRuntime(context);
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

        await this.setFinalStepRuntime(context, {
          phase: FINAL_STEP_PHASES.QUEUE,
          loopCount: loopIndex + 1,
          status: STEP_STATUS.COMPLETED,
          startedAt:
            this.promptQueue.getFinalStepRuntime()?.startedAt ?? Date.now(),
          completedAt: Date.now(),
        });

        continue;
      }

      await this.setFinalStepRuntime(context, {
        phase: FINAL_STEP_PHASES.FINAL_STEP,
        loopCount: loopIndex,
        status: STEP_STATUS.COMPLETED,
        startedAt: this.promptQueue.getFinalStepRuntime()?.startedAt,
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
      target.kind === FINAL_STEP_PHASES.QUEUE
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
        target.kind === FINAL_STEP_PHASES.QUEUE ? target.stepIndex : -1;
      return this.executeScriptStep(step, stepIndex, context, target);
    }

    let prompt: PromptStep = step as PromptStep;

    // Evaluate pre-condition gate before running the AI prompt
    const workflowFileForPre = this.promptQueue.getWorkflowFile();
    const resolvedPreCondition =
      prompt.preCondition !== undefined
        ? prompt.preCondition
        : (workflowFileForPre.preCondition ?? null);

    if (
      resolvedPreCondition !== null &&
      resolvedPreCondition !== undefined &&
      resolvedPreCondition.script?.trim()
    ) {
      const preResult = await this.endConditionEvaluator.evaluateCondition(
        resolvedPreCondition,
        context.workspaceFolderPath,
        workflowFileForPre.vars
      );
      const preAction: PreConditionAction = preResult.passed
        ? (resolvedPreCondition.onPass ?? CONDITION_ACTIONS.CONTINUE)
        : (resolvedPreCondition.onFail ?? CONDITION_ACTIONS.SKIP_PROMPT);

      Log.debug(
        `Pre-condition ${preResult.passed ? "passed" : "failed"} → action: ${preAction}`
      );

      if (preAction === CONDITION_ACTIONS.SKIP_PROMPT) {
        return this.handleSkippedStep(step, target, context);
      }
      if (preAction === CONDITION_ACTIONS.STOP_WORKFLOW) {
        Log.info("Pre-condition stopWorkflow triggered");
        this.getRuntime().fail();
        await this.promptQueue.commitRuntimeTransition();
        return false;
      }
      // CONTINUE — fall through and run the step
    }
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

    if (target.kind === FINAL_STEP_PHASES.QUEUE) {
      this.updateDashboardForPromptStart(context, prompt, target.stepIndex);
      integration.setWorkflowProgress(target.stepIndex + 1, progress.total);
      Log.info(`Executing prompt ${target.stepIndex + 1}/${progress.total}`);
    } else {
      Log.info(`Executing finalStep loop ${target.loopIndex + 1}`);
    }

    const signedStepIndex = this.getSignedStepIndex(target);
    const sendPromptIndex =
      target.kind === FINAL_STEP_PHASES.QUEUE
        ? target.stepIndex
        : state.steps.length;

    const result = await this.executeWithStreaming(
      prompt,
      integration,
      context,
      target,
      target.kind === FINAL_STEP_PHASES.QUEUE ? signedStepIndex : undefined,
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
        getFinalStepResponseTexts: () =>
          this.promptQueue.getFinalStepResponseTexts(),
        finalStepSessionId: workflowFile.finalStep?._runtime?.sessionId as
          | string
          | undefined,
      },
      async () => {
        if (target.kind === FINAL_STEP_PHASES.QUEUE) {
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
        signedStepIndex,
        0
      );
    }

    const { responseText, duration } = result;

    // Store response text for priorContext injection in subsequent prompts.
    if (target.kind === FINAL_STEP_PHASES.QUEUE) {
      // Queue steps: store on _runtime for "all" / "previous" / array-index access
      if (!prompt._runtime) {
        prompt._runtime = { startedAt: Date.now() };
      }
      prompt._runtime.responseText = responseText;
      await this.promptQueue.persistRuntimeMetadata(target.stepIndex, {
        responseText,
      });
    } else {
      // finalStep loops: store indexed by loopIndex for "finalStepAll" / "finalStepPrevious"
      await this.promptQueue.storeFinalStepResponseText(
        target.loopIndex,
        responseText
      );
    }

    await this.updateDashboardWithResponse(
      context,
      integration,
      target,
      target.kind === FINAL_STEP_PHASES.QUEUE ? signedStepIndex : undefined,
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
        target.kind === FINAL_STEP_PHASES.QUEUE ? signedStepIndex : undefined,
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
        target.kind === FINAL_STEP_PHASES.QUEUE &&
        context.dashboardProvider
      ) {
        context.dashboardProvider.updateStepStatus(signedStepIndex, {
          state: STEP_STATUS.COMPLETED,
          duration,
        });
      }
    } else {
      runtime.completeAttempt(target, 0);
      if (
        target.kind === FINAL_STEP_PHASES.QUEUE &&
        context.dashboardProvider
      ) {
        context.dashboardProvider.updateStepStatus(signedStepIndex, {
          state: STEP_STATUS.COMPLETED,
          duration,
        });
      }
    }

    if (target.kind === FINAL_STEP_PHASES.QUEUE) {
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
   * Handle a step that has been skipped by a pre-condition gate.
   *
   * For mid-queue steps: broadcasts SKIPPED status and advances the queue.
   * For finalStep: marks the loop as skipped and exits cleanly (treated as "resolved").
   *
   * @returns true to continue to the next step, false to stop (finalStep skip exits loop)
   */
  private async handleSkippedStep(
    step: WorkflowStep,
    target: ExecutionTarget,
    context: WorkflowExecutionContext
  ): Promise<boolean> {
    const stepLabel =
      !isScriptStep(step) && (step as PromptStep).name
        ? (step as PromptStep).name!
        : step.type === "script"
          ? (step as ScriptStep).script.split(/\s+/)[0]
          : "prompt";

    Log.info(`[Pre-condition] Step skipped — ${stepLabel}`);

    if (target.kind === FINAL_STEP_PHASES.QUEUE) {
      const stepIndex = target.stepIndex;
      if (context.dashboardProvider && stepIndex >= 0) {
        context.dashboardProvider.updateStepStatus(stepIndex, {
          state: STEP_STATUS.SKIPPED,
          message: "Skipped by pre-condition",
        });
      }
      await this.promptQueue.completeCurrentAndMoveNext();
      if (context.dashboardProvider) {
        const live = this.promptQueue.getProgress();
        context.dashboardProvider.updateProgress(live.current, live.total);
      }
      return true;
    }

    // finalStep — skip = loop exits cleanly (the condition we were fixing is resolved)
    await this.setFinalStepRuntime(context, {
      phase: FINAL_STEP_PHASES.FINAL_STEP,
      loopCount: target.loopIndex,
      status: STEP_STATUS.SKIPPED,
      startedAt:
        this.promptQueue.getFinalStepRuntime()?.startedAt ?? Date.now(),
      completedAt: Date.now(),
    });

    return false;
  }

  /**
   * Execute a script step — runs a shell command with no AI harness interaction.
   *
   * In headless mode the script runs in a child process with stdout streamed live
   * to the CliOutput panel via updateCliStreamingChunk.
   *
   * In interactive mode the script runs inside a PTY session so it can prompt for
   * user input. Output is simultaneously streamed to the CliOutput panel (ANSI
   * stripped) and sent as TERMINAL_OUTPUT to the embedded xterm terminal.
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

    const timeout =
      step.timeout != null
        ? step.timeout * 1000
        : ConfigurationUtils.getScriptTimeoutMs();

    const signedStepIndex = this.getSignedStepIndex(target);
    const timestampMs = Date.now();

    // Emit an initial streaming placeholder so the CliOutput panel appears immediately.
    const initCliOutput = {
      prompt: step.script,
      response: "",
      elapsed: 0,
      isStreaming: true,
      source: STEP_TYPES.SCRIPT,
      timestampMs,
      cliCommand: step.script,
      workingDirectory: context.workspaceFolderPath,
    };
    if (context.dashboardProvider && signedStepIndex >= 0) {
      context.dashboardProvider.updateCliOutput(signedStepIndex, initCliOutput);
    } else if (
      context.dashboardProvider &&
      target.kind === FINAL_STEP_PHASES.FINAL_STEP
    ) {
      context.dashboardProvider.updateFinalStepOutput(
        target.loopIndex,
        initCliOutput
      );
    }

    // Accumulate output chunks so interactive mode has output to save to history.
    const outputChunks: string[] = [];

    // Streaming callback — strips ANSI codes for the CliOutput text panel.
    const onStreamChunk = (chunk: string): void => {
      outputChunks.push(chunk);
      if (!context.dashboardProvider) return;
      if (signedStepIndex >= 0) {
        context.dashboardProvider.updateCliStreamingChunk(
          signedStepIndex,
          chunk
        );
      }
      // Note: finalStep streaming chunks reuse the same slot; updateFinalStepStreamingChunk
      // is not exposed on IDashboardSink but finalStep script steps are uncommon, so we
      // only stream to the queue slot for now.
    };

    // ─── Interactive mode: run inside a PTY so the user can provide input ────
    const isInteractive =
      ConfigurationUtils.getCliExecutionMode() === EXECUTION_MODES.INTERACTIVE;
    let ptyExitCode: number | undefined;

    if (isInteractive && context.spawnScriptPty) {
      Log.info(`[script:interactive] spawning PTY for: ${stepLabel}`);
      ptyExitCode = await context.spawnScriptPty({
        stepName: stepLabel,
        stepIndex: signedStepIndex,
        script: step.script,
        cwd: context.workspaceFolderPath ?? process.cwd(),
        onOutput: onStreamChunk,
      });
    }

    // ─── Headless mode (or PTY unavailable): run as child process ────────────
    // Always run evaluateCondition so we get the structured result (stdout/stderr,
    // passed flag, duration) needed for the final CliOutput and history entry.
    // In interactive mode we skip this since the PTY already ran the script.
    let evalResult:
      | Awaited<ReturnType<typeof this.endConditionEvaluator.evaluateCondition>>
      | undefined;

    if (!isInteractive || ptyExitCode === undefined) {
      evalResult = await this.endConditionEvaluator.evaluateCondition(
        {
          script: step.script,
          compareSource: step.compareSource ?? COMPARE_SOURCES.EXIT_CODE,
          returns: step.returns ?? "0",
          timeout: timeout,
        },
        context.workspaceFolderPath,
        this.promptQueue.getWorkflowFile().vars,
        onStreamChunk
      );
    }

    // For interactive mode, synthesise an EvaluationResult from the PTY exit code.
    if (evalResult === undefined) {
      const exitCode = ptyExitCode ?? 1;
      const passed = EndConditionEvaluator.evaluateExitCodeResult(
        exitCode,
        step.returns,
        step.compareSource
      );
      evalResult = {
        passed,
        stdout: outputChunks.join(""),
        stderr: "",
        result: "",
        duration: Date.now() - timestampMs,
        exitCode,
      };
    }

    const succeeded = evalResult.passed;

    // Build final output text (headless: from evalResult; interactive: empty since xterm shows it)
    const rawOutput = [evalResult.stdout, evalResult.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    // Strip ANSI escape codes for the CliOutput text panel.
    const outputText = rawOutput.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");

    const finalCliOutput = {
      prompt: step.script,
      response: outputText,
      elapsed: evalResult.duration / 1000,
      isStreaming: false,
      source: STEP_TYPES.SCRIPT,
      exitCode: evalResult.exitCode ?? (succeeded ? 0 : 1),
      timestampMs,
      cliCommand: step.script,
      workingDirectory: context.workspaceFolderPath,
    };

    if (context.dashboardProvider && signedStepIndex >= 0) {
      context.dashboardProvider.updateCliOutput(
        signedStepIndex,
        finalCliOutput
      );
    } else if (
      context.dashboardProvider &&
      target.kind === FINAL_STEP_PHASES.FINAL_STEP
    ) {
      context.dashboardProvider.updateFinalStepOutput(
        target.loopIndex,
        finalCliOutput
      );
    }

    // Capture for output history replay (same pattern as updateDashboardWithResponse)
    if (signedStepIndex >= 0) {
      context.captureCompletedOutput?.(signedStepIndex, finalCliOutput);
    } else if (target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
      context.captureFinalStepCompletedOutput?.(
        target.loopIndex,
        finalCliOutput
      );
    }

    if (context.historyFilePath && context.outputHistoryManager) {
      await context.outputHistoryManager
        .saveExecutionOutput(
          context.historyFilePath,
          this.toOutputExecutionTarget(target),
          [finalCliOutput]
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

    const onPass = step.onPass ?? CONDITION_ACTIONS.CONTINUE;
    const onFail = step.onFail ?? CONDITION_ACTIONS.STOP_WORKFLOW;
    const shouldContinue = succeeded
      ? onPass !== CONDITION_ACTIONS.STOP_WORKFLOW
      : onFail !== CONDITION_ACTIONS.STOP_WORKFLOW;
    const terminalStatus = shouldContinue
      ? STEP_STATUS.COMPLETED
      : STEP_STATUS.FAILED;

    if (!succeeded && onFail === CONDITION_ACTIONS.STOP_WORKFLOW) {
      Log.error(
        `Script step failed (exit code ${evalResult.exitCode}): ${stepLabel}`
      );
    } else if (succeeded && onPass === CONDITION_ACTIONS.STOP_WORKFLOW) {
      Log.info(
        `Script step passed but onPass=stopWorkflow, stopping: ${stepLabel}`
      );
    } else if (!succeeded) {
      Log.warn(
        `Script step failed but onFail=continue, continuing: ${stepLabel}`
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

    if (target.kind === FINAL_STEP_PHASES.QUEUE) {
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
    return target.kind === FINAL_STEP_PHASES.QUEUE
      ? { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: target.stepIndex }
      : { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: target.loopIndex };
  }

  /**
   * Maps an ExecutionTarget to the signed integer index used by the dashboard
   * and CLI. Queue steps use their zero-based stepIndex; finalStep loops use
   * negative values (-(loopIndex+1)) so they never collide with queue indices
   * and callers can detect them with `< 0`.
   */
  private getSignedStepIndex(target: ExecutionTarget): number {
    return target.kind === FINAL_STEP_PHASES.QUEUE
      ? target.stepIndex
      : -(target.loopIndex + 1);
  }

  private describeExecutionTarget(target: ExecutionTarget): string {
    return target.kind === FINAL_STEP_PHASES.QUEUE
      ? `queue prompt ${target.stepIndex + 1}`
      : `finalStep loop ${target.loopIndex + 1}`;
  }

  private async persistInterruptedFinalStepRuntime(
    context: WorkflowExecutionContext
  ): Promise<void> {
    const runtime = this.promptQueue.getFinalStepRuntime();
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

    await this.setFinalStepRuntime(context, {
      ...runtime,
      phase: FINAL_STEP_PHASES.FINAL_STEP,
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
    const signedStepIndex = this.getSignedStepIndex(target);

    // Queue steps keep non-negative indices; finalStep loops use negative
    // signed indices (-(loopIndex+1)) to avoid collisions with queue steps.
    context.dashboardProvider?.updateStatusMessage(
      signedStepIndex,
      message,
      severity as any
    );
    if (target.kind === FINAL_STEP_PHASES.QUEUE) {
      context.onStatusMessage?.(target.stepIndex, message, severity);
    } else {
      context.onFinalStepStatusMessage?.(target.loopIndex, message, severity);
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

  private getBufferedCliOutput(
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    signedStepIndex: number
  ): CliOutput | undefined {
    if (target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
      return context.getFinalStepBufferedOutput?.(target.loopIndex);
    }

    return signedStepIndex >= 0
      ? context.getBufferedOutput?.(signedStepIndex)
      : undefined;
  }

  private createFinalCliOutput(params: {
    context: WorkflowExecutionContext;
    integration: HarnessIntegration;
    target: ExecutionTarget;
    signedStepIndex: number;
    prompt: PromptStep;
    attemptIndex: number;
    responseText?: string;
    errorMessage?: string;
  }): CliOutput {
    const {
      context,
      integration,
      target,
      signedStepIndex,
      prompt,
      attemptIndex,
      responseText,
      errorMessage,
    } = params;
    const bufferedOutput = this.getBufferedCliOutput(
      context,
      target,
      signedStepIndex
    );
    const parsedOutput = integration.getLastParsedOutput?.();
    const parsedStructured = parsedOutput
      ? CliOutputFormatter.toDashboardFormat(parsedOutput)
      : undefined;
    const bufferedStructured = bufferedOutput?.structured;
    let structured: DashboardOutput | undefined = parsedStructured;

    if (
      parsedStructured &&
      bufferedStructured?.events &&
      bufferedStructured.events.length > parsedStructured.events.length
    ) {
      structured = {
        ...parsedStructured,
        events: bufferedStructured.events,
      };
    } else if (!parsedStructured && bufferedStructured) {
      structured = bufferedStructured;
    }

    let tokens: CliOutput["tokens"];
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

    return {
      prompt: prompt.prompt,
      response: responseText ?? bufferedOutput?.response ?? "",
      structured,
      elapsed: bufferedOutput?.elapsed ?? 0,
      tokens,
      isStreaming: false,
      cliCommand: context.shouldShowCliCommand
        ? (integration.getLastCliCommand() ?? bufferedOutput?.cliCommand)
        : undefined,
      workingDirectory:
        bufferedOutput?.workingDirectory ?? context.workspaceFolderPath,
      timestampMs:
        bufferedOutput?.timestampMs ??
        this.getAttemptStartedAt(target) ??
        Date.now(),
      attemptIndex,
      rawTextOutput:
        bufferedOutput?.rawTextOutput ??
        (integration.rawTextOutput || undefined),
      errorMessage,
    };
  }

  private async evaluateEndCondition(
    prompt: PromptStep,
    integration: HarnessIntegration,
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    signedStepIndex: number | undefined,
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

      if (context.dashboardProvider && signedStepIndex !== undefined) {
        context.dashboardProvider.updateStepStatus(signedStepIndex, {
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
      const resultStatus = evaluationResult.passed ? "Passed" : "Failed";
      const severity = evaluationResult.passed
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
      signedStepIndex
    );

    const result = await this.endConditionHandler.handleEndConditionResult(
      prompt,
      evaluationResult,
      retryContext,
      sendRetryPromptCallback
    );

    if (!result.shouldContinue) {
      if (context.dashboardProvider && signedStepIndex !== undefined) {
        context.dashboardProvider.updateStepStatus(signedStepIndex, {
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
    signedStepIndex: number | undefined,
    attemptIndex: number,
    sendOptions: WorkflowContext,
    onPromptSent?: () => Promise<void>
  ): Promise<{ responseText: string; duration: number } | null> {
    const runtime = this.promptQueue.getRuntimeStateMachine();
    const attempt = runtime.beginAttempt(target, attemptIndex, Date.now());
    const startTime = Date.now();

    const initTimestampMs = attempt.startedAt;
    const rawTextOutput = integration.rawTextOutput || undefined;

    if (target.kind === FINAL_STEP_PHASES.QUEUE) {
      if (context.dashboardProvider && signedStepIndex !== undefined) {
        context.dashboardProvider.updateCliStreamingChunk(signedStepIndex, "");
        context.dashboardProvider.updateCliOutput(signedStepIndex, {
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

      if (signedStepIndex !== undefined) {
        context.captureOutputInit?.(
          signedStepIndex,
          promptStep.prompt,
          undefined,
          context.workspaceFolderPath,
          initTimestampMs,
          attemptIndex,
          rawTextOutput
        );
      }
    } else {
      context.dashboardProvider?.updateFinalStepOutput(target.loopIndex, {
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
      context.captureFinalStepOutputInit?.(
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

      if (target.kind === FINAL_STEP_PHASES.QUEUE) {
        if (context.dashboardProvider && signedStepIndex !== undefined) {
          context.dashboardProvider.updateCliOutput(signedStepIndex, {
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

        if (signedStepIndex !== undefined) {
          context.captureOutputInit?.(
            signedStepIndex,
            promptStep.prompt,
            cliCommand,
            context.workspaceFolderPath,
            initTimestampMs,
            attemptIndex,
            rawTextOutput
          );
        }
      } else {
        context.dashboardProvider?.updateFinalStepOutput(target.loopIndex, {
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

        context.captureFinalStepOutputInit?.(
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
        target.kind === FINAL_STEP_PHASES.QUEUE &&
        signedStepIndex !== undefined
      ) {
        context.captureChunk?.(signedStepIndex, chunk);
        context.dashboardProvider?.updateCliStreamingChunk(
          signedStepIndex,
          chunk
        );
      } else if (target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
        context.captureFinalStepChunk?.(target.loopIndex, chunk);
        context.dashboardProvider?.updateFinalStepStreamingChunk(
          target.loopIndex,
          chunk
        );
      }
    });

    structuredStreamingDisposable = integration.onStreamingEvents((events) => {
      if (
        target.kind === FINAL_STEP_PHASES.QUEUE &&
        signedStepIndex !== undefined
      ) {
        context.captureEvents?.(signedStepIndex, events);
        context.dashboardProvider?.updateCliStreamingEvents(
          signedStepIndex,
          events
        );
      } else if (target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
        context.captureFinalStepEvents?.(target.loopIndex, events);
        context.dashboardProvider?.updateFinalStepStreamingEvents(
          target.loopIndex,
          events
        );
      }
    });

    const contextWindowDisposable = integration.onContextWindowUpdate(
      ({ used, size }) => {
        if (
          target.kind === FINAL_STEP_PHASES.QUEUE &&
          signedStepIndex !== undefined
        ) {
          context.dashboardProvider?.updateContextWindow(
            signedStepIndex,
            used,
            size
          );
        }
      }
    );

    const disposeListeners = () => {
      streamingDisposable?.dispose();
      structuredStreamingDisposable?.dispose();
      contextWindowDisposable?.dispose();
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
    signedStepIndex: number | undefined
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
        target.kind === FINAL_STEP_PHASES.QUEUE ? signedStepIndex : undefined,
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
          getFinalStepResponseTexts: () =>
            this.promptQueue.getFinalStepResponseTexts(),
          finalStepSessionId: workflowFile.finalStep?._runtime?.sessionId as
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
          signedStepIndex ?? this.getSignedStepIndex(target),
          retryAttemptIndex
        );
        return null;
      }

      await this.updateDashboardWithResponse(
        context,
        integration,
        target,
        target.kind === FINAL_STEP_PHASES.QUEUE ? signedStepIndex : undefined,
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
    signedStepIndex: number,
    attemptIndex: number
  ): Promise<boolean> {
    const runtime = this.getRuntime();
    if (runtime.stopped) {
      // Workflow was stopped by the user. Flush whatever partial output is available
      // so the history file is not empty and the user can resume from the stopped state.
      const failureOutput = integration.getLastFailureOutput?.();
      const failureReason =
        integration.getLastFailureReason() || "Workflow stopped by user";
      const stoppedOutput = this.createFinalCliOutput({
        context,
        integration,
        target,
        signedStepIndex,
        prompt,
        attemptIndex,
        responseText: failureOutput,
        errorMessage: failureReason,
      });
      const statusTimestampMs = Math.max(
        Date.now(),
        (stoppedOutput.timestampMs ?? Date.now()) + 1
      );

      if (context.dashboardProvider && signedStepIndex >= 0) {
        context.dashboardProvider.updateCliOutput(
          signedStepIndex,
          stoppedOutput
        );
      } else if (
        context.dashboardProvider &&
        target.kind === FINAL_STEP_PHASES.FINAL_STEP
      ) {
        context.dashboardProvider.updateFinalStepOutput(
          target.loopIndex,
          stoppedOutput
        );
      }

      if (signedStepIndex >= 0) {
        context.captureCompletedOutput?.(signedStepIndex, stoppedOutput);
      } else if (target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
        context.captureFinalStepCompletedOutput?.(
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

      if (target.kind === FINAL_STEP_PHASES.QUEUE && stoppedOutput.response) {
        await this.promptQueue
          .persistRuntimeMetadata(target.stepIndex, {
            responseText: stoppedOutput.response,
          })
          .catch((err) =>
            Log.warn("Failed to persist stopped response text:", err)
          );
      } else if (
        target.kind === FINAL_STEP_PHASES.FINAL_STEP &&
        stoppedOutput.response
      ) {
        await this.promptQueue
          .storeFinalStepResponseText(target.loopIndex, stoppedOutput.response)
          .catch((err) =>
            Log.warn("Failed to persist stopped finalStep response text:", err)
          );
      }

      await this.trackStatusMessage(
        context,
        target,
        "Stopped by user",
        STATUS_MESSAGE_SEVERITY.WARNING,
        statusTimestampMs
      );

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

      const processExitOutput = this.createFinalCliOutput({
        context,
        integration,
        target,
        signedStepIndex,
        prompt,
        attemptIndex,
        responseText: failureOutput,
        errorMessage: failureReason,
      });

      if (context.dashboardProvider && signedStepIndex >= 0) {
        context.dashboardProvider.updateCliOutput(
          signedStepIndex,
          processExitOutput
        );
      } else if (
        context.dashboardProvider &&
        target.kind === FINAL_STEP_PHASES.FINAL_STEP
      ) {
        context.dashboardProvider.updateFinalStepOutput(
          target.loopIndex,
          processExitOutput
        );
      }

      if (signedStepIndex >= 0) {
        context.captureCompletedOutput?.(signedStepIndex, processExitOutput);
      } else if (target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
        context.captureFinalStepCompletedOutput?.(
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
      signedStepIndex >= 0
        ? `prompt ${signedStepIndex + 1}`
        : `finalStep loop ${Math.abs(signedStepIndex)}`;
    this.platform.error(`Failed to execute ${stepLabel}: ${failureReason}`);

    // Send FAILED status before markErrored() so the step icon updates
    // before the execution state transitions to ERROR (separate postMessages
    // arrive in the same render cycle this way).
    if (context.dashboardProvider && signedStepIndex >= 0) {
      context.dashboardProvider.updateStepStatus(signedStepIndex, {
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

    if (context.dashboardProvider && signedStepIndex >= 0) {
      context.dashboardProvider.updateCliOutput(
        signedStepIndex,
        errorCliOutput
      );
    } else if (
      context.dashboardProvider &&
      target.kind === FINAL_STEP_PHASES.FINAL_STEP
    ) {
      context.dashboardProvider.updateFinalStepOutput(
        target.loopIndex,
        errorCliOutput
      );
    }

    if (signedStepIndex >= 0) {
      context.captureCompletedOutput?.(signedStepIndex, errorCliOutput);
    } else if (target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
      context.captureFinalStepCompletedOutput?.(
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
    signedStepIndex: number | undefined,
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

    if (context.dashboardProvider && signedStepIndex !== undefined) {
      context.dashboardProvider.updateCliOutput(signedStepIndex, cliOutputObj);
    } else if (
      context.dashboardProvider &&
      target.kind === FINAL_STEP_PHASES.FINAL_STEP
    ) {
      context.dashboardProvider.updateFinalStepOutput(
        target.loopIndex,
        cliOutputObj
      );
    }
    if (signedStepIndex !== undefined) {
      context.captureCompletedOutput?.(signedStepIndex, cliOutputObj);
    } else if (target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
      context.captureFinalStepCompletedOutput?.(target.loopIndex, cliOutputObj);
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

  private async setFinalStepRuntime(
    context: WorkflowExecutionContext,
    runtime: FinalStepRuntimeState
  ): Promise<void> {
    await this.promptQueue.setFinalStepRuntime(runtime);
    context.dashboardProvider?.updateFinalStepStatus(
      runtime.status ?? null,
      runtime.loopCount,
      runtime.phase
    );
  }
}
