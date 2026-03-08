import * as path from "path";
import { PlatformAdapter } from "../platform/PlatformAdapter";
import {
  PromptItem,
  PromptFile,
  DynamicQueueConfig,
  FinalPromptRuntimeState,
  EXECUTION_STATES,
  Harness,
} from "../types/FlightPathTypes";
import {
  STEP_STATUS,
  STATUS_MESSAGE_SEVERITY,
  FINAL_PROMPT_PHASES,
} from "../types/DashboardConstants";
import { PromptQueue } from "./PromptQueue";
import { PromptFileParser } from "./PromptFileParser";
import { HarnessIntegration } from "./HarnessIntegration";
import {
  EndConditionHandler,
  SendRetryPromptCallback,
} from "./EndConditionHandler";
import { EndConditionEvaluator } from "./EndConditionEvaluator";
import { FlightPathWebviewProvider } from "../ui/FlightPathWebviewProvider";
import { Log } from "../utils/Log";
import {
  PropertyResolver,
  ResolvedProperties,
} from "../utils/PropertyResolver";
import {
  CliOutputFormatter,
  DashboardOutput,
} from "./harness/shared/CliOutputFormatter";
import { OutputHistoryManager } from "./orchestration/OutputHistoryManager";
import { StatusMessage, CliEvent } from "../types/WebviewMessageTypes";

export interface WorkflowExecutionContext {
  workspaceFolderPath: string | undefined;
  currentPromptFilePath: string | undefined;
  dashboardProvider?: FlightPathWebviewProvider;
  shouldShowCliCommand: boolean;
  showCliOutput: boolean;
  dynamicQueueConfig: DynamicQueueConfig;
  getIntegrationForPrompt: (
    prompt: PromptItem,
    harnessOverride?: Harness
  ) => HarnessIntegration;
  historyFilePath: string;
  workingFilePath?: string;
  instanceTag?: string;
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
}

type ExecutionTarget =
  | { kind: "queue"; stepIndex: number }
  | { kind: "finalPrompt"; loopIndex: number };

type StepExecutionKey = `queue:${number}` | `final:${number}`;

/**
 * Drives the sequential execution loop for a FlightPath workflow.
 *
 * The outer loop has two phases:
 *   1. **Queue phase** — drains normal prompts via `promptQueue.hasNext()`.
 *   2. **finalPrompt phase** — runs the orchestrator gate once the queue is empty.
 *      If `finalPrompt.allowDynamicExtension` is true and the gate appends new
 *      prompts, the outer loop repeats (queue → finalPrompt → queue → …).
 *
 * Pause/resume is implemented by holding the response promise until
 * `resumePendingResponse()` is called by `FlightPathManager`.
 */
export class WorkflowExecutor {
  private pendingResponseResolver: ((text: string) => void) | null = null;
  private pendingResponseText: string | null = null;
  private isWaitingForResponse: boolean = false;

  private stepStatusMessages: Map<StepExecutionKey, StatusMessage[]> =
    new Map();

  constructor(
    private readonly promptQueue: PromptQueue,
    private readonly promptFileParser: PromptFileParser,
    private readonly endConditionHandler: EndConditionHandler,
    private readonly endConditionEvaluator: EndConditionEvaluator,
    private readonly platform: PlatformAdapter
  ) {}

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
    this.stepStatusMessages.clear();

    await this.promptQueue.start();
    this.promptQueue.startExecutionTimer();

    await this.showDashboard();

    this.logWorkflowStart(
      context,
      defaultIntegration,
      this.promptQueue.getProgress().total
    );

    const workflowFile = this.promptQueue.getWorkflowFile();
    const getFinalPrompt = () => this.promptQueue.getWorkflowFile().finalPrompt;

    const initialFinalPrompt = getFinalPrompt();

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
            kind: "queue",
            stepIndex: state.currentIndex,
          };
          const prompt = state.prompts[state.currentIndex];

          const shouldContinue = await this.executeSinglePrompt(
            target,
            prompt,
            context
          );
          if (!shouldContinue) {
            break;
          }
        }
      }

      runFinalPromptFirst = false;

      const statusAfterQueue = this.promptQueue.getState().status;
      if (statusAfterQueue !== EXECUTION_STATES.RUNNING) {
        break;
      }

      const currentFinalPrompt = getFinalPrompt();
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

      const runtime = this.promptQueue.getFinalPromptRuntime();
      const loopIndex = runtime?.loopCount ?? 0;
      const queueSizeBefore = this.promptQueue.getState().prompts.length;

      await this.setFinalPromptRuntime(context, {
        phase: FINAL_PROMPT_PHASES.FINAL_PROMPT,
        loopCount: loopIndex,
        status: STEP_STATUS.RUNNING,
        startedAt: Date.now(),
      });

      const shouldContinue = await this.executeSinglePrompt(
        { kind: "finalPrompt", loopIndex },
        currentFinalPrompt,
        context
      );
      if (!shouldContinue) {
        await this.persistInterruptedFinalPromptRuntime(context);
        break;
      }

      const statusAfterFinal = this.promptQueue.getState().status;
      if (statusAfterFinal !== EXECUTION_STATES.RUNNING) {
        await this.persistInterruptedFinalPromptRuntime(context);
        break;
      }

      const queueSizeAfter = this.promptQueue.getState().prompts.length;
      if (queueSizeAfter > queueSizeBefore) {
        const finalPromptAllowsDynamic = PropertyResolver.resolve(
          currentFinalPrompt,
          workflowFile
        ).allowDynamicExtension;
        if (!finalPromptAllowsDynamic) {
          await this.setFinalPromptRuntime(context, {
            phase: FINAL_PROMPT_PHASES.FINAL_PROMPT,
            loopCount: loopIndex,
            status: STEP_STATUS.COMPLETED,
            startedAt: this.promptQueue.getFinalPromptRuntime()?.startedAt,
            completedAt: Date.now(),
          });
          break;
        }

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
    await this.finalizeWorkflowExecution(context);
    this.logWorkflowCompletion(context, this.promptQueue.getProgress().total);
  }

  private async executeSinglePrompt(
    target: ExecutionTarget,
    prompt: PromptItem,
    context: WorkflowExecutionContext
  ): Promise<boolean> {
    const state = this.promptQueue.getState();
    const currentStatus = state.status;

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
      target.kind === "queue" ? target.stepIndex : state.currentIndex;
    const shouldStopForTime = await this.checkExecutionTimeLimit(
      context.dynamicQueueConfig,
      guardIndex,
      progress.total
    );
    if (shouldStopForTime) {
      return false;
    }

    const workflowFile = this.promptQueue.getWorkflowFile();
    const resolvedProperties = PropertyResolver.resolve(prompt, workflowFile);

    const integration = context.getIntegrationForPrompt(
      prompt,
      resolvedProperties.harness
    );

    if (target.kind === "queue") {
      this.updateDashboardForPromptStart(context, prompt, target.stepIndex);
      integration.setWorkflowProgress(target.stepIndex + 1, progress.total);
      Log.info(`Executing prompt ${target.stepIndex + 1}/${progress.total}`);
    } else {
      Log.info(`Executing finalPrompt loop ${target.loopIndex + 1}`);
    }

    const legacyStepIndex = this.getLegacyStepIndex(target);
    const sendPromptIndex =
      target.kind === "queue" ? target.stepIndex : state.prompts.length;

    const result = await this.executeWithStreaming(
      prompt,
      integration,
      context,
      target,
      target.kind === "queue" ? legacyStepIndex : undefined,
      0,
      {
        promptIndex: sendPromptIndex,
        allPrompts: state.prompts,
        filePath: context.currentPromptFilePath,
        workingFilePath: context.workingFilePath,
        resolvedProperties,
        workflowFile,
        promptQueue: this.promptQueue,
        finalPromptSessionId:
          target.kind === "finalPrompt"
            ? (workflowFile.finalPrompt?._runtime?.sessionId as
                | string
                | undefined)
            : undefined,
      },
      async () => {
        if (target.kind === "queue") {
          await this.promptQueue.markCurrentAsSent();
        }
        this.isWaitingForResponse = true;
      }
    );

    if (!result) {
      return this.handlePromptSendFailure(
        integration,
        context,
        legacyStepIndex
      );
    }

    const { responseText, duration } = result;

    // Store response text for priorContext injection in subsequent prompts.
    if (target.kind === "queue") {
      // Queue prompts: store on _runtime for "all" / "previous" / array-index access
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
      target.kind === "queue" ? legacyStepIndex : undefined,
      prompt,
      responseText,
      duration
    );

    if (prompt.endCondition) {
      const shouldContinue = await this.evaluateEndCondition(
        prompt,
        integration,
        context,
        target,
        target.kind === "queue" ? legacyStepIndex : undefined,
        duration
      );

      if (!shouldContinue) {
        Log.info("Workflow stopped due to end condition failure");
        await this.promptQueue.markErrored();
        return false;
      }

      if (target.kind === "queue" && context.dashboardProvider) {
        context.dashboardProvider.updateStepStatus(legacyStepIndex, {
          state: STEP_STATUS.COMPLETED,
          duration,
        });
        context.dashboardProvider.updateRetryAttempt(legacyStepIndex, 0, 0);
      }
    } else if (target.kind === "queue" && context.dashboardProvider) {
      context.dashboardProvider.updateStepStatus(legacyStepIndex, {
        state: STEP_STATUS.COMPLETED,
        duration,
      });
    }

    if (target.kind === "queue") {
      await this.promptQueue.completeCurrentAndMoveNext();

      if (context.dashboardProvider) {
        const live = this.promptQueue.getProgress();
        context.dashboardProvider.updateProgress(live.current, live.total);
      }

      if (this.promptQueue.getState().status === EXECUTION_STATES.PAUSED) {
        Log.info("Workflow paused");
        return false;
      }
    }

    return true;
  }

  private getExecutionKey(target: ExecutionTarget): StepExecutionKey {
    return target.kind === "queue"
      ? `queue:${target.stepIndex}`
      : `final:${target.loopIndex}`;
  }

  /**
   * Maps an ExecutionTarget to the signed integer index expected by legacy
   * dashboard/CLI callers. Queue steps use their zero-based stepIndex;
   * finalPrompt loops use negative values (-(loopIndex+1)) so they never
   * collide with queue indices and callers can detect them with `< 0`.
   */
  private getLegacyStepIndex(target: ExecutionTarget): number {
    return target.kind === "queue" ? target.stepIndex : -(target.loopIndex + 1);
  }

  private describeExecutionTarget(target: ExecutionTarget): string {
    return target.kind === "queue"
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

    const executionState = this.promptQueue.getState().status;
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

  private trackStatusMessage(
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    message: string,
    severity: string = STATUS_MESSAGE_SEVERITY.INFO
  ): void {
    const key = this.getExecutionKey(target);
    const legacyStepIndex = this.getLegacyStepIndex(target);

    // Queue steps keep non-negative indices; finalPrompt loops use negative
    // legacy indices (-(loopIndex+1)) to avoid collisions with queue steps.
    context.dashboardProvider?.updateStatusMessage(
      legacyStepIndex,
      message,
      severity as any
    );
    if (target.kind === "queue") {
      context.onStatusMessage?.(target.stepIndex, message, severity);
    } else {
      context.onFinalPromptStatusMessage?.(target.loopIndex, message, severity);
      // Backward-compatible channel used by CLI renderers and existing listeners.
      context.onStatusMessage?.(legacyStepIndex, message, severity);
    }

    const messages = this.stepStatusMessages.get(key) ?? [];
    messages.push({
      message,
      severity: severity as any,
      timestamp: Date.now(),
    });
    this.stepStatusMessages.set(key, messages);
  }

  private async evaluateEndCondition(
    prompt: PromptItem,
    integration: HarnessIntegration,
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    legacyStepIndex: number | undefined,
    duration: number
  ): Promise<boolean> {
    Log.debug(
      `Evaluating end condition for ${this.describeExecutionTarget(target)}...`
    );

    if (!prompt.endCondition?.script) {
      Log.error(
        `End condition for ${this.describeExecutionTarget(target)} is missing required 'script' property`
      );
      this.trackStatusMessage(
        context,
        target,
        "End condition failed: Missing script property",
        STATUS_MESSAGE_SEVERITY.ERROR
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
    this.trackStatusMessage(
      context,
      target,
      `Evaluating end condition: Running ${scriptName}`
    );

    const evaluationResult = await this.endConditionEvaluator.evaluateCondition(
      prompt.endCondition,
      context.workspaceFolderPath
    );

    {
      const resultStatus = evaluationResult.success ? "Passed" : "Failed";
      const severity = evaluationResult.success
        ? STATUS_MESSAGE_SEVERITY.INFO
        : STATUS_MESSAGE_SEVERITY.ERROR;
      const output = evaluationResult.error
        ? evaluationResult.error
        : evaluationResult.stdout.trim();
      this.trackStatusMessage(
        context,
        target,
        `End condition ${resultStatus} - Output: ${output}`,
        severity
      );
    }

    const retryContext = {
      integration,
      totalPrompts: this.promptQueue.getState().prompts.length,
      workspaceFolderPath: context.workspaceFolderPath,
      currentPromptFilePath: context.currentPromptFilePath,
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
    prompt: PromptItem,
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

          const currentState = this.promptQueue.getState();
          if (currentState.status === EXECUTION_STATES.PAUSED) {
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
    promptItem: PromptItem,
    integration: HarnessIntegration,
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    legacyStepIndex: number | undefined,
    attemptIndex: number,
    sendOptions: {
      promptIndex: number;
      allPrompts: PromptItem[];
      filePath?: string;
      workingFilePath?: string;
      resolvedProperties?: ResolvedProperties;
      workflowFile?: PromptFile;
      promptQueue?: PromptQueue;
      finalPromptSessionId?: string;
    },
    onPromptSent?: () => Promise<void>
  ): Promise<{ responseText: string; duration: number } | null> {
    const startTime = Date.now();

    const initTimestampMs = Date.now();
    const rawTextOutput = integration.rawTextOutput || undefined;

    if (target.kind === "queue") {
      if (context.dashboardProvider && legacyStepIndex !== undefined) {
        context.dashboardProvider.updateCliStreamingChunk(legacyStepIndex, "");
        context.dashboardProvider.updateCliOutput(legacyStepIndex, {
          prompt: promptItem.prompt,
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
          promptItem.prompt,
          undefined,
          context.workspaceFolderPath,
          initTimestampMs,
          attemptIndex,
          rawTextOutput
        );
      }
    } else {
      context.dashboardProvider?.updateFinalPromptOutput(target.loopIndex, {
        prompt: promptItem.prompt,
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
        promptItem.prompt,
        undefined,
        context.workspaceFolderPath,
        initTimestampMs,
        attemptIndex,
        rawTextOutput
      );
    }

    const responsePromise = this.waitForResponseComplete(
      promptItem,
      integration
    );

    let streamingDisposable: { dispose(): void } | undefined;
    let structuredStreamingDisposable: { dispose(): void } | undefined;
    let promptReadyDisposable: { dispose(): void } | undefined;

    promptReadyDisposable = integration.onPromptReady((data) => {
      const cliCommand = context.shouldShowCliCommand
        ? data.cliCommand
        : undefined;

      if (target.kind === "queue") {
        if (context.dashboardProvider && legacyStepIndex !== undefined) {
          context.dashboardProvider.updateCliOutput(legacyStepIndex, {
            prompt: promptItem.prompt,
            response: "",
            elapsed: 0,
            tokens: undefined,
            isStreaming: true,
            cliCommand,
            workingDirectory: context.workspaceFolderPath,
            timestampMs: Date.now(),
            attemptIndex,
            rawTextOutput,
          });
        }

        if (legacyStepIndex !== undefined) {
          context.captureOutputInit?.(
            legacyStepIndex,
            promptItem.prompt,
            cliCommand,
            context.workspaceFolderPath,
            Date.now(),
            attemptIndex,
            rawTextOutput
          );
        }
      } else {
        context.dashboardProvider?.updateFinalPromptOutput(target.loopIndex, {
          prompt: promptItem.prompt,
          response: "",
          elapsed: 0,
          tokens: undefined,
          isStreaming: true,
          cliCommand,
          workingDirectory: context.workspaceFolderPath,
          timestampMs: Date.now(),
          attemptIndex,
          rawTextOutput,
        });

        context.captureFinalPromptOutputInit?.(
          target.loopIndex,
          promptItem.prompt,
          cliCommand,
          context.workspaceFolderPath,
          Date.now(),
          attemptIndex,
          rawTextOutput
        );
      }
    });

    streamingDisposable = integration.onStreamingChunk((chunk) => {
      if (target.kind === "queue" && legacyStepIndex !== undefined) {
        context.captureChunk?.(legacyStepIndex, chunk);
        context.dashboardProvider?.updateCliStreamingChunk(
          legacyStepIndex,
          chunk
        );
      } else if (target.kind === "finalPrompt") {
        context.captureFinalPromptChunk?.(target.loopIndex, chunk);
      }
    });

    structuredStreamingDisposable = integration.onStreamingEvents((events) => {
      if (target.kind === "queue" && legacyStepIndex !== undefined) {
        context.captureEvents?.(legacyStepIndex, events);
        context.dashboardProvider?.updateCliStreamingEvents(
          legacyStepIndex,
          events
        );
      } else if (target.kind === "finalPrompt") {
        context.captureFinalPromptEvents?.(target.loopIndex, events);
      }
    });

    const disposeListeners = () => {
      streamingDisposable?.dispose();
      structuredStreamingDisposable?.dispose();
      promptReadyDisposable?.dispose();
    };

    const success = await integration.sendPrompt(promptItem, true, sendOptions);
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
      retryPromptItem: PromptItem,
      currentIndex: number
    ): Promise<string | null> => {
      const retryAttemptIndex = this.promptQueue.getCurrentRetryCount();
      const state = this.promptQueue.getState();
      const workflowFile = this.promptQueue.getWorkflowFile();
      const resolvedProperties = PropertyResolver.resolve(
        retryPromptItem,
        workflowFile
      );

      const result = await this.executeWithStreaming(
        retryPromptItem,
        integration,
        context,
        target,
        target.kind === "queue" ? legacyStepIndex : undefined,
        retryAttemptIndex,
        {
          promptIndex: currentIndex,
          allPrompts: state.prompts,
          filePath: context.currentPromptFilePath,
          workingFilePath: context.workingFilePath,
          resolvedProperties: { ...resolvedProperties, resumeSession: true },
          workflowFile,
          promptQueue: this.promptQueue,
          finalPromptSessionId:
            target.kind === "finalPrompt"
              ? (workflowFile.finalPrompt?._runtime?.sessionId as
                  | string
                  | undefined)
              : undefined,
        }
      );

      if (!result) {
        return null;
      }

      await this.updateDashboardWithResponse(
        context,
        integration,
        target,
        target.kind === "queue" ? legacyStepIndex : undefined,
        retryPromptItem,
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

  /** Called by `FlightPathManager.resume()` when there is a held response. */
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
    totalPrompts: number
  ): void {
    if (!context.showCliOutput) {
      return;
    }

    const tag = context.instanceTag ? `${context.instanceTag} ` : "";
    const workflowName = path.basename(
      context.currentPromptFilePath ?? "unknown"
    );
    Log.info(
      `${tag}Workflow started - ${workflowName}, ${totalPrompts} prompt(s), harness: ${integration.getStatus().strategy}`
    );
  }

  private logWorkflowCompletion(
    context: WorkflowExecutionContext,
    totalPrompts: number
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
      `${tag}Workflow complete - ${workflowName}, ${completedCount}/${totalPrompts} prompts completed`
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
    totalPrompts: number
  ): Promise<boolean> {
    const maxTimeSec = dynamicConfig.maxWorkflowExecutionTime;
    const unlimitedWorkflow = dynamicConfig.unlimitedMode || maxTimeSec === -1;

    if (unlimitedWorkflow) {
      return false;
    }

    const elapsedMs = this.promptQueue.getActiveExecutionTime();
    const elapsedSec = Math.floor(elapsedMs / 1000);

    if (elapsedSec >= maxTimeSec) {
      const completedCount = this.promptQueue.getCompletedCount();
      const remainingCount = totalPrompts - currentIndex;

      const message = `Workflow stopped - Maximum execution time reached (${elapsedSec}s / ${maxTimeSec}s).\nCompleted ${completedCount} of ${totalPrompts} prompts. ${remainingCount} prompts remaining in queue.`;

      this.platform.warn(message);
      Log.trace(`⏱️ ${message}`);

      await this.promptQueue.markErrored();
      return true;
    }

    return false;
  }

  private async checkQueueSizeLimit(
    dynamicConfig: DynamicQueueConfig,
    totalPrompts: number
  ): Promise<boolean> {
    if (dynamicConfig.unlimitedMode || dynamicConfig.maxQueueSize <= 0) {
      return false;
    }

    if (totalPrompts <= dynamicConfig.maxQueueSize) {
      return false;
    }

    const message = `Workflow stopped - Maximum queue size reached (${totalPrompts}/${dynamicConfig.maxQueueSize}).`;
    this.platform.warn(message);
    Log.trace(`📏 ${message}`);
    await this.promptQueue.markErrored();
    return true;
  }

  private updateDashboardForPromptStart(
    context: WorkflowExecutionContext,
    prompt: PromptItem,
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
    currentIndex: number
  ): Promise<boolean> {
    const queueState = this.promptQueue.getState();
    if (queueState.stopped) {
      return false;
    }

    if (integration.wasLastFailureUserCancellation()) {
      this.promptQueue.stop();
      return false;
    }

    const failureReason = integration.getLastFailureReason();
    const stepLabel =
      currentIndex >= 0
        ? `prompt ${currentIndex + 1}`
        : `finalPrompt loop ${Math.abs(currentIndex)}`;
    this.platform.error(`Failed to execute ${stepLabel}: ${failureReason}`);

    await this.promptQueue.markErrored();

    if (context.dashboardProvider && currentIndex >= 0) {
      context.dashboardProvider.updateStepStatus(currentIndex, {
        state: STEP_STATUS.FAILED,
        message: failureReason,
      });
    }

    return false;
  }

  private async updateDashboardWithResponse(
    context: WorkflowExecutionContext,
    integration: HarnessIntegration,
    target: ExecutionTarget,
    legacyStepIndex: number | undefined,
    prompt: PromptItem,
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
      timestampMs: Date.now(),
      attemptIndex,
      rawTextOutput: integration.rawTextOutput || undefined,
    };

    if (context.dashboardProvider && legacyStepIndex !== undefined) {
      context.dashboardProvider.updateCliOutput(legacyStepIndex, cliOutputObj);
    } else if (context.dashboardProvider && target.kind === "finalPrompt") {
      context.dashboardProvider.updateFinalPromptOutput(
        target.loopIndex,
        cliOutputObj
      );
    }
    if (legacyStepIndex !== undefined) {
      context.captureCompletedOutput?.(legacyStepIndex, cliOutputObj);
    } else if (target.kind === "finalPrompt") {
      context.captureFinalPromptCompletedOutput?.(
        target.loopIndex,
        cliOutputObj
      );
    }

    if (context.historyFilePath && context.outputHistoryManager) {
      const key = this.getExecutionKey(target);
      const statusMessages = this.stepStatusMessages.get(key) ?? [];
      await context.outputHistoryManager
        .saveExecutionOutput(
          context.historyFilePath,
          target.kind === "queue"
            ? { kind: "queue", stepIndex: target.stepIndex }
            : { kind: "finalPrompt", loopIndex: target.loopIndex },
          [cliOutputObj],
          statusMessages
        )
        .catch((err) =>
          Log.warn("Failed to save step output to history:", err)
        );
    }
  }

  private async finalizeWorkflowExecution(
    context: WorkflowExecutionContext
  ): Promise<void> {
    const finalState = this.promptQueue.getState();
    if (
      finalState.status !== EXECUTION_STATES.PAUSED &&
      finalState.status !== EXECUTION_STATES.STOPPED &&
      finalState.status !== EXECUTION_STATES.CANCELLING &&
      finalState.status !== EXECUTION_STATES.ERROR
    ) {
      await this.promptQueue.markCompleted();
      if (context.dashboardProvider) {
        context.dashboardProvider.updateExecutionCompleted();
      }
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
