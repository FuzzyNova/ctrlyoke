import type { PlatformAdapter } from "../platform/PlatformAdapter";
import {
  PromptStep,
  type ScriptProperties,
  type ScriptVerdict,
  type WorkflowAttemptTarget,
  type EndConditionAction,
} from "../types/CtrlYokeTypes";
import {
  STATUS_MESSAGE_SEVERITY,
  CONDITION_ACTIONS,
} from "../types/DashboardConstants";
import { Log } from "../utils/Log";
import {
  EndConditionEvaluator,
  EvaluationResult,
} from "./EndConditionEvaluator";
import { PromptQueue } from "./PromptQueue";
import { HarnessIntegration } from "./HarnessIntegration";
import type { WorkflowStateMachine } from "./WorkflowStateMachine";
import type { IDashboardSink } from "../types/IDashboardSink";

/** Dialog action labels used in error/retry dialogs (single-sourced to prevent typo drift) */
const DIALOG_ACTIONS = {
  STOP_WORKFLOW: "Stop Workflow",
  CONTINUE_ANYWAY: "Continue Anyway",
  RETRY_ONCE_MORE: "Retry Once More",
} as const;

/**
 * Context needed to handle retry prompts
 */
export interface RetryContext {
  integration: HarnessIntegration;
  totalSteps: number;
  workspaceFolderPath: string | undefined;
  currentPromptFilePath: string | undefined;
  runtime: WorkflowStateMachine;
  attemptTarget: WorkflowAttemptTarget;
  attemptIndex: number;
  /** Workflow variables injected into every retry evaluation. */
  vars?: Record<string, string>;
  /** Optional reporter-backed evaluation used to publish retry output. */
  evaluateCondition?: (
    condition: ScriptProperties,
    attemptIndex: number
  ) => Promise<{
    evaluationResult: EvaluationResult;
    verdict?: ScriptVerdict;
  }>;
  /** Receives each end-condition re-evaluation performed after a retry prompt. */
  onEvaluation?: (
    evaluationResult: EvaluationResult,
    attemptIndex: number,
    verdict?: ScriptVerdict
  ) => Promise<void>;
}

/**
 * Callback for sending retry prompts to Copilot.
 * Returns the response text on success, null on failure.
 */
export type SendRetryPromptCallback = (
  retryPromptStep: PromptStep,
  currentIndex: number,
  attemptIndex: number
) => Promise<string | null>;

/**
 * Result of handling an end condition evaluation.
 * Contains all information needed for the caller to update UI/state.
 */
export interface EndConditionHandlerResult {
  /** Whether the workflow should continue */
  shouldContinue: boolean;
  /** Failure reason if shouldContinue is false (for dashboard/logging) */
  failureReason?: string;
  /** Internal: user requested one more retry attempt despite max retries being exhausted */
  retryOnceMore?: boolean;
  /** An internal evaluator failure that must be routed by the executor. */
  errorResult?: EvaluationResult;
  /** Attempt index at which errorResult occurred. */
  errorAttemptIndex?: number;
}

/**
 * Handles end condition evaluation results, retry logic, and failure handling.
 *
 * Responsibilities:
 * - Determine success/failure of end condition evaluations
 * - Orchestrate retry attempts with configurable prompts
 * - Handle validation failures (output doesn't match expected)
 * - Provide user interaction for error recovery decisions
 *
 * This class extracts retry/validation logic from WorkflowOrchestrator to improve
 * separation of concerns and testability.
 */
export class EndConditionHandler {
  constructor(
    private readonly endConditionEvaluator: EndConditionEvaluator,
    private readonly promptQueue: PromptQueue,
    private readonly getDashboard: () => IDashboardSink | undefined = () =>
      undefined,
    private readonly platform?: PlatformAdapter
  ) {}

  /**
   * Handle end condition evaluation result
   * @returns Result object with shouldContinue and optional failureReason
   */
  async handleEndConditionResult(
    prompt: PromptStep,
    evaluationResult: EvaluationResult,
    retryContext: RetryContext,
    sendRetryPrompt: SendRetryPromptCallback
  ): Promise<EndConditionHandlerResult> {
    const onPass: EndConditionAction =
      prompt.endCondition?.onPass ?? CONDITION_ACTIONS.CONTINUE;
    const onFail: EndConditionAction =
      prompt.endCondition?.onFail ?? CONDITION_ACTIONS.STOP_WORKFLOW;

    // Evaluation errors are internal failures, not condition outcomes. The
    // executor owns their policy because retry must re-enter the whole step.
    if (evaluationResult.errored) {
      return {
        shouldContinue: false,
        failureReason: evaluationResult.error ?? "End condition could not run",
        errorResult: evaluationResult,
        errorAttemptIndex: retryContext.attemptIndex,
      };
    }

    // Apply maxRetries default of 1 when either retry direction is enabled and
    // maxRetries is unset.
    if (
      (onFail === CONDITION_ACTIONS.RETRY ||
        onPass === CONDITION_ACTIONS.RETRY) &&
      prompt.endCondition &&
      prompt.endCondition.maxRetries === undefined
    ) {
      prompt = {
        ...prompt,
        endCondition: { ...prompt.endCondition, maxRetries: 1 },
      };
    }

    return await this.handleEndConditionIterative(
      prompt,
      evaluationResult,
      retryContext,
      sendRetryPrompt
    );
  }

  /**
   * Handle pass and validation-failure outcomes iteratively.
   * Uses one loop so both retry directions share attempt bookkeeping and
   * re-evaluation behavior.
   */
  private async handleEndConditionIterative(
    prompt: PromptStep,
    initialEvaluationResult: EvaluationResult,
    retryContext: RetryContext,
    sendRetryPrompt: SendRetryPromptCallback
  ): Promise<EndConditionHandlerResult> {
    const onPass: EndConditionAction =
      prompt.endCondition?.onPass ?? CONDITION_ACTIONS.CONTINUE;
    const onFail: EndConditionAction =
      prompt.endCondition?.onFail ?? CONDITION_ACTIONS.STOP_WORKFLOW;
    let evaluationResult = initialEvaluationResult;
    let manualRetryRequested = false;
    let currentAttemptIndex = retryContext.attemptIndex;

    while (true) {
      if (evaluationResult.errored) {
        return {
          shouldContinue: false,
          failureReason:
            evaluationResult.error ?? "End condition could not run",
          errorResult: evaluationResult,
          errorAttemptIndex: currentAttemptIndex,
        };
      }

      if (evaluationResult.passed) {
        Log.info("✅ End condition passed");
        this.recordPassingEvaluation(evaluationResult);

        if (onPass === CONDITION_ACTIONS.STOP_WORKFLOW) {
          const reason = "End condition passed with onPass: stopWorkflow";
          this.promptQueue.resetRetryCount();
          retryContext.runtime.failAttempt(
            retryContext.attemptTarget,
            currentAttemptIndex,
            reason
          );
          return { shouldContinue: false, failureReason: reason };
        }

        if (onPass === CONDITION_ACTIONS.RETRY) {
          if (retryContext.runtime.stopped) {
            return this.workflowStopped("Workflow stopped by user");
          }

          if (this.promptQueue.canPassRetry(prompt)) {
            const retryResult = await this.sendRetryPromptAndEvaluate(
              prompt,
              evaluationResult,
              retryContext,
              sendRetryPrompt,
              currentAttemptIndex,
              "pass",
              true
            );
            if ("handlerResult" in retryResult) {
              return retryResult.handlerResult;
            }
            evaluationResult = retryResult.evaluationResult;
            currentAttemptIndex = retryResult.attemptIndex;
            continue;
          }

          Log.info(
            `✅ Pass-retry budget exhausted after ${this.promptQueue.getCurrentRetryCount()} retries; advancing`
          );
        }

        this.promptQueue.resetRetryCount();
        retryContext.runtime.completeAttempt(
          retryContext.attemptTarget,
          currentAttemptIndex
        );
        return { shouldContinue: true };
      }

      // Preserve the existing failure-side behavior: onFail: continue
      // advances immediately, while other actions use the conversational
      // retry/exhaustion flow whenever retry settings permit it.
      if (retryContext.runtime.stopped) {
        Log.info("⚠️ Workflow stopped, aborting retry");
        return this.workflowStopped("Workflow stopped by user");
      }

      if (onFail === CONDITION_ACTIONS.CONTINUE) {
        Log.warn("⚠️ End condition failed, continuing due to onFail: continue");
        this.promptQueue.resetRetryCount();
        retryContext.runtime.completeAttempt(
          retryContext.attemptTarget,
          currentAttemptIndex
        );
        return { shouldContinue: true };
      }

      if (!manualRetryRequested && !this.promptQueue.canRetry(prompt)) {
        const exhaustedResult = await this.handleMaxRetriesExhausted(
          prompt,
          evaluationResult,
          retryContext,
          currentAttemptIndex
        );
        if (exhaustedResult.retryOnceMore) {
          manualRetryRequested = true;
          continue;
        }
        return exhaustedResult;
      }

      const retryResult = await this.sendRetryPromptAndEvaluate(
        prompt,
        evaluationResult,
        retryContext,
        sendRetryPrompt,
        currentAttemptIndex,
        "failure",
        !manualRetryRequested
      );
      manualRetryRequested = false;
      if ("handlerResult" in retryResult) {
        return retryResult.handlerResult;
      }
      evaluationResult = retryResult.evaluationResult;
      currentAttemptIndex = retryResult.attemptIndex;
    }
  }

  /**
   * Backward-compatible entry point for callers that start with a validation
   * failure. The implementation is shared with pass-retry handling.
   */
  async handleValidationFailureIterative(
    prompt: PromptStep,
    initialEvaluationResult: EvaluationResult,
    retryContext: RetryContext,
    sendRetryPrompt: SendRetryPromptCallback
  ): Promise<EndConditionHandlerResult> {
    return this.handleEndConditionIterative(
      prompt,
      initialEvaluationResult,
      retryContext,
      sendRetryPrompt
    );
  }

  private async sendRetryPromptAndEvaluate(
    prompt: PromptStep,
    evaluationResult: EvaluationResult,
    retryContext: RetryContext,
    sendRetryPrompt: SendRetryPromptCallback,
    currentAttemptIndex: number,
    retryKind: "pass" | "failure",
    incrementRetryCount: boolean
  ): Promise<
    | { evaluationResult: EvaluationResult; attemptIndex: number }
    | { handlerResult: EndConditionHandlerResult }
  > {
    if (retryContext.runtime.stopped) {
      return { handlerResult: this.workflowStopped("Workflow stopped by user") };
    }

    if (incrementRetryCount) {
      this.promptQueue.incrementRetryCount();
    }

    const currentRetry = this.promptQueue.getCurrentRetryCount();
    const maxRetries = this.promptQueue.getEffectiveMaxRetries(prompt);
    const currentIndex = this.promptQueue.getState().currentIndex;
    const nextAttemptIndex = currentAttemptIndex + 1;
    const retryPromptText =
      retryKind === "pass"
        ? this.buildPassRetryPrompt(prompt, evaluationResult)
        : this.buildRetryPrompt(prompt, evaluationResult);

    retryContext.runtime.scheduleRetry(
      retryContext.attemptTarget,
      nextAttemptIndex,
      currentRetry,
      maxRetries
    );

    Log.info(
      retryKind === "pass"
        ? `🔄 End condition passed, re-running (pass retry ${currentRetry}/${maxRetries})...`
        : `🔄 Validation failed, retrying (attempt ${currentRetry}/${maxRetries})...`
    );

    const hasQueueStep =
      currentIndex < this.promptQueue.getState().results.length;
    const retryDashboard = this.getDashboard();
    if (retryDashboard && hasQueueStep) {
      const retryPromptPreview = retryPromptText
        .split("\n")[0]
        .substring(0, 60);
      const ellipsis = retryPromptText.length > 60 ? "..." : "";
      const statusMessage =
        retryKind === "pass"
          ? `Re-running Prompt ${currentIndex + 1} (Pass retry ${currentRetry}/${maxRetries}): ${retryPromptPreview}${ellipsis}`
          : `Retrying Prompt ${currentIndex + 1} (Attempt ${currentRetry}/${maxRetries}): ${retryPromptPreview}${ellipsis}`;
      retryDashboard.updateStatusMessage(
        currentIndex,
        statusMessage,
        STATUS_MESSAGE_SEVERITY.WARNING
      );
    }

    const retryPromptStep: PromptStep = {
      prompt: retryPromptText,
      model: prompt.model,
      endCondition: prompt.endCondition,
      resumeSession: prompt.endCondition?.resumeSessionOnRetry ?? true,
    };

    retryContext.integration.setWorkflowProgress(
      currentIndex + 1,
      retryContext.totalSteps
    );

    const retryResponseText = await sendRetryPrompt(
      retryPromptStep,
      currentIndex,
      nextAttemptIndex
    );

    if (retryResponseText === null) {
      const failureReason = retryContext.integration.getLastFailureReason();
      this.platform?.error(
        `ctrlyoke: Failed to send retry prompt: ${failureReason}`
      );
      this.promptQueue.resetRetryCount();
      return { handlerResult: { shouldContinue: false, failureReason } };
    }

    if (retryContext.runtime.stopped) {
      Log.info("⚠️ Workflow stopped during retry");
      return {
        handlerResult: this.workflowStopped("Workflow stopped during retry"),
      };
    }

    const retryReport = retryContext.evaluateCondition
      ? await retryContext.evaluateCondition(
          prompt.endCondition!,
          nextAttemptIndex
        )
      : {
          evaluationResult: await this.endConditionEvaluator.evaluateCondition(
            prompt.endCondition!,
            retryContext.workspaceFolderPath,
            retryContext.vars
          ),
        };
    const retryEvaluation = retryReport.evaluationResult;
    await retryContext.onEvaluation?.(
      retryEvaluation,
      nextAttemptIndex,
      retryReport.verdict
    );

    return {
      evaluationResult: retryEvaluation,
      attemptIndex: nextAttemptIndex,
    };
  }

  private workflowStopped(
    failureReason: string
  ): EndConditionHandlerResult {
    this.promptQueue.resetRetryCount();
    return { shouldContinue: false, failureReason };
  }

  private recordPassingEvaluation(evaluationResult: EvaluationResult): void {
    const currentIndex = this.promptQueue.getState().currentIndex;
    const currentResult = this.promptQueue.getState().results[currentIndex];
    if (currentResult) {
      currentResult.endConditionResult = true;
      currentResult.scriptOutput = evaluationResult.stdout;
    }
  }

  /**
   * Handle max retries exhausted
   * @returns Result object with shouldContinue and optional failureReason
   */
  async handleMaxRetriesExhausted(
    prompt: PromptStep,
    evaluationResult: EvaluationResult,
    retryContext: RetryContext,
    attemptIndex: number
  ): Promise<EndConditionHandlerResult> {
    const maxRetries = this.promptQueue.getEffectiveMaxRetries(prompt);
    const retryCount = this.promptQueue.getCurrentRetryCount();

    Log.error(
      `❌ End condition failed after ${retryCount} retries (max: ${maxRetries})`
    );

    const message =
      maxRetries > 0
        ? `End condition failed after ${retryCount} retries.\n\nExpected: ${prompt.endCondition?.returns}\nActual: ${evaluationResult.result}\n\nScript output:\n${evaluationResult.stdout.substring(0, 200)}`
        : `End condition validation failed.\n\nExpected: ${prompt.endCondition?.returns}\nActual: ${evaluationResult.result}`;

    const action = await this.platform?.showChoice(
      `ctrlyoke: ${message}`,
      DIALOG_ACTIONS.STOP_WORKFLOW,
      DIALOG_ACTIONS.CONTINUE_ANYWAY,
      DIALOG_ACTIONS.RETRY_ONCE_MORE
    );

    if (action === DIALOG_ACTIONS.CONTINUE_ANYWAY) {
      Log.info("⏭️ Continuing despite validation failure");
      this.promptQueue.resetRetryCount();
      retryContext.runtime.completeAttempt(
        retryContext.attemptTarget,
        attemptIndex
      );
      return { shouldContinue: true };
    } else if (action === DIALOG_ACTIONS.RETRY_ONCE_MORE) {
      // Allow one more retry — signal the iterative loop to perform
      // one additional attempt without incrementing the retry counter
      Log.info("🔄 Manual retry requested");
      return { shouldContinue: false, retryOnceMore: true };
    }

    // Default: stop workflow
    this.promptQueue.resetRetryCount();
    retryContext.runtime.failAttempt(
      retryContext.attemptTarget,
      attemptIndex,
      message
    );
    return { shouldContinue: false, failureReason: message };
  }

  /**
   * Build retry prompt from template with placeholder replacement
   */
  buildRetryPrompt(
    prompt: PromptStep,
    evaluationResult: EvaluationResult
  ): string {
    // Get effective retry prompt (including defaults from settings)
    const retryPromptTemplate =
      this.promptQueue.getEffectiveRetryPrompt(prompt);

    if (!retryPromptTemplate) {
      // Fallback retry prompt if none configured (should rarely happen due to smart defaults)
      return `The previous task validation failed. Expected: ${prompt.endCondition?.returns}, but got: ${evaluationResult.result}\n\nScript output:\n${evaluationResult.stdout}\n\nPlease fix the issues and try again.`;
    }

    // Use EndConditionEvaluator's buildRetryPrompt method for placeholder replacement
    return this.endConditionEvaluator.buildRetryPrompt(
      retryPromptTemplate,
      evaluationResult,
      prompt.endCondition!.returns,
      prompt.endCondition?.compareSource
    );
  }

  /**
   * Build the prompt sent after a passing end-condition evaluation.
   * A missing pass template deliberately falls back to the step's own prompt.
   */
  buildPassRetryPrompt(
    prompt: PromptStep,
    evaluationResult: EvaluationResult
  ): string {
    const passRetryPromptTemplate =
      this.promptQueue.getEffectivePassRetryPrompt(prompt);

    if (!passRetryPromptTemplate) {
      return prompt.prompt;
    }

    return this.endConditionEvaluator.buildRetryPrompt(
      passRetryPromptTemplate,
      evaluationResult,
      prompt.endCondition!.returns,
      prompt.endCondition?.compareSource
    );
  }
}
