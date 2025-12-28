import * as vscode from "vscode";
import {
  PromptItem,
  DynamicQueueConfig,
  EXECUTION_STATES,
} from "../types/FlightPathTypes";
import { STEP_STATUS } from "../types/DashboardConstants";
import { PromptQueue } from "./PromptQueue";
import { PromptFileParser } from "./PromptFileParser";
import { CopilotIntegration } from "./base/CopilotIntegration";
import {
  EndConditionHandler,
  SendRetryPromptCallback,
} from "./EndConditionHandler";
import { EndConditionEvaluator } from "./EndConditionEvaluator";
import { FlightPathDashboardProvider } from "../ui/FlightPathDashboardProvider";
import { Log } from "../utils/Log";

/**
 * Context provided by FlightPathManager for workflow execution.
 * Contains all dependencies and configuration needed during execution.
 */
export interface WorkflowContext {
  /** Current workspace folder path */
  workspaceFolderPath: string | undefined;
  /** Path to the currently loaded prompt file */
  currentPromptFilePath: string | undefined;
  /** Dashboard provider for UI updates */
  dashboardProvider?: FlightPathDashboardProvider;
  /** Whether to show CLI commands in output */
  shouldShowCliCommand: boolean;
  /** Whether to show CLI output in output panel */
  showCliOutput: boolean;
  /** Dynamic queue configuration */
  dynamicQueueConfig: DynamicQueueConfig;
}

/**
 * Handles the execution loop for FlightPath workflows.
 *
 * Responsibilities:
 * - Execute prompts sequentially with pause/resume support
 * - Wait for Copilot responses
 * - Manage pause/resume state for response handling
 * - Coordinate with EndConditionHandler for validation
 * - Update dashboard with execution progress
 * - Handle dynamic queue reload after prompt completion
 *
 * This class extracts the massive startWorkflowExecution() loop from
 * FlightPathManager to improve separation of concerns.
 */
export class WorkflowExecutor {
  // Pause/resume state: Track pending response when paused
  private pendingResponseResolver: ((text: string) => void) | null = null;
  private pendingResponseText: string | null = null;
  private isWaitingForResponse: boolean = false;

  constructor(
    private readonly promptQueue: PromptQueue,
    private readonly promptFileParser: PromptFileParser,
    private readonly endConditionHandler: EndConditionHandler,
    private readonly endConditionEvaluator: EndConditionEvaluator
  ) {}

  /**
   * Execute the workflow with the given integration and context.
   * This is the main execution loop that processes prompts sequentially.
   *
   * @param integration The Copilot integration to use for sending prompts
   * @param context Workflow context with dependencies and configuration
   */
  async execute(
    integration: CopilotIntegration,
    context: WorkflowContext
  ): Promise<void> {
    // Clear any pending response state from previous execution
    this.clearPendingState();

    // Set queue state to running (this will emit state change and update dashboard)
    await this.promptQueue.start();

    // Start execution time tracking
    this.promptQueue.startExecutionTimer();

    // Get fresh state (supports resume from pause)
    let state = this.promptQueue.getState();

    // Show the FlightPath dashboard panel when execution starts
    try {
      await vscode.commands.executeCommand("flightpath.dashboard.focus");
    } catch (error) {
      Log.error("Could not focus dashboard panel:", error);
    }

    // Log workflow start to output channel (only for CLI integration when output is enabled)
    if (context.showCliOutput && integration.isCli()) {
      Log.getOutputChannel().clear();
      Log.appendLine(
        "═══════════════════════════════════════════════════════════"
      );
      Log.appendLine("        FLIGHTPATH WORKFLOW STARTED");
      Log.appendLine(
        "═══════════════════════════════════════════════════════════"
      );
      Log.appendLine(`Started: ${new Date().toLocaleString()}`);
      Log.appendLine(`Total prompts: ${state.prompts.length}`);
      Log.appendLine(
        `Integration: ${integration.getStatus().strategy.toUpperCase()}`
      );
      Log.appendLine(
        "═══════════════════════════════════════════════════════════"
      );
      Log.appendLine("");
    }

    // Start from currentIndex to support resume functionality
    // Note: Use queue.hasNext() instead of state.prompts.length to support dynamic queue extension
    while (this.promptQueue.hasNext()) {
      // Get fresh state on each iteration (supports queue extension during execution)
      state = this.promptQueue.getState();
      const i = state.currentIndex;
      const prompt = state.prompts[i];
      const dynamicConfig = context.dynamicQueueConfig;

      // Check if paused before starting new prompt
      if (this.promptQueue.getState().status === EXECUTION_STATES.PAUSED) {
        Log.info("⏸️ Workflow paused before executing next prompt");
        break;
      }

      // Check workflow execution time limit (unless unlimited mode or timeout disabled)
      const maxTimeSec = dynamicConfig.maxWorkflowExecutionTime;
      const unlimitedWorkflow =
        dynamicConfig.unlimitedMode || maxTimeSec === -1;

      if (!unlimitedWorkflow) {
        const elapsedMs = this.promptQueue.getActiveExecutionTime();
        const elapsedSec = Math.floor(elapsedMs / 1000);

        if (elapsedSec >= maxTimeSec) {
          const completedCount = this.promptQueue.getCompletedCount();
          const totalCount = state.prompts.length;
          const remainingCount = totalCount - i;

          const message = `Workflow stopped - Maximum execution time reached (${elapsedSec}s / ${maxTimeSec}s).\nCompleted ${completedCount} of ${totalCount} prompts. ${remainingCount} prompts remaining in queue.`;

          vscode.window.showWarningMessage(message);
          Log.info(`⏱️ ${message}`);

          await this.promptQueue.markErrored();
          break;
        }
      }

      // Update dashboard step status to running
      if (context.dashboardProvider) {
        context.dashboardProvider.updateStepStatus(i, {
          state: STEP_STATUS.RUNNING,
        });

        // Send status message: Starting prompt
        const promptPreview = prompt.prompt.split("\n")[0].substring(0, 60);
        const ellipsis = prompt.prompt.length > 60 ? "..." : "";
        context.dashboardProvider.updateStatusMessage(
          i,
          `Starting Prompt ${i + 1}: ${promptPreview}${ellipsis}`
        );
      }

      // Update progress
      integration.setWorkflowProgress(i + 1, state.prompts.length);

      Log.info(`🚀 Executing prompt ${i + 1}/${state.prompts.length}`);

      // Record start time for this prompt
      const startTime = Date.now();

      // Always wait for response completion before marking workflow as done.
      // Previously, single-prompt workflows without endCondition would skip completion detection,
      // causing the queue to be marked complete before Copilot finished responding.
      const needsCompletionDetection = true;

      // Set up response listener BEFORE sending prompt to avoid race condition
      const responsePromise = this.waitForResponseComplete(prompt, integration);

      // Set up streaming listener for real-time output (for integrations that support CLI output)
      let streamingDisposable: vscode.Disposable | undefined;
      let promptReadyDisposable: vscode.Disposable | undefined;
      if (context.dashboardProvider) {
        // Initialize streaming output with basic prompt text
        context.dashboardProvider.updateCliStreamingChunk(i, ""); // Initialize buffer
        context.dashboardProvider.updateCliOutput(i, {
          prompt: prompt.prompt,
          response: "",
          elapsed: 0,
          tokens: undefined,
          isStreaming: true,
          cliCommand: undefined,
        });

        // Listen for prompt ready event (fires when full prompt and command are built)
        promptReadyDisposable = integration.onPromptReady((data) => {
          context.dashboardProvider?.updateCliOutput(i, {
            prompt: data.fullPrompt,
            response: "",
            elapsed: 0,
            tokens: undefined,
            isStreaming: true,
            cliCommand: context.shouldShowCliCommand
              ? data.cliCommand
              : undefined,
          });
        });

        streamingDisposable = integration.onStreamingChunk((chunk) => {
          Log.info(
            `🔍 WorkflowExecutor: Received streaming chunk, length=${chunk.length}, content (first 100 chars): ${JSON.stringify(chunk.substring(0, 100))}`
          );
          // Log to Output channel - centralized logging for all streaming content
          Log.append(chunk);
          // Update dashboard
          context.dashboardProvider?.updateCliStreamingChunk(i, chunk);
        });
      }

      // Send prompt to Copilot with workflow context for dynamic queue instructions
      const success = await integration.sendPrompt(
        prompt,
        needsCompletionDetection,
        {
          promptIndex: i,
          allPrompts: state.prompts,
          filePath: context.currentPromptFilePath,
        }
      );

      // Clean up event listeners
      streamingDisposable?.dispose();
      promptReadyDisposable?.dispose();

      if (!success) {
        // Check if this was a user-initiated stop (not a real error)
        const queueState = this.promptQueue.getState();
        if (queueState.stopped) {
          Log.info("⏹️ Execution stopped by user");
          break; // Exit loop without error
        }

        // Check if this was a user cancellation in chat UI
        // wasLastFailureUserCancellation() returns false by default (CLI)
        if (integration.wasLastFailureUserCancellation()) {
          Log.info("⏹️ User cancelled in Copilot Chat - stopping workflow");
          this.promptQueue.stop();
          break;
        }

        // Real error - get the specific failure reason and show message
        const failureReason = integration.getLastFailureReason();
        vscode.window.showErrorMessage(
          `Failed to execute prompt ${i + 1}: ${failureReason}`
        );

        // Mark queue as errored
        await this.promptQueue.markErrored();

        // Update dashboard with the specific failure reason
        if (context.dashboardProvider) {
          context.dashboardProvider.updateStepStatus(i, {
            state: STEP_STATUS.FAILED,
            message: failureReason,
          });
        }
        break;
      }

      // Mark as sent in queue
      await this.promptQueue.markCurrentAsSent();

      // Mark that we're waiting for a response
      this.isWaitingForResponse = true;

      // Wait for Copilot to finish responding before proceeding
      Log.info(
        `⏳ Waiting for Copilot to finish responding to prompt ${i + 1}...`
      );
      const responseText = await responsePromise;
      Log.info(`✅ Prompt ${i + 1} completed`);

      // Calculate duration
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      // Update dashboard with CLI output (if integration provides it)
      if (context.dashboardProvider) {
        // Get token statistics from CLI result (returns undefined for non-CLI)
        let tokens: { prompt: number; completion: number } | undefined;
        const lastResult = integration.getLastResult();
        if (lastResult?.statistics) {
          tokens = integration.parseTokenCounts(lastResult.statistics);
        }

        // Get CLI command if debugging is enabled (returns undefined for non-CLI)
        const cliCommand = context.shouldShowCliCommand
          ? integration.getLastCliCommand()
          : undefined;

        // Get full prompt text (with all context and instructions)
        const fullPrompt = integration.getLastFullPrompt() || prompt.prompt;

        context.dashboardProvider.updateCliOutput(i, {
          prompt: fullPrompt,
          response: responseText,
          elapsed: parseFloat(duration),
          tokens,
          isStreaming: false,
          cliCommand,
        });
      }

      // Evaluate end condition if present
      if (prompt.endCondition) {
        const shouldContinue = await this.evaluateEndCondition(
          prompt,
          integration,
          context,
          i,
          parseFloat(duration)
        );

        if (!shouldContinue) {
          Log.info("❌ Workflow stopped due to end condition failure");
          await this.promptQueue.markErrored();
          break;
        }

        // Update dashboard with success including end condition result
        if (context.dashboardProvider) {
          context.dashboardProvider.updateStepStatus(i, {
            state: STEP_STATUS.COMPLETED,
            duration: parseFloat(duration),
          });
          context.dashboardProvider.updateProgress(i + 1, state.prompts.length);
          context.dashboardProvider.updateRetryAttempt(i, 0, 0);
        }
      } else {
        // Update dashboard with success (no end condition)
        if (context.dashboardProvider) {
          context.dashboardProvider.updateStepStatus(i, {
            state: STEP_STATUS.COMPLETED,
            duration: parseFloat(duration),
          });
          context.dashboardProvider.updateProgress(i + 1, state.prompts.length);
        }
      }

      // Mark current prompt as completed and move to next
      await this.promptQueue.completeCurrentAndMoveNext();

      // Note: Queue extension now handled via MCP tools (flightpath_append_queue)
      // or user commands (Queue with FlightPath). The working file watcher in
      // FlightPathManager will detect changes and reload the queue automatically.

      // Check if workflow was paused
      if (this.promptQueue.getState().status === EXECUTION_STATES.PAUSED) {
        Log.info("⏸️ Workflow paused");
        break;
      }
    }

    Log.info("🎉 Workflow execution complete");

    // Set queue state to completed
    const finalState = this.promptQueue.getState();
    if (
      finalState.status !== EXECUTION_STATES.PAUSED &&
      finalState.status !== EXECUTION_STATES.ERROR
    ) {
      await this.promptQueue.markCompleted();
    }

    // Notify dashboard about execution completion
    if (context.dashboardProvider) {
      context.dashboardProvider.updateExecutionCompleted();
    }

    // Log workflow completion to output channel (only for CLI integration when output is enabled)
    if (context.showCliOutput && integration.isCli()) {
      Log.appendLine("");
      Log.appendLine(
        "═══════════════════════════════════════════════════════════"
      );
      Log.appendLine("        WORKFLOW COMPLETE ✓");
      Log.appendLine(
        "═══════════════════════════════════════════════════════════"
      );
      Log.appendLine(`Completed: ${new Date().toLocaleString()}`);
      Log.appendLine(
        `Prompts completed: ${state.prompts.length}/${state.prompts.length}`
      );
      Log.appendLine(
        "═══════════════════════════════════════════════════════════"
      );
    }
  }

  /**
   * Evaluate end condition for a prompt.
   * Delegates to EndConditionHandler for retry logic.
   *
   * @returns true to continue workflow, false to stop
   */
  private async evaluateEndCondition(
    prompt: PromptItem,
    integration: CopilotIntegration,
    context: WorkflowContext,
    currentIndex: number,
    duration: number
  ): Promise<boolean> {
    Log.info(`🔍 Evaluating end condition for prompt ${currentIndex + 1}...`);

    // Send status message: Evaluating end condition
    if (context.dashboardProvider) {
      const scriptName =
        prompt.endCondition!.script.split(/[\\/]/).pop() ||
        prompt.endCondition!.script;
      context.dashboardProvider.updateStatusMessage(
        currentIndex,
        `Evaluating end condition: Running ${scriptName}`
      );
    }

    // Evaluate the end condition
    const evaluationResult = await this.endConditionEvaluator.evaluateCondition(
      prompt.endCondition!,
      context.workspaceFolderPath
    );

    // Send status message: End condition result
    if (context.dashboardProvider) {
      const resultStatus = evaluationResult.success ? "Passed ✓" : "Failed ✗";
      // Show error message when present, otherwise show stdout (no truncation)
      const output = evaluationResult.error
        ? evaluationResult.error
        : evaluationResult.stdout.trim();
      context.dashboardProvider.updateStatusMessage(
        currentIndex,
        `End condition ${resultStatus} - Output: ${output}`
      );
    }

    // Handle the evaluation result using EndConditionHandler
    const retryContext = {
      integration,
      totalPrompts: this.promptQueue.getState().prompts.length,
      workspaceFolderPath: context.workspaceFolderPath,
      currentPromptFilePath: context.currentPromptFilePath,
    };

    const sendRetryPromptCallback = this.createSendRetryPromptCallback(
      integration,
      context
    );

    const result = await this.endConditionHandler.handleEndConditionResult(
      prompt,
      evaluationResult,
      retryContext,
      sendRetryPromptCallback
    );

    if (!result.shouldContinue) {
      // Update dashboard with failure using the reason from EndConditionHandler
      if (context.dashboardProvider) {
        context.dashboardProvider.updateStepStatus(currentIndex, {
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
   * Wait for Copilot to complete responding.
   * Handles pause state by holding the response until resume.
   *
   * @param prompt The current prompt being executed
   * @param integration The integration instance to use
   * @returns Promise that resolves with response text when complete
   */
  private async waitForResponseComplete(
    prompt: PromptItem,
    integration: CopilotIntegration
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let responseHandled = false;
      const disposable = integration.onResponseComplete(
        async (responseText: string) => {
          if (responseHandled) {
            Log.info("⚠️ Duplicate response complete event ignored");
            return;
          }
          responseHandled = true;
          disposable.dispose();

          // Check if workflow is paused - hold response until resume
          const currentState = this.promptQueue.getState();
          if (currentState.status === EXECUTION_STATES.PAUSED) {
            Log.info(
              "⏸️ Response complete but workflow is paused - holding until resume"
            );
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
   * Create a callback for sending retry prompts.
   * Used by EndConditionHandler for retry orchestration.
   */
  private createSendRetryPromptCallback(
    integration: CopilotIntegration,
    context: WorkflowContext
  ): SendRetryPromptCallback {
    return async (
      retryPromptItem: PromptItem,
      currentIndex: number
    ): Promise<string | null> => {
      const retryStartTime = Date.now();

      // Always need completion detection for retries
      const responsePromise = this.waitForResponseComplete(
        retryPromptItem,
        integration
      );

      // Send retry prompt with workflow context
      const state = this.promptQueue.getState();
      const success = await integration.sendPrompt(
        retryPromptItem,
        true, // needsCompletionDetection
        {
          promptIndex: currentIndex,
          allPrompts: state.prompts,
          filePath: context.currentPromptFilePath,
        }
      );

      if (!success) {
        return null;
      }

      Log.info("⏳ Waiting for retry response...");
      const retryResponseText = await responsePromise;
      Log.info("✅ Retry response complete");

      const retryDuration = ((Date.now() - retryStartTime) / 1000).toFixed(1);

      // Update dashboard with CLI output for retry (if integration supports it)
      if (context.dashboardProvider) {
        let tokens: { prompt: number; completion: number } | undefined;
        const lastResult = integration.getLastResult();
        if (lastResult?.statistics) {
          tokens = integration.parseTokenCounts(lastResult.statistics);
        }

        const cliCommand = context.shouldShowCliCommand
          ? integration.getLastCliCommand()
          : undefined;

        const fullPrompt =
          integration.getLastFullPrompt() || retryPromptItem.prompt;

        context.dashboardProvider.updateCliOutput(currentIndex, {
          prompt: fullPrompt,
          response: retryResponseText,
          elapsed: parseFloat(retryDuration),
          tokens,
          isStreaming: false,
          cliCommand,
        });
      }

      return retryResponseText;
    };
  }

  /**
   * Clear pending response state.
   * Called when starting a new execution or stopping.
   */
  clearPendingState(): void {
    this.pendingResponseResolver = null;
    this.pendingResponseText = null;
    this.isWaitingForResponse = false;
  }

  /**
   * Check if there's a pending response from when workflow was paused.
   */
  hasPendingResponse(): boolean {
    return (
      this.pendingResponseResolver !== null && this.pendingResponseText !== null
    );
  }

  /**
   * Check if we're currently waiting for a response.
   */
  isAwaitingResponse(): boolean {
    return this.isWaitingForResponse;
  }

  /**
   * Resume from pending response.
   * Called by FlightPathManager.resume() when there's a pending response.
   */
  resumePendingResponse(): void {
    if (this.pendingResponseResolver && this.pendingResponseText !== null) {
      Log.info("▶️ Resuming with pending response");
      const resolver = this.pendingResponseResolver;
      const responseText = this.pendingResponseText;

      this.pendingResponseResolver = null;
      this.pendingResponseText = null;

      resolver(responseText);
    }
  }
}
