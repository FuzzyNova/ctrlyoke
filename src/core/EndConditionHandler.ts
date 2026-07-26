import * as path from "path";
import type { PlatformAdapter } from "../platform/PlatformAdapter";
import { SCRIPT_EXTENSIONS } from "../utils/ValidationUtils";
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
  SKIP_CONDITION: "Skip Condition",
  OPEN_SCRIPT: "Open Script",
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
}

/**
 * Handles end condition evaluation results, retry logic, and failure handling.
 *
 * Responsibilities:
 * - Determine success/failure of end condition evaluations
 * - Orchestrate retry attempts with configurable prompts
 * - Handle execution errors (script failures, timeouts)
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
    private readonly platform?: PlatformAdapter,
    private readonly openFile?: (filePath: string) => Promise<void>
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

    // Apply maxRetries default of 1 when either field is "retry" and maxRetries is unset
    if (
      (onPass === CONDITION_ACTIONS.RETRY ||
        onFail === CONDITION_ACTIONS.RETRY) &&
      prompt.endCondition &&
      prompt.endCondition.maxRetries === undefined
    ) {
      prompt = {
        ...prompt,
        endCondition: { ...prompt.endCondition, maxRetries: 1 },
      };
    }

    // Success case - apply onPass action
    if (evaluationResult.passed) {
      Log.info("✅ End condition passed");
      this.promptQueue.resetRetryCount();

      // Update result with script output
      const currentIndex = this.promptQueue.getState().currentIndex;
      const currentResult = this.promptQueue.getState().results[currentIndex];
      if (currentResult) {
        currentResult.endConditionResult = true;
        currentResult.scriptOutput = evaluationResult.stdout;
      }

      if (onPass === CONDITION_ACTIONS.STOP_WORKFLOW) {
        const reason = "End condition passed with onPass: stopWorkflow";
        retryContext.runtime.failAttempt(
          retryContext.attemptTarget,
          retryContext.attemptIndex,
          reason
        );
        return { shouldContinue: false, failureReason: reason };
      }

      // CONTINUE or RETRY — advance to next step
      // Note: onPass "retry" (re-run while passing) requires orchestrator-level loop support;
      // for now it behaves as "continue" to avoid breaking workflow state.
      if (onPass === CONDITION_ACTIONS.RETRY) {
        Log.info(
          "⚠️ onPass: retry is not yet fully implemented — advancing to next step"
        );
      }

      retryContext.runtime.completeAttempt(
        retryContext.attemptTarget,
        retryContext.attemptIndex
      );

      return { shouldContinue: true };
    }

    // Failure case — apply onFail action
    if (onFail === CONDITION_ACTIONS.CONTINUE) {
      // Advance despite failure
      Log.warn("⚠️ End condition failed, continuing due to onFail: continue");
      this.promptQueue.resetRetryCount();
      retryContext.runtime.completeAttempt(
        retryContext.attemptTarget,
        retryContext.attemptIndex
      );
      return { shouldContinue: true };
    }

    // Determine if this is an execution error or validation failure
    const isExecutionError =
      evaluationResult.timeout ||
      (evaluationResult.error && evaluationResult.exitCode === undefined) ||
      (evaluationResult.exitCode !== undefined &&
        evaluationResult.exitCode !== 0);

    if (isExecutionError) {
      // Error path - script failed to execute properly
      return await this.handleExecutionError(
        prompt,
        evaluationResult,
        retryContext
      );
    } else {
      // Validation failure path - script ran but output doesn't match
      // Use iterative retry loop instead of recursion to avoid stack overflow
      return await this.handleValidationFailureIterative(
        prompt,
        evaluationResult,
        retryContext,
        sendRetryPrompt
      );
    }
  }

  /**
   * Handle execution errors (script failed, timed out, etc.)
   * @returns Result object with shouldContinue and optional failureReason
   */
  async handleExecutionError(
    prompt: PromptStep,
    evaluationResult: EvaluationResult,
    retryContext: RetryContext
  ): Promise<EndConditionHandlerResult> {
    let errorMessage = "End condition script execution failed";

    if (evaluationResult.timeout) {
      errorMessage = `End condition script timed out after ${evaluationResult.duration}ms`;
    } else if (evaluationResult.error) {
      errorMessage = `End condition script error: ${evaluationResult.error}`;
    }

    Log.error(`❌ ${errorMessage}`);

    const action = await this.platform?.showChoice(
      `ctrlyoke: ${errorMessage}`,
      DIALOG_ACTIONS.STOP_WORKFLOW,
      DIALOG_ACTIONS.SKIP_CONDITION,
      DIALOG_ACTIONS.OPEN_SCRIPT
    );

    if (action === DIALOG_ACTIONS.SKIP_CONDITION) {
      Log.info("⏭️ Skipping end condition and continuing");
      this.promptQueue.resetRetryCount();
      retryContext.runtime.completeAttempt(
        retryContext.attemptTarget,
        retryContext.attemptIndex
      );
      return { shouldContinue: true };
    } else if (action === DIALOG_ACTIONS.OPEN_SCRIPT) {
      // Try to open the script file (only if the script looks like a file path)
      if (prompt.endCondition?.script) {
        const { scriptPath: script } = EndConditionEvaluator.parseScriptCommand(
          prompt.endCondition.script
        );
        if (this.looksLikeFilePath(script)) {
          try {
            if (this.openFile) {
              await this.openFile(script);
            } else if (this.platform?.openTextFile) {
              await this.platform.openTextFile(script);
            } else {
              this.platform?.warn(
                `Open Script is not available in this execution context: ${script}`
              );
            }
          } catch {
            this.platform?.error(`Could not open script file: ${script}`);
          }
        } else {
          this.platform?.log(
            `"${prompt.endCondition.script}" appears to be a shell command, not a file path.`
          );
        }
      }

      retryContext.runtime.failAttempt(
        retryContext.attemptTarget,
        retryContext.attemptIndex,
        errorMessage
      );
      return { shouldContinue: false, failureReason: errorMessage };
    }

    // Default: stop workflow
    retryContext.runtime.failAttempt(
      retryContext.attemptTarget,
      retryContext.attemptIndex,
      errorMessage
    );
    return { shouldContinue: false, failureReason: errorMessage };
  }

  /**
   * Handle validation failure iteratively (script succeeded but output doesn't match expected).
   * Uses an iterative loop instead of recursion to avoid stack overflow with many retries.
   * @returns Result object with shouldContinue and optional failureReason
   */
  async handleValidationFailureIterative(
    prompt: PromptStep,
    initialEvaluationResult: EvaluationResult,
    retryContext: RetryContext,
    sendRetryPrompt: SendRetryPromptCallback
  ): Promise<EndConditionHandlerResult> {
    let evaluationResult = initialEvaluationResult;
    let manualRetryRequested = false;
    let currentAttemptIndex = retryContext.attemptIndex;

    while (true) {
      // Check if workflow was stopped by user
      if (retryContext.runtime.stopped) {
        Log.info("⚠️ Workflow stopped, aborting retry");
        return {
          shouldContinue: false,
          failureReason: "Workflow stopped by user",
        };
      }

      if (!manualRetryRequested) {
        // Check if retry is possible
        if (!this.promptQueue.canRetry(prompt)) {
          // Max retries exhausted or no retry configured
          const exhaustedResult = await this.handleMaxRetriesExhausted(
            prompt,
            evaluationResult,
            retryContext,
            currentAttemptIndex
          );
          if (exhaustedResult.retryOnceMore) {
            // User requested one more retry — loop again without incrementing count
            manualRetryRequested = true;
            continue;
          }
          return exhaustedResult;
        }

        // Increment retry counter
        this.promptQueue.incrementRetryCount();
      } else {
        // Manual retry: don't increment counter, reset flag
        manualRetryRequested = false;
      }

      const currentRetry = this.promptQueue.getCurrentRetryCount();
      const maxRetries = this.promptQueue.getEffectiveMaxRetries(prompt);
      const currentIndex = this.promptQueue.getState().currentIndex;
      const nextAttemptIndex = currentAttemptIndex + 1;

      retryContext.runtime.scheduleRetry(
        retryContext.attemptTarget,
        nextAttemptIndex,
        currentRetry,
        maxRetries
      );

      Log.info(
        `🔄 Validation failed, retrying (attempt ${currentRetry}/${maxRetries})...`
      );

      const hasQueueStep =
        currentIndex < this.promptQueue.getState().results.length;

      // Build retry prompt
      const retryPromptText = this.buildRetryPrompt(prompt, evaluationResult);

      // Send status message: Retrying prompt (after building retryPrompt)
      const retryDashboard = this.getDashboard();
      if (retryDashboard && hasQueueStep) {
        const retryPromptPreview = retryPromptText
          .split("\n")[0]
          .substring(0, 60);
        const ellipsis = retryPromptText.length > 60 ? "..." : "";
        retryDashboard.updateStatusMessage(
          currentIndex,
          `Retrying Prompt ${currentIndex + 1} (Attempt ${currentRetry}/${maxRetries}): ${retryPromptPreview}${ellipsis}`,
          STATUS_MESSAGE_SEVERITY.WARNING
        );
      }

      // Create retry prompt item
      const retryPromptStep: PromptStep = {
        prompt: retryPromptText,
        model: prompt.model,
        endCondition: prompt.endCondition, // Keep same end condition
        resumeSession: prompt.endCondition?.resumeSessionOnRetry ?? true, // Retries continue in same session unless resumeSessionOnRetry is explicitly false
      };

      // Update workflow progress to show retry
      retryContext.integration.setWorkflowProgress(
        currentIndex + 1,
        retryContext.totalSteps
      );

      // Send retry prompt and wait for response
      const retryResponseText = await sendRetryPrompt(
        retryPromptStep,
        currentIndex,
        nextAttemptIndex
      );

      if (retryResponseText === null) {
        // Failed to send retry prompt - get actual reason from integration
        const failureReason = retryContext.integration.getLastFailureReason();
        this.platform?.error(
          `ctrlyoke: Failed to send retry prompt: ${failureReason}`
        );
        return { shouldContinue: false, failureReason };
      }

      // Check if workflow was stopped during retry
      if (retryContext.runtime.stopped) {
        Log.info("⚠️ Workflow stopped during retry");
        return {
          shouldContinue: false,
          failureReason: "Workflow stopped during retry",
        };
      }

      // Re-evaluate end condition after retry. Production callers provide a
      // reporter-backed evaluator; the fallback retains the direct evaluator
      // for focused handler use and must carry workflow vars too.
      const retryReport = retryContext.evaluateCondition
        ? await retryContext.evaluateCondition(
            prompt.endCondition!,
            nextAttemptIndex
          )
        : {
            evaluationResult:
              await this.endConditionEvaluator.evaluateCondition(
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

      // Check if the retry succeeded
      if (retryEvaluation.passed) {
        Log.info("✅ End condition passed after retry");
        this.promptQueue.resetRetryCount();

        const resultIndex = this.promptQueue.getState().currentIndex;
        const result = this.promptQueue.getState().results[resultIndex];
        if (result) {
          result.endConditionResult = true;
          result.scriptOutput = retryEvaluation.stdout;
        }

        retryContext.runtime.completeAttempt(
          retryContext.attemptTarget,
          nextAttemptIndex
        );

        return { shouldContinue: true };
      }

      // Check if this is an execution error (not a validation failure)
      const isExecutionError =
        retryEvaluation.timeout ||
        (retryEvaluation.error && retryEvaluation.exitCode === undefined) ||
        (retryEvaluation.exitCode !== undefined &&
          retryEvaluation.exitCode !== 0);

      if (isExecutionError) {
        return await this.handleExecutionError(prompt, retryEvaluation, {
          ...retryContext,
          attemptIndex: nextAttemptIndex,
        });
      }

      // Validation failure — continue the loop for another retry attempt
      evaluationResult = retryEvaluation;
      currentAttemptIndex = nextAttemptIndex;
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
   * Check if a string looks like a file path (vs. a bare shell command like "npm").
   * Returns true if it contains path separators or has a known script extension.
   */
  private looksLikeFilePath(script: string): boolean {
    const ext = path.extname(script).toLowerCase();
    return (
      (SCRIPT_EXTENSIONS as readonly string[]).includes(ext) ||
      script.includes("/") ||
      script.includes("\\") ||
      script.startsWith(".")
    );
  }
}
