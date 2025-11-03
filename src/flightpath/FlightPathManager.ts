import * as vscode from "vscode";
import * as path from "path";
import { PromptFileParser } from "./PromptFileParser";
import { PromptQueue } from "./PromptQueue";
import { CopilotIntegration, CopilotStatus } from "./CopilotIntegration";
import { EndConditionEvaluator } from "./EndConditionEvaluator";
import { PromptFile, PromptItem, QueueState } from "../types/FlightPathTypes";

export class FlightPathManager {
  private promptFileParser: PromptFileParser;
  private promptQueue: PromptQueue;
  private copilotIntegration: CopilotIntegration;
  private endConditionEvaluator: EndConditionEvaluator;
  private context: vscode.ExtensionContext;
  private statusBarItem: vscode.StatusBarItem;
  private currentWorkspaceFolder: vscode.WorkspaceFolder | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.promptFileParser = new PromptFileParser();
    this.promptQueue = new PromptQueue();
    this.copilotIntegration = new CopilotIntegration(context);
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

    // Listen to Copilot status changes
    context.subscriptions.push(
      this.copilotIntegration.onDidChangeStatus((status) => {
        console.log(`🔄 FlightPath: Copilot status changed to: ${status}`);
        this.updateStatusBar();
      })
    );

    // Get current workspace folder
    this.currentWorkspaceFolder = vscode.workspace.workspaceFolders?.[0];

    console.log("FlightPath: Manager initialized");
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
   */
  async executePromptFile(filePath: string): Promise<void> {
    try {
      console.log(`FlightPath: Executing prompt file: ${filePath}`);

      // Check Copilot readiness FIRST
      const detailedStatus = this.copilotIntegration.getDetailedStatus();
      const fileName = path.basename(filePath);

      // Block execution if still initializing
      if (detailedStatus.initializationStatus === "initializing") {
        const action = await vscode.window.showWarningMessage(
          `FlightPath is still initializing Copilot integration. Please wait a moment and try again.`,
          "Retry",
          "Cancel"
        );

        if (action === "Retry") {
          // Try again after a short delay
          setTimeout(() => this.executePromptFile(filePath), 1000);
        }
        return;
      }

      // Block execution if waiting for Copilot
      if (detailedStatus.initializationStatus === "waiting") {
        const action = await vscode.window.showWarningMessage(
          `FlightPath is waiting for Copilot to activate (attempt ${detailedStatus.pollingAttempts}/${detailedStatus.maxPollingAttempts}). Please wait...`,
          "Retry",
          "Cancel"
        );

        if (action === "Retry") {
          // Try again after a short delay
          setTimeout(() => this.executePromptFile(filePath), 2000);
        }
        return;
      }

      // Block execution if unavailable
      if (detailedStatus.initializationStatus === "unavailable") {
        const action = await vscode.window.showErrorMessage(
          `FlightPath: Copilot automation is unavailable. Please ensure GitHub Copilot Chat is installed and active.`,
          "Retry Detection",
          "View Requirements",
          "Cancel"
        );

        if (action === "Retry Detection") {
          await this.retryCopilotDetection();
          // Try executing again after retry starts
          setTimeout(() => this.executePromptFile(filePath), 2000);
        } else if (action === "View Requirements") {
          await this.copilotIntegration.testAutomation();
        }
        return;
      }

      // Parse the prompt file
      const promptFile = await this.promptFileParser.parsePromptFile(filePath);
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
        this.copilotIntegration.setWorkflowProgress(
          1,
          promptFile.prompts.length
        );
        await this.startWorkflowExecution();
      }
    } catch (error) {
      console.error("FlightPath: Failed to execute prompt file:", error);
      vscode.window.showErrorMessage(`FlightPath: Execution failed: ${error}`);
    }
  }

  /**
   * Start workflow execution with Copilot integration
   */
  private async startWorkflowExecution(): Promise<void> {
    const state = this.promptQueue.getState();

    for (let i = 0; i < state.prompts.length; i++) {
      const prompt = state.prompts[i];

      // Update progress
      this.copilotIntegration.setWorkflowProgress(i + 1, state.prompts.length);

      console.log(
        `🚀 FlightPath: Executing prompt ${i + 1}/${state.prompts.length}`
      );

      // Send prompt to Copilot and wait for response completion
      const result =
        await this.copilotIntegration.executePromptWithContext(prompt);

      if (!result.success) {
        vscode.window.showErrorMessage(
          `FlightPath: Failed to execute prompt ${i + 1}: ${result.message}`
        );
        break;
      }

      // Mark as sent in queue
      await this.promptQueue.markCurrentAsSent();

      // Wait for Copilot to finish responding (via tool callback)
      console.log(
        `⏳ FlightPath: Waiting for Copilot to finish responding to prompt ${i + 1}...`
      );
      await this.waitForResponseComplete(prompt);

      console.log(`✅ FlightPath: Prompt ${i + 1} completed`);

      // Check if workflow was paused
      if (this.promptQueue.getState().status === "paused") {
        console.log("⏸️ FlightPath: Workflow paused");
        break;
      }
    }

    console.log("🎉 FlightPath: Workflow execution complete");
  }

  /**
   * Wait for Copilot to call the response complete tool
   * @param prompt The current prompt being executed
   * @returns Promise that resolves when response is complete or timeout occurs
   */
  private async waitForResponseComplete(prompt: PromptItem): Promise<void> {
    // Use endCondition timeout if specified, otherwise use 30 minutes as safety net
    // This should be long enough for any reasonable Copilot response
    const timeout = prompt.endCondition?.timeout || 1800000; // Default 30 minutes (1,800,000ms)

    return new Promise<void>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        disposable.dispose();
        console.warn(
          `⚠️ FlightPath: Response completion timeout after ${timeout}ms (${Math.round(timeout / 60000)} minutes)`
        );
        vscode.window.showWarningMessage(
          `FlightPath: Response timeout after ${Math.round(timeout / 60000)} minutes - Copilot did not call the completion tool. Proceeding to next prompt.`
        );
        resolve(); // Resolve anyway to continue workflow
      }, timeout);

      // Subscribe to response complete event (with duplicate protection)
      let responseHandled = false; // Prevent duplicate event handling
      const disposable = this.copilotIntegration.onResponseComplete(
        async () => {
          // Ignore duplicate events (defense-in-depth)
          if (responseHandled) {
            console.log(
              "⚠️ FlightPath: Duplicate response complete event ignored (already handled)"
            );
            return;
          }
          responseHandled = true;

          clearTimeout(timeoutHandle);
          disposable.dispose();
          console.log(
            "✅ FlightPath: Response complete signal received from tool callback"
          );

          // IMPORTANT: Tool callback fires BEFORE Copilot finishes streaming
          // Wait for streaming to actually finish before proceeding
          console.log(
            "⏳ FlightPath: Waiting for Copilot to finish streaming..."
          );
          await this.copilotIntegration.waitForStreamingComplete();
          console.log(
            "✅ FlightPath: Copilot finished streaming, ready for next prompt"
          );

          resolve();
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
    const copilotStatus = this.copilotIntegration.getDetailedStatus();

    if (copilotStatus.initializationStatus === "unavailable") {
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
    return this.copilotIntegration.getStatus();
  }

  /**
   * Test Copilot automation
   */
  async testCopilotAutomation(): Promise<boolean> {
    return await this.copilotIntegration.testAutomation();
  }

  /**
   * Retry Copilot detection (restart polling)
   */
  async retryCopilotDetection(): Promise<void> {
    await this.copilotIntegration.retryDetection();
  }

  /**
   * Get Copilot integration capabilities
   */
  getCopilotCapabilities() {
    return this.copilotIntegration.getCapabilities();
  }

  /**
   * Get detailed Copilot status including initialization state
   */
  getCopilotDetailedStatus() {
    return this.copilotIntegration.getDetailedStatus();
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
    const copilotStatus = this.copilotIntegration.getDetailedStatus();

    let text = "$(rocket) FlightPath";
    let tooltip = "FlightPath - Click to open";

    // Priority 1: Show workflow execution status if running
    if (state.status === "running") {
      text = `$(loading~spin) FlightPath ${progress.current}/${progress.total}`;
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
        case "initializing":
          text = "$(loading~spin) FlightPath - Initializing...";
          tooltip = "FlightPath - Checking Copilot availability...";
          break;
        case "waiting":
          text = `$(clock) FlightPath - Waiting for Copilot (${copilotStatus.pollingAttempts}/${copilotStatus.maxPollingAttempts})`;
          tooltip = "FlightPath - Waiting for GitHub Copilot to activate...";
          break;
        case "ready":
          text = "$(rocket) FlightPath - Ready";
          tooltip =
            "FlightPath - Ready to execute workflows with Copilot automation";
          break;
        case "unavailable":
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
   * Dispose resources
   */
  dispose(): void {
    this.statusBarItem.dispose();
    this.endConditionEvaluator.dispose();
    console.log("FlightPath: Manager disposed");
  }
}
