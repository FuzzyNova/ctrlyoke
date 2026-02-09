import * as vscode from "vscode";
import * as path from "path";
import { PromptFileParser } from "./PromptFileParser";
import { PromptQueue } from "./PromptQueue";
import { CopilotIntegration, CopilotStatus } from "./base/CopilotIntegration";
import { CopilotChatIntegration } from "./chat/CopilotChatIntegration";
import { CliIntegration } from "./cli/CliIntegration";
import { CopilotCliProvider } from "./cli/copilot/CopilotCliProvider";
import { ClaudeCliProvider } from "./cli/claude/ClaudeCliProvider";
import { CodexCliProvider } from "./cli/codex/CodexCliProvider";
import { EndConditionEvaluator } from "./EndConditionEvaluator";
import { EndConditionHandler } from "./EndConditionHandler";
import { WorkflowExecutor, WorkflowContext } from "./WorkflowExecutor";
import {
  PromptFile,
  PromptItem,
  QueueState,
  Harness,
  EXECUTION_STATES,
  WorkingFile,
} from "../types/FlightPathTypes";
import {
  ACTION_TYPES,
  QUEUE_POSITION,
  type ActionType,
  type QueuePosition,
} from "../types/DashboardConstants";
import { FlightPathDashboardProvider } from "../ui/FlightPathDashboardProvider";
import { StatusBarManager } from "../ui/StatusBarManager";
import { Log } from "../utils/Log";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import {
  PropertyResolver,
  ResolvedProperties,
} from "../utils/PropertyResolver";

// Import new orchestration classes
import { PromptFileLoader } from "./orchestration/PromptFileLoader";
import { PromptFileWatcher } from "./orchestration/PromptFileWatcher";
import { TemplateImporter } from "./orchestration/TemplateImporter";
import { WorkflowCommandHandler } from "./orchestration/WorkflowCommandHandler";
import { WorkspaceSessionManager } from "./orchestration/WorkspaceSessionManager";

export class FlightPathManager {
  private promptFileParser: PromptFileParser;
  private promptQueue: PromptQueue;
  private copilotCliIntegration: CliIntegration;
  private chatIntegration: CopilotChatIntegration;
  private claudeCliIntegration: CliIntegration;
  private codexCliIntegration: CliIntegration;
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
  private startPending: boolean = false; // Prevent duplicate workflow starts (race condition guard)
  private lastKnownPromptCount: number = 0; // Track prompt count to detect MCP merges

  // New orchestration dependencies (injected)
  private promptFileLoader: PromptFileLoader;
  private promptFileWatcher: PromptFileWatcher;
  private templateImporter: TemplateImporter;
  private workflowCommandHandler: WorkflowCommandHandler;
  private workspaceSessionManager: WorkspaceSessionManager;

  constructor(
    context: vscode.ExtensionContext,
    dashboardProvider?: FlightPathDashboardProvider | any // TODO: Create common interface for React/vanilla providers
  ) {
    this.context = context;
    this.dashboardProvider = dashboardProvider;
    this.promptFileParser = new PromptFileParser();
    this.promptQueue = new PromptQueue();

    // Initialize ALL integrations so they're always ready to use
    // Phase 3: Use composition-based CliIntegration for Copilot (pilot implementation)
    // Phase 4: Use composition-based CliIntegration for Claude (refactored)
    // Phase 5: Use composition-based CliIntegration for Codex (refactored)
    const copilotProvider = new CopilotCliProvider();
    this.copilotCliIntegration = new CliIntegration(copilotProvider, context);
    this.chatIntegration = new CopilotChatIntegration(context);
    const claudeProvider = new ClaudeCliProvider();
    this.claudeCliIntegration = new CliIntegration(claudeProvider, context);
    const codexProvider = new CodexCliProvider();
    this.codexCliIntegration = new CliIntegration(codexProvider, context);

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
   * Get the default harness integration based on user settings
   * Supports: cli (Copilot CLI), chat (Copilot Chat), claude-cli (Claude Code CLI), codex-cli (Codex CLI)
   */
  private getDefaultIntegration(): CopilotIntegration {
    const integrationMode = ConfigurationUtils.getIntegrationMode();

    switch (integrationMode) {
      case Harness.CopilotChat:
        Log.info("🔄 Using Copilot Chat integration");
        return this.chatIntegration;
      case Harness.ClaudeCli:
        Log.info("🔄 Using Claude Code CLI integration");
        return this.claudeCliIntegration;
      case Harness.CodexCli:
        Log.info("🔄 Using Codex CLI integration");
        return this.codexCliIntegration;
      case Harness.CopilotCli:
      default:
        Log.info("🔄 Using Copilot CLI integration");
        return this.copilotCliIntegration;
    }
  }

  /**
   * Get dynamic queue configuration from settings
   */
  private getDynamicQueueConfig(): import("../types/FlightPathTypes").DynamicQueueConfig {
    return ConfigurationUtils.getDynamicQueueConfig();
  }

  /**
   * Create integration instance based on harness override or user settings
   * @param harnessOverride Optional harness to override user settings
   * @returns Integration instance (either override or default)
   */
  private createIntegrationForMode(
    harnessOverride?: Harness
  ): CopilotIntegration {
    if (harnessOverride) {
      Log.info(`🔀 Using harness override: ${harnessOverride}`);
      switch (harnessOverride) {
        case Harness.CopilotChat:
          return this.chatIntegration;
        case Harness.ClaudeCli:
          return this.claudeCliIntegration;
        case Harness.CodexCli:
          return this.codexCliIntegration;
        case Harness.CopilotCli:
        default:
          return this.copilotCliIntegration;
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

      // Initialize all integrations (check CLI availability)
      await Promise.all([
        this.copilotCliIntegration.initialize(),
        this.chatIntegration.initialize(),
        this.claudeCliIntegration.initialize(),
        this.codexCliIntegration.initialize(),
      ]);

      // Discover existing prompt files (delegated to WorkspaceSessionManager)
      if (this.currentWorkspaceFolder) {
        await this.workspaceSessionManager.discoverPromptFiles(
          this.currentWorkspaceFolder
        );
      }

      // Note: Auto-load recent session is deferred until dashboard is ready
      // (see setDashboardReady() method)

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
   * Restore a workflow from a working file
   * Shared helper used by resumeSession() and loadWorkingFile()
   * @param workingFilePath - Path to working file
   * @throws Error if validation or loading fails
   */
  private async restoreWorkflowFromWorkingFile(
    workingFilePath: string
  ): Promise<void> {
    // Load the session using reloadFromWorkingFile with replace mode (throws on validation failure)
    await this.promptFileLoader.reloadFromWorkingFile(
      workingFilePath,
      "replace"
    );

    // Set currentPromptFile so getCurrentPromptFile() works correctly
    const workingFile = await this.promptQueue.readWorkingFile(workingFilePath);
    if (workingFile && workingFile.originalFile && workingFile.prompts) {
      this.currentPromptFile = {
        filePath: workingFile.originalFile,
        promptFile: { prompts: workingFile.prompts },
      };
    }

    // Set up file watcher for the restored working file (only if validation succeeded)
    this.setupPromptFileWatcher(workingFilePath);
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
        try {
          // Restore workflow using shared helper
          await this.restoreWorkflowFromWorkingFile(selected.filePath);

          // Focus the dashboard to show the restored session
          await vscode.commands.executeCommand("flightpath.dashboard.focus");

          Log.info(`Resumed session: ${selected.label}`);
        } catch (loadError) {
          // Validation or loading failed - show error to user
          Log.error("Failed to load session:", loadError as Error);
          vscode.window.showErrorMessage(
            `Failed to load session: ${loadError instanceof Error ? loadError.message : String(loadError)}`
          );
        }
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
    modeOverride?: Harness,
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

      // Check if queue needs to be restarted (completed, paused, stopped, or error state)
      // Skip restart if we're continuing from append operation
      const queueState = this.promptQueue.getState();
      if (!continueFromCurrent) {
        if (
          queueState.status === EXECUTION_STATES.COMPLETED ||
          queueState.status === EXECUTION_STATES.PAUSED ||
          queueState.status === EXECUTION_STATES.STOPPED ||
          queueState.status === EXECUTION_STATES.ERROR
        ) {
          Log.info(
            `FlightPath: Queue in ${queueState.status} state, restarting from beginning`
          );
          await this.promptQueue.restart();
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
    modeOverride?: Harness
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
   * @param position - Where to insert prompts: QUEUE_POSITION.NEXT (after current) or QUEUE_POSITION.END (at end of queue)
   */
  public async appendFromFile(
    filePath: string,
    position: QueuePosition = QUEUE_POSITION.END
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

      // If no workflow is loaded (truly empty queue), create new workflow in IDLE state
      if (currentSize === 0) {
        Log.info("Empty workflow, creating new workflow in IDLE state");

        // Use custom workflow name if it exists, otherwise use filename
        const displayName = queueState.workflowName || path.basename(filePath);
        const workflowType = queueState.workflowName
          ? `workflow "${queueState.workflowName}"`
          : "new workflow";

        // Use single-sourced initialization logic
        await this.initializeNewWorkflow(
          parsed.prompts,
          path.basename(filePath),
          filePath,
          true, // reuseExistingWorkingFile
          `Queued ${parsed.prompts.length} prompt(s) to ${workflowType}`
        );
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
      const queueConfig = ConfigurationUtils.getDynamicQueueConfig();
      const maxQueueSize = queueConfig.maxQueueSize;
      const unlimitedMode = queueConfig.unlimitedMode;
      const newSize = currentSize + parsed.prompts.length;

      if (!unlimitedMode && newSize > maxQueueSize) {
        vscode.window.showWarningMessage(
          `Queue size limit exceeded: ${newSize}/${maxQueueSize} prompts. ` +
            `Enable unlimitedMode or increase maxQueueSize to proceed.`
        );
        return;
      }

      // 5. Append prompts with specified position
      const source = `User append (${position}): ${path.basename(filePath)}`;
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

      // 6. Update prompt file context if needed (without executing)
      if (!this.currentPromptFile) {
        Log.info("No prompt file loaded, updating context (append mode)");
        this.currentPromptFile = { filePath, promptFile: parsed };
        this.setupPromptFileWatcher(filePath);
      }

      // 7. Show notification
      const positionText =
        position === QUEUE_POSITION.NEXT
          ? "after current prompt"
          : "at end of queue";
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
            this.promptQueue.loadPrompts(promptFile);

            if (this.dashboardProvider) {
              const queueState = this.promptQueue.getState();
              this.dashboardProvider.updateFileSelected(
                fileName,
                promptFile.prompts, // Send full prompt objects with all properties
                queueState.workflowName || undefined
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
    // Race condition guard: Prevent duplicate starts (from both auto-start and explicit calls)
    if (this.startPending) {
      Log.info(
        "⚠️ Workflow start already pending, skipping duplicate start request"
      );
      return;
    }

    this.startPending = true;

    try {
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
        getIntegrationForPrompt: (
          prompt: PromptItem,
          harnessOverride?: Harness
        ) => {
          const resolvedHarness = harnessOverride || prompt.harness;
          // If prompt or workflow has a harness override, use it; otherwise use the active integration
          if (resolvedHarness) {
            Log.info(
              `🔀 Prompt ${prompt.id || "unnamed"} using harness override: ${resolvedHarness}`
            );
            const overrideIntegration =
              this.createIntegrationForMode(resolvedHarness);
            // CRITICAL: Update activeIntegration so stop() uses the correct integration
            this.activeIntegration = overrideIntegration;
            return overrideIntegration;
          }
          return activeIntegration;
        },
      };

      // Delegate to WorkflowExecutor
      await this.workflowExecutor.execute(activeIntegration, context);

      // Clear active integration reference after execution
      this.activeIntegration = undefined;
    } finally {
      // Always clear the pending flag, even if execution throws
      this.startPending = false;
    }
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
  async pause(): Promise<void> {
    await this.promptQueue.pause();
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

    Log.info(
      `⏹️ FlightPathManager.stop() - Using ${integration === this.copilotCliIntegration ? "Copilot CLI" : integration === this.claudeCliIntegration ? "Claude CLI" : integration === this.codexCliIntegration ? "Codex CLI" : "Copilot Chat"} integration`
    );

    // Stop the queue (sets state to CANCELLING)
    this.promptQueue.stop();

    // Listen for process to actually exit (responseComplete event)
    const responseCompleteDisposable = integration.onResponseComplete(() => {
      Log.info("🔔 Process confirmed exited - setting queue state to IDLE");
      this.promptQueue.confirmedStopped().catch((err) => {
        Log.error("Failed to update working file after stop:", err);
      });
      responseCompleteDisposable.dispose();
    });

    // Send cancel signal to integration
    await integration.cancel();

    // Clear any pending response state in the executor
    this.workflowExecutor.clearPendingState();

    // Clear the startPending flag to allow new workflows to start
    // (The finally block in startWorkflowExecution may not have run yet if execute() is still unwinding)
    this.startPending = false;
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
   * Clear current workflow state
   * Resets queue, clears current prompt file, and removes working file reference
   */
  clearWorkflow(): void {
    // Clear current prompt file reference
    this.currentPromptFile = undefined;

    // Clear queue state (including working file path)
    this.promptQueue.clearQueue();

    // Reset tracked prompt count
    this.lastKnownPromptCount = 0;

    Log.info("Workflow state cleared");
  }

  /**
   * Get current queue state
   */
  getQueueState(): QueueState {
    return this.promptQueue.getState();
  }

  /**
   * Update workflow name
   * @param workflowName - New workflow name
   */
  async updateWorkflowName(workflowName: string): Promise<void> {
    if (!this.promptQueue) {
      throw new Error("No active queue");
    }

    await this.promptQueue.updateWorkflowName(workflowName);
    // State change event is automatically emitted by PromptQueue
  }

  /**
   * Load working file from path
   * Uses the same flow as resumeSession for proper workflow restoration
   * @param filePath - Path to working file
   */
  async loadWorkingFile(filePath: string): Promise<void> {
    if (!this.promptQueue) {
      throw new Error("Queue not initialized");
    }

    try {
      // Restore workflow using shared helper
      await this.restoreWorkflowFromWorkingFile(filePath);
      Log.info(`Loaded workflow: ${filePath}`);
    } catch (loadError) {
      // Validation or loading failed - show error to user
      Log.error("Failed to load workflow:", loadError as Error);
      vscode.window.showErrorMessage(
        `Failed to load workflow: ${loadError instanceof Error ? loadError.message : String(loadError)}`
      );
      throw loadError; // Re-throw so caller knows it failed
    }
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
   * Read working file (delegated to PromptQueue)
   */
  async readWorkingFile(workingFilePath: string): Promise<any> {
    return this.promptQueue.readWorkingFile(workingFilePath);
  }

  /**
   * Update workflow-level property in the queue cache.
   * Ensures property resolution uses the latest working file values.
   */
  updateWorkflowPropertyInQueue(property: string, value: unknown): void {
    this.promptQueue.updateWorkflowProperty(property, value);
  }

  /**
   * Update workflow-level properties in the working file using the queue writer.
   */
  async updateWorkingFileProperties(
    properties: Record<string, unknown>,
    options: {
      onlyIfUndefined?: boolean;
      ensureHarnessAndModel?: boolean;
      allowDeletes?: boolean;
    } = {}
  ): Promise<{ workingFile: WorkingFile; appliedKeys: string[] } | null> {
    return this.promptQueue.updateWorkingFileProperties(properties, options);
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
   * Triggers auto-load if enabled in settings
   */
  async setDashboardReady(): Promise<void> {
    Log.info("✅ Dashboard is ready");
    this.dashboardReady = true;

    // Check if auto-load is enabled and trigger it now that dashboard is ready
    if (
      ConfigurationUtils.shouldAutoLoadRecentSession() &&
      this.currentWorkspaceFolder
    ) {
      Log.info("Triggering auto-load of recent session");

      await this.workspaceSessionManager.autoLoadRecentSession(
        this.currentWorkspaceFolder,
        async (workingFilePath: string) => {
          // Attempt to reload from working file - throws if validation fails
          // Pass isAutoLoad=true to prevent auto-starting RUNNING workflows
          await this.promptFileLoader.reloadFromWorkingFile(
            workingFilePath,
            "replace",
            true
          );

          // Set currentPromptFile so getCurrentPromptFile() works correctly
          const workingFile =
            await this.promptQueue.readWorkingFile(workingFilePath);
          if (workingFile && workingFile.originalFile && workingFile.prompts) {
            this.currentPromptFile = {
              filePath: workingFile.originalFile,
              promptFile: { prompts: workingFile.prompts },
            };
          }

          // Only set up file watcher if we successfully loaded and validated
          this.setupPromptFileWatcher(workingFilePath);
        }
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
   * Handle queue state changes
   *
   * Auto-starts workflow execution when queue transitions to RUNNING without an active integration.
   * This handles cases like:
   * - Append to COMPLETED: appendPrompts() → RUNNING state → here → auto-start (or skipped if explicit start pending)
   * - Resume from STOPPED/PAUSED: resume() → RUNNING state → here → auto-start (or skipped if explicit start pending)
   *
   * Race condition protection: startWorkflowExecution() uses startPending flag to prevent duplicate starts,
   * ensuring only one execution path runs regardless of whether auto-start or explicit start happens first.
   */
  private onQueueStateChanged(state: QueueState): void {
    Log.info(
      `FlightPath: Queue state changed to ${state.status} (currentIndex: ${state.currentIndex}, total: ${state.prompts.length}, completed: ${state.completedIds.size})`
    );
    this.updateStatusBar();

    // Send execution state to dashboard
    if (this.dashboardProvider) {
      this.dashboardProvider.updateExecutionState(state.status);

      // Detect if prompts were added externally (e.g., MCP merge)
      // This happens when updateWorkingFile() detects new prompts on disk and merges them
      if (state.prompts.length > this.lastKnownPromptCount) {
        Log.info(
          `Detected prompt count increase: ${this.lastKnownPromptCount} → ${state.prompts.length}. Notifying dashboard.`
        );
        this.dashboardProvider.updatePromptsExtended(state.prompts);

        // Also update progress so the counter updates immediately
        this.dashboardProvider.updateProgress(
          state.currentIndex,
          state.prompts.length
        );
      }
    }

    // Update tracked prompt count
    this.lastKnownPromptCount = state.prompts.length;

    // Auto-start execution if state is RUNNING but no execution is active
    // startWorkflowExecution() will prevent duplicate starts via startPending flag
    if (state.status === EXECUTION_STATES.RUNNING && !this.activeIntegration) {
      Log.info(
        `Auto-starting workflow: State=RUNNING, activeIntegration=null, currentIndex=${state.currentIndex}, totalPrompts=${state.prompts.length}`
      );
      // Start execution asynchronously (don't block state change handler)
      this.startWorkflowExecution().catch((error) => {
        Log.error("Auto-start failed:", error);
        vscode.window.showErrorMessage(
          `FlightPath: Failed to auto-start workflow: ${error}`
        );
      });
    } else if (state.status === EXECUTION_STATES.RUNNING) {
      Log.info(
        `State is RUNNING but NOT auto-starting (activeIntegration already exists)`
      );
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

        // Keep currentPromptFile in sync with working file (for queue extensions)
        const workingFile =
          await this.promptQueue.readWorkingFile(changedFilePath);
        if (workingFile && workingFile.originalFile && workingFile.prompts) {
          this.currentPromptFile = {
            filePath: workingFile.originalFile,
            promptFile: { prompts: workingFile.prompts },
          };
        }
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
        this.dashboardProvider.updateFileSelected(
          result.fileName,
          [],
          undefined
        );
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
   * Build PromptItem properties from dashboard properties object
   * Handles three cases for each property:
   * - null: Clear the override (set to undefined to remove from prompt)
   * - value: Set the override
   * - undefined (not in object): Don't change (not included in updates)
   * @param properties - Raw properties from dashboard
   * @returns Partial PromptItem with properties to update
   */
  private buildPromptItemProperties(properties: any): Partial<PromptItem> {
    const updates: Partial<PromptItem> = {};

    // Handle harness: null clears, value sets, undefined skips
    if (properties.harness !== undefined) {
      updates.harness =
        properties.harness === null
          ? undefined
          : (properties.harness as Harness);
    }

    // Handle model: null clears, value sets, undefined skips
    if (properties.model !== undefined) {
      updates.model = properties.model === null ? undefined : properties.model;
    }

    // Handle agent: null clears, value sets, undefined skips
    if (properties.agent !== undefined) {
      updates.agent = properties.agent === null ? undefined : properties.agent;
    }

    // Handle resumeSession: null clears, boolean sets, undefined skips
    if (properties.resumeSession !== undefined) {
      updates.resumeSession =
        properties.resumeSession === null
          ? undefined
          : properties.resumeSession;
    }

    // Handle sessionId: null clears, string/number sets, undefined skips
    if (properties.sessionId !== undefined) {
      updates.sessionId =
        properties.sessionId === null ? undefined : properties.sessionId;
    }

    // Handle allowDynamicExtension: null clears, boolean sets, undefined skips
    if (properties.allowDynamicExtension !== undefined) {
      updates.allowDynamicExtension =
        properties.allowDynamicExtension === null
          ? undefined
          : properties.allowDynamicExtension;
    }

    // Handle endCondition: null clears, object sets, undefined skips
    if (properties.endCondition !== undefined) {
      updates.endCondition =
        properties.endCondition === null ? undefined : properties.endCondition;
    }

    return updates;
  }

  /**
   * Initialize a new workflow with prompts
   * Handles working file creation, queue loading, and dashboard updates
   * Single source of truth for workflow initialization across all entry points
   *
   * @param prompts - Array of prompt items
   * @param displayName - Display name for dashboard
   * @param originalFilePath - Original file path (for file-based workflows)
   * @param reuseExistingWorkingFile - Check for existing working file first
   * @param notificationMessage - Optional notification to show user
   * @returns Created working file path (if successful)
   */
  private async initializeNewWorkflow(
    prompts: PromptItem[],
    displayName: string,
    originalFilePath?: string,
    reuseExistingWorkingFile: boolean = false,
    notificationMessage?: string
  ): Promise<string | undefined> {
    // Check for existing working file (appendFromFile scenario)
    let workingFilePath: string | undefined;
    if (reuseExistingWorkingFile) {
      const queueState = this.promptQueue.getState();
      workingFilePath = queueState.workingFilePath;
      if (workingFilePath) {
        Log.info(`Reusing existing working file: ${workingFilePath}`);
      }
    }

    // Create new working file if needed
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workingFilePath && workspaceFolder) {
      try {
        workingFilePath = await this.promptQueue.createWorkingFile(
          displayName,
          prompts,
          workspaceFolder
        );
        Log.info(`✅ Created working file: ${workingFilePath}`);

        // Apply pending workflow properties IMMEDIATELY after creating working file
        // This ensures properties are in place BEFORE prompt execution resolves them
        if (this.dashboardProvider) {
          await this.dashboardProvider.applyPendingWorkflowProperties();
        }
      } catch (error) {
        Log.error("Failed to create working file:", error);
        // Continue without working file (MCP won't work but execution can proceed)
      }
    } else if (!workingFilePath) {
      Log.warn(
        "No workspace folder, skipping working file creation (MCP won't work)"
      );
    }

    // Load prompts into queue
    // If working file exists, reload it to get workflow properties (including pending properties just applied)
    // Otherwise, use minimal PromptFile with just prompts
    let promptFile: PromptFile;
    if (workingFilePath) {
      // Reload working file to get complete PromptFile with workflow properties
      promptFile = await this.promptQueue.readWorkingFile(workingFilePath);
    } else {
      // No working file - use minimal PromptFile
      promptFile = { prompts };
    }
    this.promptQueue.loadPrompts(promptFile, workingFilePath);

    // Update dashboard
    if (this.dashboardProvider) {
      const queueState = this.promptQueue.getState();
      this.dashboardProvider.updateFileSelected(
        displayName,
        prompts,
        queueState.workflowName || undefined
      );
    }

    // Set current prompt file for tracking
    if (originalFilePath) {
      this.currentPromptFile = {
        filePath: originalFilePath,
        promptFile: { prompts },
      };
      this.setupPromptFileWatcher(originalFilePath);
    } else {
      // Ephemeral prompts use generated filename as tracking ID
      this.currentPromptFile = {
        filePath: displayName,
        promptFile: { prompts },
      };
    }

    // Show notification if provided
    if (notificationMessage) {
      vscode.window.showInformationMessage(notificationMessage);
    }

    return workingFilePath;
  }

  /**
   * Execute an ephemeral prompt from the dashboard editor
   * @param text - Prompt text
   * @param properties - PromptItem properties (harness, model, etc.)
   * @param action - 'send' (append + run) or 'add' (append only)
   */
  /**
   * Generate a clean workflow name from prompt text or prompt name
   * Takes first 5 words from text (if no prompt name), converts to kebab-case
   * Note: Does NOT include timestamp - that's added by generateWorkingFilePath for the file on disk
   */
  private generateWorkflowNameFromPrompt(
    text: string,
    promptName?: string
  ): string {
    // Prefer user-provided prompt name if available
    if (promptName && promptName.trim().length > 0) {
      return promptName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-") // Replace non-alphanumeric with dashes
        .replace(/^-+|-+$/g, ""); // Remove leading/trailing dashes
    }

    // Fallback: Extract first 5 words from prompt text
    const words = text
      .trim()
      .split(/\s+/)
      .slice(0, 5)
      .map(
        (word) =>
          word
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-") // Replace non-alphanumeric with dashes
            .replace(/^-+|-+$/g, "") // Remove leading/trailing dashes
      )
      .filter((word) => word.length > 0);

    return words.length > 0 ? words.join("-") : "ephemeral-prompt";
  }

  async executeEphemeralPrompt(
    text: string,
    properties: any,
    action: ActionType,
    promptName?: string,
    forceNewWorkflow: boolean = false
  ): Promise<void> {
    // Generate timestamp components for both filename and ID
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
    const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, ""); // HHMMSS

    // Generate a meaningful workflow name from prompt name (if provided) or prompt text
    const generatedWorkflowName = this.generateWorkflowNameFromPrompt(
      text,
      promptName
    );

    // Build PromptItem with ID that includes timestamp for uniqueness
    // This prevents deduplication when users append multiple prompts with the same name
    let promptId: string;
    if (promptName && promptName.trim().length > 0) {
      const sanitizedName = promptName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      promptId = `${sanitizedName}-${dateStr}-${timeStr}`;
    } else {
      promptId = `ephemeral-${Date.now()}`;
    }

    const promptItem: PromptItem = {
      prompt: text,
      id: promptId,
      ...this.buildPromptItemProperties(properties),
    };

    // If forceNewWorkflow is true, clear current workflow first
    if (forceNewWorkflow) {
      Log.info("Force new workflow requested - clearing current workflow");
      this.clearWorkflow();
    }

    // Get current queue state to determine behavior
    const currentState = this.promptQueue.getState();
    const hasWorkflow = currentState.prompts.length > 0;
    const isIdle = currentState.status === EXECUTION_STATES.IDLE;
    const isCompleted = currentState.status === EXECUTION_STATES.COMPLETED;

    // Determine position (end vs next vs before current)
    let position: QueuePosition = QUEUE_POSITION.END;
    let shouldRun = false;

    if (
      action === ACTION_TYPES.RUN ||
      action === ACTION_TYPES.RUN_NEXT ||
      action === ACTION_TYPES.RUN_BEFORE_CURRENT
    ) {
      shouldRun = true;
      if (action === ACTION_TYPES.RUN_NEXT) {
        position = QUEUE_POSITION.NEXT;
      } else if (action === ACTION_TYPES.RUN_BEFORE_CURRENT) {
        position = QUEUE_POSITION.BEFORE_CURRENT;
      } else {
        position = QUEUE_POSITION.END;
      }
    } else if (
      action === ACTION_TYPES.QUEUE ||
      action === ACTION_TYPES.QUEUE_NEXT
    ) {
      shouldRun = false;
      position =
        action === ACTION_TYPES.QUEUE_NEXT
          ? QUEUE_POSITION.NEXT
          : QUEUE_POSITION.END;
    }

    if (!hasWorkflow) {
      // No workflow exists: Create new workflow (DRY - single code path)
      // Use existing workflow name if user has set one, otherwise use generated name
      const workflowName = currentState.workflowName || generatedWorkflowName;
      await this.initializeNewWorkflow([promptItem], workflowName);

      // Execute immediately if shouldRun=true
      if (shouldRun) {
        await this.executeLoadedPromptFile();
        Log.info(
          `Send prompt (run, position=${position}): ${text.substring(0, 50)}...`
        );
      } else {
        Log.info(
          `Add prompt (no run, position=${position}): ${text.substring(0, 50)}...`
        );
      }
    } else {
      // Workflow exists: Append with specified position
      await this.promptQueue.appendPrompts(
        [promptItem],
        "Dashboard editor",
        position
      );

      // Notify dashboard
      if (this.dashboardProvider) {
        const updatedState = this.promptQueue.getState();
        this.dashboardProvider.updatePromptsExtended(updatedState.prompts);
      }

      // Execute if shouldRun=true and queue is idle/completed/stopped
      if (shouldRun) {
        const isStopped = currentState.status === EXECUTION_STATES.STOPPED;
        if (isIdle || isCompleted || isStopped) {
          // When resuming completed/stopped queue or continuing idle queue, preserve existing state
          await this.executeLoadedPromptFile(undefined, true);
        }
        Log.info(
          `Send prompt (run, position=${position}): ${text.substring(0, 50)}...`
        );
      } else {
        Log.info(
          `Add prompt (no run, position=${position}): ${text.substring(0, 50)}...`
        );
      }
    }
  }

  /**
   * Update an existing prompt in the queue
   * @param index - Prompt index
   * @param text - New prompt text
   * @param properties - Updated PromptItem properties
   */
  async updatePromptInQueue(
    index: number,
    text: string,
    properties: any
  ): Promise<void> {
    const updates: Partial<PromptItem> = {
      prompt: text,
      ...this.buildPromptItemProperties(properties),
    };

    await this.promptQueue.updatePrompt(index, updates);

    // Notify dashboard
    if (this.dashboardProvider) {
      const currentState = this.promptQueue.getState();
      this.dashboardProvider.updatePromptsExtended(currentState.prompts);
    }

    Log.info(`Updated prompt ${index}: ${text.substring(0, 50)}...`);
  }

  /**
   * Delete a prompt from the queue
   * @param index - Prompt index
   */
  async deletePromptFromQueue(index: number): Promise<void> {
    console.log(
      `🗑️ FlightPathManager.deletePromptFromQueue: Deleting prompt at index ${index}`
    );

    await this.promptQueue.deletePrompt(index);
    console.log(
      `🗑️ FlightPathManager.deletePromptFromQueue: PromptQueue.deletePrompt completed`
    );

    // Notify dashboard of deletion
    if (this.dashboardProvider) {
      const currentState = this.promptQueue.getState();
      const fileName = this.currentPromptFile
        ? path.basename(this.currentPromptFile.filePath)
        : "Untitled";
      console.log(
        `🗑️ FlightPathManager.deletePromptFromQueue: Notifying dashboard, ${currentState.prompts.length} prompts remaining`
      );
      this.dashboardProvider.updatePromptDeleted(
        fileName,
        currentState.prompts
      );
    }

    Log.info(`Deleted prompt ${index}`);
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
