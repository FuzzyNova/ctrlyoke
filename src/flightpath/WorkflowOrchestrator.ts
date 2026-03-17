import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { HarnessIntegration, HarnessStatus } from "./HarnessIntegration";
import { CopilotChatIntegration } from "./harness/chat/CopilotChatIntegration";
import { CliIntegration } from "./harness/CliIntegration";
import { IntegrationFactory } from "./IntegrationFactory";
import { VsCodeIntegrationFactory } from "./VsCodeIntegrationFactory";
import { WorkflowInstance } from "./WorkflowInstance";
import { PromptQueue } from "./PromptQueue";
import {
  Harness,
  QueueState,
  WorkingFile,
  WorkflowSummary,
  WorkflowRunnerLock,
  EXECUTION_STATES,
  STEP_STATUS,
  type PromptItem,
  workflowDisplayStep,
} from "../types/FlightPathTypes";
import {
  HARNESS_IDS,
  LOCK_STATUS,
  type QueuePosition,
  type ActionType,
  type StepStatus,
} from "../types/DashboardConstants";
import { FlightPathWebviewProvider } from "../ui/FlightPathWebviewProvider";
import { StatusBarManager } from "../ui/StatusBarManager";
import { Log } from "../utils/Log";
import {
  ConfigurationUtils,
  PATH_CONSTANTS,
} from "../utils/ConfigurationUtils";
import { OutputHistoryManager } from "./orchestration/OutputHistoryManager";
import { EndConditionEvaluator } from "./EndConditionEvaluator";
import { WorkflowLockManager } from "../utils/WorkflowLockManager";
import { CliWatchSession } from "./orchestration/CliWatchSession";

// Orchestration classes that remain at orchestrator level
import { TemplateImporter } from "./orchestration/TemplateImporter";
import { WorkflowCommandHandler } from "./orchestration/WorkflowCommandHandler";
import { WorkspaceSessionManager } from "./orchestration/WorkspaceSessionManager";
import { PromptFileParser } from "./PromptFileParser";
import { VsCodeAdapter } from "../platform/VsCodeAdapter";

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
 */
export class WorkflowOrchestrator {
  // ─────────────────────────────────────────────────────────────────────────
  // Instance registry
  // ─────────────────────────────────────────────────────────────────────────

  /** RUNNING and PAUSED instances only — the parallel execution registry */
  private readonly workflows: Map<string, WorkflowInstance> = new Map();

  /** CLI-managed workflows being watched (keyed by workflowId) */
  private readonly cliSessions: Map<
    string,
    { session: CliWatchSession; summary: WorkflowSummary }
  > = new Map();

  /** Watcher for *.runner.json creation (Entry Point 3: CLI starts while VS Code is open) */
  private runnerJsonCreateWatcher?: vscode.FileSystemWatcher;

  /** The instance currently displayed in the dashboard (may or may not be in the Map) */
  private viewedInstance: WorkflowInstance | null = null;

  // ─────────────────────────────────────────────────────────────────────────
  // Cross-cutting concerns
  // ─────────────────────────────────────────────────────────────────────────
  private dashboardProvider?: FlightPathWebviewProvider;
  private readonly integrationFactory: VsCodeIntegrationFactory;
  private readonly statusBarManager: StatusBarManager;
  private currentWorkspaceFolder: vscode.WorkspaceFolder | undefined;

  // Harness integrations — created once at startup
  private readonly copilotCliIntegration: CliIntegration;
  private readonly chatIntegration: CopilotChatIntegration;
  private readonly claudeCliIntegration: CliIntegration;
  private readonly codexCliIntegration: CliIntegration;
  private readonly openCodeCliIntegration: CliIntegration;

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
    this.integrationFactory = new VsCodeIntegrationFactory(
      new VsCodeAdapter(context)
    );

    // Create the four shared harness integrations
    this.copilotCliIntegration = this.integrationFactory.createCopilotCli();
    this.chatIntegration = this.integrationFactory.createCopilotChat();
    this.claudeCliIntegration = this.integrationFactory.createClaudeCli();
    this.codexCliIntegration = this.integrationFactory.createCodexCli();
    this.openCodeCliIntegration = this.integrationFactory.createOpenCodeCli();

    // Status bar
    this.statusBarManager = new StatusBarManager(context);

    // Workspace
    this.currentWorkspaceFolder = vscode.workspace.workspaceFolders?.[0];

    // Shared parsers / orchestration helpers
    this.promptFileParser = new PromptFileParser(new VsCodeAdapter(context));
    this.workspaceSessionManager = new WorkspaceSessionManager(
      this.promptFileParser,
      new VsCodeAdapter(context)
    );
    this.templateImporter = new TemplateImporter(context);
    this.endConditionEvaluatorForCommands = new EndConditionEvaluator(
      new VsCodeAdapter(context)
    );
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
      [HARNESS_IDS.OPENCODE_CLI, this.openCodeCliIntegration],
    ];
    for (const [harnessId, integration] of allIntegrations) {
      context.subscriptions.push(
        integration.onDidChangeStatus((status) => {
          if (integration === defaultIntegration) {
            Log.debug(`🔄 Copilot status changed to: ${status}`);
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
    Log.debug("WorkflowOrchestrator initialized");
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
    Log.debug(
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
      Log.debug(
        `createWorkflow: disposing idle viewedInstance inst:${this.viewedInstance.id.slice(0, 8)}`
      );
      this.viewedInstance.dispose();
    } else if (this.viewedInstance) {
      // It is running/paused — just deactivate it visually
      Log.debug(
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
      Log.debug(
        `retireWorkflow: inst:${workflowId.slice(0, 8)} not in registry (already retired?)`
      );
      return;
    }

    const isViewed = this.viewedInstance === instance;
    Log.debug(
      `retireWorkflow: inst:${workflowId.slice(0, 8)} name=\"${instance.workflowName || "(empty)"}\" ` +
        `status=${instance.getQueueState().status}, isViewed=${isViewed}, remaining=${this.workflows.size - 1}`
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
    // Check if this is a CLI-managed session
    const cliEntry = this.cliSessions.get(workflowId);
    if (cliEntry) {
      Log.debug(
        `setActiveWorkflow: switching to CLI-managed session workflowId="${workflowId}"`
      );
      this.dashboardProvider?.notifyActiveWorkflowChanged(workflowId);
      // Send the CLI session's summary so the dashboard shows read-only state
      this.dashboardProvider?.notifyWorkflowSummaryUpdated(cliEntry.summary);
      // Send full workflow state (prompts + outputs) so the dashboard panels update
      this.sendCliWorkflowFullStateToDashboard(workflowId, cliEntry).catch(
        (err) =>
          Log.warn(
            `setActiveWorkflow: failed to send full CLI state for "${workflowId}":`,
            err
          )
      );
      return;
    }

    const instance = this.workflows.get(workflowId);
    if (!instance) {
      Log.warn(
        `setActiveWorkflow: inst:${workflowId.slice(0, 8)} not found in running/paused registry`
      );
      throw new Error(
        `Workflow ${workflowId} not found in running/paused registry`
      );
    }

    Log.debug(
      `setActiveWorkflow: switching from inst:${this.viewedInstance?.id.slice(0, 8) ?? "null"} → inst:${workflowId.slice(0, 8)} (${instance.workflowName || "unnamed"})`
    );

    // Dispose current viewedInstance if it is idle (not executing)
    if (this.viewedInstance && !this.workflows.has(this.viewedInstance.id)) {
      Log.debug(
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
    Log.debug(
      `setActiveWorkflow: switch complete — inst:${workflowId.slice(0, 8)} is now active`
    );
    // Restore run history counter so the RunSelector appears in the output header.
    // Fire-and-forget: sendRunHistoryToDashboard is async (disk I/O) but non-critical.
    instance
      .sendRunHistoryToDashboard()
      .catch((err) =>
        Log.warn(
          `setActiveWorkflow: failed to send run history for inst:${workflowId.slice(0, 8)}:`,
          err
        )
      );
  }

  /** Return summaries without exposing WorkflowInstance internals */
  getWorkflowSummaries(): WorkflowSummary[] {
    const vsSummaries = [...this.workflows.values()].map((w) => w.getSummary());
    const cliSummaries = [...this.cliSessions.values()].map(
      (entry) => entry.summary
    );
    const summaries = [...vsSummaries, ...cliSummaries];
    Log.trace(
      `[getWorkflowSummaries] registry has ${this.workflows.size} running/paused instances + ${this.cliSessions.size} CLI sessions, viewed=${this.viewedInstance?.id.slice(0, 8) ?? "null"}: ${summaries.map((s) => `inst:${s.id.slice(0, 8)}(${s.executionState},fp=${s.filePath ? path.basename(s.filePath) : "?"})`).join(", ") || "(none)"}`
    );
    return summaries;
  }

  /**
   * Ensure a CliWatchSession exists for the given working file if the lock is active-cli.
   *
   * Called by WorkflowSerializer.handleGetRecentWorkflows to bridge the timing gap between
   * CLI lock file creation and the runnerJsonCreateWatcher firing (VS Code file-watcher
   * latency on Windows can be several hundred milliseconds).
   *
   * Also implements Entry Point 2 from the CLI Watch Mode plan: the user opens a recently-run
   * workflow from the dropdown while the CLI is still actively running it.
   *
   * @returns true if the working file is (or was just registered as) CLI-managed;
   *          false if no active-cli lock exists or the session could not be started.
   */
  async ensureCliWatchSession(workingFilePath: string): Promise<boolean> {
    const workflowId = path
      .basename(workingFilePath)
      .replace(/\.flightpath\.json$/, "");

    // Already tracked — nothing to do
    if (this.cliSessions.has(workflowId)) {
      return true;
    }

    const workspaceFolderPath = this.currentWorkspaceFolder?.uri.fsPath;
    if (!workspaceFolderPath) {
      return false;
    }

    const lockStatus = await WorkflowLockManager.checkLock(workingFilePath);
    Log.debug(
      `[WorkflowOrchestrator] ensureCliWatchSession: "${workflowId}" lockStatus=${lockStatus}`
    );
    if (lockStatus !== LOCK_STATUS.ACTIVE_CLI) {
      return false;
    }

    Log.info(
      `[WorkflowOrchestrator] ensureCliWatchSession: registering CLI watch session for "${workflowId}" (lock was active-cli but watcher hadn't fired yet)`
    );
    await this.startCliWatchSession(workingFilePath, workspaceFolderPath);
    return true;
  }

  /**
   * Clears persisted workflow state from the previous architecture.
   * Running/paused workflows live only in the in-memory Map and cannot be
   * meaningfully restored after the extension host terminates, so we write
   * an empty array to clear any stale data left by earlier versions.
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
      Log.debug("WorkflowOrchestrator: Initializing...");

      const integrationMode = ConfigurationUtils.getIntegrationMode();
      const modeLabel =
        {
          [Harness.CopilotChat]: "Copilot Chat",
          [Harness.ClaudeCli]: "Claude Code CLI",
          [Harness.CodexCli]: "Codex CLI",
          [Harness.CopilotCli]: "Copilot CLI",
          [Harness.OpenCodeCli]: "OpenCode CLI",
        }[integrationMode] || "Copilot CLI";
      Log.info(`🔄 Default integration: ${modeLabel}`);

      await Promise.all([
        this.copilotCliIntegration.initialize(),
        this.chatIntegration.initialize(),
        this.claudeCliIntegration.initialize(),
        this.codexCliIntegration.initialize(),
        this.openCodeCliIntegration.initialize(),
      ]);

      if (this.currentWorkspaceFolder) {
        await this.workspaceSessionManager.discoverPromptFiles(
          this.currentWorkspaceFolder.uri.fsPath
        );
        // Must run after harness init and before auto-load so stale RUNNING files
        // are normalized and CLI-managed workflows are registered.
        await this.setupCliWatching();
      }

      this.orchestratorInitialized = true;
      Log.debug("WorkflowOrchestrator: Initialization complete");

      await this.restoreState(); // no-op

      if (this.dashboardReady) {
        Log.debug(
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
      Log.debug(
        "Orchestrator not yet initialized — deferring auto-load until init completes"
      );
    }
  }

  private async triggerAutoLoad(): Promise<void> {
    if (
      ConfigurationUtils.shouldAutoLoadRecentSession() &&
      this.currentWorkspaceFolder
    ) {
      Log.debug("Triggering auto-load of recent session");

      await this.workspaceSessionManager.autoLoadRecentSession(
        this.currentWorkspaceFolder.uri.fsPath,
        async (workingFilePath: string) => {
          // Skip auto-loading if this working file is actively managed by the CLI.
          // The CliWatchSession was already created in setupCliWatching(), so the
          // workflow is already visible in the Running section — auto-loading it
          // as a VS Code instance would create a conflicting viewedInstance.
          const lockStatus =
            await WorkflowLockManager.checkLock(workingFilePath);
          if (lockStatus === LOCK_STATUS.ACTIVE_CLI) {
            Log.debug(
              `triggerAutoLoad: skipping CLI-managed workflow "${path.basename(workingFilePath)}"`
            );
            return;
          }
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

    // Note: the instance is registered in this.workflows when its promptQueue
    // transitions to RUNNING or PAUSED via the onDidChangeState listener wired
    // in buildWorkflowInstance(). Registering there (not here) guarantees
    // getWorkflowSummaries() only ever returns truly running/paused workflows.

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
    // Phase 2: load into a new instance (same as loadPromptFile), then execute.
    // This keeps the two operations DRY — executePromptFile = loadPromptFile + executeWorkflow.
    // Previously this called getActiveInstance().executePromptFile() which would
    // clear the active instance's queue (even if it was a running workflow) and
    // load the new file into it — stomping on parallel workflows.
    Log.debug(
      `executePromptFile: loading "${path.basename(filePath)}" into new instance ` +
        `(${this.workflows.size} workflow(s) currently in registry)`
    );
    const instance = await this.createWorkflow(filePath);
    if (!instance) {
      return;
    }
    // Guard: if createWorkflow switched to an already-running/paused duplicate,
    // don't re-execute it — the user just wanted to view it.
    const status = instance.getQueueState().status;
    if (
      status === EXECUTION_STATES.RUNNING ||
      status === EXECUTION_STATES.PAUSED
    ) {
      Log.debug(
        `executePromptFile: switched to existing ${status} workflow inst:${instance.id.slice(0, 8)}, skipping re-execution`
      );
      return;
    }
    return this.executeWorkflow(undefined, modeOverride);
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

  /**
   * Pause a specific workflow by ID.
   * Used by per-workflow controls in the dropdown; allows pausing non-active instances.
   */
  async pauseWorkflow(workflowId: string): Promise<void> {
    const instance = this.workflows.get(workflowId);
    if (!instance) {
      Log.warn(
        `pauseWorkflow: inst:${workflowId.slice(0, 8)} not found in registry`
      );
      return;
    }
    return instance.pause();
  }

  /**
   * Resume a specific workflow by ID.
   * Used by per-workflow controls in the dropdown; allows resuming non-active instances.
   */
  async resumeWorkflow(workflowId: string): Promise<void> {
    const instance = this.workflows.get(workflowId);
    if (!instance) {
      Log.warn(
        `resumeWorkflow: inst:${workflowId.slice(0, 8)} not found in registry`
      );
      return;
    }
    return instance.resume();
  }

  /**
   * Stop a specific workflow by ID.
   * Used by per-workflow controls in the dropdown; allows stopping non-active instances.
   */
  async stopWorkflow(workflowId: string): Promise<void> {
    const instance = this.workflows.get(workflowId);
    if (!instance) {
      Log.warn(
        `stopWorkflow: inst:${workflowId.slice(0, 8)} not found in registry`
      );
      return;
    }
    return instance.stop();
  }

  /**
   * Kill the CLI process for a CLI-managed workflow by sending SIGTERM to its PID.
   * The CLI handles SIGTERM by releasing the lock and exiting cleanly, which triggers
   * CliWatchSession.onFinished() → workflow transitions to STOPPED automatically.
   */
  async stopCliSession(workflowId: string): Promise<void> {
    const entry = this.cliSessions.get(workflowId);
    if (!entry) {
      Log.warn(
        `stopCliSession: no CLI session found for workflowId="${workflowId}"`
      );
      return;
    }

    const lock = await WorkflowLockManager.readLock(
      entry.summary.workingFilePath ?? ""
    );
    if (!lock) {
      Log.warn(
        `stopCliSession: no lock file found for workflowId="${workflowId}"`
      );
      return;
    }

    Log.info(
      `stopCliSession: sending SIGTERM to CLI pid=${lock.pid} for workflowId="${workflowId}"`
    );
    try {
      process.kill(lock.pid, "SIGTERM");
    } catch (err) {
      // ESRCH = process already dead — that's fine, the session will clean itself up
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") {
        Log.warn(`stopCliSession: process.kill(${lock.pid}) failed:`, err);
      }
    }
  }

  async clearWorkflow(): Promise<void> {
    const active = this.getActiveInstance();
    const state = active.getQueueState().status;
    if (
      state === EXECUTION_STATES.RUNNING ||
      state === EXECUTION_STATES.PAUSED
    ) {
      // Running/paused workflow stays alive in the background;
      // create a fresh empty instance as the new active view.
      Log.debug(
        `clearWorkflow: active inst:${active.id.slice(0, 8)} is ${state} — creating new empty instance`
      );
      await this.createWorkflow();
    } else {
      active.clearWorkflow();
    }
  }

  getQueueState(): QueueState {
    return this.getActiveInstance().getQueueState();
  }

  clearWorkingFilePath(): void {
    this.getActiveInstance().clearWorkingFilePath();
  }

  /**
   * Get the PromptQueue of the currently active workflow instance.
   * Returns null if no instance exists yet.
   */
  getActivePromptQueue(): PromptQueue | null {
    return this.viewedInstance?.promptQueue ?? null;
  }

  async updateWorkflowName(workflowName: string): Promise<void> {
    return this.getActiveInstance().updateWorkflowName(workflowName);
  }

  async loadWorkingFile(filePath: string): Promise<void> {
    const workflowId = path
      .basename(filePath)
      .replace(/\.flightpath\.json$/, "");

    // If already tracked as a CLI session, switch the panel view to it (Entry Point 2)
    const existingCliEntry = this.cliSessions.get(workflowId);
    if (existingCliEntry) {
      Log.debug(
        `loadWorkingFile: "${workflowId}" is CLI-managed (session exists) — switching view`
      );
      this.dashboardProvider?.notifyActiveWorkflowChanged(workflowId);
      this.dashboardProvider?.notifyWorkflowSummaryUpdated(
        existingCliEntry.summary
      );
      return;
    }

    // Check for an active CLI lock before creating a VS Code instance (Entry Point 2)
    const lockStatus = await WorkflowLockManager.checkLock(filePath);
    if (lockStatus === LOCK_STATUS.ACTIVE_CLI) {
      const workspaceFolderPath = this.currentWorkspaceFolder?.uri.fsPath;
      if (workspaceFolderPath) {
        Log.debug(
          `loadWorkingFile: "${workflowId}" has active CLI lock — starting CliWatchSession`
        );
        await this.startCliWatchSession(filePath, workspaceFolderPath);
      }
      return;
    }

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
    properties: unknown,
    promptName?: string,
    clearProperties?: string[]
  ): Promise<void> {
    return this.getActiveInstance().updatePromptInQueue(
      index,
      text,
      properties,
      promptName,
      clearProperties
    );
  }

  async updateFinalPromptInQueue(
    finalPrompt: PromptItem | null,
    clearProperties?: string[]
  ): Promise<void> {
    return this.getActiveInstance().updateFinalPromptInQueue(
      finalPrompt,
      clearProperties
    );
  }

  async ensureEphemeralWorkingFile(options?: {
    initialProperties?: Record<string, unknown>;
  }): Promise<void> {
    return this.getActiveInstance().ensureEphemeralWorkingFile(options);
  }

  async deletePromptFromQueue(index: number): Promise<void> {
    return this.getActiveInstance().deletePromptFromQueue(index);
  }

  async resetWorkflowState(): Promise<void> {
    return this.getActiveInstance().resetWorkflowState();
  }

  async reorderPendingPrompts(newPendingOrder: number[]): Promise<void> {
    return this.getActiveInstance().reorderPendingPrompts(newPendingOrder);
  }

  async syncPromptsForUndoRedo(
    prompts: PromptItem[],
    finalPrompt: PromptItem | null
  ): Promise<void> {
    return this.getActiveInstance().syncPromptsForUndoRedo(prompts, finalPrompt);
  }

  async setStartPosition(toIndex: number): Promise<void> {
    return this.getActiveInstance().setStartPosition(toIndex);
  }

  async markCurrentAsComplete(): Promise<void> {
    return this.getActiveInstance().markCurrentAsComplete();
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
        this.currentWorkspaceFolder.uri.fsPath
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
      // Expose draft file into the active workflow instance via public accessors
      // so the instance owns currentPromptFile, watcher setup, etc.
      const instance = this.getActiveInstance();
      instance.setCurrentPromptFile(result.filePath, { prompts: [] });
      instance.initializeFileWatcher(result.filePath);

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

    // Dispose all CLI watch sessions
    for (const entry of this.cliSessions.values()) {
      entry.session.dispose();
    }
    this.cliSessions.clear();

    // Dispose the runner.json create watcher
    this.runnerJsonCreateWatcher?.dispose();

    this.statusBarManager.dispose();
    this.endConditionEvaluatorForCommands.dispose();
    Log.debug("WorkflowOrchestrator disposed");
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
      new VsCodeAdapter(this.context),
      this.dashboardProvider,
      this.integrationFactory,
      (harnessOverride?: Harness) =>
        this.resolveDetectorIntegration(harnessOverride),
      (name: string | undefined) =>
        this.propagateWorkflowNameToIntegrations(name),
      () => this.updateStatusBar(),
      this.currentWorkspaceFolder?.uri.fsPath
    );

    Log.debug(`buildWorkflowInstance: created inst:${instance.id.slice(0, 8)}`);

    // Broadcast summary updates whenever this instance's execution state changes.
    // This covers both active and inactive workflows so the multi-workflow list
    // stays in sync regardless of which workflow is currently displayed.
    instance.promptQueue.onDidChangeState((state) => {
      const summary = instance.getSummary();

      Log.debug(
        `[onDidChangeState] inst:${instance.id.slice(0, 8)} state=${state.status} name="${summary.workflowName || "(empty)"}" ` +
          `inRegistry=${this.workflows.has(instance.id)} registrySize=${this.workflows.size} ` +
          `fp=${summary.filePath ? path.basename(summary.filePath) : "?"} step=${workflowDisplayStep(summary)}/${summary.totalSteps}`
      );

      // Register in the running/paused registry the first time this instance
      // becomes RUNNING or PAUSED.  Doing this here (rather than eagerly in
      // executeWorkflow) guarantees that getWorkflowSummaries() never returns
      // an IDLE workflow and that notifyWorkflowAdded() always fires with an
      // accurate RUNNING/PAUSED state — eliminating the race condition where a
      // GET_WORKFLOWS_LIST request processed before promptQueue.start() would
      // return an IDLE summary that the webview filter drops, incorrectly
      // clearing loadedWorkflows.
      if (
        (state.status === EXECUTION_STATES.RUNNING ||
          state.status === EXECUTION_STATES.PAUSED) &&
        !this.workflows.has(instance.id)
      ) {
        this.workflows.set(instance.id, instance);
        Log.debug(
          `onDidChangeState: registered inst:${instance.id.slice(0, 8)} in running registry on ${state.status} ` +
            `name="${summary.workflowName || "(empty)"}" (total: ${this.workflows.size})`
        );
        this.dashboardProvider?.notifyWorkflowAdded(summary);
      }

      this.dashboardProvider?.notifyWorkflowSummaryUpdated(summary);

      // Auto-retire when a workflow completes, errors, or stops.
      // All dashboard messages (notifyWorkflowSummaryUpdated) have already been
      // sent synchronously above, so there's nothing to wait for.
      // Guard with has() — workflows restored from disk in a terminal state are
      // never registered in this.workflows, so there's nothing to retire.
      if (
        this.workflows.has(instance.id) &&
        (state.status === EXECUTION_STATES.COMPLETED ||
          state.status === EXECUTION_STATES.ERROR ||
          state.status === EXECUTION_STATES.STOPPED)
      ) {
        Log.debug(
          `onDidChangeState: inst:${instance.id.slice(0, 8)} terminal state ${state.status} — retiring immediately`
        );
        this.retireWorkflow(instance.id);
      }
    });

    return instance;
  }

  private getDefaultIntegration(): HarnessIntegration {
    return this.resolveDetectorIntegration(undefined);
  }

  /**
   * Return the DETECTOR singleton for the given harness (or the default harness if none).
   * Used for pre-flight status checks and harness availability UI only.
   * Never used for execution — execution integrations are created per-run via IntegrationFactory.
   */
  private resolveDetectorIntegration(
    harnessOverride?: Harness
  ): HarnessIntegration {
    const harness = harnessOverride ?? ConfigurationUtils.getIntegrationMode();
    switch (harness) {
      case Harness.CopilotChat:
        return this.chatIntegration;
      case Harness.ClaudeCli:
        return this.claudeCliIntegration;
      case Harness.CodexCli:
        return this.codexCliIntegration;
      case Harness.OpenCodeCli:
        return this.openCodeCliIntegration;
      case Harness.CopilotCli:
      default:
        return this.copilotCliIntegration;
    }
  }

  private propagateWorkflowNameToIntegrations(name: string | undefined): void {
    this.copilotCliIntegration.setWorkflowName(name);
    this.claudeCliIntegration.setWorkflowName(name);
    this.codexCliIntegration.setWorkflowName(name);
    this.openCodeCliIntegration.setWorkflowName(name);
  }

  private updateStatusBar(): void {
    const activeInstance = this.getActiveInstance();
    const state = activeInstance.getQueueState();
    const harnessStatus = this.getDefaultIntegration().getDetailedStatus();
    this.statusBarManager.updateStatusBar(state, harnessStatus);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CLI Watch Mode
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Normalize stale locks and set up watchers for any active CLI-managed workflows.
   * Called during initialize() after harness initialization.
   */
  private async setupCliWatching(): Promise<void> {
    const workspaceFolderPath = this.currentWorkspaceFolder?.uri.fsPath;
    if (!workspaceFolderPath) {
      return;
    }

    const queueDir = path.join(
      workspaceFolderPath,
      PATH_CONSTANTS.FLIGHTPATH_DIR,
      PATH_CONSTANTS.QUEUE_DIR
    );

    // Normalize stale locks and get active-cli paths
    let activeCliPaths: string[];
    try {
      activeCliPaths = await WorkflowLockManager.normalizeStaleLocks(queueDir);
    } catch (err) {
      Log.warn(
        "[WorkflowOrchestrator] setupCliWatching: normalizeStaleLocks failed:",
        err
      );
      activeCliPaths = [];
    }

    // Create CliWatchSession for each active-cli workflow (Entry Point 1)
    for (const workingFilePath of activeCliPaths) {
      await this.startCliWatchSession(workingFilePath, workspaceFolderPath);
    }

    // Entry Point 3: Watch for new *.runner.json files created while VS Code is open
    this.setupRunnerJsonCreateWatcher(workspaceFolderPath, queueDir);
  }

  /**
   * Watch for new *.runner.json files so we detect when the CLI starts a workflow
   * while VS Code is already open.
   */
  private setupRunnerJsonCreateWatcher(
    workspaceFolderPath: string,
    queueDir: string
  ): void {
    const queueRelative = path
      .relative(workspaceFolderPath, queueDir)
      .replace(/\\/g, "/");
    const pattern = new vscode.RelativePattern(
      workspaceFolderPath,
      `${queueRelative}/*.runner.json`
    );
    this.runnerJsonCreateWatcher =
      vscode.workspace.createFileSystemWatcher(pattern);

    this.runnerJsonCreateWatcher.onDidCreate(async (uri) => {
      Log.debug(
        `[WorkflowOrchestrator] runner.json created: ${path.basename(uri.fsPath)}`
      );
      await this.handleRunnerJsonEvent(uri.fsPath, workspaceFolderPath);
    });

    // Fallback for Windows: atomic file creation via rename (writeFile+rename)
    // may deliver a "change" event instead of "create". CLI heartbeats (every 5s)
    // also use atomic rename, so this fires ~5s after CLI start at the latest.
    this.runnerJsonCreateWatcher.onDidChange(async (uri) => {
      Log.trace(
        `[WorkflowOrchestrator] runner.json changed: ${path.basename(uri.fsPath)}`
      );
      await this.handleRunnerJsonEvent(uri.fsPath, workspaceFolderPath);
    });
  }

  private async handleRunnerJsonEvent(
    lockFilePath: string,
    workspaceFolderPath: string
  ): Promise<void> {
    // Read and validate the lock file
    let lock: WorkflowRunnerLock;
    try {
      const content = await fs.promises.readFile(lockFilePath, "utf8");
      lock = JSON.parse(content) as WorkflowRunnerLock;
    } catch (err) {
      Log.debug(
        `[WorkflowOrchestrator] handleRunnerJsonEvent: skipping "${path.basename(lockFilePath)}" — unreadable/mid-write: ${(err as NodeJS.ErrnoException).code ?? err}`
      );
      return;
    }

    if (lock.runner !== "cli") {
      return;
    }

    // Derive the working file path from the lock path
    const workingFilePath = lockFilePath.replace(
      /\.runner\.json$/,
      ".flightpath.json"
    );

    // Check if there is already an active CliWatchSession for this workflow
    const workflowId = path
      .basename(workingFilePath)
      .replace(/\.flightpath\.json$/, "");

    Log.debug(
      `[WorkflowOrchestrator] handleRunnerJsonEvent: CLI lock detected for "${workflowId}" pid=${lock.pid} heartbeat=${lock.lastHeartbeat}`
    );

    if (this.cliSessions.has(workflowId)) {
      Log.debug(
        `[WorkflowOrchestrator] handleRunnerJsonEvent: session already exists for "${workflowId}" — skipping`
      );
      return;
    }

    // Verify the lock is truly active before creating a session
    const status = await WorkflowLockManager.checkLock(workingFilePath);
    if (status !== LOCK_STATUS.ACTIVE_CLI) {
      Log.debug(
        `[WorkflowOrchestrator] handleRunnerJsonEvent: lock status is "${status}" for "${workflowId}" — skipping`
      );
      return;
    }

    await this.startCliWatchSession(workingFilePath, workspaceFolderPath);
  }

  /**
   * Create and start a CliWatchSession for a CLI-managed workflow.
   * Reads the working file, builds a WorkflowSummary, and registers the session.
   */
  private async startCliWatchSession(
    workingFilePath: string,
    workspaceFolderPath: string
  ): Promise<void> {
    const workflowId = path
      .basename(workingFilePath)
      .replace(/\.flightpath\.json$/, "");

    // Retire any existing VS Code WorkflowInstance tracking this same working file.
    // This prevents a conflict where VS Code auto-loaded the workflow in PAUSED state
    // and the CLI is now taking over execution. Without this, the PAUSED instance
    // stays in the Running Workflows section alongside the CLI watch session.
    for (const [instanceId, instance] of [...this.workflows.entries()]) {
      if (instance.getSummary().workingFilePath === workingFilePath) {
        Log.info(
          `[WorkflowOrchestrator] startCliWatchSession: retiring conflicting WorkflowInstance inst:${instanceId.slice(0, 8)} for "${workflowId}"`
        );
        this.retireWorkflow(instanceId);
        break;
      }
    }

    // Read working file to build initial summary
    let workingFile: {
      workflowName?: string;
      startedAt?: number;
      prompts?: unknown[];
      _runtime?: { currentIndex?: number; executionState?: string };
    };
    try {
      const content = await fs.promises.readFile(workingFilePath, "utf8");
      workingFile = JSON.parse(content);
    } catch (err) {
      Log.warn(
        `[WorkflowOrchestrator] startCliWatchSession: failed to read working file "${path.basename(workingFilePath)}":`,
        err
      );
      return;
    }

    const currentIndex = workingFile._runtime?.currentIndex ?? 0;
    const totalSteps = workingFile.prompts?.length ?? 0;

    const summary: WorkflowSummary = {
      id: workflowId,
      workflowName: workingFile.workflowName ?? workflowId,
      filePath: workingFilePath,
      workingFilePath,
      executionState: EXECUTION_STATES.RUNNING,
      currentStep: currentIndex,
      totalSteps,
      startedAt: workingFile.startedAt,
      managedBy: "cli",
    };

    const session = new CliWatchSession(
      workingFilePath,
      workflowId,
      workspaceFolderPath,
      (partialSummary) => {
        // Merge partial update into stored summary
        const entry = this.cliSessions.get(workflowId);
        if (!entry) {
          return;
        }
        const prevTotalSteps = entry.summary.totalSteps;
        const updatedSummary: WorkflowSummary = {
          ...entry.summary,
          ...partialSummary,
          managedBy: "cli",
        };
        entry.summary = updatedSummary;
        this.dashboardProvider?.notifyWorkflowSummaryUpdated(updatedSummary);

        // If the CLI extended the queue, send the new prompts so the PromptsPanel reflects them
        if (
          updatedSummary.totalSteps > prevTotalSteps &&
          this.dashboardProvider
        ) {
          const provider = this.dashboardProvider;
          fs.promises
            .readFile(workingFilePath, "utf8")
            .then((content) => {
              const wf = JSON.parse(content) as { prompts?: unknown[] };
              if (wf.prompts) {
                Log.debug(
                  `[WorkflowOrchestrator] CLI extended queue for "${workflowId}": ${prevTotalSteps} → ${updatedSummary.totalSteps} steps`
                );
                provider.notifyCliPromptsExtended(workflowId, wf.prompts);
              }
            })
            .catch((err) => {
              Log.warn(
                `[WorkflowOrchestrator] onUpdate: failed to read working file for queue extension:`,
                err
              );
            });
        }
      },
      (historyFilePath) => {
        this.handleCliWatchOutput(workflowId, historyFilePath);
      },
      () => {
        this.handleCliSessionFinished(workflowId, workingFilePath);
      }
    );

    this.cliSessions.set(workflowId, { session, summary });
    await session.start();

    // Notify the dashboard so the workflow appears in the Running section
    this.dashboardProvider?.notifyWorkflowAdded(summary);
    Log.info(
      `[WorkflowOrchestrator] CLI watch session started for "${workflowId}"`
    );
  }

  /**
   * Send full workflow state to the dashboard when switching to a CLI-managed workflow.
   * Sends SESSION_RESTORED with the current prompts, then replays all captured outputs.
   */
  private async sendCliWorkflowFullStateToDashboard(
    workflowId: string,
    cliEntry: { session: CliWatchSession; summary: WorkflowSummary }
  ): Promise<void> {
    const workingFilePath = cliEntry.summary.workingFilePath;
    if (!workingFilePath) {
      return;
    }

    // Read the latest working file to get current prompt list and step position
    let prompts: PromptItem[] = [];
    let currentIndex = cliEntry.summary.currentStep ?? 0;
    let finalPrompt: PromptItem | null = null;
    let finalPromptRuntime:
      | {
          status?: StepStatus;
          loopCount: number;
          phase: "queue" | "finalPrompt";
        }
      | undefined;

    try {
      const content = await fs.promises.readFile(workingFilePath, "utf8");
      const workingFile = JSON.parse(content) as WorkingFile;
      prompts = ((workingFile.prompts as PromptItem[]) ?? []).map((p) => ({
        ...p,
        // Strip any existing status so loadWorkflow sets it from the results array
        status: undefined as unknown as string,
      }));
      currentIndex = workingFile._runtime?.currentIndex ?? currentIndex;
      finalPrompt = (workingFile.finalPrompt as PromptItem | undefined) ?? null;
      finalPromptRuntime = workingFile._runtime?.finalPrompt
        ? {
            status: workingFile._runtime.finalPrompt.status,
            loopCount: workingFile._runtime.finalPrompt.loopCount,
            phase: workingFile._runtime.finalPrompt.phase,
          }
        : undefined;
    } catch (err) {
      Log.warn(
        `[WorkflowOrchestrator] sendCliWorkflowFullStateToDashboard: could not read working file:`,
        err
      );
    }

    // Derive step statuses from current position:
    //   < currentIndex  → completed
    //   = currentIndex  → running
    //   > currentIndex  → pending
    const results = prompts.map((_, i) => ({
      status:
        i < currentIndex
          ? STEP_STATUS.COMPLETED
          : i === currentIndex
            ? STEP_STATUS.RUNNING
            : STEP_STATUS.PENDING,
    }));

    const fileName = path.basename(workingFilePath);
    await this.dashboardProvider?.updateSessionRestored(
      fileName,
      prompts,
      results,
      cliEntry.summary.executionState,
      currentIndex,
      cliEntry.summary.workflowName,
      finalPrompt,
      finalPromptRuntime
    );

    // Replay all captured CLI outputs from the active history file
    const historyFilePath = cliEntry.session.getActiveHistoryFilePath();
    if (historyFilePath) {
      await this.replayCliWatchHistoryFile(workflowId, historyFilePath);
    }
  }

  /**
   * Replay all captured CLI outputs from a history file to the dashboard.
   * Updates lastKnownOutputByStep so subsequent incremental updates don't re-send.
   */
  private async replayCliWatchHistoryFile(
    workflowId: string,
    historyFilePath: string
  ): Promise<void> {
    const entry = this.cliSessions.get(workflowId);
    if (!entry) {
      return;
    }

    try {
      const content = await fs.promises.readFile(historyFilePath, "utf8");
      const history = JSON.parse(content) as {
        promptOutputs: Record<string, { cliOutputs: Array<unknown> }>;
      };

      for (const [stepIndexStr, stepOutput] of Object.entries(
        history.promptOutputs
      )) {
        const stepIndex = parseInt(stepIndexStr, 10);
        const outputs = stepOutput.cliOutputs ?? [];

        // Update lastKnown so subsequent incremental handleCliWatchOutput calls
        // don't re-send these outputs
        entry.session.getAndUpdateLastKnownOutputCount(
          stepIndex,
          outputs.length
        );

        // Send ALL outputs from the beginning (full replay, not diff)
        for (let i = 0; i < outputs.length; i++) {
          this.dashboardProvider?.notifyCliWatchOutput(
            workflowId,
            stepIndex,
            outputs[i] as Parameters<
              FlightPathWebviewProvider["notifyCliWatchOutput"]
            >[2]
          );
        }
      }
    } catch (err) {
      Log.warn(
        `[WorkflowOrchestrator] replayCliWatchHistoryFile: failed to read history file:`,
        err
      );
    }
  }

  /**
   * Handle output change notifications from a CliWatchSession.
   * Reads the history file and sends new outputs to the dashboard.
   */
  private handleCliWatchOutput(
    workflowId: string,
    historyFilePath: string
  ): void {
    const entry = this.cliSessions.get(workflowId);
    if (!entry) {
      return;
    }

    fs.promises
      .readFile(historyFilePath, "utf8")
      .then((content) => {
        const history = JSON.parse(content) as {
          promptOutputs: Record<string, { cliOutputs: Array<unknown> }>;
        };

        for (const [stepIndexStr, stepOutput] of Object.entries(
          history.promptOutputs
        )) {
          const stepIndex = parseInt(stepIndexStr, 10);
          const outputs = stepOutput.cliOutputs ?? [];
          const lastKnown = entry.session.getAndUpdateLastKnownOutputCount(
            stepIndex,
            outputs.length
          );

          // Send only new outputs
          for (let i = lastKnown; i < outputs.length; i++) {
            this.dashboardProvider?.notifyCliWatchOutput(
              workflowId,
              stepIndex,
              outputs[i] as Parameters<
                FlightPathWebviewProvider["notifyCliWatchOutput"]
              >[2]
            );
          }
        }
      })
      .catch((err) => {
        Log.warn(
          `[WorkflowOrchestrator] handleCliWatchOutput: failed to read history file:`,
          err
        );
      });
  }

  /**
   * Handle CLI session completion (lock deleted or heartbeat stale).
   * Reads the final working file state, normalizes if needed, and updates the dashboard.
   */
  private handleCliSessionFinished(
    workflowId: string,
    workingFilePath: string
  ): void {
    const entry = this.cliSessions.get(workflowId);
    if (!entry) {
      return;
    }

    Log.info(`[WorkflowOrchestrator] CLI session finished for "${workflowId}"`);

    // Dispose the session first so watchers stop firing
    entry.session.dispose();
    this.cliSessions.delete(workflowId);

    // Read final working file state
    fs.promises
      .readFile(workingFilePath, "utf8")
      .then(async (content) => {
        const workingFile = JSON.parse(content) as {
          _runtime?: { executionState?: string; currentIndex?: number };
          prompts?: unknown[];
          workflowName?: string;
          startedAt?: number;
        };

        let finalState = workingFile._runtime?.executionState ?? "stopped";

        // If still shows "running", normalize to "stopped" on disk
        if (finalState === "running") {
          finalState = "stopped";
          if (workingFile._runtime) {
            workingFile._runtime.executionState = "stopped";
          }
          try {
            const tmpPath = workingFilePath + ".tmp";
            await fs.promises.writeFile(
              tmpPath,
              JSON.stringify(workingFile, null, 2),
              "utf8"
            );
            await fs.promises.rename(tmpPath, workingFilePath);
          } catch (writeErr) {
            Log.warn(
              `[WorkflowOrchestrator] handleCliSessionFinished: failed to normalize working file:`,
              writeErr
            );
          }
        }

        const finalSummary: WorkflowSummary = {
          ...entry.summary,
          executionState: finalState as WorkflowSummary["executionState"],
          currentStep:
            workingFile._runtime?.currentIndex ?? entry.summary.currentStep,
          totalSteps: workingFile.prompts?.length ?? entry.summary.totalSteps,
          managedBy: undefined, // no longer CLI-managed
        };

        // Update the dashboard: send final state then dismiss from Running section
        this.dashboardProvider?.notifyWorkflowSummaryUpdated(finalSummary);
        this.dashboardProvider?.notifyWorkflowDismissed(workflowId);

        void this.saveState();
      })
      .catch((err) => {
        Log.warn(
          `[WorkflowOrchestrator] handleCliSessionFinished: failed to read working file:`,
          err
        );
        // Still dismiss from the dashboard
        this.dashboardProvider?.notifyWorkflowDismissed(workflowId);
      });
  }
}
