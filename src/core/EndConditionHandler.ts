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
  FINAL_STEP_PHASES,
  RETRY_KINDS,
  type RetryKind,
} from "../types/DashboardConstants";
import { Log } from "../utils/Log";
import { formatRetryDenominator } from "../utils/LimitUtils";
import {
  EndConditionEvaluator,
  EvaluationResult,
} from "./EndConditionEvaluator";
import { createConditionEvaluationSummary } from "./orchestration/ScriptExecutionReporter";
import { PromptQueue } from "./PromptQueue";
import type { RetryPromptSource } from "./RetryBudget";
import { HarnessIntegration } from "./HarnessIntegration";
import type { WorkflowStateMachine } from "./WorkflowStateMachine";
import type { ExecutionWorkspace } from "../types/WorkflowContextTypes";
import { notifyUserFeedback, type UserFeedbackSink } from "./UserFeedbackSink";
import { StatusMessageReporter } from "./orchestration/StatusMessageReporter";
import { PropertyResolver } from "../utils/PropertyResolver";
import { reportEndConditionEvaluated } from "../utils/TelemetryEvents";
import { formatComparison } from "../utils/ScriptComparison";
import { fenceLiteral, LITERAL_FENCE_INFO } from "../utils/FileReferenceParser";

/**
 * The `Expected:` / `Actual:` pair every end-condition failure message shows.
 * Expected is the comparison that actually ran (`exit code == 0`,
 * `stdout contains 0 failing`) rather than the raw `expected` field, which is
 * absent under the zero-config default; Actual is the value read from
 * `compareSource`, which for an exit-code comparison is not stdout.
 */
function describeComparisonOutcome(
  endCondition: ScriptProperties | null | undefined,
  evaluationResult: EvaluationResult
): { expected: string; actual: string } {
  return {
    expected: formatComparison(endCondition ?? {}),
    actual: evaluationResult.actual,
  };
}

/**
 * Context needed to handle retry prompts
 */
export interface RetryContext {
  integration: HarnessIntegration;
  totalSteps: number;
  workspaceFolderPath: string | undefined;
  executionWorkspace?: ExecutionWorkspace;
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
  attemptIndex: number,
  promptSource: RetryPromptSource
) => Promise<{ responseText: string; attemptIndex: number } | null>;

/**
 * Result of handling an end condition evaluation.
 * Contains all information needed for the caller to update UI/state.
 */
export interface EndConditionHandlerResult {
  /** Whether the workflow should continue */
  shouldContinue: boolean;
  /** Failure reason if shouldContinue is false (for dashboard/logging) */
  failureReason?: string;
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
    private readonly statusMessageReporter: StatusMessageReporter,
    private readonly userFeedbackSink?: UserFeedbackSink
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
    // Evaluation errors are internal failures, not condition outcomes. The
    // executor owns their policy because retry must re-enter the whole step.
    if (evaluationResult.errored) {
      this.recordEndConditionEvaluation(
        prompt,
        evaluationResult,
        retryContext.attemptTarget
      );
      return {
        shouldContinue: false,
        failureReason: evaluationResult.error ?? "End condition could not run",
        errorResult: evaluationResult,
        errorAttemptIndex: retryContext.attemptIndex,
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
    let currentAttemptIndex = retryContext.attemptIndex;

    while (true) {
      if (evaluationResult.errored) {
        this.recordEndConditionEvaluation(
          prompt,
          evaluationResult,
          retryContext.attemptTarget
        );
        return {
          shouldContinue: false,
          failureReason:
            evaluationResult.error ?? "End condition could not run",
          errorResult: evaluationResult,
          errorAttemptIndex: currentAttemptIndex,
        };
      }

      if (evaluationResult.passed) {
        Log.info("[EndConditionHandler] End condition passed");
        this.recordPassingEvaluation(
          prompt,
          evaluationResult,
          retryContext.attemptTarget
        );

        if (onPass === CONDITION_ACTIONS.STOP_WORKFLOW) {
          const reason = "End condition passed with onPass: stopWorkflow";
          retryContext.runtime.failAttempt(
            retryContext.attemptTarget,
            currentAttemptIndex,
            reason
          );
          this.promptQueue.resetRetryCount(retryContext.attemptTarget);
          return { shouldContinue: false, failureReason: reason };
        }

        if (onPass === CONDITION_ACTIONS.RETRY) {
          if (retryContext.runtime.stopped) {
            return this.workflowStopped(
              "Workflow stopped by user",
              retryContext.attemptTarget
            );
          }

          if (
            this.promptQueue.canPassRetry(prompt, retryContext.attemptTarget)
          ) {
            const retryResult = await this.sendRetryPromptAndEvaluate(
              prompt,
              evaluationResult,
              retryContext,
              sendRetryPrompt,
              currentAttemptIndex,
              RETRY_KINDS.PASS
            );
            if ("handlerResult" in retryResult) {
              return retryResult.handlerResult;
            }
            evaluationResult = retryResult.evaluationResult;
            currentAttemptIndex = retryResult.attemptIndex;
            continue;
          }

          Log.info(
            `[EndConditionHandler] Pass-retry budget exhausted after ${this.promptQueue.getCurrentRetryCount(
              retryContext.attemptTarget
            )} retries; advancing`
          );
        }

        retryContext.runtime.completeAttempt(
          retryContext.attemptTarget,
          currentAttemptIndex
        );
        this.promptQueue.resetRetryCount(retryContext.attemptTarget);
        return { shouldContinue: true };
      }

      // Preserve the existing failure-side behavior: onFail: continue
      // advances immediately, while other actions use the conversational
      // retry/exhaustion flow whenever retry settings permit it.
      this.recordEndConditionEvaluation(
        prompt,
        evaluationResult,
        retryContext.attemptTarget
      );
      if (retryContext.runtime.stopped) {
        Log.info("[EndConditionHandler] Workflow stopped, aborting retry");
        return this.workflowStopped(
          "Workflow stopped by user",
          retryContext.attemptTarget
        );
      }

      if (onFail === CONDITION_ACTIONS.CONTINUE) {
        Log.warn(
          "[EndConditionHandler] End condition failed, continuing due to onFail: continue"
        );
        retryContext.runtime.completeAttempt(
          retryContext.attemptTarget,
          currentAttemptIndex
        );
        this.promptQueue.resetRetryCount(retryContext.attemptTarget);
        return { shouldContinue: true };
      }

      if (!this.promptQueue.canRetry(prompt, retryContext.attemptTarget)) {
        const maxRetries =
          this.promptQueue.getEffectiveFailureRetryBudget(prompt);
        const retryCount = this.promptQueue.getCurrentRetryCount(
          retryContext.attemptTarget
        );
        const { expected, actual } = describeComparisonOutcome(
          prompt.endCondition,
          evaluationResult
        );
        const headline =
          maxRetries > 0 || retryCount > 0
            ? `End condition failed after ${retryCount} retries.`
            : "End condition validation failed.";
        const comparisonReason = evaluationResult.comparisonReason
          ? `${evaluationResult.comparisonReason}\n\n`
          : "";
        const failureReason = `${headline}\n\n${comparisonReason}Expected: ${expected}\nActual: ${actual}\n\nScript output:\n${evaluationResult.stdout.substring(0, 200)}`;

        Log.error(
          `[EndConditionHandler] End condition failed after ${retryCount} retries (max: ${maxRetries})`
        );
        this.statusMessageReporter.report(
          retryContext.attemptTarget,
          failureReason,
          STATUS_MESSAGE_SEVERITY.ERROR
        );
        retryContext.runtime.failAttempt(
          retryContext.attemptTarget,
          currentAttemptIndex,
          failureReason
        );
        this.promptQueue.resetRetryCount(retryContext.attemptTarget);
        return { shouldContinue: false, failureReason };
      }

      const retryResult = await this.sendRetryPromptAndEvaluate(
        prompt,
        evaluationResult,
        retryContext,
        sendRetryPrompt,
        currentAttemptIndex,
        RETRY_KINDS.FAILURE
      );
      if ("handlerResult" in retryResult) {
        return retryResult.handlerResult;
      }
      evaluationResult = retryResult.evaluationResult;
      currentAttemptIndex = retryResult.attemptIndex;
    }
  }

  private async sendRetryPromptAndEvaluate(
    prompt: PromptStep,
    evaluationResult: EvaluationResult,
    retryContext: RetryContext,
    sendRetryPrompt: SendRetryPromptCallback,
    currentAttemptIndex: number,
    retryKind: RetryKind
  ): Promise<
    | { evaluationResult: EvaluationResult; attemptIndex: number }
    | { handlerResult: EndConditionHandlerResult }
  > {
    if (retryContext.runtime.stopped) {
      return {
        handlerResult: this.workflowStopped(
          "Workflow stopped by user",
          retryContext.attemptTarget
        ),
      };
    }

    this.promptQueue.incrementRetryCount(retryContext.attemptTarget);

    const currentRetry = this.promptQueue.getCurrentRetryCount(
      retryContext.attemptTarget
    );
    const maxRetries = this.promptQueue.getEffectiveMaxRetries(prompt);
    const currentIndex =
      retryContext.attemptTarget.kind === FINAL_STEP_PHASES.QUEUE
        ? retryContext.attemptTarget.stepIndex
        : this.promptQueue.getState().results.length;
    const nextAttemptIndex = currentAttemptIndex + 1;
    const retryPromptText =
      retryKind === RETRY_KINDS.PASS
        ? this.buildPassRetryPrompt(prompt)
        : this.buildRetryPrompt(prompt, evaluationResult);
    const promptSource =
      retryKind === RETRY_KINDS.PASS
        ? this.promptQueue.getEffectivePassRetryPromptSource(prompt)
        : this.promptQueue.getEffectiveRetryPromptSource(prompt);
    const retryDenominator = formatRetryDenominator(maxRetries);

    retryContext.runtime.scheduleRetry(
      retryContext.attemptTarget,
      nextAttemptIndex,
      currentRetry,
      maxRetries
    );

    Log.info(
      retryKind === RETRY_KINDS.PASS
        ? `End condition passed, re-running (pass retry ${currentRetry}/${retryDenominator})...`
        : `Validation failed, retrying (attempt ${currentRetry}/${retryDenominator})...`
    );

    const hasQueueStep =
      retryContext.attemptTarget.kind === FINAL_STEP_PHASES.QUEUE;
    if (hasQueueStep) {
      const retryPromptPreview = retryPromptText
        .split("\n")[0]
        .substring(0, 60);
      const ellipsis = retryPromptText.length > 60 ? "..." : "";
      const statusMessage =
        retryKind === RETRY_KINDS.PASS
          ? `Re-running Prompt ${currentIndex + 1} (Pass retry ${currentRetry}/${retryDenominator}): ${retryPromptPreview}${ellipsis}`
          : `Retrying Prompt ${currentIndex + 1} (Attempt ${currentRetry}/${retryDenominator}): ${retryPromptPreview}${ellipsis}`;
      this.statusMessageReporter.report(
        {
          kind: FINAL_STEP_PHASES.QUEUE,
          stepIndex: currentIndex,
        },
        statusMessage,
        STATUS_MESSAGE_SEVERITY.WARNING
      );
    }

    const retryPromptStep: PromptStep = {
      ...prompt,
      prompt: retryPromptText,
      resumeSession: prompt.endCondition?.resumeSessionOnRetry ?? true,
    };
    delete retryPromptStep._runtime;
    delete retryPromptStep.sessionId;
    delete retryPromptStep.preCondition;

    retryContext.integration.setWorkflowProgress(
      currentIndex + 1,
      retryContext.totalSteps
    );

    const retrySendResult = await sendRetryPrompt(
      retryPromptStep,
      currentIndex,
      nextAttemptIndex,
      promptSource
    );

    if (retrySendResult === null) {
      const failureReason = retryContext.integration.getLastFailureReason();
      notifyUserFeedback(
        this.userFeedbackSink,
        "error",
        `ctrlyoke: Failed to send retry prompt: ${failureReason}`
      );
      this.promptQueue.resetRetryCount(retryContext.attemptTarget);
      return { handlerResult: { shouldContinue: false, failureReason } };
    }

    const retryAttemptIndex = retrySendResult.attemptIndex;

    if (retryContext.runtime.stopped) {
      Log.info("[EndConditionHandler] Workflow stopped during retry");
      return {
        handlerResult: this.workflowStopped(
          "Workflow stopped during retry",
          retryContext.attemptTarget
        ),
      };
    }

    const retryReport = retryContext.evaluateCondition
      ? await retryContext.evaluateCondition(
          prompt.endCondition!,
          retryAttemptIndex
        )
      : {
          evaluationResult: await this.endConditionEvaluator.evaluateCondition(
            prompt.endCondition!,
            retryContext.executionWorkspace?.executionRoot ??
              retryContext.workspaceFolderPath,
            retryContext.vars
          ),
        };
    const retryEvaluation = retryReport.evaluationResult;
    await retryContext.onEvaluation?.(
      retryEvaluation,
      retryAttemptIndex,
      retryReport.verdict
    );

    return {
      evaluationResult: retryEvaluation,
      attemptIndex: retryAttemptIndex,
    };
  }

  private workflowStopped(
    failureReason: string,
    target: WorkflowAttemptTarget
  ): EndConditionHandlerResult {
    this.promptQueue.resetRetryCount(target);
    return { shouldContinue: false, failureReason };
  }

  private recordPassingEvaluation(
    prompt: PromptStep,
    evaluationResult: EvaluationResult,
    target: WorkflowAttemptTarget
  ): void {
    this.recordEndConditionEvaluation(prompt, evaluationResult, target);
  }

  private recordEndConditionEvaluation(
    prompt: PromptStep,
    evaluationResult: EvaluationResult,
    target: WorkflowAttemptTarget
  ): void {
    const summary = createConditionEvaluationSummary(
      prompt.endCondition?.script ?? "",
      evaluationResult,
      {
        expected: prompt.endCondition?.expected,
        compareSource: prompt.endCondition?.compareSource,
        operator: prompt.endCondition?.operator,
      }
    );
    if (target.kind === FINAL_STEP_PHASES.QUEUE) {
      this.promptQueue.recordEndConditionSummary(target.stepIndex, summary);
    } else {
      this.promptQueue.recordFinalStepEndConditionSummary(summary);
    }

    reportEndConditionEvaluated({
      harness: PropertyResolver.resolveHarnessValue(prompt.harness, undefined),
      result: evaluationResult.errored
        ? "error"
        : evaluationResult.passed
          ? "pass"
          : "fail",
      attempt: this.promptQueue.getCurrentRetryCount(target) + 1,
      maxRetries: this.promptQueue.getEffectiveMaxRetries(prompt),
      durationMs: evaluationResult.duration,
    });
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
      const { expected, actual } = describeComparisonOutcome(
        prompt.endCondition,
        evaluationResult
      );
      return [
        "The previous task validation failed.",
        `Expected:\n${fenceLiteral(expected, LITERAL_FENCE_INFO)}`,
        `Actual:\n${fenceLiteral(actual, LITERAL_FENCE_INFO)}`,
        `Script output:\n${fenceLiteral(evaluationResult.stdout, LITERAL_FENCE_INFO)}`,
        "Please fix the issues and try again.",
      ].join("\n\n");
    }

    return retryPromptTemplate;
  }

  /**
   * Build the prompt sent after a passing end-condition evaluation.
   * A missing pass template deliberately falls back to the step's own prompt.
   */
  buildPassRetryPrompt(prompt: PromptStep): string {
    const passRetryPromptTemplate =
      this.promptQueue.getEffectivePassRetryPrompt(prompt);

    if (!passRetryPromptTemplate) {
      return prompt.prompt;
    }

    return passRetryPromptTemplate;
  }
}
