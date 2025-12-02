import * as vscode from "vscode";
import * as path from "path";
import { PromptFileParser } from "./PromptFileParser";
import { PromptQueue } from "./PromptQueue";
import { CopilotIntegration, CopilotStatus } from "./base/CopilotIntegration";
import { CopilotChatIntegration } from "./chat/CopilotChatIntegration";
import { CopilotCommandLineIntegration } from "./cli/CopilotCommandLineIntegration";
import { ClaudeCommandLineIntegration } from "./cli/ClaudeCommandLineIntegration";
import { EndConditionEvaluator } from "./EndConditionEvaluator";
import { EndConditionHandler } from "./EndConditionHandler";
import { WorkflowExecutor, WorkflowContext } from "./WorkflowExecutor";
import {
  PromptFile,
  PromptItem,
  QueueState,
  Provider,
  EXECUTION_STATES,
} from "../types/FlightPathTypes";
import { FlightPathDashboardProvider } from "../ui/FlightPathDashboardProvider";
import { StatusBarManager } from "../ui/StatusBarManager";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";

export class FlightPathManager {
  private promptFileParser: PromptFileParser;
  private promptQueue: PromptQueue;
  private cliIntegration: CopilotCommandLineIntegration;
  private chatIntegration: CopilotChatIntegration;
  private claudeCliIntegration: ClaudeCommandLineIntegration;
  private endConditionEvaluator: EndConditionEvaluator;
  private endConditionHandler: EndConditionHandler;
  private workflowExecutor: WorkflowExecutor;
  private context: vscode.ExtensionContext;
  private statusBarManager: StatusBarManager;
  private currentWorkspaceFolder: vscode.WorkspaceFolder | undefined;
  private outputChannel: vscode.OutputChannel;
  private dashboardProvider?: FlightPathDashboardProvider;
  private currentPromptFile?: { filePath: string; promptFile: PromptFile };
  private activeIntegration?: CopilotIntegration; // Track currently executing integration
  private promptFileWatcher?: vscode.FileSystemWatcher; // Watch for changes to current prompt file

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

    // Initialize ALL integrations so they're always ready to use
    this.cliIntegration = new CopilotCommandLineIntegration(
      context,
      this.outputChannel
    );
    this.chatIntegration = new CopilotChatIntegration(context);
    this.claudeCliIntegration = new ClaudeCommandLineIntegration(
      context,
      this.outputChannel
    );

    this.endConditionEvaluator = new EndConditionEvaluator(context);
    this.endConditionHandler = new EndConditionHandler(
      this.endConditionEvaluator,
      this.promptQueue,
      this.dashboardProvider
    );
    this.workflowExecutor = new WorkflowExecutor(
      this.promptQueue,
      this.promptFileParser,
      this.endConditionHandler,
      this.endConditionEvaluator
    );

    // Create status bar manager
    this.statusBarManager = new StatusBarManager(context);
    this.updateStatusBar();

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
   * Check if CLI command should be shown in dashboard output
   */
  private shouldShowCliCommand(): boolean {
    return ConfigurationUtils.shouldShowCliCommand();
  }

  /**
   * Open a prompt file in the editor.
   * If openPromptsInSecondGroup setting is enabled, opens in ViewColumn.Two (right side)
   * to keep main code files visible for #selection references.
   * Otherwise opens in the active editor (default VS Code behavior).
   * @param filePath Path to the prompt file to open
   */
  private async openPromptFile(filePath: string): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(filePath);

      if (ConfigurationUtils.shouldOpenPromptsInSecondGroup()) {
        // Open in second editor group (right side) to keep main code visible
        await vscode.window.showTextDocument(document, {
          viewColumn: vscode.ViewColumn.Two,
          preview: false,
          preserveFocus: false,
        });
      } else {
        // Open in active editor (default VS Code behavior)
        await vscode.window.showTextDocument(document);
      }
    } catch (error) {
      console.error("FlightPath: Failed to open prompt file:", error);
    }
  }

  /**
   * Get the default Copilot integration based on user settings
   * Supports: cli (Copilot CLI), chat (Copilot Chat), claude-cli (Claude Code CLI)
   */
  private getDefaultIntegration(): CopilotIntegration {
    const integrationMode = ConfigurationUtils.getIntegrationMode();

    switch (integrationMode) {
      case Provider.CopilotChat:
        console.log("🔄 FlightPath: Using Copilot Chat integration");
        return this.chatIntegration;
      case Provider.ClaudeCli:
        console.log("🔄 FlightPath: Using Claude Code CLI integration");
        return this.claudeCliIntegration;
      case Provider.CopilotCli:
      default:
        console.log("🔄 FlightPath: Using Copilot CLI integration");
        return this.cliIntegration;
    }
  }

  /**
   * Get dynamic queue configuration from settings
   */
  private getDynamicQueueConfig(): import("../types/FlightPathTypes").DynamicQueueConfig {
    return ConfigurationUtils.getDynamicQueueConfig();
  }

  /**
   * Create integration instance based on mode override or user settings
   * @param modeOverride Optional mode to override user settings
   * @returns Integration instance (either override or default)
   */
  private createIntegrationForMode(
    modeOverride?: Provider
  ): CopilotIntegration {
    if (modeOverride) {
      console.log(`🔀 FlightPath: Using mode override: ${modeOverride}`);
      switch (modeOverride) {
        case Provider.CopilotChat:
          return this.chatIntegration;
        case Provider.ClaudeCli:
          return this.claudeCliIntegration;
        case Provider.CopilotCli:
        default:
          return this.cliIntegration;
      }
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

      // Parse prompt file (parser handles all formats including .prompt.md)
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

      // Store the loaded file
      this.currentPromptFile = { filePath, promptFile };

      // Set up file watcher for live reload
      this.setupPromptFileWatcher(filePath);

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
  async executeLoadedPromptFile(modeOverride?: Provider): Promise<void> {
    if (!this.currentPromptFile) {
      vscode.window.showWarningMessage(
        "FlightPath: No prompt file loaded. Use 'Change' button to select a file first."
      );
      return;
    }

    const { filePath } = this.currentPromptFile;

    // Auto-save and reload if the file has unsaved changes
    await this.saveAndReloadIfDirty(filePath);

    // Re-read after potential reload
    if (!this.currentPromptFile) {
      return; // File was deleted or became invalid
    }

    const { promptFile } = this.currentPromptFile;
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
          // Test automation now available on all integrations via base class
          await integration.testAutomation();
        }
        return;
      }

      // Check if queue needs to be restarted (completed, paused, or error state)
      const queueState = this.promptQueue.getState();
      if (
        queueState.status === EXECUTION_STATES.COMPLETED ||
        queueState.status === EXECUTION_STATES.PAUSED ||
        queueState.status === EXECUTION_STATES.ERROR
      ) {
        console.log(
          `FlightPath: Queue in ${queueState.status} state, restarting from beginning`
        );
        this.promptQueue.restart();
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
    modeOverride?: Provider
  ): Promise<void> {
    // Auto-save if the file is open with unsaved changes
    await this.saveAndReloadIfDirty(filePath);

    // Load the file first
    await this.loadPromptFile(filePath);
    // Then execute it immediately (for backwards compatibility with context menu)
    await this.executeLoadedPromptFile(modeOverride);
  }

  /**
   * Save the file if it's open in an editor with unsaved changes, then reload
   * This ensures we always execute the latest user edits
   */
  private async saveAndReloadIfDirty(filePath: string): Promise<void> {
    // Find if this file is open in any editor
    const openDocument = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.fsPath === filePath
    );

    if (openDocument && openDocument.isDirty) {
      console.log(
        `FlightPath: Auto-saving dirty file before execution: ${filePath}`
      );
      try {
        await openDocument.save();
        // Reload the prompt file to pick up saved changes
        await this.reloadCurrentPromptFile();
      } catch (error) {
        console.error("FlightPath: Failed to auto-save file:", error);
        // Continue anyway - user may have unsaved changes but we'll use disk version
        vscode.window.showWarningMessage(
          "FlightPath: Could not auto-save file. Running with last saved version."
        );
      }
    }
  }

  /**
   * Start workflow execution with Copilot integration.
   * Delegates to WorkflowExecutor for the actual execution loop.
   *
   * @param integration Optional integration to use (defaults to instance integration)
   */
  private async startWorkflowExecution(
    integration?: CopilotIntegration
  ): Promise<void> {
    const activeIntegration = integration || this.getDefaultIntegration();

    // Track the active integration for stop() method
    this.activeIntegration = activeIntegration;

    // Build workflow context for the executor
    const context: WorkflowContext = {
      workspaceFolderPath: this.currentWorkspaceFolder?.uri.fsPath,
      currentPromptFilePath: this.currentPromptFile?.filePath,
      dashboardProvider: this.dashboardProvider,
      outputChannel: this.outputChannel,
      shouldShowCliCommand: this.shouldShowCliCommand(),
      showCliOutput: ConfigurationUtils.shouldShowCliOutput(),
      dynamicQueueConfig: this.getDynamicQueueConfig(),
    };

    // Delegate to WorkflowExecutor
    await this.workflowExecutor.execute(activeIntegration, context);

    // Clear active integration reference after execution
    this.activeIntegration = undefined;
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

    // Case 1: Tool callback already fired while paused - resume from pending response
    if (this.workflowExecutor.hasPendingResponse()) {
      console.log(
        "▶️ FlightPath: Resuming with pending response (Copilot finished while paused)"
      );
      this.workflowExecutor.resumePendingResponse();
      return;
    }

    // Case 2: Still waiting for response (prompt sent but tool callback not fired yet)
    if (this.workflowExecutor.isAwaitingResponse()) {
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

    // Clear any pending response state in the executor
    this.workflowExecutor.clearPendingState();

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
      const promptsDir = ConfigurationUtils.getPromptsDirectory();
      const promptsDirPath = path.join(
        this.currentWorkspaceFolder.uri.fsPath,
        promptsDir
      );

      // Ensure directory exists
      try {
        await vscode.workspace.fs.createDirectory(
          vscode.Uri.file(promptsDirPath)
        );
      } catch {
        // Directory might already exist
      }

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

      // Open file in editor (respects openPromptsInSecondGroup setting)
      await this.openPromptFile(filePath);

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
      await this.openPromptFile(this.currentPromptFile.filePath);
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
   * Test Copilot automation
   * For CLI: Returns isReady() since automation testing is not needed
   * For Chat: Sends test message to verify automation works
   */
  async testCopilotAutomation(): Promise<boolean> {
    return await this.getDefaultIntegration().testAutomation();
  }

  /**
   * Retry Copilot detection/initialization
   * For CLI: Re-runs initialize()
   * For Chat: Restarts polling for Copilot availability
   */
  async retryCopilotDetection(): Promise<void> {
    await this.getDefaultIntegration().retryDetection();
  }

  /**
   * Get Copilot integration capabilities
   */
  getCopilotCapabilities() {
    return this.getDefaultIntegration().getCapabilities();
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
   * Delegates to StatusBarManager for display logic
   */
  private updateStatusBar(): void {
    const state = this.promptQueue.getState();
    const copilotStatus = this.getDefaultIntegration().getDetailedStatus();
    this.statusBarManager.updateStatusBar(state, copilotStatus);
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
            id: "analyze",
            prompt:
              "Analyze this codebase for potential bugs and code quality issues. Focus on error handling, type safety, and security concerns.",
          },
          {
            id: "fix",
            prompt: "Fix any issues found in the previous analysis.",
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
   * Import FlightPath custom agents to the workspace's .github/agents folder
   */
  async importAgents(): Promise<void> {
    try {
      if (!this.currentWorkspaceFolder) {
        vscode.window.showErrorMessage("FlightPath: No workspace folder open");
        return;
      }

      // Load agent manifest
      const manifestPath = path.join(
        this.context.extensionPath,
        "out",
        "templates",
        "agents",
        "manifest.json"
      );

      let manifest: {
        agents: Array<{
          id: string;
          label: string;
          description: string;
          file: string;
          tags?: string[];
          icon?: string;
        }>;
      };

      try {
        const manifestUri = vscode.Uri.file(manifestPath);
        const manifestContent = await vscode.workspace.fs.readFile(manifestUri);
        manifest = JSON.parse(Buffer.from(manifestContent).toString("utf-8"));
      } catch (error) {
        console.error("FlightPath: Failed to load agent manifest:", error);
        vscode.window.showErrorMessage(
          "❌ Failed to load FlightPath agents. The extension may not be properly installed."
        );
        return;
      }

      if (!manifest.agents || manifest.agents.length === 0) {
        vscode.window.showInformationMessage(
          "FlightPath: No agents available to import"
        );
        return;
      }

      // Show QuickPick with available agents
      const selectedAgents = await vscode.window.showQuickPick(
        manifest.agents.map((agent) => ({
          label: `${agent.icon || "$(hubot)"} ${agent.label}`,
          description: agent.description,
          detail: agent.tags?.join(", "),
          picked: true,
          agent,
        })),
        {
          placeHolder: "Select agents to import to .github/agents/",
          title: "FlightPath: Import Custom Agents",
          canPickMany: true,
        }
      );

      if (!selectedAgents || selectedAgents.length === 0) {
        return; // User cancelled
      }

      // Create .github/agents directory
      const agentsDir = path.join(
        this.currentWorkspaceFolder.uri.fsPath,
        ".github",
        "agents"
      );

      try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(agentsDir));
      } catch {
        // Directory might already exist
      }

      // Copy selected agents
      const templatesPath = path.join(
        this.context.extensionPath,
        "out",
        "templates",
        "agents"
      );

      const importedAgents: string[] = [];
      const failedAgents: string[] = [];

      for (const selection of selectedAgents) {
        const agent = selection.agent;
        const srcPath = path.join(templatesPath, agent.file);
        const destPath = path.join(agentsDir, agent.file);

        try {
          // Check if agent already exists
          try {
            await vscode.workspace.fs.stat(vscode.Uri.file(destPath));
            // File exists, ask for confirmation
            const overwrite = await vscode.window.showWarningMessage(
              `Agent "${agent.label}" already exists. Overwrite?`,
              "Yes",
              "No"
            );
            if (overwrite !== "Yes") {
              continue;
            }
          } catch {
            // File doesn't exist, proceed with copy
          }

          // Copy the agent file
          const content = await vscode.workspace.fs.readFile(
            vscode.Uri.file(srcPath)
          );
          await vscode.workspace.fs.writeFile(
            vscode.Uri.file(destPath),
            content
          );
          importedAgents.push(agent.label);
        } catch (error) {
          console.error(
            `FlightPath: Failed to import agent ${agent.id}:`,
            error
          );
          failedAgents.push(agent.label);
        }
      }

      // Show result
      if (importedAgents.length > 0) {
        const action = await vscode.window.showInformationMessage(
          `✅ Imported ${importedAgents.length} agent(s): ${importedAgents.join(", ")}`,
          "Open Agents Folder",
          "View Agent"
        );

        if (action === "Open Agents Folder") {
          await vscode.commands.executeCommand(
            "revealFileInOS",
            vscode.Uri.file(agentsDir)
          );
        } else if (action === "View Agent" && importedAgents.length === 1) {
          // Open the first imported agent
          const agentFile = path.join(agentsDir, selectedAgents[0].agent.file);
          const doc = await vscode.workspace.openTextDocument(agentFile);
          await vscode.window.showTextDocument(doc);
        }
      }

      if (failedAgents.length > 0) {
        vscode.window.showErrorMessage(
          `❌ Failed to import: ${failedAgents.join(", ")}`
        );
      }
    } catch (error) {
      console.error("FlightPath: Error importing agents:", error);
      vscode.window.showErrorMessage(`❌ Failed to import agents: ${error}`);
    }
  }

  /**
   * Import FlightPath workflow templates to the workspace's .flightpath folder
   */
  async importWorkflowTemplates(): Promise<void> {
    try {
      if (!this.currentWorkspaceFolder) {
        vscode.window.showErrorMessage("FlightPath: No workspace folder open");
        return;
      }

      // Load workflow manifest
      const manifestPath = path.join(
        this.context.extensionPath,
        "out",
        "templates",
        "workflows",
        "manifest.json"
      );

      let manifest: {
        workflows: Array<{
          id: string;
          label: string;
          description: string;
          file: string;
          tags?: string[];
          icon?: string;
        }>;
      };

      try {
        const manifestUri = vscode.Uri.file(manifestPath);
        const manifestContent = await vscode.workspace.fs.readFile(manifestUri);
        manifest = JSON.parse(Buffer.from(manifestContent).toString("utf-8"));
      } catch (error) {
        console.error("FlightPath: Failed to load workflow manifest:", error);
        vscode.window.showErrorMessage(
          "❌ Failed to load FlightPath workflow templates. The extension may not be properly installed."
        );
        return;
      }

      if (!manifest.workflows || manifest.workflows.length === 0) {
        vscode.window.showInformationMessage(
          "FlightPath: No workflow templates available to import"
        );
        return;
      }

      // Show QuickPick with available workflows
      const selectedWorkflows = await vscode.window.showQuickPick(
        manifest.workflows.map((workflow) => ({
          label: `${workflow.icon || "$(file-code)"} ${workflow.label}`,
          description: workflow.description,
          detail: workflow.tags?.join(", "),
          picked: false,
          workflow,
        })),
        {
          placeHolder:
            "Select workflow templates to import to .flightpath/templates/",
          title: "FlightPath: Import Workflow Templates",
          canPickMany: true,
        }
      );

      if (!selectedWorkflows || selectedWorkflows.length === 0) {
        return; // User cancelled
      }

      // Get prompts directory from settings
      const promptsDir = vscode.workspace
        .getConfiguration("flightpath")
        .get<string>("promptsDirectory", ".flightpath");

      // Create .flightpath/templates directory
      const targetDir = path.join(
        this.currentWorkspaceFolder.uri.fsPath,
        promptsDir,
        "templates"
      );

      try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(targetDir));
      } catch {
        // Directory might already exist
      }

      // Copy selected workflows
      const templatesPath = path.join(
        this.context.extensionPath,
        "out",
        "templates",
        "workflows"
      );

      const importedWorkflows: string[] = [];
      const failedWorkflows: string[] = [];

      for (const selection of selectedWorkflows) {
        const workflow = selection.workflow;
        const srcPath = path.join(templatesPath, workflow.file);
        const destPath = path.join(targetDir, workflow.file);

        try {
          // Check if workflow already exists
          try {
            await vscode.workspace.fs.stat(vscode.Uri.file(destPath));
            // File exists, ask for confirmation
            const overwrite = await vscode.window.showWarningMessage(
              `Workflow "${workflow.label}" already exists. Overwrite?`,
              "Yes",
              "No"
            );
            if (overwrite !== "Yes") {
              continue;
            }
          } catch {
            // File doesn't exist, proceed with copy
          }

          // Copy the workflow file
          const content = await vscode.workspace.fs.readFile(
            vscode.Uri.file(srcPath)
          );
          await vscode.workspace.fs.writeFile(
            vscode.Uri.file(destPath),
            content
          );
          importedWorkflows.push(workflow.label);
        } catch (error) {
          console.error(
            `FlightPath: Failed to import workflow ${workflow.id}:`,
            error
          );
          failedWorkflows.push(workflow.label);
        }
      }

      // Show result
      if (importedWorkflows.length > 0) {
        const action = await vscode.window.showInformationMessage(
          `✅ Imported ${importedWorkflows.length} workflow(s): ${importedWorkflows.join(", ")}`,
          "Open Folder",
          "View Workflow"
        );

        if (action === "Open Folder") {
          await vscode.commands.executeCommand(
            "revealFileInOS",
            vscode.Uri.file(targetDir)
          );
        } else if (
          action === "View Workflow" &&
          importedWorkflows.length === 1
        ) {
          // Open the first imported workflow
          const workflowFile = path.join(
            targetDir,
            selectedWorkflows[0].workflow.file
          );
          const doc = await vscode.workspace.openTextDocument(workflowFile);
          await vscode.window.showTextDocument(doc);
        }
      }

      if (failedWorkflows.length > 0) {
        vscode.window.showErrorMessage(
          `❌ Failed to import: ${failedWorkflows.join(", ")}`
        );
      }
    } catch (error) {
      console.error("FlightPath: Error importing workflow templates:", error);
      vscode.window.showErrorMessage(
        `❌ Failed to import workflow templates: ${error}`
      );
    }
  }

  /**
   * Set up file watcher for the currently loaded prompt file
   * Reloads prompt content when file changes (only when not executing)
   */
  private setupPromptFileWatcher(filePath: string): void {
    // Dispose existing watcher
    this.promptFileWatcher?.dispose();

    // Create watcher for this specific file
    const pattern = new vscode.RelativePattern(
      path.dirname(filePath),
      path.basename(filePath)
    );

    this.promptFileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

    this.promptFileWatcher.onDidChange(async (uri) => {
      // Only reload if not currently executing
      const state = this.promptQueue.getState();
      if (
        state.status === EXECUTION_STATES.IDLE ||
        state.status === EXECUTION_STATES.COMPLETED ||
        state.status === EXECUTION_STATES.ERROR
      ) {
        console.log(
          `FlightPath: Prompt file changed, reloading: ${uri.fsPath}`
        );
        await this.reloadCurrentPromptFile();
      }
    });

    // Also watch for deletion
    this.promptFileWatcher.onDidDelete((uri) => {
      console.log(`FlightPath: Prompt file deleted: ${uri.fsPath}`);
      this.currentPromptFile = undefined;
      this.promptFileWatcher?.dispose();
      this.promptFileWatcher = undefined;
      if (this.dashboardProvider) {
        this.dashboardProvider.updateFileSelected("No file selected", []);
      }
    });
  }

  /**
   * Reload the currently loaded prompt file
   */
  private async reloadCurrentPromptFile(): Promise<void> {
    if (!this.currentPromptFile) return;

    try {
      const filePath = this.currentPromptFile.filePath;
      const fileName = path.basename(filePath);

      // Re-parse the file
      const promptFile = await this.promptFileParser.parsePromptFile(filePath);
      if (!promptFile || !promptFile.prompts) return;

      // Validate
      const validation = this.promptFileParser.validatePromptItems(
        promptFile.prompts
      );
      if (!validation.valid) return;

      // Update stored file
      this.currentPromptFile = { filePath, promptFile };

      // Reload queue
      this.promptQueue.loadPrompts(promptFile.prompts);

      // Update dashboard
      if (this.dashboardProvider) {
        this.dashboardProvider.updateFileSelected(
          fileName,
          promptFile.prompts.map((p) => ({ prompt: p.prompt }))
        );
      }

      console.log(
        `FlightPath: Reloaded ${promptFile.prompts.length} prompt(s) from ${fileName}`
      );
    } catch (error) {
      console.error("FlightPath: Failed to reload prompt file:", error);
    }
  }

  /**
   * Create a new draft prompt file with timestamp-based name
   * Opens in editor and auto-selects in dashboard
   */
  async createDraftPrompt(): Promise<void> {
    try {
      if (!this.currentWorkspaceFolder) {
        vscode.window.showErrorMessage("FlightPath: No workspace folder found");
        return;
      }

      // Generate timestamp-based filename: YYYYMMDD-HHmmss.prompt.md
      const now = new Date();
      const pad = (n: number) => n.toString().padStart(2, "0");
      const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const fileName = `${timestamp}.prompt.md`;

      // Create prompts directory
      const promptsDir = path.join(
        this.currentWorkspaceFolder.uri.fsPath,
        ".flightpath",
        "prompts"
      );

      // Ensure directory exists
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(promptsDir));

      const filePath = path.join(promptsDir, fileName);
      const uri = vscode.Uri.file(filePath);

      // Create empty file
      await vscode.workspace.fs.writeFile(uri, Buffer.from("", "utf8"));

      // Open file in editor (respects openPromptsInSecondGroup setting)
      const document = await vscode.workspace.openTextDocument(uri);
      if (ConfigurationUtils.shouldOpenPromptsInSecondGroup()) {
        await vscode.window.showTextDocument(document, {
          viewColumn: vscode.ViewColumn.Two,
          preview: true,
          preserveFocus: false,
        });
      } else {
        await vscode.window.showTextDocument(document, {
          preview: true,
          preserveFocus: false,
        });
      }

      // Set up as current file (empty, but ready for the user to edit)
      // We don't call loadPromptFile() because empty files are invalid
      // Instead, we set up the watcher and show a placeholder in the dashboard
      this.currentPromptFile = {
        filePath,
        promptFile: { prompts: [] }, // Empty prompts array
      };

      // Set up file watcher - will reload when user saves content
      this.setupPromptFileWatcher(filePath);

      // Show in dashboard with placeholder
      if (this.dashboardProvider) {
        this.dashboardProvider.updateFileSelected(fileName, []);
      }

      console.log(`FlightPath: Created draft prompt: ${fileName}`);
    } catch (error) {
      console.error("FlightPath: Failed to create draft prompt:", error);
      vscode.window.showErrorMessage(
        `FlightPath: Failed to create draft prompt: ${error}`
      );
    }
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    this.promptFileWatcher?.dispose();
    this.statusBarManager.dispose();
    this.endConditionEvaluator.dispose();
    console.log("FlightPath: Manager disposed");
  }
}
