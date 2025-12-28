import * as vscode from "vscode";
import * as path from "path";
import { PromptFileParser } from "./PromptFileParser";
import { PromptQueue } from "./PromptQueue";
import { CopilotIntegration, CopilotStatus } from "./base/CopilotIntegration";
import { CopilotChatIntegration } from "./chat/CopilotChatIntegration";
import { CopilotCommandLineIntegration } from "./cli/CopilotCommandLineIntegration";
import { ClaudeCommandLineIntegration } from "./cli/ClaudeCommandLineIntegration";
import { CodexCommandLineIntegration } from "./cli/CodexCommandLineIntegration";
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
import { Log } from "../utils/Log";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";

// Import new orchestration classes
import { PromptFileLoader } from "./orchestration/PromptFileLoader";
import { PromptFileWatcher } from "./orchestration/PromptFileWatcher";
import { TemplateImporter } from "./orchestration/TemplateImporter";
import { WorkflowCommandHandler } from "./orchestration/WorkflowCommandHandler";
import { WorkspaceSessionManager } from "./orchestration/WorkspaceSessionManager";

export class FlightPathManager {
  private promptFileParser: PromptFileParser;
  private promptQueue: PromptQueue;
  private cliIntegration: CopilotCommandLineIntegration;
  private chatIntegration: CopilotChatIntegration;
  private claudeCliIntegration: ClaudeCommandLineIntegration;
  private codexCliIntegration: CodexCommandLineIntegration;
  private endConditionEvaluator: EndConditionEvaluator;
  private endConditionHandler: EndConditionHandler;
  private workflowExecutor: WorkflowExecutor;
  private context: vscode.ExtensionContext;
  private statusBarManager: StatusBarManager;
  private currentWorkspaceFolder: vscode.WorkspaceFolder | undefined;
  private dashboardProvider?: FlightPathDashboardProvider;
  private currentPromptFile?: { filePath: string; promptFile: PromptFile };
  private activeIntegration?: CopilotIntegration; // Track currently executing integration
  private dashboardReady: boolean = false; // Track dashboard initialization state

  // New orchestration dependencies (injected)
  private promptFileLoader: PromptFileLoader;
  private promptFileWatcher: PromptFileWatcher;
  private templateImporter: TemplateImporter;
  private workflowCommandHandler: WorkflowCommandHandler;
  private workspaceSessionManager: WorkspaceSessionManager;

  constructor(
    context: vscode.ExtensionContext,
    dashboardProvider?: FlightPathDashboardProvider
  ) {
    this.context = context;
    this.dashboardProvider = dashboardProvider;
    this.promptFileParser = new PromptFileParser();
    this.promptQueue = new PromptQueue();

    // Initialize ALL integrations so they're always ready to use
    this.cliIntegration = new CopilotCommandLineIntegration(context);
    this.chatIntegration = new CopilotChatIntegration(context);
    this.claudeCliIntegration = new ClaudeCommandLineIntegration(context);
    this.codexCliIntegration = new CodexCommandLineIntegration(context);

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

    // Initialize new orchestration dependencies
    this.promptFileLoader = new PromptFileLoader(
      this.promptFileParser,
      this.promptQueue,
      this.dashboardProvider
    );
    this.promptFileWatcher = new PromptFileWatcher(
      this.promptQueue,
      this.dashboardProvider
    );
    this.templateImporter = new TemplateImporter(context);
    this.workflowCommandHandler = new WorkflowCommandHandler(
      context,
      this.promptFileParser,
      this.endConditionEvaluator
    );
    this.workspaceSessionManager = new WorkspaceSessionManager(
      this.promptFileParser
    );

    // Listen to queue state changes
    this.promptQueue.onDidChangeState(this.onQueueStateChanged.bind(this));

    // Listen to Copilot status changes from the default integration
    const defaultIntegration = this.getDefaultIntegration();
    context.subscriptions.push(
      defaultIntegration.onDidChangeStatus((status) => {
        Log.info(`🔄 Copilot status changed to: ${status}`);
        this.updateStatusBar();
      })
    );

    // Get current workspace folder
    this.currentWorkspaceFolder = vscode.workspace.workspaceFolders?.[0];

    // Update workspace folder in orchestration components
    this.templateImporter.setWorkspaceFolder(this.currentWorkspaceFolder);
    this.workflowCommandHandler.setWorkspaceFolder(this.currentWorkspaceFolder);

    Log.info("Manager initialized");
  }

  /**
   * Check if CLI command should be shown in dashboard output
   */
  private shouldShowCliCommand(): boolean {
    return ConfigurationUtils.shouldShowCliCommand();
  }

  /**
   * Get the default Copilot integration based on user settings
   * Supports: cli (Copilot CLI), chat (Copilot Chat), claude-cli (Claude Code CLI), codex-cli (Codex CLI)
   */
  private getDefaultIntegration(): CopilotIntegration {
    const integrationMode = ConfigurationUtils.getIntegrationMode();

    switch (integrationMode) {
      case Provider.CopilotChat:
        Log.info("🔄 Using Copilot Chat integration");
        return this.chatIntegration;
      case Provider.ClaudeCli:
        Log.info("🔄 Using Claude Code CLI integration");
        return this.claudeCliIntegration;
      case Provider.CodexCli:
        Log.info("🔄 Using Codex CLI integration");
        return this.codexCliIntegration;
      case Provider.CopilotCli:
      default:
        Log.info("🔄 Using Copilot CLI integration");
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
      Log.info(`🔀 Using mode override: ${modeOverride}`);
      switch (modeOverride) {
        case Provider.CopilotChat:
          return this.chatIntegration;
        case Provider.ClaudeCli:
          return this.claudeCliIntegration;
        case Provider.CodexCli:
          return this.codexCliIntegration;
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
      Log.info("Initializing manager...");

      // Discover existing prompt files (delegated to WorkspaceSessionManager)
      if (this.currentWorkspaceFolder) {
        await this.workspaceSessionManager.discoverPromptFiles(
          this.currentWorkspaceFolder
        );
      }

      // Auto-load most recent session if enabled (delegated to WorkspaceSessionManager)
      const config = vscode.workspace.getConfiguration("flightpath");
      const autoLoad = config.get<boolean>("autoLoadRecentSession", true);
      if (autoLoad && this.currentWorkspaceFolder) {
        await this.workspaceSessionManager.autoLoadRecentSession(
          this.currentWorkspaceFolder,
          async (workingFilePath: string) => {
            await this.promptFileLoader.reloadFromWorkingFile(workingFilePath);
            this.setupPromptFileWatcher(workingFilePath);
          }
        );
      }

      // Note: Copilot integration starts background polling automatically in constructor
      // Status bar will update via onDidChangeStatus event listener

      Log.info("Manager initialization complete");
    } catch (error) {
      Log.error("Failed to initialize manager:", error);
      vscode.window.showErrorMessage(
        `FlightPath: Initialization failed: ${error}`
      );
    }
  }

  /**
   * Load a prompt file into the dashboard without executing
   * Delegates to PromptFileLoader
   *
   * @param filePath Path to the prompt file
   */
  async loadPromptFile(filePath: string): Promise<void> {
    // Delegate to PromptFileLoader
    const workingFilePath = await this.promptFileLoader.loadPromptFile(
      filePath,
      this.currentWorkspaceFolder
    );

    if (workingFilePath) {
      // Store the loaded file reference
      const promptFile = await this.promptFileParser.parsePromptFile(filePath);
      if (promptFile) {
        this.currentPromptFile = { filePath, promptFile };
      }

      // Set up file watcher for working file
      this.setupPromptFileWatcher(workingFilePath);
    }
  }

  /**
   * Resume a previous session from .flightpath/.queue
   * Shows a quick pick of available sessions and restores the selected one
   */
  async resumeSession(): Promise<void> {
    if (!this.currentWorkspaceFolder) {
      vscode.window.showErrorMessage("No workspace folder open");
      return;
    }

    try {
      // Discover available sessions (delegated to WorkspaceSessionManager)
      const sessions = await this.workspaceSessionManager.discoverSessions(
        this.currentWorkspaceFolder
      );

      if (sessions.length === 0) {
        vscode.window.showInformationMessage(
          "No previous sessions found. Run a workflow first to create a session."
        );
        return;
      }

      // Show quick pick
      const selected = await vscode.window.showQuickPick(sessions, {
        placeHolder: "Select a session to resume",
        matchOnDescription: true,
        matchOnDetail: true,
      });

      if (selected) {
        // Load the session using reloadFromWorkingFile
        await this.promptFileLoader.reloadFromWorkingFile(selected.filePath);

        // Set up file watcher for the restored working file
        this.setupPromptFileWatcher(selected.filePath);

        // Focus the dashboard to show the restored session
        await vscode.commands.executeCommand("flightpath.dashboard.focus");

        Log.info(`Resumed session: ${selected.label}`);
      }
    } catch (error) {
      Log.error("Failed to resume session:", error as Error);
      vscode.window.showErrorMessage(
        `Failed to resume session: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Execute the currently loaded prompt file
   * @param modeOverride Optional integration mode (overrides user settings for this execution)
   */
  async executeLoadedPromptFile(
    modeOverride?: Provider,
    continueFromCurrent: boolean = false
  ): Promise<void> {
    if (!this.currentPromptFile) {
      vscode.window.showWarningMessage(
        "No prompt file loaded. Use 'Change' button to select a file first."
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
      Log.info(`FlightPath: Executing loaded prompt file: ${filePath}`);

      // Create integration for this execution (either override or default)
      const integration = this.createIntegrationForMode(modeOverride);

      // Check dashboard readiness FIRST (if dashboard exists)
      if (this.dashboardProvider && !this.dashboardReady) {
        const action = await vscode.window.showWarningMessage(
          `FlightPath dashboard is still initializing. Please wait a moment and try again.`,
          "Retry",
          "Cancel"
        );

        if (action === "Retry") {
          // Try again after a short delay
          setTimeout(
            () =>
              this.executeLoadedPromptFile(modeOverride, continueFromCurrent),
            500
          );
        }
        return;
      }

      // Check Copilot readiness
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
          setTimeout(
            () =>
              this.executeLoadedPromptFile(modeOverride, continueFromCurrent),
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
            () =>
              this.executeLoadedPromptFile(modeOverride, continueFromCurrent),
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
            () =>
              this.executeLoadedPromptFile(modeOverride, continueFromCurrent),
            2000
          );
        } else if (action === "View Requirements") {
          // Test automation now available on all integrations via base class
          await integration.testAutomation();
        }
        return;
      }

      // Check if queue needs to be restarted (completed, paused, or error state)
      // Skip restart if we're continuing from append operation
      const queueState = this.promptQueue.getState();
      if (!continueFromCurrent) {
        if (
          queueState.status === EXECUTION_STATES.COMPLETED ||
          queueState.status === EXECUTION_STATES.PAUSED ||
          queueState.status === EXECUTION_STATES.ERROR
        ) {
          Log.info(
            `FlightPath: Queue in ${queueState.status} state, restarting from beginning`
          );
          this.promptQueue.restart();
        }
      } else {
        Log.info(
          `FlightPath: Continuing from current position (append mode), preserving history`
        );
      }

      // Notify dashboard about execution start or continuation
      // Use queue state for accurate count (handles appended prompts)
      const currentQueueState = this.promptQueue.getState();
      const totalPrompts = currentQueueState.prompts.length;

      if (this.dashboardProvider && totalPrompts > 0) {
        if (!continueFromCurrent) {
          // Fresh start - send EXECUTION_STARTED message
          this.dashboardProvider.updateExecutionStarted(fileName, totalPrompts);
        } else {
          // Continuing from append - just update progress, don't reset state
          const currentIndex = currentQueueState.currentIndex;
          this.dashboardProvider.updateProgress(currentIndex, totalPrompts);
        }
      }

      // Set workflow progress in Copilot integration (use queue count, not file count)
      if (totalPrompts > 0) {
        const currentIndex = currentQueueState.currentIndex;
        integration.setWorkflowProgress(currentIndex + 1, totalPrompts);
      }
      await this.startWorkflowExecution(integration);
    } catch (error) {
      Log.error("Failed to execute prompt file:", error);

      // Mark queue as errored
      await this.promptQueue.markErrored();

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
   * Append prompts from a file to the current queue
   * @param filePath - Path to prompt file (.prompt.md, .flightpath.yaml, .flightpath.json)
   * @param position - Where to insert prompts: "next" (after current) or "end" (at end of queue)
   */
  public async appendFromFile(
    filePath: string,
    position: "next" | "end" = "end"
  ): Promise<void> {
    try {
      // 1. Parse file (reuse existing parser)
      const parsed = await this.promptFileParser.parsePromptFile(filePath);

      if (!parsed || !parsed.prompts || parsed.prompts.length === 0) {
        vscode.window.showErrorMessage("No prompts found in file");
        return;
      }

      // 2. Check queue state
      const queueState = this.promptQueue.getState();
      const currentSize = queueState.prompts.length;
      const isCompleted = queueState.status === EXECUTION_STATES.COMPLETED;

      // If no workflow is loaded (truly empty queue), treat as "Run with FlightPath"
      if (currentSize === 0) {
        Log.info("No workflow loaded, treating queue as run");
        await this.executePromptFile(filePath);
        return;
      }

      // 3. Validate queue state
      if (!this.promptQueue.canAppend()) {
        vscode.window.showErrorMessage(
          "Cannot queue prompts: Workflow must be cleared first"
        );
        return;
      }

      // 4. Check queue size limit
      const config = vscode.workspace.getConfiguration("flightpath");
      const maxQueueSize = config.get<number>("maxQueueSize", 100);
      const unlimitedMode = config.get<boolean>("unlimitedMode", false);
      const newSize = currentSize + parsed.prompts.length;

      if (!unlimitedMode && newSize > maxQueueSize) {
        vscode.window.showWarningMessage(
          `Queue size limit exceeded: ${newSize}/${maxQueueSize} prompts. ` +
            `Enable unlimitedMode or increase maxQueueSize to proceed.`
        );
        return;
      }

      // 5. Append prompts with specified position
      const positionLabel = position === "next" ? "next" : "end";
      const source = `User append (${positionLabel}): ${path.basename(filePath)}`;
      await this.promptQueue.appendPrompts(parsed.prompts, source, position);

      // 5.1. Notify dashboard about extended prompts
      if (this.dashboardProvider) {
        const updatedState = this.promptQueue.getState();
        this.dashboardProvider.updatePromptsExtended(updatedState.prompts);
        this.dashboardProvider.updateProgress(
          updatedState.currentIndex,
          updatedState.prompts.length
        );
      }

      // 6. If queue was completed, trigger execution to continue (preserves history)
      if (isCompleted) {
        Log.info(
          "Queue was completed, resuming execution with appended prompts"
        );

        // If no prompt file is loaded, update context WITHOUT clearing dashboard
        if (!this.currentPromptFile) {
          Log.info("No prompt file loaded, updating context (append mode)");
          // Store the loaded file without calling loadPromptFile (which clears dashboard)
          this.currentPromptFile = { filePath, promptFile: parsed };
          // Set up file watcher for live reload
          this.setupPromptFileWatcher(filePath);
        }

        // Continue execution from current position (preserves history)
        await this.executeLoadedPromptFile(undefined, true);
      }

      // 7. Show notification
      const positionText =
        position === "next" ? "after current prompt" : "at end of queue";
      vscode.window.showInformationMessage(
        `Queued ${parsed.prompts.length} prompt(s) ${positionText}`
      );
    } catch (error) {
      Log.error("Failed to queue prompts:", error);
      vscode.window.showErrorMessage(
        `Failed to queue prompts: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Save the file if it's open in an editor with unsaved changes, then reload
   * Delegates to PromptFileLoader
   *
   * @param filePath Path to the file to check and save
   */
  private async saveAndReloadIfDirty(filePath: string): Promise<void> {
    await this.promptFileLoader.saveAndReloadIfDirty(filePath, async () => {
      // Reload callback - re-parse and update current prompt file reference
      if (this.currentPromptFile) {
        const fileName = path.basename(this.currentPromptFile.filePath);
        const promptFile = await this.promptFileParser.parsePromptFile(
          this.currentPromptFile.filePath
        );

        if (promptFile && promptFile.prompts) {
          const validation = this.promptFileParser.validatePromptItems(
            promptFile.prompts
          );
          if (validation.valid) {
            this.currentPromptFile = {
              filePath: this.currentPromptFile.filePath,
              promptFile,
            };
            this.promptQueue.loadPrompts(promptFile.prompts);

            if (this.dashboardProvider) {
              this.dashboardProvider.updateFileSelected(
                fileName,
                promptFile.prompts.map((p) => ({ prompt: p.prompt }))
              );
            }

            Log.info(
              `FlightPath: Reloaded ${promptFile.prompts.length} prompt(s) from ${fileName}`
            );
          }
        }
      }
    });
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
   * Delegates to WorkflowCommandHandler
   */
  async takeOff(): Promise<void> {
    await this.workflowCommandHandler.takeOff(async (filePath: string) => {
      await this.executePromptFile(filePath);
    });
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
      Log.info(
        "▶️ Resuming with pending response (Copilot finished while paused)"
      );
      this.workflowExecutor.resumePendingResponse();
      return;
    }

    // Case 2: Still waiting for response (prompt sent but tool callback not fired yet)
    if (this.workflowExecutor.isAwaitingResponse()) {
      Log.info(
        "▶️ Resuming while Copilot is still responding - will continue when response completes"
      );
      // Do nothing - when the response completes, it will see queue state is "running"
      // and will resolve normally, continuing the workflow
      return;
    }

    // Case 3: Not waiting for response (paused between prompts or before sending)
    Log.info("▶️ Resuming workflow from paused position");
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

    // Stop the queue (sets state to CANCELLING)
    this.promptQueue.stop();

    // Listen for process to actually exit (responseComplete event)
    const responseCompleteDisposable = integration.onResponseComplete(() => {
      Log.info("🔔 Process confirmed exited - setting queue state to IDLE");
      this.promptQueue.confirmedStopped();
      responseCompleteDisposable.dispose();
    });

    // Send cancel signal to integration
    await integration.cancel();

    // Clear any pending response state in the executor
    this.workflowExecutor.clearPendingState();
  }

  /**
   * Create a new prompt file
   * Delegates to WorkflowCommandHandler
   */
  async createPromptFile(): Promise<void> {
    await this.workflowCommandHandler.createPromptFile();
  }

  /**
   * Open FlightPath panel
   * Delegates to WorkflowCommandHandler
   */
  async openPanel(): Promise<void> {
    try {
      await this.workflowCommandHandler.openPanel(
        () => this.getDefaultIntegration().getDetailedStatus(),
        async () => await this.retryCopilotDetection()
      );
    } catch (error) {
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
   * Delegates to WorkflowCommandHandler
   */
  async openCurrentPromptFile(): Promise<void> {
    await this.workflowCommandHandler.openCurrentPromptFile(
      this.currentPromptFile?.filePath
    );
  }

  /**
   * Set dashboard ready flag (called by DashboardProvider when webview signals READY)
   */
  setDashboardReady(): void {
    Log.info("✅ Dashboard is ready");
    this.dashboardReady = true;
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
   * Handle queue state changes
   *
   * This method provides a single execution path for state management:
   * - Normal start: User action → startWorkflowExecution() → WorkflowExecutor → start() → RUNNING state → here
   *   (activeIntegration is set, so no auto-start)
   * - Append to COMPLETED: appendPrompts() → RUNNING state → here → auto-start
   *   (activeIntegration is undefined, so we start execution)
   * - Append to IDLE/PAUSED: appendPrompts() → stays IDLE/PAUSED → here → no auto-start
   */
  private onQueueStateChanged(state: QueueState): void {
    Log.info(`FlightPath: Queue state changed to ${state.status}`);
    this.updateStatusBar();

    // Send execution state to dashboard
    if (this.dashboardProvider) {
      this.dashboardProvider.updateExecutionState(state.status);
    }

    // Auto-start execution if state is RUNNING but no execution is active
    // This handles the case where appendPrompts() set COMPLETED → RUNNING
    if (state.status === EXECUTION_STATES.RUNNING && !this.activeIntegration) {
      Log.info(
        "Queue state is RUNNING but no active execution detected. Auto-starting workflow..."
      );
      // Start execution asynchronously (don't block state change handler)
      this.startWorkflowExecution().catch((error) => {
        Log.error("Auto-start failed:", error);
        vscode.window.showErrorMessage(
          `FlightPath: Failed to auto-start workflow: ${error}`
        );
      });
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
   * Create an end condition script from templates
   * Delegates to WorkflowCommandHandler
   */
  async createEndConditionScript(): Promise<void> {
    await this.workflowCommandHandler.createEndConditionScript();
  }

  /**
   * Import FlightPath custom agents to the workspace's .github/agents folder
   * Delegates to TemplateImporter
   */
  async importAgents(): Promise<void> {
    await this.templateImporter.importAgents();
  }

  /**
   * Import FlightPath workflow templates to the workspace's .flightpath folder
   * Delegates to TemplateImporter
   */
  async importWorkflowTemplates(): Promise<void> {
    await this.templateImporter.importWorkflowTemplates();
  }

  /**
   * Set up file watcher for the working file (not the original prompt file!)
   * Delegates to PromptFileWatcher
   *
   * @param filePath Path to the working file to watch
   */
  private setupPromptFileWatcher(filePath: string): void {
    this.promptFileWatcher.setupFileWatcher(
      filePath,
      async (changedFilePath: string) => {
        // Reload callback
        await this.promptFileLoader.reloadFromWorkingFile(changedFilePath);
      },
      (deletedFilePath: string) => {
        // Delete callback
        this.currentPromptFile = undefined;
      }
    );
  }

  /**
   * Create a new draft prompt file with timestamp-based name
   * Delegates to WorkflowCommandHandler
   */
  async createDraftPrompt(): Promise<void> {
    const result = await this.workflowCommandHandler.createDraftPrompt();

    if (result) {
      // Set up as current file (empty, but ready for the user to edit)
      this.currentPromptFile = {
        filePath: result.filePath,
        promptFile: { prompts: [] }, // Empty prompts array
      };

      // Set up file watcher - will reload when user saves content
      this.setupPromptFileWatcher(result.filePath);

      // Show in dashboard with placeholder
      if (this.dashboardProvider) {
        this.dashboardProvider.updateFileSelected(result.fileName, []);
      }
    }
  }

  /**
   * Create a new custom template from a built-in starting point
   * Delegates to WorkflowCommandHandler
   */
  async createNewTemplate(): Promise<void> {
    await this.workflowCommandHandler.createNewTemplate();
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    this.promptFileWatcher.dispose();
    this.statusBarManager.dispose();
    this.endConditionEvaluator.dispose();
    Log.info("Manager disposed");
  }
}
