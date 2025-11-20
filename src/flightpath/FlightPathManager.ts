import * as vscode from "vscode";
import * as path from "path";
import { PromptFileParser } from "./PromptFileParser";
import { PromptQueue } from "./PromptQueue";
import { CopilotIntegration, CopilotStatus } from "./base/CopilotIntegration";
import { CopilotChatIntegration } from "./chat/CopilotChatIntegration";
import { CopilotCommandLineIntegration } from "./cli/CopilotCommandLineIntegration";
import { EndConditionEvaluator } from "./EndConditionEvaluator";
import {
  PromptFile,
  PromptItem,
  QueueState,
  CopilotIntegrationMode,
} from "../types/FlightPathTypes";
import { FlightPathDashboardProvider } from "../ui/FlightPathDashboardProvider";

export class FlightPathManager {
  private promptFileParser: PromptFileParser;
  private promptQueue: PromptQueue;
  private cliIntegration: CopilotCommandLineIntegration;
  private chatIntegration: CopilotChatIntegration;
  private endConditionEvaluator: EndConditionEvaluator;
  private context: vscode.ExtensionContext;
  private statusBarItem: vscode.StatusBarItem;
  private currentWorkspaceFolder: vscode.WorkspaceFolder | undefined;
  private outputChannel: vscode.OutputChannel;
  private dashboardProvider?: FlightPathDashboardProvider;
  private currentPromptFile?: { filePath: string; promptFile: PromptFile };
  private activeIntegration?: CopilotIntegration; // Track currently executing integration

  // Pause/resume state: Track pending response when paused
  private pendingResponseResolver: ((text: string) => void) | null = null;
  private pendingResponseText: string | null = null;
  private isWaitingForResponse: boolean = false; // Track if we're waiting for response to sent prompt

  constructor(
    context: vscode.ExtensionContext,
    dashboardProvider?: FlightPathDashboardProvider
  ) {
    this.context = context;
    this.dashboardProvider = dashboardProvider;
    this.promptFileParser = new PromptFileParser();
    this.promptQueue = new PromptQueue();

    // Create output channel for CLI output
    this.outputChannel = vscode.window.createOutputChannel("FlightPath");
    context.subscriptions.push(this.outputChannel);

    // Initialize BOTH integrations so they're always ready to use
    this.cliIntegration = new CopilotCommandLineIntegration(
      context,
      this.outputChannel
    );
    this.chatIntegration = new CopilotChatIntegration(context);

    this.endConditionEvaluator = new EndConditionEvaluator(context);

    // Create status bar item
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBarItem.command = "flightpath.openPanel";
    this.updateStatusBar();
    context.subscriptions.push(this.statusBarItem);

    // Listen to queue state changes
    this.promptQueue.onDidChangeState(this.onQueueStateChanged.bind(this));

    // Listen to Copilot status changes from the default integration
    const defaultIntegration = this.getDefaultIntegration();
    context.subscriptions.push(
      defaultIntegration.onDidChangeStatus((status) => {
        console.log(`🔄 FlightPath: Copilot status changed to: ${status}`);
        this.updateStatusBar();
      })
    );

    // Get current workspace folder
    this.currentWorkspaceFolder = vscode.workspace.workspaceFolders?.[0];

    console.log("FlightPath: Manager initialized");
  }

  /**
   * Type guard to check if integration is chat-based
   */
  private isChatIntegration(
    integration: CopilotIntegration
  ): integration is CopilotChatIntegration {
    return integration instanceof CopilotChatIntegration;
  }

  /**
   * Type guard to check if integration is CLI-based
   */
  private isCliIntegration(
    integration: CopilotIntegration
  ): integration is CopilotCommandLineIntegration {
    return integration instanceof CopilotCommandLineIntegration;
  }

  /**
   * Get the default Copilot integration based on user settings
   */
  private getDefaultIntegration(): CopilotIntegration {
    const config = vscode.workspace.getConfiguration("flightpath");
    const integrationMode = config.get<string>(
      "copilotIntegrationMode",
      CopilotIntegrationMode.CLI
    );

    return integrationMode === CopilotIntegrationMode.Chat
      ? this.chatIntegration
      : this.cliIntegration;
  }

  /**
   * Get dynamic queue configuration from settings
   */
  private getDynamicQueueConfig(): import("../types/FlightPathTypes").DynamicQueueConfig {
    const config = vscode.workspace.getConfiguration("flightpath");

    return {
      enabled: config.get<boolean>("enableDynamicQueue", false),
      dynamicExtensionOnLastPrompt: config.get<boolean>(
        "dynamicExtensionOnLastPrompt",
        true
      ),
      maxQueueSize: config.get<number>("maxQueueSize", 100),
      maxExecutionTime: config.get<number>("maxExecutionTime", 18000),
      unlimitedMode: config.get<boolean>("unlimitedMode", false),
      notifyOnExtension: config.get<boolean>("notifyOnQueueExtension", true),
    };
  }

  /**
   * Create integration instance based on mode override or user settings
   * @param modeOverride Optional mode to override user settings
   * @returns Integration instance (either override or default)
   */
  private createIntegrationForMode(
    modeOverride?: CopilotIntegrationMode
  ): CopilotIntegration {
    if (modeOverride) {
      console.log(`🔀 FlightPath: Using mode override: ${modeOverride}`);
      return modeOverride === CopilotIntegrationMode.Chat
        ? this.chatIntegration
        : this.cliIntegration;
    }

    // Use default integration based on user settings
    return this.getDefaultIntegration();
  }

  /**
   * Initialize FlightPath manager
   */
  async initialize(): Promise<void> {
    try {
      console.log("FlightPath: Initializing manager...");

      // Discover existing prompt files
      await this.discoverPromptFiles();

      // Note: Copilot integration starts background polling automatically in constructor
      // Status bar will update via onDidChangeStatus event listener

      console.log("FlightPath: Manager initialization complete");
    } catch (error) {
      console.error("FlightPath: Failed to initialize manager:", error);
      vscode.window.showErrorMessage(
        `FlightPath: Initialization failed: ${error}`
      );
    }
  }

  /**
   * Load a prompt file into the dashboard without executing
   * @param filePath Path to the prompt file
   */
  async loadPromptFile(filePath: string): Promise<void> {
    try {
      console.log(`FlightPath: Loading prompt file: ${filePath}`);

      const fileName = path.basename(filePath);

      // Handle .prompt.md files differently (direct text, no parsing)
      let promptFile: PromptFile | null = null;

      if (filePath.endsWith(".prompt.md")) {
        console.log(
          "FlightPath: Detected .prompt.md file - reading as plain text"
        );
        promptFile = await this.parseMarkdownPromptFile(filePath);
      } else {
        // Parse JSON files (.prompt.json, .flightpath.json)
        promptFile = await this.promptFileParser.parsePromptFile(filePath);
      }

      if (!promptFile || !promptFile.prompts) {
        vscode.window.showErrorMessage(
          "FlightPath: Failed to parse prompt file"
        );
        return;
      }

      // Validate prompts
      const validation = this.promptFileParser.validatePromptItems(
        promptFile.prompts
      );
      if (!validation.valid) {
        const errors = validation.errors.join("\n");
        vscode.window.showErrorMessage(
          `FlightPath: Validation failed:\n${errors}`
        );
        return;
      }

      // Store the loaded file
      this.currentPromptFile = { filePath, promptFile };

      // Load prompts into queue (but don't start execution)
      this.promptQueue.loadPrompts(promptFile.prompts);

      // Notify dashboard about file selection
      if (this.dashboardProvider) {
        this.dashboardProvider.updateFileSelected(
          fileName,
          promptFile.prompts.map((p) => ({ prompt: p.prompt }))
        );
      }

      console.log(
        `FlightPath: Loaded ${promptFile.prompts.length} prompt(s) from ${fileName}`
      );
    } catch (error) {
      console.error("FlightPath: Failed to load prompt file:", error);
      vscode.window.showErrorMessage(
        `FlightPath: Failed to load file: ${error}`
      );
    }
  }

  /**
   * Execute the currently loaded prompt file
   * @param modeOverride Optional integration mode (overrides user settings for this execution)
   */
  async executeLoadedPromptFile(
    modeOverride?: CopilotIntegrationMode
  ): Promise<void> {
    if (!this.currentPromptFile) {
      vscode.window.showWarningMessage(
        "FlightPath: No prompt file loaded. Use 'Change' button to select a file first."
      );
      return;
    }

    const { filePath, promptFile } = this.currentPromptFile;
    const fileName = path.basename(filePath);

    try {
      console.log(`FlightPath: Executing loaded prompt file: ${filePath}`);

      // Create integration for this execution (either override or default)
      const integration = this.createIntegrationForMode(modeOverride);

      // Check Copilot readiness FIRST
      const detailedStatus = integration.getDetailedStatus();

      // Block execution if still initializing
      if (detailedStatus.initializationStatus === CopilotStatus.Initializing) {
        const action = await vscode.window.showWarningMessage(
          `FlightPath is still initializing Copilot integration. Please wait a moment and try again.`,
          "Retry",
          "Cancel"
        );

        if (action === "Retry") {
          // Try again after a short delay
          setTimeout(() => this.executeLoadedPromptFile(modeOverride), 1000);
        }
        return;
      }

      // Block execution if waiting for Copilot
      if (detailedStatus.initializationStatus === CopilotStatus.Waiting) {
        const action = await vscode.window.showWarningMessage(
          `FlightPath is waiting for Copilot to activate (attempt ${detailedStatus.pollingAttempts}/${detailedStatus.maxPollingAttempts}). Please wait...`,
          "Retry",
          "Cancel"
        );

        if (action === "Retry") {
          // Try again after a short delay
          setTimeout(() => this.executeLoadedPromptFile(modeOverride), 2000);
        }
        return;
      }

      // Block execution if unavailable
      if (detailedStatus.initializationStatus === CopilotStatus.Unavailable) {
        const action = await vscode.window.showErrorMessage(
          `FlightPath: Copilot automation is unavailable. Please ensure GitHub Copilot Chat is installed and active.`,
          "Retry Detection",
          "View Requirements",
          "Cancel"
        );

        if (action === "Retry Detection") {
          await this.retryCopilotDetection();
          // Try executing again after retry starts
          setTimeout(() => this.executeLoadedPromptFile(modeOverride), 2000);
        } else if (action === "View Requirements") {
          // Test automation only available for chat integration
          if (this.isChatIntegration(integration)) {
            await integration.testAutomation();
          } else {
            vscode.window.showInformationMessage(
              "FlightPath: Using CLI integration. Test automation is not needed."
            );
          }
        }
        return;
      }

      // Notify dashboard about execution start
      if (this.dashboardProvider && promptFile.prompts) {
        this.dashboardProvider.updateExecutionStarted(
          fileName,
          promptFile.prompts.length
        );
      }

      // Set workflow progress in Copilot integration
      if (promptFile.prompts) {
        integration.setWorkflowProgress(1, promptFile.prompts.length);
      }
      await this.startWorkflowExecution(integration);
    } catch (error) {
      console.error("FlightPath: Failed to execute prompt file:", error);

      // Mark queue as errored
      this.promptQueue.markErrored();

      vscode.window.showErrorMessage(`FlightPath: Execution failed: ${error}`);
    }
  }

  /**
   * Execute a prompt file (legacy method - loads and executes immediately)
   * @param filePath Path to the prompt file
   * @param modeOverride Optional integration mode (overrides user settings for this execution)
   */
  async executePromptFile(
    filePath: string,
    modeOverride?: CopilotIntegrationMode
  ): Promise<void> {
    // Load the file first
    await this.loadPromptFile(filePath);
    // Then execute it immediately (for backwards compatibility with context menu)
    await this.executeLoadedPromptFile(modeOverride);
  }

  /**
   * Parse a .prompt.md file as a single prompt
   * @param filePath Path to the .prompt.md file
   * @returns PromptFile with single prompt item
   */
  private async parseMarkdownPromptFile(
    filePath: string
  ): Promise<PromptFile | null> {
    try {
      const fs = await import("fs/promises");
      const content = await fs.readFile(filePath, "utf8");

      // Trim whitespace but preserve the prompt text as-is
      const promptText = content.trim();

      if (!promptText) {
        throw new Error("Prompt file is empty");
      }

      return {
        prompts: [
          {
            prompt: promptText,
            // No end condition for markdown files (they're single prompts)
            endCondition: undefined,
          },
        ],
      };
    } catch (error) {
      console.error(
        `FlightPath: Failed to read markdown prompt file ${filePath}:`,
        error
      );
      vscode.window.showErrorMessage(
        `FlightPath: Failed to read ${path.basename(filePath)}: ${error}`
      );
      return null;
    }
  }

  /**
   * Start workflow execution with Copilot integration
   * @param integration Optional integration to use (defaults to instance integration)
   */
  private async startWorkflowExecution(
    integration?: CopilotIntegration
  ): Promise<void> {
    const activeIntegration = integration || this.getDefaultIntegration();

    // Track the active integration for stop() method
    this.activeIntegration = activeIntegration;

    // Clear any pending response state from previous execution
    this.pendingResponseResolver = null;
    this.pendingResponseText = null;
    this.isWaitingForResponse = false;

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

    // Log workflow start to output channel
    const shouldShowOutput = vscode.workspace
      .getConfiguration("flightpath")
      .get<boolean>("showCliOutput", true);

    if (shouldShowOutput && this.isCliIntegration(activeIntegration)) {
      this.outputChannel.clear();
      this.outputChannel.appendLine(
        "═══════════════════════════════════════════════════════════"
      );
      this.outputChannel.appendLine("        FLIGHTPATH WORKFLOW STARTED");
      this.outputChannel.appendLine(
        "═══════════════════════════════════════════════════════════"
      );
      this.outputChannel.appendLine(`Started: ${new Date().toLocaleString()}`);
      this.outputChannel.appendLine(`Total prompts: ${state.prompts.length}`);
      this.outputChannel.appendLine(
        `Integration: ${activeIntegration.getStatus().strategy.toUpperCase()}`
      );
      this.outputChannel.appendLine(
        "═══════════════════════════════════════════════════════════"
      );
      this.outputChannel.appendLine("");
      // Don't automatically show output panel - user can view it manually if needed
      // this.outputChannel.show(true); // Show but preserve focus
    }

    // Start from currentIndex to support resume functionality
    // When paused, currentIndex is already at the next prompt to execute
    for (let i = state.currentIndex; i < state.prompts.length; i++) {
      const prompt = state.prompts[i];

      // Get dynamic queue config once per loop iteration
      const dynamicConfig = this.getDynamicQueueConfig();

      // Check if paused before starting new prompt (handles pause between prompts)
      if (this.promptQueue.getState().status === "paused") {
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
      if (this.dashboardProvider) {
        this.dashboardProvider.updateStepStatus(i, { state: "running" });

        // Send status message: Starting prompt
        const promptPreview = prompt.prompt.split("\n")[0].substring(0, 60);
        const ellipsis = prompt.prompt.length > 60 ? "..." : "";
        this.dashboardProvider.updateStatusMessage(
          i,
          `Starting Prompt ${i + 1}: ${promptPreview}${ellipsis}`
        );
      }

      // Update progress
      activeIntegration.setWorkflowProgress(i + 1, state.prompts.length);

      console.log(
        `🚀 FlightPath: Executing prompt ${i + 1}/${state.prompts.length}`
      );

      // Record start time for this prompt
      const startTime = Date.now();

      // Need completion detection if:
      // 1. Multi-prompt workflow (need to know when to advance to next prompt)
      // 2. Single prompt with endCondition (need to know when to evaluate script)
      const needsCompletionDetection =
        state.prompts.length > 1 || !!prompt.endCondition?.script;

      // Set up response listener BEFORE sending prompt to avoid race condition (only if needed)
      const responsePromise = needsCompletionDetection
        ? this.waitForResponseComplete(prompt, activeIntegration)
        : Promise.resolve(""); // No completion detection needed

      // Set up streaming listener for real-time output (CLI only)
      let streamingDisposable: vscode.Disposable | undefined;
      if (this.dashboardProvider && this.isCliIntegration(activeIntegration)) {
        // Initialize streaming output with prompt text
        this.dashboardProvider.updateCliStreamingChunk(i, ""); // Initialize buffer
        this.dashboardProvider.updateCliOutput(i, {
          prompt: prompt.prompt,
          response: "",
          elapsed: 0,
          tokens: undefined,
          isStreaming: true,
        });

        streamingDisposable = activeIntegration.onStreamingChunk((chunk) => {
          this.dashboardProvider?.updateCliStreamingChunk(i, chunk);
        });
      }

      // Send prompt to Copilot with workflow context for dynamic queue instructions
      const success = await activeIntegration.sendPrompt(
        prompt,
        needsCompletionDetection,
        {
          promptIndex: i,
          allPrompts: state.prompts,
          filePath: this.currentPromptFile?.filePath,
        }
      );

      // Clean up streaming listener
      streamingDisposable?.dispose();

      if (!success) {
        // Check if this was a user-initiated stop (not a real error)
        const queueState = this.promptQueue.getState();
        if (queueState.stopped) {
          console.log("⏹️ Execution stopped by user");
          break; // Exit loop without error
        }

        // Real error - show message and mark as failed
        vscode.window.showErrorMessage(
          `FlightPath: Failed to execute prompt ${i + 1}`
        );

        // Mark queue as errored
        this.promptQueue.markErrored();

        // Update dashboard with failure
        if (this.dashboardProvider) {
          this.dashboardProvider.updateStepStatus(i, {
            state: "failed",
            message: "Failed to send prompt",
          });
        }
        break;
      }

      // Mark as sent in queue
      await this.promptQueue.markCurrentAsSent();

      // Mark that we're waiting for a response
      this.isWaitingForResponse = true;

      // Wait for Copilot to finish responding (only for multi-prompt workflows)
      let responseText = "";
      if (needsCompletionDetection) {
        console.log(
          `⏳ FlightPath: Waiting for Copilot to finish responding to prompt ${i + 1}...`
        );
        responseText = await responsePromise;
        console.log(`✅ FlightPath: Prompt ${i + 1} completed`);

        // Calculate duration
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        // Update dashboard with CLI output (if using CLI integration)
        if (
          this.dashboardProvider &&
          this.isCliIntegration(activeIntegration)
        ) {
          // Get token statistics from CLI result
          let tokens: { prompt: number; completion: number } | undefined;
          const lastResult = activeIntegration.getLastResult();
          if (lastResult?.statistics) {
            tokens = activeIntegration.parseTokenCounts(lastResult.statistics);
          }

          this.dashboardProvider.updateCliOutput(i, {
            prompt: prompt.prompt,
            response: responseText,
            elapsed: parseFloat(duration),
            tokens,
            isStreaming: false, // Mark as complete
          });
        }

        // Evaluate end condition if present (now with response text available)
        if (prompt.endCondition) {
          console.log(
            `🔍 FlightPath: Evaluating end condition for prompt ${i + 1}...`
          );

          // Send status message: Evaluating end condition
          if (this.dashboardProvider) {
            const scriptName =
              prompt.endCondition.script.split(/[\\/]/).pop() ||
              prompt.endCondition.script;
            this.dashboardProvider.updateStatusMessage(
              i,
              `Evaluating end condition: Running ${scriptName}`
            );
          }

          // Evaluate the end condition
          const evaluationResult =
            await this.endConditionEvaluator.evaluateCondition(
              prompt.endCondition,
              this.currentWorkspaceFolder?.uri.fsPath
            );

          // Send status message: End condition result
          if (this.dashboardProvider) {
            const resultStatus = evaluationResult.success
              ? "Passed ✓"
              : "Failed ✗";
            const output = evaluationResult.stdout.trim().substring(0, 100);
            const ellipsis =
              evaluationResult.stdout.trim().length > 100 ? "..." : "";
            this.dashboardProvider.updateStatusMessage(
              i,
              `End condition ${resultStatus} - Output: ${output}${ellipsis}`
            );
          }

          // Handle the evaluation result
          const shouldContinue = await this.handleEndConditionResult(
            prompt,
            evaluationResult,
            activeIntegration,
            state.prompts.length
          );

          if (!shouldContinue) {
            console.log(
              "❌ FlightPath: Workflow stopped due to end condition failure"
            );

            // Mark queue as errored
            this.promptQueue.markErrored();

            // Update dashboard with failure
            if (this.dashboardProvider) {
              this.dashboardProvider.updateStepStatus(i, {
                state: "failed",
                message: "End condition failed",
                duration: parseFloat(duration),
                endConditionResult: evaluationResult,
              });
            }
            break;
          }

          // Update dashboard with success including end condition result
          if (this.dashboardProvider) {
            this.dashboardProvider.updateStepStatus(i, {
              state: "completed",
              duration: parseFloat(duration),
              endConditionResult: evaluationResult,
            });
            // Update progress AFTER completion
            this.dashboardProvider.updateProgress(i + 1, state.prompts.length);
            // Reset retry state on success
            this.dashboardProvider.updateRetryAttempt(i, 0, 0);
          }
        } else {
          // Update dashboard with success (no end condition)
          if (this.dashboardProvider) {
            this.dashboardProvider.updateStepStatus(i, {
              state: "completed",
              duration: parseFloat(duration),
            });
            // Update progress AFTER completion
            this.dashboardProvider.updateProgress(i + 1, state.prompts.length);
          }
        }
      } else {
        console.log(
          `✅ FlightPath: Prompt sent successfully (no completion detection needed)`
        );
        // Note: This path only executes for single prompts WITHOUT end conditions
        // If a single prompt has an endCondition, needsCompletionDetection will be true

        // Calculate duration
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        // For CLI integration, we can still get the output even without completion detection
        // The CLI command has already completed when sendPrompt returns
        if (
          this.dashboardProvider &&
          this.isCliIntegration(activeIntegration)
        ) {
          // Get the CLI result (response and statistics)
          const lastResult = activeIntegration.getLastResult();
          if (lastResult) {
            // Parse token counts from statistics
            let tokens: { prompt: number; completion: number } | undefined;
            if (lastResult.statistics) {
              tokens = activeIntegration.parseTokenCounts(
                lastResult.statistics
              );
            }

            // Update dashboard with CLI output
            this.dashboardProvider.updateCliOutput(i, {
              prompt: prompt.prompt,
              response: lastResult.response,
              elapsed: parseFloat(duration),
              tokens,
              isStreaming: false, // Mark as complete
            });
          }
        }

        // Update dashboard with completion
        if (this.dashboardProvider) {
          this.dashboardProvider.updateStepStatus(i, {
            state: "completed",
            duration: parseFloat(duration),
          });
          // Update progress AFTER completion
          this.dashboardProvider.updateProgress(i + 1, state.prompts.length);
        }
      }

      // Mark current prompt as completed in queue and move to next
      // This updates queue state (currentIndex, retryCount) properly
      await this.promptQueue.completeCurrentAndMoveNext();

      // Dynamic queue reload: Check if we should reload the prompt file after completion
      // (dynamicConfig already declared at top of loop)
      if (dynamicConfig.enabled && this.currentPromptFile?.filePath) {
        const maxSize = dynamicConfig.unlimitedMode
          ? 0
          : dynamicConfig.maxQueueSize;
        const addedCount = await this.promptQueue.reloadAndMergeQueue(
          this.currentPromptFile.filePath,
          this.promptFileParser,
          maxSize
        );

        if (addedCount > 0) {
          // Update state reference after reload
          state = this.promptQueue.getState();

          // Show notification if enabled
          if (dynamicConfig.notifyOnExtension) {
            const currentSize = state.prompts.length;
            const message = dynamicConfig.unlimitedMode
              ? `FlightPath: Queue extended (+${addedCount} prompts, total: ${currentSize})`
              : `FlightPath: Queue extended (+${addedCount} prompts, ${currentSize}/${dynamicConfig.maxQueueSize})`;

            vscode.window.showInformationMessage(message);
          }

          // Notify dashboard about queue extension
          if (this.dashboardProvider) {
            this.dashboardProvider.notifyQueueExtended(
              addedCount,
              state.prompts.length,
              dynamicConfig.unlimitedMode
                ? undefined
                : dynamicConfig.maxQueueSize
            );

            // Update dashboard with new total
            this.dashboardProvider.updateProgress(i + 1, state.prompts.length);
          }
        }
      }

      // Check if workflow was paused
      if (this.promptQueue.getState().status === "paused") {
        console.log("⏸️ FlightPath: Workflow paused");
        break;
      }
    }

    console.log("🎉 FlightPath: Workflow execution complete");

    // Clear active integration reference
    this.activeIntegration = undefined;

    // Set queue state to completed (this will emit state change and update dashboard)
    const finalState = this.promptQueue.getState();
    if (finalState.status !== "paused" && finalState.status !== "error") {
      // Only mark as completed if not already paused or errored
      this.promptQueue.markCompleted();
    }

    // Notify dashboard about execution completion
    if (this.dashboardProvider) {
      this.dashboardProvider.updateExecutionCompleted();
    }

    // Log workflow completion to output channel
    if (shouldShowOutput && this.isCliIntegration(activeIntegration)) {
      this.outputChannel.appendLine("");
      this.outputChannel.appendLine(
        "═══════════════════════════════════════════════════════════"
      );
      this.outputChannel.appendLine("        WORKFLOW COMPLETE ✓");
      this.outputChannel.appendLine(
        "═══════════════════════════════════════════════════════════"
      );
      this.outputChannel.appendLine(
        `Completed: ${new Date().toLocaleString()}`
      );
      this.outputChannel.appendLine(
        `Prompts completed: ${state.prompts.length}/${state.prompts.length}`
      );
      this.outputChannel.appendLine(
        "═══════════════════════════════════════════════════════════"
      );
    }
  }

  /**
   * Wait for Copilot to call the response complete tool
   * @param prompt The current prompt being executed
   * @param integration The integration instance to use
   * @returns Promise that resolves with response text when response is complete
   */
  private async waitForResponseComplete(
    prompt: PromptItem,
    integration: CopilotIntegration
  ): Promise<string> {
    // No timeout - CLI completes deterministically, Chat should call the completion tool
    // End condition timeout is separate and handled by EndConditionEvaluator
    return new Promise<string>((resolve, reject) => {
      // Subscribe to response complete event (with duplicate protection)
      let responseHandled = false; // Prevent duplicate event handling
      const disposable = integration.onResponseComplete(
        async (responseText: string) => {
          // Ignore duplicate events (defense-in-depth)
          if (responseHandled) {
            console.log(
              "⚠️ FlightPath: Duplicate response complete event ignored (already handled)"
            );
            return;
          }
          responseHandled = true;

          disposable.dispose();
          console.log("✅ FlightPath: Response complete signal received");
          console.log(
            `📊 Response text length: ${responseText.length} characters`
          );

          // IMPORTANT: For chat integration, tool callback fires BEFORE Copilot finishes streaming
          // Wait for streaming to actually finish before proceeding
          // CLI integration doesn't need this as the command returns when complete
          if (this.isChatIntegration(integration)) {
            console.log(
              "⏳ FlightPath: Waiting for Copilot chat to finish streaming..."
            );
            await integration.waitForStreamingComplete();
            console.log(
              "✅ FlightPath: Copilot finished streaming, ready for next prompt"
            );
          }

          // Check if workflow is paused - if so, hold the response until resume
          const currentState = this.promptQueue.getState();
          if (currentState.status === "paused") {
            console.log(
              "⏸️ FlightPath: Response complete but workflow is paused - holding response until resume"
            );
            // Store the resolver and response text, but don't call it yet
            // Resume will call this resolver to continue the workflow
            this.pendingResponseResolver = resolve;
            this.pendingResponseText = responseText;
            this.isWaitingForResponse = false; // No longer waiting - response received
            return; // Don't resolve yet - wait for resume
          }

          // Clear waiting flag - response received
          this.isWaitingForResponse = false;
          resolve(responseText);
        }
      );
    });
  }

  /**
   * Take off - execute selected prompt file
   */
  async takeOff(): Promise<void> {
    try {
      if (!this.currentWorkspaceFolder) {
        vscode.window.showErrorMessage("FlightPath: No workspace folder found");
        return;
      }

      // Discover available prompt files
      const promptFiles = await this.promptFileParser.discoverPromptFiles(
        this.currentWorkspaceFolder
      );

      if (promptFiles.length === 0) {
        const createAction = await vscode.window.showInformationMessage(
          "No prompt files found. Would you like to create one?",
          "Create Prompt File",
          "Cancel"
        );

        if (createAction === "Create Prompt File") {
          await this.createPromptFile();
        }
        return;
      }

      // Show quick pick for file selection
      const items = promptFiles.map((filePath) => ({
        label: path.basename(filePath),
        description: path.relative(
          this.currentWorkspaceFolder!.uri.fsPath,
          filePath
        ),
        filePath,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a prompt file to execute",
        ignoreFocusOut: true,
      });

      if (selected) {
        await this.executePromptFile(selected.filePath);
      }
    } catch (error) {
      console.error("FlightPath: Take off failed:", error);
      vscode.window.showErrorMessage(`FlightPath: Take off failed: ${error}`);
    }
  }

  /**
   * Pause current execution
   */
  pause(): void {
    this.promptQueue.pause();
  }

  /**
   * Resume execution from paused state
   */
  async resume(): Promise<void> {
    // First, update queue state to running
    await this.promptQueue.resume();

    // Case 1: Tool callback already fired while paused
    if (this.pendingResponseResolver && this.pendingResponseText !== null) {
      console.log(
        "▶️ FlightPath: Resuming with pending response (Copilot finished while paused)"
      );
      // Resolve the pending promise to continue the workflow
      const resolver = this.pendingResponseResolver;
      const responseText = this.pendingResponseText;

      // Clear pending state before resolving to avoid re-entrance
      this.pendingResponseResolver = null;
      this.pendingResponseText = null;

      // Resolve the promise - this will continue the workflow loop
      resolver(responseText);
      return;
    }

    // Case 2: Still waiting for response (prompt sent but tool callback not fired yet)
    if (this.isWaitingForResponse) {
      console.log(
        "▶️ FlightPath: Resuming while Copilot is still responding - will continue when response completes"
      );
      // Do nothing - when the response completes, it will see queue state is "running"
      // and will resolve normally, continuing the workflow
      return;
    }

    // Case 3: Not waiting for response (paused between prompts or before sending)
    console.log("▶️ FlightPath: Resuming workflow from paused position");
    await this.startWorkflowExecution();
  }

  /**
   * Stop current execution
   * Cancels the active integration's current operation and stops the queue
   */
  async stop(): Promise<void> {
    // Cancel the currently executing integration (respects mode override)
    // If no execution is active, use default integration
    const integration = this.activeIntegration || this.getDefaultIntegration();

    // Cancel is now in base class, no need for type guards
    await integration.cancel();

    // Clear any pending response (prevents workflow from continuing after stop)
    this.pendingResponseResolver = null;
    this.pendingResponseText = null;
    this.isWaitingForResponse = false;

    // Stop the queue
    this.promptQueue.stop();
  }

  /**
   * Create a new prompt file
   */
  async createPromptFile(): Promise<void> {
    try {
      if (!this.currentWorkspaceFolder) {
        vscode.window.showErrorMessage("FlightPath: No workspace folder found");
        return;
      }

      // Get file name from user
      const fileName = await vscode.window.showInputBox({
        prompt: "Enter prompt file name",
        placeHolder: "my-workflow.prompt.json",
        validateInput: (value) => {
          if (!value) {
            return "File name is required";
          }
          if (
            !value.endsWith(".prompt.json") &&
            !value.endsWith(".flightpath.json")
          ) {
            return "File must end with .prompt.json or .flightpath.json";
          }
          return null;
        },
      });

      if (!fileName) {
        return;
      }

      // Create prompts directory if it doesn't exist
      const promptsDir = vscode.workspace
        .getConfiguration("flightpath")
        .get<string>("promptsDirectory", ".flightpath");
      const promptsDirPath = path.join(
        this.currentWorkspaceFolder.uri.fsPath,
        promptsDir
      );
      const filePath = path.join(promptsDirPath, fileName);

      // Create example content
      const exampleContent = fileName.endsWith(".flightpath.json")
        ? this.createExampleFlightPathContent()
        : this.createExamplePromptContent();

      // Write file
      const uri = vscode.Uri.file(filePath);
      await vscode.workspace.fs.writeFile(
        uri,
        Buffer.from(exampleContent, "utf8")
      );

      // Open file for editing
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);

      vscode.window.showInformationMessage(`FlightPath: Created ${fileName}`);
    } catch (error) {
      console.error("FlightPath: Failed to create prompt file:", error);
      vscode.window.showErrorMessage(
        `FlightPath: Failed to create prompt file: ${error}`
      );
    }
  }

  /**
   * Open FlightPath panel
   */
  async openPanel(): Promise<void> {
    // Check if Copilot is unavailable and offer retry
    const copilotStatus = this.getDefaultIntegration().getDetailedStatus();

    if (copilotStatus.initializationStatus === CopilotStatus.Unavailable) {
      const action = await vscode.window.showWarningMessage(
        "FlightPath: Copilot automation is unavailable. Would you like to retry detection?",
        "Retry Detection",
        "View Status",
        "Continue Anyway"
      );

      if (action === "Retry Detection") {
        await this.retryCopilotDetection();
        return;
      } else if (action === "View Status") {
        vscode.commands.executeCommand("flightpath.showCopilotStatus");
        return;
      }
    }

    // Focus the FlightPath dashboard panel
    try {
      await vscode.commands.executeCommand("flightpath.dashboard.focus");
    } catch (error) {
      console.error("Failed to focus FlightPath dashboard:", error);
      // Fallback to takeOff if focus fails
      await this.takeOff();
    }
  }

  /**
   * Get current queue state
   */
  getQueueState(): QueueState {
    return this.promptQueue.getState();
  }

  /**
   * Get currently loaded prompt file info
   */
  getCurrentPromptFile(): { fileName: string; prompts: any[] } | null {
    if (!this.currentPromptFile || !this.currentPromptFile.promptFile.prompts) {
      return null;
    }

    return {
      fileName: path.basename(this.currentPromptFile.filePath),
      prompts: this.currentPromptFile.promptFile.prompts.map((p) => ({
        prompt: p.prompt,
      })),
    };
  }

  /**
   * Open the currently loaded prompt file in the editor
   */
  async openCurrentPromptFile(): Promise<void> {
    if (!this.currentPromptFile) {
      vscode.window.showWarningMessage(
        "FlightPath: No prompt file loaded. Use 'Select' button to choose a file first."
      );
      return;
    }

    try {
      const uri = vscode.Uri.file(this.currentPromptFile.filePath);
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
      console.log(
        `FlightPath: Opened prompt file: ${this.currentPromptFile.filePath}`
      );
    } catch (error) {
      console.error("FlightPath: Failed to open prompt file:", error);
      vscode.window.showErrorMessage(
        `FlightPath: Failed to open file: ${error}`
      );
    }
  }

  /**
   * Get Copilot integration status
   */
  getCopilotStatus(): {
    available: boolean;
    message: string;
    strategy: string;
  } {
    return this.getDefaultIntegration().getStatus();
  }

  /**
   * Test Copilot automation (chat integration only)
   */
  async testCopilotAutomation(): Promise<boolean> {
    const defaultIntegration = this.getDefaultIntegration();
    if (this.isChatIntegration(defaultIntegration)) {
      return await defaultIntegration.testAutomation();
    } else {
      vscode.window.showInformationMessage(
        "FlightPath: Test automation is only available for chat integration. CLI integration is ready when initialized."
      );
      return defaultIntegration.isReady();
    }
  }

  /**
   * Retry Copilot detection (restart polling - chat integration only)
   */
  async retryCopilotDetection(): Promise<void> {
    const defaultIntegration = this.getDefaultIntegration();
    if (this.isChatIntegration(defaultIntegration)) {
      await defaultIntegration.retryDetection();
    } else {
      // For CLI integration, just re-initialize
      await defaultIntegration.initialize();
    }
  }

  /**
   * Get Copilot integration capabilities (chat integration only)
   */
  getCopilotCapabilities() {
    const defaultIntegration = this.getDefaultIntegration();
    if (this.isChatIntegration(defaultIntegration)) {
      return defaultIntegration.getCapabilities();
    } else {
      // Return basic capabilities for CLI integration
      return {
        hasDirectAutomation: true,
        supportsZeroInteraction: true,
        currentStrategy: CopilotIntegrationMode.CLI,
      };
    }
  }

  /**
   * Get detailed Copilot status including initialization state
   */
  getCopilotDetailedStatus() {
    return this.getDefaultIntegration().getDetailedStatus();
  }

  /**
   * Discover prompt files in workspace
   */
  private async discoverPromptFiles(): Promise<void> {
    if (!this.currentWorkspaceFolder) {
      return;
    }

    const promptFiles = await this.promptFileParser.discoverPromptFiles(
      this.currentWorkspaceFolder
    );
    console.log(`FlightPath: Discovered ${promptFiles.length} prompt files`);
  }

  /**
   * Handle queue state changes
   */
  private onQueueStateChanged(state: QueueState): void {
    console.log(`FlightPath: Queue state changed to ${state.status}`);
    this.updateStatusBar();

    // Send execution state to dashboard
    if (this.dashboardProvider) {
      this.dashboardProvider.updateExecutionState(state.status);
    }
  }

  /**
   * Update status bar item
   */
  private updateStatusBar(): void {
    const state = this.promptQueue.getState();
    const progress = this.promptQueue.getProgress();
    const copilotStatus = this.getDefaultIntegration().getDetailedStatus();

    let text = "$(compass) FlightPath";
    let tooltip = "FlightPath - Click to open";

    // Priority 1: Show workflow execution status if running
    if (state.status === "running") {
      text = `$(compass-dot) FlightPath ${progress.current}/${progress.total}`;
      tooltip = `FlightPath - Running (${progress.percentage}% complete)`;
    } else if (state.status === "paused") {
      text = `$(debug-pause) FlightPath ${progress.current}/${progress.total}`;
      tooltip = "FlightPath - Paused (click to resume)";
    } else if (state.status === "completed") {
      text = `$(check) FlightPath Complete`;
      tooltip = "FlightPath - Workflow completed successfully";
    } else if (state.status === "error") {
      text = `$(error) FlightPath Error`;
      tooltip = "FlightPath - Execution failed (click to retry)";
    } else {
      // Priority 2: Show Copilot initialization status when idle
      switch (copilotStatus.initializationStatus) {
        case CopilotStatus.Initializing:
          text = "$(compass) FlightPath - Initializing...";
          tooltip = "FlightPath - Checking Copilot availability...";
          break;
        case CopilotStatus.Waiting:
          text = `$(compass) FlightPath - Waiting for Copilot (${copilotStatus.pollingAttempts}/${copilotStatus.maxPollingAttempts})`;
          tooltip = "FlightPath - Waiting for GitHub Copilot to activate...";
          break;
        case CopilotStatus.Ready:
          text = "$(compass-active) FlightPath - Ready";
          tooltip =
            "FlightPath - Ready to execute workflows with Copilot automation";
          break;
        case CopilotStatus.Unavailable:
          text = "$(warning) FlightPath - Setup Required";
          tooltip =
            "FlightPath - Copilot automation unavailable. Click to retry detection.";
          break;
      }
    }

    this.statusBarItem.text = text;
    this.statusBarItem.tooltip = tooltip;
    this.statusBarItem.show();
  }

  /**
   * Create example prompt content
   */
  private createExamplePromptContent(): string {
    return JSON.stringify(
      {
        prompt:
          "/explain #file:src/extension.ts Analyze this file and suggest improvements",
        endCondition: {
          script: "check_improvements.py",
          returns: "true",
        },
      },
      null,
      2
    );
  }

  /**
   * Create example FlightPath content
   */
  private createExampleFlightPathContent(): string {
    return JSON.stringify(
      {
        prompts: [
          {
            prompt:
              "/explain @workspace #file:src/**/*.ts Analyze this codebase for potential bugs",
          },
          {
            prompt: "/fix @workspace Fix any issues found in the analysis",
            endCondition: {
              script: "run_tests.py",
              returns: "all_passed",
            },
          },
        ],
      },
      null,
      2
    );
  }

  /**
   * Create an end condition script from templates
   */
  async createEndConditionScript(): Promise<void> {
    try {
      // Ask user which type of script to create
      const scriptType = await vscode.window.showQuickPick(
        [
          {
            label: "$(file-code) Python",
            description: "Create a Python end condition script",
            value: "python" as const,
          },
          {
            label: "$(file-code) JavaScript",
            description: "Create a JavaScript/Node.js end condition script",
            value: "javascript" as const,
          },
          {
            label: "$(terminal) Shell Script",
            description:
              process.platform === "win32"
                ? "Create a Windows batch script"
                : "Create a bash shell script",
            value: "shell" as const,
          },
          {
            label: "$(terminal-powershell) PowerShell",
            description: "Create a PowerShell script (.ps1)",
            value: "powershell" as const,
          },
        ],
        {
          placeHolder: "Select the type of end condition script to create",
          title: "FlightPath: Create End Condition Script",
        }
      );

      if (!scriptType) {
        return; // User cancelled
      }

      // Create the script
      const scriptPath = await this.endConditionEvaluator.createSampleScript(
        scriptType.value
      );

      if (scriptPath) {
        // Show success message with option to open
        const action = await vscode.window.showInformationMessage(
          `✅ Created end condition script: ${path.basename(scriptPath)}`,
          "Open Script",
          "Show in Explorer"
        );

        if (action === "Open Script") {
          const doc = await vscode.workspace.openTextDocument(scriptPath);
          await vscode.window.showTextDocument(doc);
        } else if (action === "Show in Explorer") {
          await vscode.commands.executeCommand(
            "revealFileInOS",
            vscode.Uri.file(scriptPath)
          );
        }
      } else {
        vscode.window.showErrorMessage(
          "❌ Failed to create end condition script. Check that you have a workspace folder open."
        );
      }
    } catch (error) {
      console.error("FlightPath: Error creating end condition script:", error);
      vscode.window.showErrorMessage(
        `❌ Failed to create end condition script: ${error}`
      );
    }
  }

  /**
   * Handle end condition evaluation result
   * @returns true to continue workflow, false to stop
   */
  private async handleEndConditionResult(
    prompt: PromptItem,
    evaluationResult: import("./EndConditionEvaluator").EvaluationResult,
    integration: CopilotIntegration,
    totalPrompts: number
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
      // Happy path - validation failure (script ran but output doesn't match)
      return await this.handleValidationFailure(
        prompt,
        evaluationResult,
        integration,
        totalPrompts
      );
    }
  }

  /**
   * Handle execution errors (script failed, timed out, etc.)
   * @returns true to continue, false to stop
   */
  private async handleExecutionError(
    prompt: PromptItem,
    evaluationResult: import("./EndConditionEvaluator").EvaluationResult
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
  private async handleValidationFailure(
    prompt: PromptItem,
    evaluationResult: import("./EndConditionEvaluator").EvaluationResult,
    integration: CopilotIntegration,
    totalPrompts: number
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
          state: "running",
        });
      }

      // Build retry prompt
      const retryPrompt = this.buildRetryPrompt(prompt, evaluationResult);

      // Send status message: Retrying prompt (after building retryPrompt)
      if (this.dashboardProvider) {
        const retryPromptPreview = retryPrompt.split("\n")[0].substring(0, 60);
        const ellipsis = retryPrompt.length > 60 ? "..." : "";
        this.dashboardProvider.updateStatusMessage(
          currentIndex,
          `Retrying Prompt ${currentIndex + 1} (Attempt ${currentRetry}/${maxRetries}): ${retryPromptPreview}${ellipsis}`
        );
      }

      // Send retry prompt to Copilot
      const retryPromptItem: PromptItem = {
        prompt: retryPrompt,
        model: prompt.model,
        endCondition: prompt.endCondition, // Keep same end condition
        newChatSession: false, // IMPORTANT: Retries must use same chat session
      };

      // Update workflow progress to show retry
      integration.setWorkflowProgress(currentIndex + 1, totalPrompts);

      // Record start time for retry
      const retryStartTime = Date.now();

      // Set up response listener for retry
      // IMPORTANT: Always need completion detection for retries because we need to
      // wait for response before re-evaluating the end condition script
      const needsCompletionDetection = true;
      const responsePromise = this.waitForResponseComplete(
        retryPromptItem,
        integration
      );

      // Send retry prompt with workflow context
      const state = this.promptQueue.getState();
      const success = await integration.sendPrompt(
        retryPromptItem,
        needsCompletionDetection,
        {
          promptIndex: currentIndex,
          allPrompts: state.prompts,
          filePath: this.currentPromptFile?.filePath,
        }
      );

      if (!success) {
        vscode.window.showErrorMessage(
          "FlightPath: Failed to send retry prompt"
        );
        return false;
      }

      // Wait for response
      if (needsCompletionDetection) {
        console.log("⏳ FlightPath: Waiting for retry response...");
        const retryResponseText = await responsePromise;
        console.log("✅ FlightPath: Retry response complete");

        // Calculate duration for retry
        const retryDuration = ((Date.now() - retryStartTime) / 1000).toFixed(1);

        // Update dashboard with CLI output for retry (if using CLI integration)
        if (this.dashboardProvider && this.isCliIntegration(integration)) {
          // Get token statistics from CLI result
          let tokens: { prompt: number; completion: number } | undefined;
          const lastResult = integration.getLastResult();
          if (lastResult?.statistics) {
            tokens = integration.parseTokenCounts(lastResult.statistics);
          }

          this.dashboardProvider.updateCliOutput(currentIndex, {
            prompt: retryPrompt,
            response: retryResponseText,
            elapsed: parseFloat(retryDuration),
            tokens,
            isStreaming: false, // Mark as complete
          });
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
            this.currentWorkspaceFolder?.uri.fsPath
          );

        // Recursively handle the result (will retry again if needed or max out)
        return await this.handleEndConditionResult(
          prompt,
          retryEvaluation,
          integration,
          totalPrompts
        );
      }

      return true;
    } else {
      // Max retries exhausted or no retry configured
      return await this.handleMaxRetriesExhausted(prompt, evaluationResult);
    }
  }

  /**
   * Handle max retries exhausted
   * @returns true to continue, false to stop
   */
  private async handleMaxRetriesExhausted(
    prompt: PromptItem,
    evaluationResult: import("./EndConditionEvaluator").EvaluationResult
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
  private buildRetryPrompt(
    prompt: PromptItem,
    evaluationResult: import("./EndConditionEvaluator").EvaluationResult
  ): string {
    // Get effective retry prompt (including defaults from settings)
    const retryPromptTemplate =
      this.promptQueue.getEffectiveRetryPrompt(prompt);
    const maxRetries = this.promptQueue.getEffectiveMaxRetries(prompt);

    if (!retryPromptTemplate) {
      // Fallback retry prompt if none configured (should rarely happen due to smart defaults)
      return `The previous task validation failed. Expected: ${prompt.endCondition?.returns}, but got: ${evaluationResult.result}\n\nScript output:\n${evaluationResult.stdout}\n\nPlease fix the issues and try again.`;
    }

    // Use EndConditionEvaluator's buildRetryPrompt method
    return this.endConditionEvaluator.buildRetryPrompt(
      retryPromptTemplate,
      evaluationResult,
      prompt.endCondition!.returns,
      this.promptQueue.getCurrentRetryCount(),
      maxRetries
    );
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    this.statusBarItem.dispose();
    this.endConditionEvaluator.dispose();
    console.log("FlightPath: Manager disposed");
  }
}
