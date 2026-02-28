import * as vscode from "vscode";
import * as path from "path";
import { PromptItem } from "../types/FlightPathTypes";
import {
  STEP_STATUS,
  STATUS_MESSAGE_SEVERITY,
} from "../types/DashboardConstants";
import { Log } from "../utils/Log";
import {
  EndConditionEvaluator,
  EvaluationResult,
} from "./EndConditionEvaluator";
import { PromptQueue } from "./PromptQueue";
import { HarnessIntegration } from "./HarnessIntegration";
import { FlightPathWebviewProvider } from "../ui/FlightPathWebviewProvider";

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
  totalPrompts: number;
  workspaceFolderPath: string | undefined;
  currentPromptFilePath: string | undefined;
}

/**
 * Callback for sending retry prompts to Copilot.
 * Returns the response text on success, null on failure.
 */
export type SendRetryPromptCallback = (
  retryPromptItem: PromptItem,
  currentIndex: number
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
 * This class extracts retry/validation logic from FlightPathManager to improve
 * separation of concerns and testability.
 */
export class EndConditionHandler {
  constructor(
    private readonly endConditionEvaluator: EndConditionEvaluator,
    private readonly promptQueue: PromptQueue,
    private readonly getDashboard: () =>
      | FlightPathWebviewProvider
      | undefined = () => undefined
  ) {}

  /**
   * Handle end condition evaluation result
   * @returns Result object with shouldContinue and optional failureReason
   */
  async handleEndConditionResult(
    prompt: PromptItem,
    evaluationResult: EvaluationResult,
    retryContext: RetryContext,
    sendRetryPrompt: SendRetryPromptCallback
  ): Promise<EndConditionHandlerResult> {
    // Success case - continue to next prompt
    if (evaluationResult.success) {
      Log.info("✅ End condition passed");
      this.promptQueue.resetRetryCount();

      // Update result with script output
      const currentIndex = this.promptQueue.getState().currentIndex;
      const currentResult = this.promptQueue.getState().results[currentIndex];
      if (currentResult) {
        currentResult.endConditionResult = true;
        currentResult.scriptOutput = evaluationResult.stdout;
      }

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
      return await this.handleExecutionError(prompt, evaluationResult);
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
    prompt: PromptItem,
    evaluationResult: EvaluationResult
  ): Promise<EndConditionHandlerResult> {
    let errorMessage = "End condition script execution failed";

    if (evaluationResult.timeout) {
      errorMessage = `End condition script timed out after ${evaluationResult.duration}ms`;
    } else if (evaluationResult.error) {
      errorMessage = `End condition script error: ${evaluationResult.error}`;
    }

    Log.error(`❌ ${errorMessage}`);

    const action = await vscode.window.showErrorMessage(
      `FlightPath: ${errorMessage}`,
      DIALOG_ACTIONS.STOP_WORKFLOW,
      DIALOG_ACTIONS.SKIP_CONDITION,
      DIALOG_ACTIONS.OPEN_SCRIPT
    );

    if (action === DIALOG_ACTIONS.SKIP_CONDITION) {
      Log.info("⏭️ Skipping end condition and continuing");
      return { shouldContinue: true };
    } else if (action === DIALOG_ACTIONS.OPEN_SCRIPT) {
      // Try to open the script file (only if the script looks like a file path)
      if (prompt.endCondition?.script) {
        const script = prompt.endCondition.script.split(/\s+/)[0]; // Extract first token (path)
        if (this.looksLikeFilePath(script)) {
          try {
            const scriptUri = vscode.Uri.file(script);
            const doc = await vscode.workspace.openTextDocument(scriptUri);
            await vscode.window.showTextDocument(doc);
          } catch {
            vscode.window.showErrorMessage(
              `Could not open script file: ${script}`
            );
          }
        } else {
          vscode.window.showInformationMessage(
            `"${prompt.endCondition.script}" appears to be a shell command, not a file path.`
          );
        }
      }
      return { shouldContinue: false, failureReason: errorMessage };
    }

    // Default: stop workflow
    return { shouldContinue: false, failureReason: errorMessage };
  }

  /**
   * Handle validation failure iteratively (script succeeded but output doesn't match expected).
   * Uses an iterative loop instead of recursion to avoid stack overflow with many retries.
   * @returns Result object with shouldContinue and optional failureReason
   */
  async handleValidationFailureIterative(
    prompt: PromptItem,
    initialEvaluationResult: EvaluationResult,
    retryContext: RetryContext,
    sendRetryPrompt: SendRetryPromptCallback
  ): Promise<EndConditionHandlerResult> {
    let evaluationResult = initialEvaluationResult;
    let manualRetryRequested = false;

    while (true) {
      // Check if workflow was stopped by user
      if (this.promptQueue.getState().stopped) {
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
            evaluationResult
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

      Log.info(
        `🔄 Validation failed, retrying (attempt ${currentRetry}/${maxRetries})...`
      );

      // Update dashboard with retry state
      const dashboard = this.getDashboard();
      if (dashboard) {
        dashboard.updateRetryAttempt(currentIndex, currentRetry, maxRetries);
        dashboard.updateStepStatus(currentIndex, {
          state: STEP_STATUS.RUNNING,
        });
      }

      // Build retry prompt
      const retryPromptText = this.buildRetryPrompt(prompt, evaluationResult);

      // Send status message: Retrying prompt (after building retryPrompt)
      const retryDashboard = this.getDashboard();
      if (retryDashboard) {
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
      const retryPromptItem: PromptItem = {
        prompt: retryPromptText,
        model: prompt.model,
        endCondition: prompt.endCondition, // Keep same end condition
        resumeSession: true, // IMPORTANT: Retries must use same chat session
      };

      // Update workflow progress to show retry
      retryContext.integration.setWorkflowProgress(
        currentIndex + 1,
        retryContext.totalPrompts
      );

      // Send retry prompt and wait for response
      const retryResponseText = await sendRetryPrompt(
        retryPromptItem,
        currentIndex
      );

      if (retryResponseText === null) {
        // Failed to send retry prompt - get actual reason from integration
        const failureReason = retryContext.integration.getLastFailureReason();
        vscode.window.showErrorMessage(
          `FlightPath: Failed to send retry prompt: ${failureReason}`
        );
        return { shouldContinue: false, failureReason };
      }

      // Check if workflow was stopped during retry
      if (this.promptQueue.getState().stopped) {
        Log.info("⚠️ Workflow stopped during retry");
        return {
          shouldContinue: false,
          failureReason: "Workflow stopped during retry",
        };
      }

      // Re-evaluate end condition after retry
      const retryEvaluation =
        await this.endConditionEvaluator.evaluateCondition(
          prompt.endCondition!,
          retryContext.workspaceFolderPath
        );

      // Check if the retry succeeded
      if (retryEvaluation.success) {
        Log.info("✅ End condition passed after retry");
        this.promptQueue.resetRetryCount();

        const resultIndex = this.promptQueue.getState().currentIndex;
        const result = this.promptQueue.getState().results[resultIndex];
        if (result) {
          result.endConditionResult = true;
          result.scriptOutput = retryEvaluation.stdout;
        }

        return { shouldContinue: true };
      }

      // Check if this is an execution error (not a validation failure)
      const isExecutionError =
        retryEvaluation.timeout ||
        (retryEvaluation.error && retryEvaluation.exitCode === undefined) ||
        (retryEvaluation.exitCode !== undefined &&
          retryEvaluation.exitCode !== 0);

      if (isExecutionError) {
        return await this.handleExecutionError(prompt, retryEvaluation);
      }

      // Validation failure — continue the loop for another retry attempt
      evaluationResult = retryEvaluation;
    }
  }

  /**
   * Handle max retries exhausted
   * @returns Result object with shouldContinue and optional failureReason
   */
  async handleMaxRetriesExhausted(
    prompt: PromptItem,
    evaluationResult: EvaluationResult
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

    const action = await vscode.window.showErrorMessage(
      `FlightPath: ${message}`,
      DIALOG_ACTIONS.STOP_WORKFLOW,
      DIALOG_ACTIONS.CONTINUE_ANYWAY,
      DIALOG_ACTIONS.RETRY_ONCE_MORE
    );

    if (action === DIALOG_ACTIONS.CONTINUE_ANYWAY) {
      Log.info("⏭️ Continuing despite validation failure");
      this.promptQueue.resetRetryCount();
      return { shouldContinue: true };
    } else if (action === DIALOG_ACTIONS.RETRY_ONCE_MORE) {
      // Allow one more retry — signal the iterative loop to perform
      // one additional attempt without incrementing the retry counter
      Log.info("🔄 Manual retry requested");
      return { shouldContinue: false, retryOnceMore: true };
    }

    // Default: stop workflow
    this.promptQueue.resetRetryCount();
    return { shouldContinue: false, failureReason: message };
  }

  /**
   * Build retry prompt from template with placeholder replacement
   */
  buildRetryPrompt(
    prompt: PromptItem,
    evaluationResult: EvaluationResult
  ): string {
    // Get effective retry prompt (including defaults from settings)
    const retryPromptTemplate =
      this.promptQueue.getEffectiveRetryPrompt(prompt);
    const maxRetries = this.promptQueue.getEffectiveMaxRetries(prompt);

    if (!retryPromptTemplate) {
      // Fallback retry prompt if none configured (should rarely happen due to smart defaults)
      return `The previous task validation failed. Expected: ${prompt.endCondition?.returns}, but got: ${evaluationResult.result}\n\nScript output:\n${evaluationResult.stdout}\n\nPlease fix the issues and try again.`;
    }

    // Use EndConditionEvaluator's buildRetryPrompt method for placeholder replacement
    return this.endConditionEvaluator.buildRetryPrompt(
      retryPromptTemplate,
      evaluationResult,
      prompt.endCondition!.returns,
      this.promptQueue.getCurrentRetryCount(),
      maxRetries
    );
  }

  /**
   * Check if a string looks like a file path (vs. a bare shell command like "npm").
   * Returns true if it contains path separators or has a known script extension.
   */
  private looksLikeFilePath(script: string): boolean {
    const knownExtensions = [
      ".js",
      ".ts",
      ".py",
      ".sh",
      ".bat",
      ".ps1",
      ".cmd",
    ];
    const ext = path.extname(script).toLowerCase();
    return (
      knownExtensions.includes(ext) ||
      script.includes("/") ||
      script.includes("\\") ||
      script.startsWith(".")
    );
  }
}
