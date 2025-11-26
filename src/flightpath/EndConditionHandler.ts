import * as vscode from "vscode";
import { PromptItem } from "../types/FlightPathTypes";
import { STEP_STATUS } from "../types/DashboardConstants";
import {
  EndConditionEvaluator,
  EvaluationResult,
} from "./EndConditionEvaluator";
import { PromptQueue } from "./PromptQueue";
import { CopilotIntegration } from "./base/CopilotIntegration";
import { FlightPathDashboardProvider } from "../ui/FlightPathDashboardProvider";

/**
 * Context needed to handle retry prompts
 */
export interface RetryContext {
  integration: CopilotIntegration;
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
    private readonly dashboardProvider?: FlightPathDashboardProvider
  ) {}

  /**
   * Handle end condition evaluation result
   * @returns true to continue workflow, false to stop
   */
  async handleEndConditionResult(
    prompt: PromptItem,
    evaluationResult: EvaluationResult,
    retryContext: RetryContext,
    sendRetryPrompt: SendRetryPromptCallback
  ): Promise<boolean> {
    // Success case - continue to next prompt
    if (evaluationResult.success) {
      console.log("✅ FlightPath: End condition passed");
      this.promptQueue.resetRetryCount();

      // Update result with script output
      const currentIndex = this.promptQueue.getState().currentIndex;
      const currentResult = this.promptQueue.getState().results[currentIndex];
      if (currentResult) {
        currentResult.endConditionResult = true;
        currentResult.scriptOutput = evaluationResult.stdout;
      }

      return true;
    }

    // Determine if this is an execution error or validation failure
    const isExecutionError =
      evaluationResult.timeout ||
      (evaluationResult.error && !evaluationResult.exitCode) ||
      (evaluationResult.exitCode !== undefined &&
        evaluationResult.exitCode !== 0);

    if (isExecutionError) {
      // Error path - script failed to execute properly
      return await this.handleExecutionError(prompt, evaluationResult);
    } else {
      // Validation failure path - script ran but output doesn't match
      return await this.handleValidationFailure(
        prompt,
        evaluationResult,
        retryContext,
        sendRetryPrompt
      );
    }
  }

  /**
   * Handle execution errors (script failed, timed out, etc.)
   * @returns true to continue, false to stop
   */
  async handleExecutionError(
    prompt: PromptItem,
    evaluationResult: EvaluationResult
  ): Promise<boolean> {
    let errorMessage = "End condition script execution failed";

    if (evaluationResult.timeout) {
      errorMessage = `End condition script timed out after ${evaluationResult.duration}ms`;
    } else if (evaluationResult.error) {
      errorMessage = `End condition script error: ${evaluationResult.error}`;
    }

    console.error(`❌ FlightPath: ${errorMessage}`);

    const action = await vscode.window.showErrorMessage(
      `FlightPath: ${errorMessage}`,
      "Stop Workflow",
      "Skip Condition",
      "Open Script"
    );

    if (action === "Skip Condition") {
      console.log("⏭️ FlightPath: Skipping end condition and continuing");
      return true;
    } else if (action === "Open Script") {
      // Try to open the script file
      if (prompt.endCondition?.script) {
        try {
          const scriptUri = vscode.Uri.file(prompt.endCondition.script);
          const doc = await vscode.workspace.openTextDocument(scriptUri);
          await vscode.window.showTextDocument(doc);
        } catch {
          vscode.window.showErrorMessage("Failed to open script file");
        }
      }
      return false;
    }

    // Default: stop workflow
    return false;
  }

  /**
   * Handle validation failure (script succeeded but output doesn't match expected)
   * @returns true to continue, false to stop
   */
  async handleValidationFailure(
    prompt: PromptItem,
    evaluationResult: EvaluationResult,
    retryContext: RetryContext,
    sendRetryPrompt: SendRetryPromptCallback
  ): Promise<boolean> {
    // Check if workflow was stopped by user
    if (this.promptQueue.getState().stopped) {
      console.log("⚠️ FlightPath: Workflow stopped, aborting retry");
      return false;
    }

    // Check if retry is possible
    if (this.promptQueue.canRetry(prompt)) {
      // Increment retry counter
      this.promptQueue.incrementRetryCount();

      const currentRetry = this.promptQueue.getCurrentRetryCount();
      const maxRetries = this.promptQueue.getEffectiveMaxRetries(prompt);
      const currentIndex = this.promptQueue.getState().currentIndex;

      console.log(
        `🔄 FlightPath: Validation failed, retrying (attempt ${currentRetry}/${maxRetries})...`
      );

      // Update dashboard with retry state
      if (this.dashboardProvider) {
        this.dashboardProvider.updateRetryAttempt(
          currentIndex,
          currentRetry,
          maxRetries
        );
        this.dashboardProvider.updateStepStatus(currentIndex, {
          state: STEP_STATUS.RUNNING,
        });
      }

      // Build retry prompt
      const retryPromptText = this.buildRetryPrompt(prompt, evaluationResult);

      // Send status message: Retrying prompt (after building retryPrompt)
      if (this.dashboardProvider) {
        const retryPromptPreview = retryPromptText
          .split("\n")[0]
          .substring(0, 60);
        const ellipsis = retryPromptText.length > 60 ? "..." : "";
        this.dashboardProvider.updateStatusMessage(
          currentIndex,
          `Retrying Prompt ${currentIndex + 1} (Attempt ${currentRetry}/${maxRetries}): ${retryPromptPreview}${ellipsis}`
        );
      }

      // Create retry prompt item
      const retryPromptItem: PromptItem = {
        prompt: retryPromptText,
        model: prompt.model,
        endCondition: prompt.endCondition, // Keep same end condition
        newChatSession: false, // IMPORTANT: Retries must use same chat session
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
        // Failed to send retry prompt
        vscode.window.showErrorMessage(
          "FlightPath: Failed to send retry prompt"
        );
        return false;
      }

      // Check if workflow was stopped during retry
      if (this.promptQueue.getState().stopped) {
        console.log("⚠️ FlightPath: Workflow stopped during retry");
        return false;
      }

      // Re-evaluate end condition after retry
      const retryEvaluation =
        await this.endConditionEvaluator.evaluateCondition(
          prompt.endCondition!,
          retryContext.workspaceFolderPath
        );

      // Recursively handle the result (will retry again if needed or max out)
      return await this.handleEndConditionResult(
        prompt,
        retryEvaluation,
        retryContext,
        sendRetryPrompt
      );
    } else {
      // Max retries exhausted or no retry configured
      return await this.handleMaxRetriesExhausted(prompt, evaluationResult);
    }
  }

  /**
   * Handle max retries exhausted
   * @returns true to continue, false to stop
   */
  async handleMaxRetriesExhausted(
    prompt: PromptItem,
    evaluationResult: EvaluationResult
  ): Promise<boolean> {
    const maxRetries = this.promptQueue.getEffectiveMaxRetries(prompt);
    const retryCount = this.promptQueue.getCurrentRetryCount();

    console.error(
      `❌ FlightPath: End condition failed after ${retryCount} retries (max: ${maxRetries})`
    );

    const message =
      maxRetries > 0
        ? `End condition failed after ${retryCount} retries.\n\nExpected: ${prompt.endCondition?.returns}\nActual: ${evaluationResult.result}\n\nScript output:\n${evaluationResult.stdout.substring(0, 200)}`
        : `End condition validation failed.\n\nExpected: ${prompt.endCondition?.returns}\nActual: ${evaluationResult.result}`;

    const action = await vscode.window.showErrorMessage(
      `FlightPath: ${message}`,
      "Stop Workflow",
      "Continue Anyway",
      "Retry Once More"
    );

    if (action === "Continue Anyway") {
      console.log("⏭️ FlightPath: Continuing despite validation failure");
      this.promptQueue.resetRetryCount();
      return true;
    } else if (action === "Retry Once More") {
      // Allow one more retry even if max reached
      console.log("🔄 FlightPath: Manual retry requested");
      // Don't increment retry count, just return false to re-evaluate
      // The calling code will handle this case
      return false;
    }

    // Default: stop workflow
    this.promptQueue.resetRetryCount();
    return false;
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
}
