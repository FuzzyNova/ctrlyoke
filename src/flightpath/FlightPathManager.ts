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

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
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
   * Execute a prompt file
   * @param filePath Path to the prompt file
   * @param modeOverride Optional integration mode (overrides user settings for this execution)
   */
  async executePromptFile(
    filePath: string,
    modeOverride?: CopilotIntegrationMode
  ): Promise<void> {
    try {
      console.log(`FlightPath: Executing prompt file: ${filePath}`);

      // Create integration for this execution (either override or default)
      const integration = this.createIntegrationForMode(modeOverride);

      // Check Copilot readiness FIRST
      const detailedStatus = integration.getDetailedStatus();
      const fileName = path.basename(filePath);

      // Block execution if still initializing
      if (detailedStatus.initializationStatus === CopilotStatus.Initializing) {
        const action = await vscode.window.showWarningMessage(
          `FlightPath is still initializing Copilot integration. Please wait a moment and try again.`,
          "Retry",
          "Cancel"
        );

        if (action === "Retry") {
          // Try again after a short delay
          setTimeout(
            () => this.executePromptFile(filePath, modeOverride),
            1000
          );
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
          setTimeout(
            () => this.executePromptFile(filePath, modeOverride),
            2000
          );
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
          setTimeout(
            () => this.executePromptFile(filePath, modeOverride),
            2000
          );
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

      // Load prompts into queue
      this.promptQueue.loadPrompts(promptFile.prompts);

      // At this point, we know Copilot is ready!
      let confirmMessage = `Execute ${promptFile.prompts.length} prompt(s) from ${fileName}?`;
      confirmMessage +=
        "\n\n✅ Copilot automation is ready - workflow will run automatically!";

      const action = await vscode.window.showInformationMessage(
        confirmMessage,
        { modal: true },
        "Take Off 🚀",
        "Cancel"
      );

      if (action === "Take Off 🚀") {
        // Set workflow progress in Copilot integration
        integration.setWorkflowProgress(1, promptFile.prompts.length);
        await this.startWorkflowExecution(integration);
      }
    } catch (error) {
      console.error("FlightPath: Failed to execute prompt file:", error);
      vscode.window.showErrorMessage(`FlightPath: Execution failed: ${error}`);
    }
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
    const state = this.promptQueue.getState();

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
      this.outputChannel.show(true); // Show but preserve focus
    }

    for (let i = 0; i < state.prompts.length; i++) {
      const prompt = state.prompts[i];

      // Update progress
      activeIntegration.setWorkflowProgress(i + 1, state.prompts.length);

      console.log(
        `🚀 FlightPath: Executing prompt ${i + 1}/${state.prompts.length}`
      );

      // Need completion detection if:
      // 1. Multi-prompt workflow (need to know when to advance to next prompt)
      // 2. Single prompt with endCondition (need to know when to evaluate script)
      const needsCompletionDetection =
        state.prompts.length > 1 || !!prompt.endCondition?.script;

      // Set up response listener BEFORE sending prompt to avoid race condition (only if needed)
      const responsePromise = needsCompletionDetection
        ? this.waitForResponseComplete(prompt, activeIntegration)
        : Promise.resolve(""); // No completion detection needed

      // Send prompt to Copilot
      const success = await activeIntegration.sendPrompt(
        prompt,
        needsCompletionDetection
      );

      if (!success) {
        vscode.window.showErrorMessage(
          `FlightPath: Failed to execute prompt ${i + 1}`
        );
        break;
      }

      // Mark as sent in queue
      await this.promptQueue.markCurrentAsSent();

      // Wait for Copilot to finish responding (only for multi-prompt workflows)
      let responseText = "";
      if (needsCompletionDetection) {
        console.log(
          `⏳ FlightPath: Waiting for Copilot to finish responding to prompt ${i + 1}...`
        );
        responseText = await responsePromise;
        console.log(`✅ FlightPath: Prompt ${i + 1} completed`);

        // Evaluate end condition if present (now with response text available)
        if (prompt.endCondition) {
          console.log(
            `🔍 FlightPath: Evaluating end condition for prompt ${i + 1}...`
          );

          // Evaluate the end condition
          const evaluationResult =
            await this.endConditionEvaluator.evaluateCondition(
              prompt.endCondition,
              this.currentWorkspaceFolder?.uri.fsPath
            );

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
            break;
          }
        }
      } else {
        console.log(
          `✅ FlightPath: Prompt sent successfully (no completion detection needed)`
        );
        // Note: This path only executes for single prompts WITHOUT end conditions
        // If a single prompt has an endCondition, needsCompletionDetection will be true
      }

      // Check if workflow was paused
      if (this.promptQueue.getState().status === "paused") {
        console.log("⏸️ FlightPath: Workflow paused");
        break;
      }
    }

    console.log("🎉 FlightPath: Workflow execution complete");

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
   * Resume execution
   */
  async resume(): Promise<void> {
    await this.promptQueue.resume();
  }

  /**
   * Stop current execution
   */
  stop(): void {
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

    // This would open the WebView panel
    // For now, just show the take off command
    await this.takeOff();
  }

  /**
   * Get current queue state
   */
  getQueueState(): QueueState {
    return this.promptQueue.getState();
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

    // Handle prompt execution
    if (state.status === "running" && state.prompts.length > 0) {
      const currentPrompt = this.promptQueue.getCurrentPrompt();
      if (currentPrompt) {
        this.executeCurrentPrompt(currentPrompt);
      }
    }
  }

  /**
   * Execute current prompt with Copilot
   */
  private async executeCurrentPrompt(prompt: PromptItem): Promise<void> {
    try {
      console.log(
        "FlightPath: Executing prompt with Copilot (stub implementation)"
      );

      // This is where we would integrate with GitHub Copilot Chat API
      // For now, show the prompt and simulate execution
      const action = await vscode.window.showInformationMessage(
        `FlightPath: Ready to send prompt to Copilot:\n\n"${prompt.prompt.substring(0, 100)}..."`,
        "Send to Copilot",
        "Skip",
        "Stop"
      );

      if (action === "Send to Copilot") {
        // Simulate sending to Copilot
        await this.promptQueue.markCurrentAsSent();

        // Simulate completion after a delay (in real implementation, this would be triggered by end condition)
        setTimeout(async () => {
          await this.promptQueue.completeCurrentAndMoveNext();
        }, 2000);
      } else if (action === "Skip") {
        await this.promptQueue.completeCurrentAndMoveNext();
      } else {
        this.promptQueue.stop();
      }
    } catch (error) {
      console.error("FlightPath: Failed to execute prompt:", error);
      this.promptQueue.markCurrentAsFailed(
        error instanceof Error ? error.message : String(error)
      );
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
    // Check if retry is possible
    if (this.promptQueue.canRetry(prompt)) {
      console.log(
        `🔄 FlightPath: Validation failed, retrying (attempt ${this.promptQueue.getCurrentRetryCount() + 1}/${prompt.endCondition?.maxRetries})...`
      );

      // Increment retry counter
      this.promptQueue.incrementRetryCount();

      // Build retry prompt
      const retryPrompt = this.buildRetryPrompt(prompt, evaluationResult);

      // Send retry prompt to Copilot
      const retryPromptItem: PromptItem = {
        prompt: retryPrompt,
        model: prompt.model,
        endCondition: prompt.endCondition, // Keep same end condition
      };

      // Update workflow progress to show retry
      const currentIndex = this.promptQueue.getState().currentIndex;
      integration.setWorkflowProgress(currentIndex + 1, totalPrompts);

      // Set up response listener for retry
      // IMPORTANT: Always need completion detection for retries because we need to
      // wait for response before re-evaluating the end condition script
      const needsCompletionDetection = true;
      const responsePromise = this.waitForResponseComplete(
        retryPromptItem,
        integration
      );

      // Send retry prompt
      const success = await integration.sendPrompt(
        retryPromptItem,
        needsCompletionDetection
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
        await responsePromise;
        console.log("✅ FlightPath: Retry response complete");

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
