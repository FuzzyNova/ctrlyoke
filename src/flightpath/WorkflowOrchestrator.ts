import * as vscode from "vscode";
import * as path from "path";
import { HarnessIntegration, HarnessStatus } from "./HarnessIntegration";
import { CopilotChatIntegration } from "./chat/CopilotChatIntegration";
import { CliIntegration } from "./cli/CliIntegration";
import { IntegrationFactory } from "./IntegrationFactory";
import { WorkflowInstance } from "./WorkflowInstance";
import {
  Harness,
  QueueState,
  WorkingFile,
  WorkflowSummary,
  EXECUTION_STATES,
} from "../types/FlightPathTypes";
import {
  HARNESS_IDS,
  type QueuePosition,
  type ActionType,
} from "../types/DashboardConstants";
import { FlightPathWebviewProvider } from "../ui/FlightPathWebviewProvider";
import { StatusBarManager } from "../ui/StatusBarManager";
import { Log } from "../utils/Log";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { OutputHistoryManager } from "./orchestration/OutputHistoryManager";
import { EndConditionEvaluator } from "./EndConditionEvaluator";

// Orchestration classes that remain at orchestrator level
import { TemplateImporter } from "./orchestration/TemplateImporter";
import { WorkflowCommandHandler } from "./orchestration/WorkflowCommandHandler";
import { WorkspaceSessionManager } from "./orchestration/WorkspaceSessionManager";
import { PromptFileParser } from "./PromptFileParser";

/**
 * WorkflowOrchestrator
 *
 * RESPONSIBILITY: Workflow Registry & Cross-Cutting Concerns
 *
 * Manages the registry of WorkflowInstance objects and owns resources that
 * are shared or orchestrator-scoped:
 *   - Four harness integrations (created once, shared for Phase 1)
 *   - StatusBarManager
 *   - TemplateImporter / WorkflowCommandHandler
 *   - WorkspaceSessionManager (workspace-level session discovery)
 *   - dashboardReady / orchestratorInitialized gates
 *
 * Phase 1: Always holds exactly one WorkflowInstance (the active one).
 * Phase 2: Will hold many instances in parallel; `activeWorkflowId` decides
 *          which one is displayed in the dashboard.
 *
 * The public API mirrors FlightPathManager so FlightPathManager can simply
 * delegate every call here without changing any call-sites.
 */
export class WorkflowOrchestrator {
  // ─────────────────────────────────────────────────────────────────────────
  // Instance registry
  // ─────────────────────────────────────────────────────────────────────────

  /** RUNNING and PAUSED instances only — the parallel execution registry */
  private readonly workflows: Map<string, WorkflowInstance> = new Map();

  /** The instance currently displayed in the dashboard (may or may not be in the Map) */
  private viewedInstance: WorkflowInstance | null = null;

  // ─────────────────────────────────────────────────────────────────────────
  // Cross-cutting concerns
  // ─────────────────────────────────────────────────────────────────────────
  private dashboardProvider?: FlightPathWebviewProvider;
  private readonly integrationFactory: IntegrationFactory;
  private readonly statusBarManager: StatusBarManager;
  private currentWorkspaceFolder: vscode.WorkspaceFolder | undefined;

  // Harness integrations — created once at startup
  private readonly copilotCliIntegration: CliIntegration;
  private readonly chatIntegration: CopilotChatIntegration;
  private readonly claudeCliIntegration: CliIntegration;
  private readonly codexCliIntegration: CliIntegration;

  // Orchestration helpers
  private readonly templateImporter: TemplateImporter;
  private readonly workflowCommandHandler: WorkflowCommandHandler;
  private readonly workspaceSessionManager: WorkspaceSessionManager;
  private readonly promptFileParser: PromptFileParser;
  /** Dedicated evaluator for WorkflowCommandHandler (createEndConditionScript) */
  private readonly endConditionEvaluatorForCommands: EndConditionEvaluator;

  // Initialization gates
  private dashboardReady: boolean = false;
  private orchestratorInitialized: boolean = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    dashboardProvider?: FlightPathWebviewProvider
  ) {
    this.dashboardProvider = dashboardProvider;
    this.integrationFactory = new IntegrationFactory(context);

    // Create the four shared harness integrations
    this.copilotCliIntegration = this.integrationFactory.createCopilotCli();
    this.chatIntegration = this.integrationFactory.createCopilotChat();
    this.claudeCliIntegration = this.integrationFactory.createClaudeCli();
    this.codexCliIntegration = this.integrationFactory.createCodexCli();

    // Status bar
    this.statusBarManager = new StatusBarManager(context);

    // Workspace
    this.currentWorkspaceFolder = vscode.workspace.workspaceFolders?.[0];

    // Shared parsers / orchestration helpers
    this.promptFileParser = new PromptFileParser();
    this.workspaceSessionManager = new WorkspaceSessionManager(
      this.promptFileParser
    );
    this.templateImporter = new TemplateImporter(context);
    this.endConditionEvaluatorForCommands = new EndConditionEvaluator(context);
    this.workflowCommandHandler = new WorkflowCommandHandler(
      context,
      this.promptFileParser,
      this.endConditionEvaluatorForCommands
    );

    this.templateImporter.setWorkspaceFolder(this.currentWorkspaceFolder);
    this.workflowCommandHandler.setWorkspaceFolder(this.currentWorkspaceFolder);

    // Wire harness status subscriptions
    const defaultIntegration = this.getDefaultIntegration();
    const allIntegrations: Array<[string, HarnessIntegration]> = [
      [HARNESS_IDS.COPILOT_CLI, this.copilotCliIntegration],
      [HARNESS_IDS.COPILOT_CHAT, this.chatIntegration],
      [HARNESS_IDS.CLAUDE_CLI, this.claudeCliIntegration],
      [HARNESS_IDS.CODEX_CLI, this.codexCliIntegration],
    ];
    for (const [harnessId, integration] of allIntegrations) {
      context.subscriptions.push(
        integration.onDidChangeStatus((status) => {
          if (integration === defaultIntegration) {
            Log.info(`🔄 Copilot status changed to: ${status}`);
            this.updateStatusBar();
          }
          if (
            status === HarnessStatus.Ready ||
            status === HarnessStatus.Unavailable
          ) {
            this.dashboardProvider?.notifyHarnessAvailability(
              harnessId,
              status === HarnessStatus.Ready
            );
          }
        })
      );
    }

    this.updateStatusBar();
    Log.info("WorkflowOrchestrator initialized");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Instance registry management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Creates a fresh WorkflowInstance and makes it the active workflow.
   * Phase 2: adds it alongside existing instances without clearing the registry.
   */
  async createWorkflow(
    _filePath?: string
  ): Promise<WorkflowInstance | undefined> {
    Log.info(
      `createWorkflow: filePath="${_filePath ?? "(none)"}", currently viewed=${this.viewedInstance?.id.slice(0, 8) ?? "null"}, running=${this.workflows.size}`
    );
    // ── Duplicate detection: only running/paused instances are in the Map ──
    if (_filePath) {
      const existing = [...this.workflows.values()].find(
        (w) => w.filePath === _filePath
      );
      if (existing) {
        const existingStatus = existing.getQueueState().status;
        if (
          existingStatus === EXECUTION_STATES.RUNNING ||
          existingStatus === EXECUTION_STATES.PAUSED
        ) {
          Log.info(
            `createWorkflow: duplicate detected — existing inst:${existing.id.slice(0, 8)} is ${existingStatus}`
          );
          const choice = await vscode.window.showInformationMessage(
            `This workflow is already running and ${existingStatus}. Switch to it or create a new instance?`,
            "Switch to Existing",
            "Create New Instance"
          );
          if (choice === "Switch to Existing" || choice === undefined) {
            this.setActiveWorkflow(existing.id);
            return existing;
          }
          // Fall through to create new instance
        }
      }
    }

    // Dispose current viewedInstance if it is idle (not in the execution registry)
    if (this.viewedInstance && !this.workflows.has(this.viewedInstance.id)) {
      Log.info(
        `createWorkflow: disposing idle viewedInstance inst:${this.viewedInstance.id.slice(0, 8)}`
      );
      this.viewedInstance.dispose();
    } else if (this.viewedInstance) {
      // It is running/paused — just deactivate it visually
      Log.info(
        `createWorkflow: deactivating running viewedInstance inst:${this.viewedInstance.id.slice(0, 8)}`
      );
      this.viewedInstance.setActive(false);
    }

    const instance = this.buildWorkflowInstance();
    this.viewedInstance = instance;
    instance.setActive(true);

    // Load the prompt file into the new instance if a path was provided
    if (_filePath) {
      await instance.loadPromptFile(_filePath);
    }

    // Send full state sync so the dashboard reflects the new (or file-loaded) state
    instance.sendFullStateToDashboard();
    // Notify the dashboard that the active workflow changed (new instance is now viewed)
    this.dashboardProvider?.notifyActiveWorkflowChanged(instance.id);

    return instance;
  }

  /**
   * Silently retire a workflow from the registry — no confirmation, no stop prompts.
   * Called automatically when a workflow reaches COMPLETED, ERROR, or STOPPED state.
   */
  private retireWorkflow(workflowId: string): void {
    const instance = this.workflows.get(workflowId);
    if (!instance) {
      Log.info(`retireWorkflow: inst:${workflowId.slice(0, 8)} not in registry (already retired?)`);
      return;
    }

    const isViewed = this.viewedInstance === instance;
    Log.info(
      `retireWorkflow: inst:${workflowId.slice(0, 8)} status=${instance.getQueueState().status}, isViewed=${isViewed}, remaining=${this.workflows.size - 1}`
    );
    this.workflows.delete(workflowId);

    if (this.viewedInstance === instance) {
      // Keep as viewedInstance so the user still sees the completed result.
      // It will be disposed when the next workflow is created or the extension is disposed.
    } else {
      // Background workflow completed silently — dispose it immediately.
      instance.dispose();
    }

    // Remove from the Running Workflows section in the dashboard.
    this.dashboardProvider?.notifyWorkflowDismissed(workflowId);

    void this.saveState();
  }

  getWorkflow(workflowId: string): WorkflowInstance | undefined {
    return this.workflows.get(workflowId);
  }

  getAllWorkflows(): WorkflowInstance[] {
    return [...this.workflows.values()];
  }

  getRunningWorkflows(): WorkflowInstance[] {
    return [...this.workflows.values()].filter(
      (w) => w.getQueueState().status === EXECUTION_STATES.RUNNING
    );
  }

  getActiveWorkflow(): WorkflowInstance | undefined {
    return this.viewedInstance ?? undefined;
  }

  getActiveWorkflowId(): string | null {
    return this.viewedInstance?.id ?? null;
  }

  setActiveWorkflow(workflowId: string): void {
    const instance = this.workflows.get(workflowId);
    if (!instance) {
      Log.warn(`setActiveWorkflow: inst:${workflowId.slice(0, 8)} not found in running/paused registry`);
      throw new Error(
        `Workflow ${workflowId} not found in running/paused registry`
      );
    }

    Log.info(
      `setActiveWorkflow: switching from inst:${this.viewedInstance?.id.slice(0, 8) ?? "null"} → inst:${workflowId.slice(0, 8)} (${instance.workflowName || "unnamed"})`
    );

    // Dispose current viewedInstance if it is idle (not executing)
    if (this.viewedInstance && !this.workflows.has(this.viewedInstance.id)) {
      Log.info(
        `setActiveWorkflow: disposing idle viewedInstance inst:${this.viewedInstance.id.slice(0, 8)}`
      );
      this.viewedInstance.dispose();
    } else if (this.viewedInstance && this.viewedInstance !== instance) {
      this.viewedInstance.setActive(false);
    }

    this.viewedInstance = instance;
    // setActive(true) calls flushBufferedEvents → sendFullStateToDashboard internally
    instance.setActive(true);
    // Notify the dashboard that the active workflow selection changed.
    this.dashboardProvider?.notifyActiveWorkflowChanged(workflowId);
    Log.info(
      `setActiveWorkflow: switch complete — inst:${workflowId.slice(0, 8)} is now active`
    );
  }

  /** Return summaries without exposing WorkflowInstance internals */
  getWorkflowSummaries(): WorkflowSummary[] {
    const summaries = [...this.workflows.values()].map((w) => w.getSummary());
    Log.info(`[getWorkflowSummaries] registry has ${this.workflows.size} running/paused instances, viewed=${this.viewedInstance?.id.slice(0,8) ?? "null"}: ${summaries.map(s => `inst:${s.id.slice(0,8)}(${s.executionState},fp=${s.filePath ? path.basename(s.filePath) : "?"})`).join(", ") || "(none)"}`);
    return summaries;
  }

  /**
   * No-op: only running/paused workflows are in the Map, and live process state
   * cannot be meaningfully restored after the extension host terminates.
   * Clears any stale persisted state from the previous architecture.
   */
  async saveState(): Promise<void> {
    await this.context.workspaceState.update("flightpath.loadedWorkflows", []);
  }

  /**
   * No-op: Workflows are not persisted across restarts.
   * Only running/paused instances exist in the registry, and those are
   * impossible to restore after the extension host process terminates.
   */
  async restoreState(): Promise<void> {
    // no-op
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Initialization
  // ─────────────────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    try {
      Log.info("WorkflowOrchestrator: Initializing...");

      const integrationMode = ConfigurationUtils.getIntegrationMode();
      const modeLabel =
        {
          [Harness.CopilotChat]: "Copilot Chat",
          [Harness.ClaudeCli]: "Claude Code CLI",
          [Harness.CodexCli]: "Codex CLI",
          [Harness.CopilotCli]: "Copilot CLI",
        }[integrationMode] || "Copilot CLI";
      Log.info(`🔄 Default integration: ${modeLabel}`);

      await Promise.all([
        this.copilotCliIntegration.initialize(),
        this.chatIntegration.initialize(),
        this.claudeCliIntegration.initialize(),
        this.codexCliIntegration.initialize(),
      ]);

      if (this.currentWorkspaceFolder) {
        await this.workspaceSessionManager.discoverPromptFiles(
          this.currentWorkspaceFolder
        );
      }

      this.orchestratorInitialized = true;
      Log.info("WorkflowOrchestrator: Initialization complete");

      await this.restoreState(); // no-op

      if (this.dashboardReady) {
        Log.info(
          "Dashboard was ready before init — triggering deferred auto-load"
        );
        await this.triggerAutoLoad();
      }
    } catch (error) {
      this.orchestratorInitialized = true;
      Log.error("Failed to initialize WorkflowOrchestrator:", error);
      vscode.window.showErrorMessage(
        `FlightPath: Initialization failed: ${error}`
      );
    }
  }

  async setDashboardReady(): Promise<void> {
    Log.info("✅ Dashboard is ready");
    this.dashboardReady = true;

    if (this.orchestratorInitialized) {
      await this.triggerAutoLoad();
    } else {
      Log.info(
        "Orchestrator not yet initialized — deferring auto-load until init completes"
      );
    }
  }

  private async triggerAutoLoad(): Promise<void> {
    if (
      ConfigurationUtils.shouldAutoLoadRecentSession() &&
      this.currentWorkspaceFolder
    ) {
      Log.info("Triggering auto-load of recent session");

      await this.workspaceSessionManager.autoLoadRecentSession(
        this.currentWorkspaceFolder,
        async (workingFilePath: string) => {
          await this.getActiveInstance().autoLoadFromWorkingFile(
            workingFilePath
          );
        }
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Per-workflow delegation — load / execute / control
  // ─────────────────────────────────────────────────────────────────────────

  async loadPromptFile(filePath: string): Promise<void> {
    // Phase 2: each explicit load creates a new workflow instance alongside any running ones
    await this.createWorkflow(filePath);
  }

  /**
   * Execute a specific workflow (or the active one) by ID.
   * Multiple workflows may run simultaneously.
   * Warns (but does not block) if a second Chat-harness workflow is started.
   */
  async executeWorkflow(
    workflowId?: string,
    modeOverride?: Harness,
    continueFromCurrent?: boolean
  ): Promise<void> {
    const instance = workflowId
      ? this.workflows.get(workflowId)
      : this.viewedInstance;

    if (!instance) {
      Log.warn(`executeWorkflow: workflow ${workflowId ?? "viewed"} not found`);
      return;
    }

    // Add to the workflows Map (running/paused registry) if not already there
    if (!this.workflows.has(instance.id)) {
      this.workflows.set(instance.id, instance);
      Log.info(
        `executeWorkflow: registered inst:${instance.id.slice(0, 8)} in running registry (total: ${this.workflows.size})`
      );
      this.dashboardProvider?.notifyWorkflowAdded(instance.getSummary());
    }

    // Warn (but don't block) if trying to run a second Chat-harness workflow
    const effectiveHarness =
      modeOverride ?? ConfigurationUtils.getIntegrationMode();
    if (effectiveHarness === Harness.CopilotChat) {
      const alreadyRunning = this.getRunningWorkflows().filter(
        (w) => w !== instance
      );
      if (alreadyRunning.length > 0) {
        void vscode.window.showWarningMessage(
          "Another Chat workflow is already running. Starting this one may cause conflicts."
        );
        // Continue anyway
      }
    }

    return instance.executeLoadedPromptFile(modeOverride, continueFromCurrent);
  }

  async executeLoadedPromptFile(
    modeOverride?: Harness,
    continueFromCurrent?: boolean
  ): Promise<void> {
    return this.executeWorkflow(undefined, modeOverride, continueFromCurrent);
  }

  async executePromptFile(
    filePath: string,
    modeOverride?: Harness
  ): Promise<void> {
    return this.getActiveInstance().executePromptFile(filePath, modeOverride);
  }

  async appendFromFile(
    filePath: string,
    position?: QueuePosition
  ): Promise<void> {
    return this.getActiveInstance().appendFromFile(filePath, position);
  }

  async pause(): Promise<void> {
    return this.getActiveInstance().pause();
  }

  async resume(): Promise<void> {
    return this.getActiveInstance().resume();
  }

  async stop(): Promise<void> {
    return this.getActiveInstance().stop();
  }

  clearWorkflow(): void {
    this.getActiveInstance().clearWorkflow();
  }

  getQueueState(): QueueState {
    return this.getActiveInstance().getQueueState();
  }

  async updateWorkflowName(workflowName: string): Promise<void> {
    return this.getActiveInstance().updateWorkflowName(workflowName);
  }

  async loadWorkingFile(filePath: string): Promise<void> {
    // Phase 2: loading a working file creates a new instance alongside any running ones
    await this.createWorkflow();
    return this.getActiveInstance().loadWorkingFile(filePath);
  }

  getCurrentPromptFile(): { fileName: string; prompts: unknown[] } | null {
    return this.getActiveInstance().getCurrentPromptFile();
  }

  async readWorkingFile(workingFilePath: string): Promise<WorkingFile> {
    return this.getActiveInstance().readWorkingFile(workingFilePath);
  }

  getOutputHistoryManager(): OutputHistoryManager {
    return this.getActiveInstance().outputHistoryManager;
  }

  updateWorkflowPropertyInQueue(property: string, value: unknown): void {
    this.getActiveInstance().updateWorkflowPropertyInQueue(property, value);
  }

  async updateWorkingFileProperties(
    properties: Record<string, unknown>,
    options: {
      onlyIfUndefined?: boolean;
      ensureHarnessAndModel?: boolean;
      allowDeletes?: boolean;
    } = {}
  ): Promise<{ workingFile: WorkingFile; appliedKeys: string[] } | null> {
    return this.getActiveInstance().updateWorkingFileProperties(
      properties,
      options
    );
  }

  async updatePromptInQueue(
    index: number,
    text: string,
    properties: unknown
  ): Promise<void> {
    return this.getActiveInstance().updatePromptInQueue(
      index,
      text,
      properties
    );
  }

  async deletePromptFromQueue(index: number): Promise<void> {
    return this.getActiveInstance().deletePromptFromQueue(index);
  }

  async resetWorkflowState(): Promise<void> {
    return this.getActiveInstance().resetWorkflowState();
  }

  async executeEphemeralPrompt(
    text: string,
    properties: unknown,
    action: ActionType,
    promptName?: string,
    forceNewWorkflow?: boolean
  ): Promise<void> {
    return this.getActiveInstance().executeEphemeralPrompt(
      text,
      properties,
      action,
      promptName,
      forceNewWorkflow
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Orchestrator-level workflow operations
  // ─────────────────────────────────────────────────────────────────────────

  async resumeSession(): Promise<void> {
    if (!this.currentWorkspaceFolder) {
      vscode.window.showErrorMessage("No workspace folder open");
      return;
    }

    try {
      const sessions = await this.workspaceSessionManager.discoverSessions(
        this.currentWorkspaceFolder
      );

      if (sessions.length === 0) {
        vscode.window.showInformationMessage(
          "No previous sessions found. Run a workflow first to create a session."
        );
        return;
      }

      const selected = await vscode.window.showQuickPick(sessions, {
        placeHolder: "Select a session to resume",
        matchOnDescription: true,
        matchOnDetail: true,
      });

      if (selected) {
        try {
          // Create a fresh instance so the resumed workflow is parallel to any running ones
          await this.createWorkflow();
          await this.getActiveInstance().restoreWorkflowFromWorkingFile(
            selected.filePath
          );
          await vscode.commands.executeCommand("flightpath.dashboard.focus");
          Log.info(`Resumed session: ${selected.label}`);
        } catch (loadError) {
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

  async createPromptFile(): Promise<void> {
    await this.workflowCommandHandler.createPromptFile();
  }

  async openPanel(): Promise<void> {
    await this.workflowCommandHandler.openPanel(
      () => this.getDefaultIntegration().getDetailedStatus(),
      async () => await this.retryHarnessDetection()
    );
  }

  async openCurrentPromptFile(): Promise<void> {
    const filePath = this.getActiveInstance().getCurrentPromptFilePath();
    await this.workflowCommandHandler.openCurrentPromptFile(filePath);
  }

  async createDraftPrompt(): Promise<void> {
    const result = await this.workflowCommandHandler.createDraftPrompt();

    if (result) {
      // Expose draft file into the active workflow instance via loadPromptFile
      // so the instance owns currentPromptFile, watcher setup, etc.
      // Use a lightweight path: just set up the tracker + watcher without parsing.
      const instance = this.getActiveInstance();
      // Reuse the internal loadPromptFile pathway but the file is empty so
      // we set up a placeholder currentPromptFile manually.
      instance["currentPromptFile"] = {
        filePath: result.filePath,
        promptFile: { prompts: [] },
      };
      instance["setupPromptFileWatcher"](result.filePath);

      if (this.dashboardProvider) {
        this.dashboardProvider.updateFileSelected(
          result.fileName,
          [],
          undefined
        );
      }
    }
  }

  async createEndConditionScript(): Promise<void> {
    await this.workflowCommandHandler.createEndConditionScript();
  }

  async importAgents(): Promise<void> {
    await this.templateImporter.importAgents();
  }

  async importWorkflowTemplates(): Promise<void> {
    await this.templateImporter.importWorkflowTemplates();
  }

  async createNewTemplate(): Promise<void> {
    await this.workflowCommandHandler.createNewTemplate();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Harness / integration status
  // ─────────────────────────────────────────────────────────────────────────

  async retryHarnessDetection(): Promise<void> {
    await this.getDefaultIntegration().retryDetection();
  }

  getHarnessDetailedStatus() {
    return this.getDefaultIntegration().getDetailedStatus();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Dispose
  // ─────────────────────────────────────────────────────────────────────────

  dispose(): void {
    // Dispose viewedInstance if it is not tracked in the running/paused Map
    if (this.viewedInstance && !this.workflows.has(this.viewedInstance.id)) {
      this.viewedInstance.dispose();
    }
    this.viewedInstance = null;

    for (const instance of this.workflows.values()) {
      instance.dispose();
    }
    this.workflows.clear();
    this.statusBarManager.dispose();
    this.endConditionEvaluatorForCommands.dispose();
    Log.info("WorkflowOrchestrator disposed");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get the active WorkflowInstance, creating one if none exists yet.
   */
  private getActiveInstance(): WorkflowInstance {
    if (this.viewedInstance) {
      return this.viewedInstance;
    }

    // Lazily create the initial viewed instance
    const instance = this.buildWorkflowInstance();
    this.viewedInstance = instance;
    instance.setActive(true);
    return instance;
  }

  /**
   * Construct a new WorkflowInstance wired to this orchestrator's integrations.
   */
  private buildWorkflowInstance(): WorkflowInstance {
    const instance = new WorkflowInstance(
      this.context,
      this.dashboardProvider,
      this.integrationFactory,
      (harnessOverride?: Harness) => this.resolveDetectorIntegration(harnessOverride),
      (name: string | undefined) =>
        this.propagateWorkflowNameToIntegrations(name),
      () => this.updateStatusBar(),
      this.currentWorkspaceFolder
    );

    Log.info(`buildWorkflowInstance: created inst:${instance.id.slice(0, 8)}`);

    // Broadcast summary updates whenever this instance's execution state changes.
    // This covers both active and inactive workflows so the multi-workflow list
    // stays in sync regardless of which workflow is currently displayed.
    instance.promptQueue.onDidChangeState((state) => {
      this.dashboardProvider?.notifyWorkflowSummaryUpdated(
        instance.getSummary()
      );

      // Auto-retire when a workflow completes, errors, or stops.
      // Small delay lets final dashboard messages flush first.
      if (
        state.status === EXECUTION_STATES.COMPLETED ||
        state.status === EXECUTION_STATES.ERROR ||
        state.status === EXECUTION_STATES.STOPPED
      ) {
        setTimeout(() => {
          this.retireWorkflow(instance.id);
        }, 500);
      }
    });

    return instance;
  }

  private getDefaultIntegration(): HarnessIntegration {
    const integrationMode = ConfigurationUtils.getIntegrationMode();
    switch (integrationMode) {
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

  /**
   * Return the DETECTOR singleton for the given harness (or the default harness if none).
   * Used for pre-flight status checks and harness availability UI only.
   * Never used for execution — execution integrations are created per-run via IntegrationFactory.
   */
  private resolveDetectorIntegration(harnessOverride?: Harness): HarnessIntegration {
    if (harnessOverride) {
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
    return this.getDefaultIntegration();
  }

  private propagateWorkflowNameToIntegrations(name: string | undefined): void {
    this.copilotCliIntegration.setWorkflowName(name);
    this.claudeCliIntegration.setWorkflowName(name);
    this.codexCliIntegration.setWorkflowName(name);
  }

  private updateStatusBar(): void {
    const activeInstance = this.getActiveInstance();
    const state = activeInstance.getQueueState();
    const harnessStatus = this.getDefaultIntegration().getDetailedStatus();
    this.statusBarManager.updateStatusBar(state, harnessStatus);
  }
}
