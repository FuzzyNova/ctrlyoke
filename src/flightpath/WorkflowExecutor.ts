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
  /** Output channel for CLI logging */
  outputChannel: vscode.OutputChannel;
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
      console.log("FlightPath: Could not focus dashboard panel:", error);
    }

    // Log workflow start to output channel (only for CLI integration when output is enabled)
    if (context.showCliOutput && integration.isCli()) {
      context.outputChannel.clear();
      context.outputChannel.appendLine(
        "═══════════════════════════════════════════════════════════"
      );
      context.outputChannel.appendLine("        FLIGHTPATH WORKFLOW STARTED");
      context.outputChannel.appendLine(
        "═══════════════════════════════════════════════════════════"
      );
      context.outputChannel.appendLine(
        `Started: ${new Date().toLocaleString()}`
      );
      context.outputChannel.appendLine(
        `Total prompts: ${state.prompts.length}`
      );
      context.outputChannel.appendLine(
        `Integration: ${integration.getStatus().strategy.toUpperCase()}`
      );
      context.outputChannel.appendLine(
        "═══════════════════════════════════════════════════════════"
      );
      context.outputChannel.appendLine("");
    }

    // Start from currentIndex to support resume functionality
    for (let i = state.currentIndex; i < state.prompts.length; i++) {
      const prompt = state.prompts[i];
      const dynamicConfig = context.dynamicQueueConfig;

      // Check if paused before starting new prompt
      if (this.promptQueue.getState().status === EXECUTION_STATES.PAUSED) {
        console.log(
          "⏸️ FlightPath: Workflow paused before executing next prompt"
        );
        break;
      }

      // Check execution time limit (if not unlimited)
      if (dynamicConfig.enabled && !dynamicConfig.unlimitedMode) {
        const elapsedMs = this.promptQueue.getActiveExecutionTime();
        const elapsedSec = Math.floor(elapsedMs / 1000);
        const maxTimeSec = dynamicConfig.maxExecutionTime;

        if (elapsedSec >= maxTimeSec) {
          const completedCount = this.promptQueue.getCompletedCount();
          const totalCount = state.prompts.length;
          const remainingCount = totalCount - i;

          const message = `FlightPath: Workflow stopped - Maximum execution time reached (${elapsedSec}s / ${maxTimeSec}s).\nCompleted ${completedCount} of ${totalCount} prompts. ${remainingCount} prompts remaining in queue.`;

          vscode.window.showWarningMessage(message);
          console.log(`⏱️ ${message}`);

          this.promptQueue.markErrored();
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

      console.log(
        `🚀 FlightPath: Executing prompt ${i + 1}/${state.prompts.length}`
      );

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
          console.log("⏹️ Execution stopped by user");
          break; // Exit loop without error
        }

        // Check if this was a user cancellation in chat UI
        // wasLastFailureUserCancellation() returns false by default (CLI)
        if (integration.wasLastFailureUserCancellation()) {
          console.log("⏹️ User cancelled in Copilot Chat - stopping workflow");
          this.promptQueue.stop();
          break;
        }

        // Real error - get the specific failure reason and show message
        const failureReason = integration.getLastFailureReason();
        vscode.window.showErrorMessage(
          `FlightPath: Failed to execute prompt ${i + 1}: ${failureReason}`
        );

        // Mark queue as errored
        this.promptQueue.markErrored();

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
      console.log(
        `⏳ FlightPath: Waiting for Copilot to finish responding to prompt ${i + 1}...`
      );
      const responseText = await responsePromise;
      console.log(`✅ FlightPath: Prompt ${i + 1} completed`);

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
          console.log(
            "❌ FlightPath: Workflow stopped due to end condition failure"
          );
          this.promptQueue.markErrored();
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

      // Dynamic queue reload
      if (dynamicConfig.enabled && context.currentPromptFilePath) {
        const maxSize = dynamicConfig.unlimitedMode
          ? 0
          : dynamicConfig.maxQueueSize;
        const addedCount = await this.promptQueue.reloadAndMergeQueue(
          context.currentPromptFilePath,
          this.promptFileParser,
          maxSize
        );

        if (addedCount > 0) {
          state = this.promptQueue.getState();

          if (dynamicConfig.notifyOnExtension) {
            const currentSize = state.prompts.length;
            const message = dynamicConfig.unlimitedMode
              ? `FlightPath: Queue extended (+${addedCount} prompts, total: ${currentSize})`
              : `FlightPath: Queue extended (+${addedCount} prompts, ${currentSize}/${dynamicConfig.maxQueueSize})`;

            vscode.window.showInformationMessage(message);
          }

          if (context.dashboardProvider) {
            context.dashboardProvider.notifyQueueExtended(
              addedCount,
              state.prompts.length,
              dynamicConfig.unlimitedMode
                ? undefined
                : dynamicConfig.maxQueueSize
            );
            context.dashboardProvider.updatePromptsExtended(state.prompts);
            context.dashboardProvider.updateProgress(
              i + 1,
              state.prompts.length
            );
          }
        }
      }

      // Check if workflow was paused
      if (this.promptQueue.getState().status === EXECUTION_STATES.PAUSED) {
        console.log("⏸️ FlightPath: Workflow paused");
        break;
      }
    }

    console.log("🎉 FlightPath: Workflow execution complete");

    // Set queue state to completed
    const finalState = this.promptQueue.getState();
    if (
      finalState.status !== EXECUTION_STATES.PAUSED &&
      finalState.status !== EXECUTION_STATES.ERROR
    ) {
      this.promptQueue.markCompleted();
    }

    // Notify dashboard about execution completion
    if (context.dashboardProvider) {
      context.dashboardProvider.updateExecutionCompleted();
    }

    // Log workflow completion to output channel (only for CLI integration when output is enabled)
    if (context.showCliOutput && integration.isCli()) {
      context.outputChannel.appendLine("");
      context.outputChannel.appendLine(
        "═══════════════════════════════════════════════════════════"
      );
      context.outputChannel.appendLine("        WORKFLOW COMPLETE ✓");
      context.outputChannel.appendLine(
        "═══════════════════════════════════════════════════════════"
      );
      context.outputChannel.appendLine(
        `Completed: ${new Date().toLocaleString()}`
      );
      context.outputChannel.appendLine(
        `Prompts completed: ${state.prompts.length}/${state.prompts.length}`
      );
      context.outputChannel.appendLine(
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
    console.log(
      `🔍 FlightPath: Evaluating end condition for prompt ${currentIndex + 1}...`
    );

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

    const shouldContinue =
      await this.endConditionHandler.handleEndConditionResult(
        prompt,
        evaluationResult,
        retryContext,
        sendRetryPromptCallback
      );

    if (!shouldContinue) {
      // Update dashboard with failure
      if (context.dashboardProvider) {
        context.dashboardProvider.updateStepStatus(currentIndex, {
          state: STEP_STATUS.FAILED,
          message: "End condition failed",
          duration,
          endConditionResult: evaluationResult,
        });
      }
    }

    return shouldContinue;
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
            console.log(
              "⚠️ FlightPath: Duplicate response complete event ignored"
            );
            return;
          }
          responseHandled = true;
          disposable.dispose();

          // Check if workflow is paused - hold response until resume
          const currentState = this.promptQueue.getState();
          if (currentState.status === EXECUTION_STATES.PAUSED) {
            console.log(
              "⏸️ FlightPath: Response complete but workflow is paused - holding until resume"
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

      console.log("⏳ FlightPath: Waiting for retry response...");
      const retryResponseText = await responsePromise;
      console.log("✅ FlightPath: Retry response complete");

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
      console.log("▶️ FlightPath: Resuming with pending response");
      const resolver = this.pendingResponseResolver;
      const responseText = this.pendingResponseText;

      this.pendingResponseResolver = null;
      this.pendingResponseText = null;

      resolver(responseText);
    }
  }
}
