import * as vscode from "vscode";
import {
  PromptItem,
  DynamicQueueConfig,
  EXECUTION_STATES,
  Harness,
} from "../types/FlightPathTypes";
import {
  STEP_STATUS,
  STATUS_MESSAGE_SEVERITY,
} from "../types/DashboardConstants";
import { PromptQueue } from "./PromptQueue";
import { PromptFileParser } from "./PromptFileParser";
import { CopilotIntegration } from "./base/CopilotIntegration";
import {
  EndConditionHandler,
  SendRetryPromptCallback,
} from "./EndConditionHandler";
import { EndConditionEvaluator } from "./EndConditionEvaluator";
import { FlightPathWebviewProvider } from "../ui/FlightPathWebviewProvider";
import { Log } from "../utils/Log";
import { PropertyResolver } from "../utils/PropertyResolver";
import {
  CliOutputFormatter,
  DashboardOutput,
} from "./cli/shared/CliOutputFormatter";
import { OutputHistoryManager } from "./orchestration/OutputHistoryManager";
import { StatusMessage } from "../types/WebviewMessageTypes";

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
  dashboardProvider?: FlightPathWebviewProvider;
  /** Whether to show CLI commands in output */
  shouldShowCliCommand: boolean;
  /** Whether to show CLI output in output panel */
  showCliOutput: boolean;
  /** Dynamic queue configuration */
  dynamicQueueConfig: DynamicQueueConfig;
  /** Integration resolver - gets the appropriate integration for a prompt */
  getIntegrationForPrompt: (
    prompt: PromptItem,
    harnessOverride?: Harness
  ) => CopilotIntegration;
  /** Path to current run's history file (empty string if history disabled) */
  historyFilePath: string;
  /** OutputHistoryManager for saving step outputs */
  outputHistoryManager?: OutputHistoryManager;
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

  // History tracking: accumulate status messages per step for history storage
  private stepStatusMessages: Map<number, StatusMessage[]> = new Map();

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
   * @param defaultIntegration The default Copilot integration to use (can be overridden per-prompt)
   * @param context Workflow context with dependencies and configuration
   */
  async execute(
    defaultIntegration: CopilotIntegration,
    context: WorkflowContext
  ): Promise<void> {
    // Clear any pending response state from previous execution
    this.clearPendingState();

    // Clear status message accumulator for this run
    this.stepStatusMessages.clear();

    // Set queue state to running (this will emit state change and update dashboard)
    await this.promptQueue.start();

    // Start execution time tracking
    this.promptQueue.startExecutionTimer();

    // Get fresh state (supports resume from pause)
    let state = this.promptQueue.getState();

    // Show the FlightPath dashboard panel when execution starts
    await this.showDashboard();

    // Log workflow start to output channel
    this.logWorkflowStart(context, defaultIntegration, state.prompts.length);

    // Start from currentIndex to support resume functionality
    // Note: Use queue.hasNext() instead of state.prompts.length to support dynamic queue extension
    while (this.promptQueue.hasNext()) {
      // Get fresh state on each iteration (supports queue extension during execution)
      state = this.promptQueue.getState();
      const i = state.currentIndex;
      const prompt = state.prompts[i];
      const dynamicConfig = context.dynamicQueueConfig;

      // Check if paused or stopped before starting new prompt
      const currentStatus = this.promptQueue.getState().status;
      if (currentStatus === EXECUTION_STATES.PAUSED) {
        Log.info("⏸️ Workflow paused before executing next prompt");
        break;
      }
      if (
        currentStatus === EXECUTION_STATES.STOPPED ||
        currentStatus === EXECUTION_STATES.CANCELLING
      ) {
        Log.info("🛑 Workflow stopped before executing next prompt");
        break;
      }

      // Check workflow execution time limit (unless unlimited mode or timeout disabled)
      // Use live queue state for accurate total (MCP may have extended queue)
      const liveProgress = this.promptQueue.getProgress();
      const shouldStop = await this.checkExecutionTimeLimit(
        dynamicConfig,
        i,
        liveProgress.total
      );
      if (shouldStop) {
        break;
      }

      // Resolve properties with three-tier precedence (prompt → workflow → settings)
      const workflowFile = this.promptQueue.getWorkflowFile();
      const resolvedProperties = PropertyResolver.resolve(prompt, workflowFile);

      // Resolve the integration for this prompt (supports per-prompt and workflow-level harness)
      const integration = context.getIntegrationForPrompt(
        prompt,
        resolvedProperties.harness
      );

      // Update dashboard step status to running
      this.updateDashboardForPromptStart(context, prompt, i);

      // Update progress - use live queue state for accurate total
      integration.setWorkflowProgress(i + 1, liveProgress.total);

      Log.info(`🚀 Executing prompt ${i + 1}/${liveProgress.total}`);

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
      let structuredStreamingDisposable: vscode.Disposable | undefined;
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
          workingDirectory: context.workspaceFolderPath,
          timestampMs: Date.now(),
          attemptIndex: 0,
        });

        // Listen for prompt ready event (fires when full prompt and command are built)
        promptReadyDisposable = integration.onPromptReady((data) => {
          context.dashboardProvider?.updateCliOutput(i, {
            prompt: prompt.prompt, // Use unexpanded prompt to avoid flooding output with large attachments
            response: "",
            elapsed: 0,
            tokens: undefined,
            isStreaming: true,
            cliCommand: context.shouldShowCliCommand
              ? data.cliCommand
              : undefined,
            workingDirectory: context.workspaceFolderPath,
            timestampMs: Date.now(),
            attemptIndex: 0,
          });
        });

        streamingDisposable = integration.onStreamingChunk((chunk) => {
          Log.info(
            `🔍 WorkflowExecutor: Received streaming chunk, length=${chunk.length}, content (first 100 chars): ${JSON.stringify(chunk.substring(0, 100))}`
          );
          // Log to Output channel - centralized logging for all streaming content
          Log.append(chunk);
          // Update dashboard (plain text streaming - Copilot CLI)
          context.dashboardProvider?.updateCliStreamingChunk(i, chunk);
        });

        // Subscribe to structured streaming events (Claude/Codex CLI)
        structuredStreamingDisposable = integration.onStreamingEvents(
          (events) => {
            Log.info(
              `🔍 WorkflowExecutor: Received ${events.length} structured streaming events`
            );
            // Update dashboard with structured events
            context.dashboardProvider?.updateCliStreamingEvents(i, events);
          }
        );
      }

      // Log resolved properties for debugging
      Log.info(
        `📋 Resolved properties for prompt ${i + 1}: ` +
          `harness=${resolvedProperties.harness}, ` +
          `model=${resolvedProperties.model}, ` +
          `agent=${resolvedProperties.agent || "(none)"}, ` +
          `resumeSession=${resolvedProperties.resumeSession}, ` +
          `allowDynamicExtension=${resolvedProperties.allowDynamicExtension}, ` +
          `endCondition=${resolvedProperties.endCondition ? "defined" : "none"}`
      );

      // Send prompt to integration
      const success = await integration.sendPrompt(
        prompt,
        needsCompletionDetection,
        {
          promptIndex: i,
          allPrompts: state.prompts,
          filePath: context.currentPromptFilePath,
          resolvedProperties, // Pass resolved properties to integration
          workflowFile, // Pass workflow file for session resolution
          promptQueue: this.promptQueue, // Pass queue for working file updates
        }
      );

      if (!success) {
        // Clean up event listeners immediately on failure
        streamingDisposable?.dispose();
        structuredStreamingDisposable?.dispose();
        promptReadyDisposable?.dispose();

        const shouldContinue = await this.handlePromptSendFailure(
          integration,
          context,
          i
        );
        if (!shouldContinue) {
          break;
        }
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

      // Clean up event listeners
      // This prevents the next prompt's subscriptions from overlapping with this one
      streamingDisposable?.dispose();
      structuredStreamingDisposable?.dispose();
      promptReadyDisposable?.dispose();

      // Calculate duration
      const duration = parseFloat(((Date.now() - startTime) / 1000).toFixed(1));

      // Update dashboard with CLI output (if integration provides it) and save to history
      await this.updateDashboardWithResponse(
        context,
        integration,
        prompt,
        responseText,
        duration,
        i
      );

      // Evaluate end condition if present
      if (prompt.endCondition) {
        const shouldContinue = await this.evaluateEndCondition(
          prompt,
          integration,
          context,
          i,
          duration
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
            duration: duration,
          });
          context.dashboardProvider.updateRetryAttempt(i, 0, 0);
        }
      } else {
        // Update dashboard with success (no end condition)
        if (context.dashboardProvider) {
          context.dashboardProvider.updateStepStatus(i, {
            state: STEP_STATUS.COMPLETED,
            duration: duration,
          });
        }
      }

      // Mark current prompt as completed and move to next
      await this.promptQueue.completeCurrentAndMoveNext();

      // Update progress after moving to next (progress.current = completed count)
      if (context.dashboardProvider) {
        const progress = this.promptQueue.getProgress();
        context.dashboardProvider.updateProgress(
          progress.current,
          progress.total
        );
      }

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

    // Set queue state to completed (unless user paused, stopped, or error occurred)
    await this.finalizeWorkflowExecution(context);

    // Log workflow completion to output channel
    this.logWorkflowCompletion(context, state.prompts.length);
  }

  /**
   * Send a status message to the dashboard and track it in stepStatusMessages.
   * This dual-write ensures history captures the same messages shown live.
   */
  private trackStatusMessage(
    context: WorkflowContext,
    stepIndex: number,
    message: string,
    severity: string = STATUS_MESSAGE_SEVERITY.INFO
  ): void {
    context.dashboardProvider?.updateStatusMessage(
      stepIndex,
      message,
      severity as any
    );

    // Track for history storage
    const msgs = this.stepStatusMessages.get(stepIndex) ?? [];
    msgs.push({
      message,
      severity: severity as any,
      timestamp: Date.now(),
    });
    this.stepStatusMessages.set(stepIndex, msgs);
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

    // Validate that the end condition has a script property
    if (!prompt.endCondition?.script) {
      Log.error(
        `End condition for prompt ${currentIndex + 1} is missing required 'script' property`
      );
      this.trackStatusMessage(
        context,
        currentIndex,
        `End condition failed: Missing script property`,
        STATUS_MESSAGE_SEVERITY.ERROR
      );
      if (context.dashboardProvider) {
        context.dashboardProvider.updateStepStatus(currentIndex, {
          state: STEP_STATUS.FAILED,
          message: "End condition missing required 'script' property",
          duration,
        });
      }
      return false;
    }

    // Send status message: Evaluating end condition
    const scriptName =
      prompt.endCondition.script.split(/[\\/]/).pop() ||
      prompt.endCondition.script;
    this.trackStatusMessage(
      context,
      currentIndex,
      `Evaluating end condition: Running ${scriptName}`
    );

    // Evaluate the end condition
    const evaluationResult = await this.endConditionEvaluator.evaluateCondition(
      prompt.endCondition,
      context.workspaceFolderPath
    );

    // Send status message: End condition result
    {
      const resultStatus = evaluationResult.success ? "Passed ✓" : "Failed ✗";
      const severity = evaluationResult.success
        ? STATUS_MESSAGE_SEVERITY.INFO
        : STATUS_MESSAGE_SEVERITY.ERROR;
      // Show error message when present, otherwise show stdout (no truncation)
      const output = evaluationResult.error
        ? evaluationResult.error
        : evaluationResult.stdout.trim();
      this.trackStatusMessage(
        context,
        currentIndex,
        `End condition ${resultStatus} - Output: ${output}`,
        severity
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
      const workflowFile = this.promptQueue.getWorkflowFile();
      const resolvedProperties = PropertyResolver.resolve(
        retryPromptItem,
        workflowFile
      );
      const resolvedRetryProperties = {
        ...resolvedProperties,
        resumeSession: true,
      };
      const success = await integration.sendPrompt(
        retryPromptItem,
        true, // needsCompletionDetection
        {
          promptIndex: currentIndex,
          allPrompts: state.prompts,
          filePath: context.currentPromptFilePath,
          resolvedProperties: resolvedRetryProperties,
          workflowFile, // Pass workflow file for session resolution
          promptQueue: this.promptQueue, // Pass queue for working file updates
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
      {
        // Get structured output if available (CLI integrations only)
        const parsedOutput = integration.getLastParsedOutput?.();
        let structured: DashboardOutput | undefined;
        if (parsedOutput) {
          structured = CliOutputFormatter.toDashboardFormat(parsedOutput);
        }

        // Get token statistics (prefer structured output over legacy parsing)
        let tokens: { prompt: number; completion: number } | undefined;
        if (parsedOutput?.metadata.usage) {
          // Modern path: Use structured metadata directly
          tokens = {
            prompt: parsedOutput.metadata.usage.inputTokens,
            completion: parsedOutput.metadata.usage.outputTokens,
          };
        } else {
          // Legacy fallback: Parse from statistics string (Chat integration)
          const lastResult = integration.getLastResult();
          if (lastResult?.statistics) {
            tokens = integration.parseTokenCounts(lastResult.statistics);
          }
        }

        const cliCommand = context.shouldShowCliCommand
          ? integration.getLastCliCommand()
          : undefined;

        // Use unexpanded prompt to avoid flooding output with large attachments
        const retryAttemptIndex = this.promptQueue.getCurrentRetryCount();
        const retryCliOutput = {
          prompt: retryPromptItem.prompt,
          response: retryResponseText,
          structured,
          elapsed: parseFloat(retryDuration),
          tokens,
          isStreaming: false,
          cliCommand,
          workingDirectory: context.workspaceFolderPath,
          timestampMs: Date.now(),
          attemptIndex: retryAttemptIndex,
        };

        if (context.dashboardProvider) {
          context.dashboardProvider.updateCliOutput(currentIndex, retryCliOutput);
        }

        // Save retry output to history
        if (context.historyFilePath && context.outputHistoryManager) {
          const statusMessages =
            this.stepStatusMessages.get(currentIndex) ?? [];
          await context.outputHistoryManager
            .saveStepOutput(
              context.historyFilePath,
              currentIndex,
              [retryCliOutput],
              statusMessages
            )
            .catch((err) =>
              Log.warn("Failed to save retry output to history:", err)
            );
        }
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

  /**
   * Log workflow start message to output channel.
   * Logs workflow metadata including start time, total prompts, and integration type.
   */
  private logWorkflowStart(
    context: WorkflowContext,
    integration: CopilotIntegration,
    totalPrompts: number
  ): void {
    if (!context.showCliOutput) {
      return;
    }

    Log.getOutputChannel().clear();
    Log.appendLine(
      "═══════════════════════════════════════════════════════════"
    );
    Log.appendLine("        FLIGHTPATH WORKFLOW STARTED");
    Log.appendLine(
      "═══════════════════════════════════════════════════════════"
    );
    Log.appendLine(`Started: ${new Date().toLocaleString()}`);
    Log.appendLine(`Total prompts: ${totalPrompts}`);
    Log.appendLine(
      `Integration: ${integration.getStatus().strategy.toUpperCase()}`
    );
    Log.appendLine(
      "═══════════════════════════════════════════════════════════"
    );
    Log.appendLine("");
  }

  /**
   * Log workflow completion message to output channel.
   * Logs completion metadata including end time and prompts completed.
   */
  private logWorkflowCompletion(
    context: WorkflowContext,
    totalPrompts: number
  ): void {
    if (!context.showCliOutput) {
      return;
    }

    Log.appendLine("");
    Log.appendLine(
      "═══════════════════════════════════════════════════════════"
    );
    Log.appendLine("        WORKFLOW COMPLETE ✓");
    Log.appendLine(
      "═══════════════════════════════════════════════════════════"
    );
    Log.appendLine(`Completed: ${new Date().toLocaleString()}`);
    Log.appendLine(`Prompts completed: ${totalPrompts}/${totalPrompts}`);
    Log.appendLine(
      "═══════════════════════════════════════════════════════════"
    );
  }

  /**
   * Show the FlightPath dashboard panel.
   * Attempts to focus the dashboard when execution starts.
   */
  private async showDashboard(): Promise<void> {
    try {
      await vscode.commands.executeCommand("flightpath.dashboard.focus");
    } catch (error) {
      Log.error("Could not focus dashboard panel:", error);
    }
  }

  /**
   * Check if workflow has exceeded maximum execution time.
   * Returns true if workflow should stop, false if it can continue.
   */
  private async checkExecutionTimeLimit(
    dynamicConfig: DynamicQueueConfig,
    currentIndex: number,
    totalPrompts: number
  ): Promise<boolean> {
    const maxTimeSec = dynamicConfig.maxWorkflowExecutionTime;
    const unlimitedWorkflow = dynamicConfig.unlimitedMode || maxTimeSec === -1;

    if (unlimitedWorkflow) {
      return false; // Can continue
    }

    const elapsedMs = this.promptQueue.getActiveExecutionTime();
    const elapsedSec = Math.floor(elapsedMs / 1000);

    if (elapsedSec >= maxTimeSec) {
      const completedCount = this.promptQueue.getCompletedCount();
      const remainingCount = totalPrompts - currentIndex;

      const message = `Workflow stopped - Maximum execution time reached (${elapsedSec}s / ${maxTimeSec}s).\nCompleted ${completedCount} of ${totalPrompts} prompts. ${remainingCount} prompts remaining in queue.`;

      vscode.window.showWarningMessage(message);
      Log.info(`⏱️ ${message}`);

      await this.promptQueue.markErrored();
      return true; // Should stop
    }

    return false; // Can continue
  }

  /**
   * Update dashboard to show prompt is starting.
   * Sets step status to running and updates status message.
   */
  private updateDashboardForPromptStart(
    context: WorkflowContext,
    prompt: PromptItem,
    currentIndex: number
  ): void {
    if (!context.dashboardProvider) {
      return;
    }

    context.dashboardProvider.updateStepStatus(currentIndex, {
      state: STEP_STATUS.RUNNING,
    });

    // NOTE: Removed redundant "Starting Prompt N:" status message
    // The CLI output header now shows "[Prompt N] Initial Attempt" with timestamp,
    // which provides the same information in a more consistent format.
  }

  /**
   * Handle prompt send failure.
   * Checks for user-initiated stop, user cancellation, or real errors.
   * Returns true if workflow should continue, false if it should stop.
   */
  private async handlePromptSendFailure(
    integration: CopilotIntegration,
    context: WorkflowContext,
    currentIndex: number
  ): Promise<boolean> {
    // Check if this was a user-initiated stop (not a real error)
    const queueState = this.promptQueue.getState();
    if (queueState.stopped) {
      Log.info("⏹️ Execution stopped by user");
      return false; // Stop workflow
    }

    // Check if this was a user cancellation in chat UI
    // wasLastFailureUserCancellation() returns false by default (CLI)
    if (integration.wasLastFailureUserCancellation()) {
      Log.info("⏹️ User cancelled in Copilot Chat - stopping workflow");
      this.promptQueue.stop();
      return false; // Stop workflow
    }

    // Real error - get the specific failure reason and show message
    const failureReason = integration.getLastFailureReason();
    vscode.window.showErrorMessage(
      `Failed to execute prompt ${currentIndex + 1}: ${failureReason}`
    );

    // Mark queue as errored
    await this.promptQueue.markErrored();

    // Update dashboard with the specific failure reason
    if (context.dashboardProvider) {
      context.dashboardProvider.updateStepStatus(currentIndex, {
        state: STEP_STATUS.FAILED,
        message: failureReason,
      });
    }

    return false; // Stop workflow
  }

  /**
   * Update dashboard with response data from integration.
   * Includes CLI output, tokens, elapsed time, and streaming status.
   * Also saves to history if enabled.
   */
  private async updateDashboardWithResponse(
    context: WorkflowContext,
    integration: CopilotIntegration,
    prompt: PromptItem,
    responseText: string,
    duration: number,
    currentIndex: number
  ): Promise<void> {
    // Get structured output if available (CLI integrations only)
    const parsedOutput = integration.getLastParsedOutput?.();
    let structured: DashboardOutput | undefined;
    if (parsedOutput) {
      structured = CliOutputFormatter.toDashboardFormat(parsedOutput);
    }

    // Get token statistics (prefer structured output over legacy parsing)
    let tokens: { prompt: number; completion: number } | undefined;
    if (parsedOutput?.metadata.usage) {
      // Modern path: Use structured metadata directly
      tokens = {
        prompt: parsedOutput.metadata.usage.inputTokens,
        completion: parsedOutput.metadata.usage.outputTokens,
      };
    } else {
      // Legacy fallback: Parse from statistics string (Chat integration)
      const lastResult = integration.getLastResult();
      if (lastResult?.statistics) {
        tokens = integration.parseTokenCounts(lastResult.statistics);
      }
    }

    // Get CLI command if debugging is enabled (returns undefined for non-CLI)
    const cliCommand = context.shouldShowCliCommand
      ? integration.getLastCliCommand()
      : undefined;

    // Build the output object (shared between dashboard and history)
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
      attemptIndex: 0,
    };

    // Use unexpanded prompt to avoid flooding output with large attachments
    if (context.dashboardProvider) {
      context.dashboardProvider.updateCliOutput(currentIndex, cliOutputObj);
    }

    // Save to history (same data, same moment)
    if (context.historyFilePath && context.outputHistoryManager) {
      const statusMessages = this.stepStatusMessages.get(currentIndex) ?? [];
      await context.outputHistoryManager
        .saveStepOutput(
          context.historyFilePath,
          currentIndex,
          [cliOutputObj],
          statusMessages
        )
        .catch((err) => Log.warn("Failed to save step output to history:", err));
    }
  }

  /**
   * Finalize workflow execution by setting appropriate end state.
   * Marks queue as completed if no errors, pauses, or stops occurred.
   */
  private async finalizeWorkflowExecution(
    context: WorkflowContext
  ): Promise<void> {
    const finalState = this.promptQueue.getState();
    if (
      finalState.status !== EXECUTION_STATES.PAUSED &&
      finalState.status !== EXECUTION_STATES.STOPPED &&
      finalState.status !== EXECUTION_STATES.CANCELLING &&
      finalState.status !== EXECUTION_STATES.ERROR
    ) {
      await this.promptQueue.markCompleted();

      // Only notify dashboard about completion if we actually completed
      if (context.dashboardProvider) {
        context.dashboardProvider.updateExecutionCompleted();
      }
    }
  }
}
