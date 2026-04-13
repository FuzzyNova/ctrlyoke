import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { HarnessIntegration, HarnessStatus } from "./HarnessIntegration";
import { CopilotChatIntegration } from "./harness/chat/CopilotChatIntegration";
import { CliIntegration } from "./harness/CliIntegration";
import { VsCodeIntegrationFactory } from "./VsCodeIntegrationFactory";
import { WorkflowInstance } from "./WorkflowInstance";
import type { FlightPathMcpServerProvider } from "../ui/FlightPathMcpServerProvider";
import { PromptQueue } from "./PromptQueue";
import {
  Harness,
  QueueState,
  WorkingFile,
  WorkflowSummary,
  WorkflowRunnerLock,
  EXECUTION_STATES,
  STEP_STATUS,
  type PromptStep,
  type WorkflowStep,
  workflowDisplayStep,
} from "../types/FlightPathTypes";
import {
  ACTION_TYPES,
  HARNESS_IDS,
  LOCK_STATUS,
  FINAL_STEP_PHASES,
  OUTPUT_HISTORY_KINDS,
  MESSAGE_TYPES,
  PANEL_CLIENT_ID,
  TERMINAL_SESSION_STATUS,
  type QueuePosition,
  type ActionType,
  type StepStatus,
  type FinalStepPhase,
} from "../types/DashboardConstants";
import type { IDashboardSink } from "../types/IDashboardSink";
import { PostMessageDashboardSink } from "../ui/PostMessageDashboardSink";
import type { CliOutput } from "../types/WebviewMessageTypes";
import { StatusBarManager } from "../ui/StatusBarManager";
import { Log } from "../utils/Log";
import { getErrorMessage } from "../utils/ErrorUtils";
import {
  ConfigurationUtils,
  PATH_CONSTANTS,
} from "../utils/ConfigurationUtils";
import { OutputHistoryManager } from "./orchestration/OutputHistoryManager";
import { EndConditionEvaluator } from "./EndConditionEvaluator";
import { WorkflowLockManager } from "../utils/WorkflowLockManager";
import { CliWatchSession } from "./orchestration/CliWatchSession";
import { getPtyProcessManager } from "./harness/PtyProcessManager";

// Orchestration classes that remain at orchestrator level
import { TemplateImporter } from "./orchestration/TemplateImporter";
import { WorkflowCommandHandler } from "./orchestration/WorkflowCommandHandler";
import { WorkspaceSessionManager } from "./orchestration/WorkspaceSessionManager";
import { PromptFileParser } from "./PromptFileParser";
import { VsCodeAdapter } from "../platform/VsCodeAdapter";
import {
  DashboardBroadcastHub,
  type DashboardClient,
} from "../ui/DashboardBroadcastHub";

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

  /** Instance registry — running/paused instances plus idle instances loaded via browser client.
   * Keyed by WorkflowInstance.id (UUID). */
  private readonly instances: Map<string, WorkflowInstance> = new Map();

  /** CLI-managed workflows being watched (keyed by workflowId) */
  private readonly cliSessions: Map<
    string,
    { session: CliWatchSession; summary: WorkflowSummary }
  > = new Map();

  /** Watcher for *.runner.json creation (Entry Point 3: CLI starts while VS Code is open) */
  private runnerJsonCreateWatcher?: vscode.FileSystemWatcher;

  private readonly PANEL_CLIENT_ID = PANEL_CLIENT_ID;

  /** Stored send function for the VS Code panel — set when the panel connects via setDashboardReady. */
  private storedPanelSend?: (msg: unknown) => void;

  /** Called once after the startup auto-load (including deferred loads) completes. */
  private storedPostAutoLoadCallback?: () => Promise<void>;

  /**
   * Resolves to the loaded workflow ID (or null if no session was found) once
   * triggerAutoLoad() completes. Browser clients await this instead of
   * registering pending callbacks, eliminating the startup race condition.
   */
  private readonly startupAutoLoadSettled: Promise<string | null>;
  private resolveStartupAutoLoad!: (id: string | null) => void;
  /** True once startupAutoLoadSettled has been resolved (set in triggerAutoLoad finally). */
  private _autoLoadHasSettled: boolean = false;

  /** Per-client viewer registry: maps clientId → viewed workflowId (or null). */
  private viewerRegistry = new Map<string, string | null>();

  /** Retired instances keyed by workflowId — held until no client views them. */
  private retiredInstances = new Map<string, WorkflowInstance>();

  // ─────────────────────────────────────────────────────────────────────────
  // Cross-cutting concerns
  // ─────────────────────────────────────────────────────────────────────────
  private readonly dashboardBroadcastHub = new DashboardBroadcastHub();
  private readonly integrationFactory: VsCodeIntegrationFactory;
  private readonly statusBarManager: StatusBarManager;
  private currentWorkspaceFolder: vscode.WorkspaceFolder | undefined;

  // Harness integrations — created once at startup
  private readonly copilotCliIntegration: CliIntegration;
  private readonly chatIntegration: CopilotChatIntegration;
  private readonly claudeCliIntegration: CliIntegration;
  private readonly codexCliIntegration: CliIntegration;
  private readonly openCodeCliIntegration: CliIntegration;
  private readonly qwenCliIntegration: CliIntegration;
  private readonly geminiCliIntegration: CliIntegration;

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
  /** Guards triggerStartupAutoLoadIfReady so triggerAutoLoad fires at most once. */
  private startupAutoLoadTriggered: boolean = false;

  /** MCP server provider for injecting user-defined MCP servers into VS Code (chat harness only) */
  private mcpServerProvider?: FlightPathMcpServerProvider;

  constructor(
    private readonly context: vscode.ExtensionContext,
    dashboardProvider?: DashboardClient
  ) {
    // Create the startup auto-load promise — browser clients await this instead
    // of registering pending callbacks, eliminating the startup race condition.
    this.startupAutoLoadSettled = new Promise((resolve) => {
      this.resolveStartupAutoLoad = resolve;
    });

    this.viewerRegistry.set(this.PANEL_CLIENT_ID, null);

    if (dashboardProvider) {
      this.dashboardBroadcastHub.addClient(dashboardProvider);
    }
    this.integrationFactory = new VsCodeIntegrationFactory(
      new VsCodeAdapter(context)
    );

    // Create the four shared harness integrations
    this.copilotCliIntegration = this.integrationFactory.createCopilotCli();
    this.chatIntegration = this.integrationFactory.createCopilotChat();
    this.claudeCliIntegration = this.integrationFactory.createClaudeCli();
    this.codexCliIntegration = this.integrationFactory.createCodexCli();
    this.openCodeCliIntegration = this.integrationFactory.createOpenCodeCli();
    this.qwenCliIntegration = this.integrationFactory.createQwenCli();
    this.geminiCliIntegration = this.integrationFactory.createGeminiCli();

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
      [HARNESS_IDS.QWEN_CLI, this.qwenCliIntegration],
      [HARNESS_IDS.GEMINI_CLI, this.geminiCliIntegration],
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
            this.dashboardBroadcastHub.notifyHarnessAvailability(
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
  // Dashboard provider registry
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Register an additional dashboard client to receive orchestrator and
   * workflow-instance updates.
   */
  public addDashboardProvider(provider: DashboardClient): void {
    this.dashboardBroadcastHub.addClient(provider);
  }

  public removeDashboardProvider(provider: DashboardClient): void {
    this.dashboardBroadcastHub.removeClient(provider);
  }

  public getDashboardBroadcastHub(): DashboardBroadcastHub {
    return this.dashboardBroadcastHub;
  }

  /** Set the MCP server provider for injecting user-defined MCP servers (chat harness) */
  public setMcpServerProvider(provider: FlightPathMcpServerProvider): void {
    this.mcpServerProvider = provider;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Instance registry management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Creates a fresh WorkflowInstance and makes it the active workflow.
   * Phase 2: adds it alongside existing instances without clearing the registry.
   */
  private async createWorkflow(
    _filePath?: string
  ): Promise<WorkflowInstance | undefined> {
    const currentPanelId = this.getViewedWorkflowId(this.PANEL_CLIENT_ID);
    Log.debug(
      `createWorkflow: filePath="${_filePath ?? "(none)"}", currently viewed=${currentPanelId?.slice(0, 8) ?? "null"}, running=${this.instances.size}`
    );
    // ── Duplicate detection: only running/paused instances are in the Map ──
    if (_filePath) {
      const existing = [...this.instances.values()].find(
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
            const panelSend = this.storedPanelSend ?? ((_: unknown) => {});
            await this.replayWorkflowStateTo(
              existing.id,
              panelSend,
              this.PANEL_CLIENT_ID
            );
            return existing;
          }
          // Fall through to create new instance
        }
      }
    }

    // Dispose/deactivate the current panel-viewed instance if applicable
    const retiredInstance = currentPanelId
      ? this.retiredInstances.get(currentPanelId)
      : null;
    const currentViewed = currentPanelId
      ? (this.instances.get(currentPanelId) ?? retiredInstance)
      : null;
    if (retiredInstance) {
      Log.debug(
        `createWorkflow: disposing retired viewedInstance inst:${retiredInstance.id.slice(0, 8)}`
      );
      retiredInstance.dispose();
      this.retiredInstances.delete(currentPanelId!);
    } else if (currentViewed) {
      const viewedStatus = currentViewed.getQueueState().status;
      const isIdle =
        viewedStatus !== EXECUTION_STATES.RUNNING &&
        viewedStatus !== EXECUTION_STATES.PAUSED;
      if (isIdle) {
        Log.debug(
          `createWorkflow: disposing idle viewedInstance inst:${currentViewed.id.slice(0, 8)}`
        );
        currentViewed.dispose();
        this.instances.delete(currentPanelId!);
      } else {
        // It is running/paused — keep it in the registry but do not deactivate
        Log.debug(
          `createWorkflow: keeping running viewedInstance inst:${currentViewed.id.slice(0, 8)} in registry`
        );
      }
    }

    const instance = this.buildWorkflowInstance();
    this.setViewedWorkflowId(this.PANEL_CLIENT_ID, instance.id);
    this.instances.set(instance.id, instance);
    if (_filePath) {
      await instance.loadPromptFile(_filePath);
    }

    // Deliver full state to the panel via per-client replay (sends ACTIVE_WORKFLOW_CHANGED first,
    // then SESSION_RESTORED with current state). If the panel is not yet connected, it will
    // receive the state when it connects via the READY → handleClientReady path.
    if (this.storedPanelSend) {
      await this.replayWorkflowStateTo(
        instance.id,
        this.storedPanelSend,
        this.PANEL_CLIENT_ID
      );
    }

    return instance;
  }

  /**
   * Silently retire a workflow from the registry — no confirmation, no stop prompts.
   * Called automatically when a workflow reaches COMPLETED, ERROR, or STOPPED state.
   */
  private retireWorkflow(workflowId: string): void {
    const instance = this.instances.get(workflowId);
    if (!instance) {
      Log.debug(
        `retireWorkflow: inst:${workflowId.slice(0, 8)} not in registry (already retired?)`
      );
      return;
    }

    const isViewed = this.isWorkflowViewedByAnyClient(workflowId);
    const ptyManager = getPtyProcessManager();
    const activePtySessions = ptyManager
      ? ptyManager
          .getSessionsForWorkflow(workflowId)
          .filter((s) => s.status === TERMINAL_SESSION_STATUS.RUNNING)
      : [];
    const hasActivePty = activePtySessions.length > 0;
    Log.debug(
      `retireWorkflow: inst:${workflowId.slice(0, 8)} name=\"${instance.workflowName || "(empty)"}\" ` +
        `status=${instance.getQueueState().status}, isViewed=${isViewed}, hasActivePty=${hasActivePty}(${activePtySessions.length}), remaining=${this.instances.size - 1}`
    );
    this.instances.delete(workflowId);

    if (isViewed || hasActivePty) {
      // Keep in retiredInstances if a client is still viewing it OR if PTY sessions remain
      // alive. In the latter case, the user may switch back to this workflow and expect to
      // see (and interact with) the still-running terminal. Each client's entry is cleaned
      // up when the client switches away or disconnects; PTY-only entries are cleaned up
      // when the last PTY session exits (via onExit → replayWorkflowStateTo finding 0 sessions
      // → no TERMINAL_STARTED sent → TerminalInstance unmount → nothing holds the entry).
      this.retiredInstances.set(workflowId, instance);
    } else {
      // Background workflow completed silently with no active terminals — dispose immediately.
      instance.dispose();
    }

    // Remove from the Running Workflows section in the dashboard.
    this.dashboardBroadcastHub.notifyWorkflowDismissed(workflowId);

    void this.saveState();
  }

  getWorkflow(workflowId: string): WorkflowInstance | undefined {
    return this.findInstance(workflowId);
  }

  getAllWorkflows(): WorkflowInstance[] {
    return [...this.instances.values()];
  }

  getRunningWorkflows(): WorkflowInstance[] {
    return [...this.instances.values()].filter(
      (w) => w.getQueueState().status === EXECUTION_STATES.RUNNING
    );
  }

  getActiveWorkflow(): WorkflowInstance | undefined {
    const id = this.getViewedWorkflowId(this.PANEL_CLIENT_ID);
    if (id) {
      return (
        this.instances.get(id) ?? this.retiredInstances.get(id) ?? undefined
      );
    }
    return undefined;
  }

  getActiveWorkflowId(): string | null {
    return this.getViewedWorkflowId(this.PANEL_CLIENT_ID);
  }

  /**
   * Replay the full state of a specific workflow to a single client's send
   * function without changing the global active workflow or broadcasting to
   * other clients. Used by SWITCH_WORKFLOW from external WebSocket clients
   * so each browser tab can view a different workflow independently.
   *
   * @param options.skipTerminalReplay - When true, omit TERMINAL_STARTED and
   *   reconnect-buffer TERMINAL_OUTPUT messages. Pass this for workflow
   *   *switches* (both panel and browser) where the xterm.js registry is
   *   already intact, and for the panel's setDashboardReady path where the
   *   READY handler's dedicated PTY reconnect loop sends terminals.
   *   Leave false (default) for initial client connections and reloads where
   *   the client's xterm registry has been wiped.
   */
  async replayWorkflowStateTo(
    workflowId: string,
    send: (msg: unknown) => void,
    clientId: string,
    options?: { skipTerminalReplay?: boolean }
  ): Promise<void> {
    const sink = new PostMessageDashboardSink(send);

    // Check live instances first, then retired (terminal-state workflows that were
    // loaded for viewing — e.g. completed workflows selected from recent list).
    const inLive = this.instances.has(workflowId);
    const inRetired = this.retiredInstances.has(workflowId);
    Log.debug(
      `[replayWorkflowStateTo] inst:${workflowId.slice(0, 8)} clientId=${clientId.slice(0, 12)} ` +
        `skipTerminalReplay=${options?.skipTerminalReplay ?? false} ` +
        `inLive=${inLive} inRetired=${inRetired}`
    );
    const instance =
      this.instances.get(workflowId) ?? this.retiredInstances.get(workflowId);
    if (instance) {
      send({ type: MESSAGE_TYPES.ACTIVE_WORKFLOW_CHANGED, workflowId });
      instance.replayFullStateTo(sink);
      await instance.replayRunHistoryTo(sink);
      await instance.replayOutputHistoryTo(send);
      // Replay active terminal sessions to the client so it can render the live
      // terminal. Only needed for initial connections and reloads where the
      // client's xterm.js registry has been wiped. Callers that know the client's
      // registry is intact (workflow switches, panel setDashboardReady) pass
      // skipTerminalReplay: true so we don't clear and dispose live xtermjs
      // instances that already hold the correct scrollback.
      if (!options?.skipTerminalReplay) {
        const ptyManager = getPtyProcessManager();
        if (ptyManager) {
          const sessionsForWorkflow = ptyManager.getSessionsForWorkflow(workflowId);
          Log.debug(
            `[replayWorkflowStateTo] terminal replay for inst:${workflowId.slice(0, 8)} — ` +
              `found ${sessionsForWorkflow.length} PTY session(s): ` +
              `[${sessionsForWorkflow.map((s) => `${s.id.slice(0, 8)}(status=${s.status},kind=${s.kind})`).join(", ") || "none"}]`
          );
          for (const session of sessionsForWorkflow) {
            // Auto-assign controller to the first client to reconnect for this session
            if (session.controllerClientId === undefined) {
              session.controllerClientId = clientId;
            }
            Log.debug(
              `[replayWorkflowStateTo] sending TERMINAL_STARTED for session ${session.id.slice(0, 8)} ` +
                `kind=${session.kind} controllerClientId=${session.controllerClientId?.slice(0, 12) ?? "none"} ` +
                `reconnectBuffer=${session.reconnectBuffer.length} chunks`
            );
            send({
              type: MESSAGE_TYPES.TERMINAL_STARTED,
              workflowId: session.workflowId,
              sessionId: session.id,
              stepName: session.stepName,
              kind: session.kind,
              promptNumber: session.promptNumber,
              harnessId: session.harnessId,
              controllerClientId: session.controllerClientId,
            });
            // Immediately follow with current PTY dimensions so viewers can match
            // the controller's width without waiting for the next resize event.
            // session.pty.cols reflects the controller's most recent TERMINAL_RESIZE.
            send({
              type: MESSAGE_TYPES.TERMINAL_SIZE_CHANGED,
              workflowId: session.workflowId,
              sessionId: session.id,
              cols: session.pty.cols,
              rows: session.pty.rows,
            });
            for (const chunk of session.reconnectBuffer) {
              send({
                type: MESSAGE_TYPES.TERMINAL_OUTPUT,
                workflowId: session.workflowId,
                sessionId: session.id,
                data: chunk,
              });
            }
          }
        }
      }
      this.setViewedWorkflowId(clientId, workflowId);
      return;
    }

    // CLI-managed session
    const cliEntry = this.cliSessions.get(workflowId);
    if (cliEntry) {
      send({ type: MESSAGE_TYPES.ACTIVE_WORKFLOW_CHANGED, workflowId });
      await this.sendCliWorkflowFullStateToDashboard(
        workflowId,
        cliEntry,
        sink
      );
      this.setViewedWorkflowId(clientId, workflowId);
    } else {
      Log.warn(
        `replayWorkflowStateTo: workflowId "${workflowId.slice(0, 8)}" not found`
      );
    }
  }

  /** Return summaries without exposing WorkflowInstance internals */
  getWorkflowSummaries(): WorkflowSummary[] {
    const vsSummaries = [...this.instances.values()].map((w) => w.getSummary());
    const cliSummaries = [...this.cliSessions.values()].map(
      (entry) => entry.summary
    );
    const summaries = [...vsSummaries, ...cliSummaries];
    Log.trace(
      `[getWorkflowSummaries] registry has ${this.instances.size} instances + ${this.cliSessions.size} CLI sessions, viewed=${this.getViewedWorkflowId(this.PANEL_CLIENT_ID)?.slice(0, 8) ?? "null"}: ${summaries.map((s) => `inst:${s.id.slice(0, 8)}(${s.executionState},fp=${s.filePath ? path.basename(s.filePath) : "?"})`).join(", ") || "(none)"}`
    );
    return summaries;
  }

  /**
   * Load a working file for a specific browser client without changing the VS Code
   * sidebar's active view. Used by LOAD_WORKFLOW from external clients.
   */
  async loadWorkflowForClient(
    filePath: string,
    send: (message: unknown) => void,
    clientId: string
  ): Promise<void> {
    // Parse working file path to get workflowId (used for CLI session lookup)
    const workflowId = path
      .basename(filePath)
      .replace(/\.flightpath\.json$/, "");

    // Check for CLI-managed session first
    const cliEntry = this.cliSessions.get(workflowId);
    if (cliEntry) {
      await this.replayWorkflowStateTo(workflowId, send, clientId);
      return;
    }

    // Check if already in instances registry by working file path
    const existing = [...this.instances.values()].find(
      (w) => w.getSummary().workingFilePath === filePath
    );
    if (existing) {
      this.setViewedWorkflowId(clientId, existing.id);
      await this.replayWorkflowStateTo(existing.id, send, clientId);
      return;
    }

    // Check retired instances (completed/stopped workflows) by working file path.
    // Reuse the existing retired instance so its PTY sessions remain accessible.
    const existingRetired = [...this.retiredInstances.values()].find(
      (w) => w.getSummary().workingFilePath === filePath
    );
    if (existingRetired) {
      this.setViewedWorkflowId(clientId, existingRetired.id);
      await this.replayWorkflowStateTo(existingRetired.id, send, clientId);
      return;
    }

    // Not in registry — load file without touching the panel's viewed workflow.
    // Set viewedId BEFORE loadWorkingFile so retireWorkflow (triggered by terminal
    // state during load) sees isViewed=true and keeps the instance in retiredInstances
    // instead of disposing it immediately.
    const instance = this.buildWorkflowInstance();
    this.instances.set(instance.id, instance);
    this.setViewedWorkflowId(clientId, instance.id);
    await instance.loadWorkingFile(filePath);
    await this.replayWorkflowStateTo(instance.id, send, clientId);
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
          [Harness.QwenCli]: "Qwen Code CLI",
          [Harness.GeminiCli]: "Gemini CLI",
        }[integrationMode] || "Copilot CLI";
      Log.info(`🔄 Default integration: ${modeLabel}`);

      await Promise.all([
        this.copilotCliIntegration.initialize(),
        this.chatIntegration.initialize(),
        this.claudeCliIntegration.initialize(),
        this.codexCliIntegration.initialize(),
        this.openCodeCliIntegration.initialize(),
        this.qwenCliIntegration.initialize(),
        this.geminiCliIntegration.initialize(),
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
        await this.triggerStartupAutoLoadIfReady();
      }
    } catch (error) {
      this.orchestratorInitialized = true;
      Log.error("Failed to initialize WorkflowOrchestrator:", error);
      vscode.window.showErrorMessage(
        `FlightPath: Initialization failed: ${error}`
      );
    }
  }

  /**
   * Register a one-shot callback invoked after the startup auto-load finishes
   * (whether it runs immediately or is deferred until initialization completes).
   * The router uses this to send WORKFLOW_PROPERTIES_UPDATE once the working
   * file path is known.
   */
  setPostAutoLoadCallback(callback: () => Promise<void>): void {
    this.storedPostAutoLoadCallback = callback;
  }

  /**
   * True once the startup auto-load promise has resolved (whether or not a
   * session was found). Browser clients and the panel READY fast-path use this
   * to determine whether STARTUP_COMPLETE needs to be sent directly.
   */
  get isAutoLoadTriggered(): boolean {
    return this._autoLoadHasSettled;
  }

  /**
   * Awaitable version of the startup auto-load result.
   * Resolves to the loaded workflow ID, or null if no session was found.
   * Browser clients await this in the READY handler to eliminate the race
   * condition that existed with the old pending-callback approach.
   */
  awaitStartupAutoLoad(): Promise<string | null> {
    return this.startupAutoLoadSettled;
  }

  /**
   * Returns true if the given client already has a viewed workflow assigned.
   * Used by the READY handler to avoid double-replaying browser clients that
   * handleClientReady already served via the panel's viewedId fallback.
   */
  hasViewedWorkflow(clientId: string): boolean {
    return !!this.getViewedWorkflowId(clientId);
  }

  async setDashboardReady(panelSend?: (msg: unknown) => void): Promise<void> {
    Log.info("✅ Dashboard is ready");
    this.dashboardReady = true;

    if (panelSend) {
      this.storedPanelSend = panelSend;
      // Re-hydrate via targeted replay to the panel (handles webview reloads).
      // Skip terminal replay — the panel READY handler's dedicated PTY reconnect
      // loop sends TERMINAL_STARTED + reconnect buffers after this returns.
      const viewedId = this.getViewedWorkflowId(this.PANEL_CLIENT_ID);
      if (viewedId) {
        await this.replayWorkflowStateTo(
          viewedId,
          panelSend,
          this.PANEL_CLIENT_ID,
          { skipTerminalReplay: true }
        );
      }
    } else {
      // Fallback path when the panel send function is not available (e.g. during tests
      // or before the webview mounts). Re-send run history so any already-connected
      // browser clients see the RunSelector on reconnect.
      const panelId = this.getViewedWorkflowId(this.PANEL_CLIENT_ID);
      const viewed = panelId
        ? (this.instances.get(panelId) ?? this.retiredInstances.get(panelId))
        : null;
      if (viewed) {
        viewed
          .sendRunHistoryToDashboard()
          .catch((err) =>
            Log.warn(`setDashboardReady: failed to send run history: ${err}`)
          );
      }
    }

    if (this.orchestratorInitialized) {
      await this.triggerStartupAutoLoadIfReady();
    } else {
      Log.debug(
        "Orchestrator not yet initialized — deferring auto-load until init completes"
      );
    }
  }

  private async triggerStartupAutoLoadIfReady(): Promise<void> {
    if (
      this.startupAutoLoadTriggered ||
      !this.dashboardReady ||
      !this.orchestratorInitialized
    ) {
      return;
    }

    this.startupAutoLoadTriggered = true;
    await this.triggerAutoLoad();
  }

  private async triggerAutoLoad(): Promise<void> {
    let loadedWorkflowId: string | null = null;
    try {
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
            // Replay full state to the panel (SESSION_RESTORED + ACTIVE_WORKFLOW_CHANGED
            // + RUN_HISTORY_UPDATED + OUTPUT_HISTORY_LOADED). This is required because
            // DashboardBroadcastHub.updateSessionRestored() is a no-op — SESSION_RESTORED
            // is only sent via direct PostMessageDashboardSink (inside replayWorkflowStateTo),
            // never via the hub. Without this call the panel receives no step state and all
            // status icons show as idle/pending even for completed runs.
            const instance = this.getActiveInstance();
            if (this.storedPanelSend) {
              await this.replayWorkflowStateTo(
                instance.id,
                this.storedPanelSend,
                this.PANEL_CLIENT_ID
              );
            }
            if (this.storedPostAutoLoadCallback) {
              await this.storedPostAutoLoadCallback();
              this.storedPostAutoLoadCallback = undefined;
            }
            // Capture the loaded workflow ID so the finally block can resolve
            // the promise and browser clients can replay the correct session.
            loadedWorkflowId = instance.id;
          }
        );
      }
    } finally {
      // Always settle the promise and broadcast STARTUP_COMPLETE, regardless of
      // whether a session was found or an exception occurred. This ensures:
      // - Browser clients awaiting awaitStartupAutoLoad() unblock immediately.
      // - The webview overlay lifts via hub broadcast (panel fresh startup).
      this._autoLoadHasSettled = true;
      this.resolveStartupAutoLoad(loadedWorkflowId);
      this.dashboardBroadcastHub.notifyStartupComplete();
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
    const panelViewedId = this.getViewedWorkflowId(this.PANEL_CLIENT_ID);
    // When a specific workflowId is given, check retiredInstances as a fallback
    // so that restarting a STOPPED/COMPLETED workflow that was just retired works.
    // Remove from retiredInstances first so the instance can re-register in
    // this.instances when execution starts again.
    let instance: WorkflowInstance | null | undefined;
    if (workflowId) {
      instance = this.findInstance(workflowId);
      // If found in retiredInstances, un-retire it so it can re-register in
      // this.instances when it transitions to RUNNING/PAUSED.
      if (instance) {
        this.retiredInstances.delete(workflowId);
      }
    } else {
      instance = panelViewedId ? this.findInstance(panelViewedId) : null;
    }

    if (!instance) {
      Log.warn(`executeWorkflow: workflow ${workflowId ?? "viewed"} not found`);
      return;
    }

    // Note: the instance is registered in this.instances when its promptQueue
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
    Log.debug(
      `executePromptFile: loading "${path.basename(filePath)}" into new instance ` +
        `(${this.instances.size} workflow(s) currently in registry)`
    );
    const panelSend = this.storedPanelSend ?? ((_: unknown) => {});
    await this.createWorkflowForClient(panelSend, this.PANEL_CLIENT_ID);
    const instance = this.getActiveInstance();
    await instance.loadPromptFile(filePath);
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
    const instance = this.instances.get(workflowId);
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
    const instance = this.findInstance(workflowId);
    if (!instance) {
      Log.warn(
        `resumeWorkflow: inst:${workflowId.slice(0, 8)} not found in registry`
      );
      return;
    }
    // If the instance is retired (terminal state reached but still alive),
    // remove it from retiredInstances so it can re-register in this.instances
    // when it transitions to RUNNING/PAUSED via the onDidChangeState listener.
    if (this.retiredInstances.has(workflowId)) {
      this.retiredInstances.delete(workflowId);
    }
    return instance.resume();
  }

  /**
   * Stop a specific workflow by ID.
   * Used by per-workflow controls in the dropdown; allows stopping non-active instances.
   */
  async stopWorkflow(workflowId: string): Promise<void> {
    const instance = this.instances.get(workflowId);
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
    // Always create a fresh empty instance. This fires ACTIVE_WORKFLOW_CHANGED
    // with a new workflowId so the webview resets all per-workflow state
    // (including terminal sessions) to a clean default — regardless of whether
    // the current workflow is running, paused, completed, or idle.
    // Running/paused workflows stay alive in the background (createWorkflow only
    // deactivates them visually); completed/idle instances are disposed.
    await this.createWorkflow();
  }

  async createWorkflowForClient(
    send: (msg: unknown) => void,
    clientId: string
  ): Promise<void> {
    const instance = this.buildWorkflowInstance();
    this.instances.set(instance.id, instance);
    await this.replayWorkflowStateTo(instance.id, send, clientId);
  }

  /**
   * Unified client-ready handler: registers the client, replays the workflow
   * state if one was previously viewed, and sends the current workflows list.
   * Called for both the VS Code panel and browser WebSocket clients.
   *
   * For browser clients with no previously-viewed workflow, falls back to the
   * panel's currently viewed workflow so the browser mirrors the panel state
   * on first connect (same auto-load behaviour as the panel).
   */
  async handleClientReady(
    clientId: string,
    send: (msg: unknown) => void,
    options?: { skipTerminalReplay?: boolean }
  ): Promise<void> {
    this.registerClient(clientId);
    let viewedId = this.getViewedWorkflowId(clientId);

    // Browser clients connecting for the first time have no viewed workflow.
    // Fall back to whatever the panel is currently viewing so the browser
    // mirrors the panel's session on first connect.
    if (!viewedId && clientId !== this.PANEL_CLIENT_ID) {
      viewedId = this.getViewedWorkflowId(this.PANEL_CLIENT_ID);
    }

    if (viewedId) {
      await this.replayWorkflowStateTo(viewedId, send, clientId, options);
    }
    send({
      type: MESSAGE_TYPES.WORKFLOWS_LIST,
      workflows: this.getWorkflowSummaries(),
    });
  }

  getQueueState(clientId: string): QueueState {
    return this.getInstanceForClient(clientId).getQueueState();
  }

  clearWorkingFilePath(clientId: string): void {
    this.getInstanceForClient(clientId).clearWorkingFilePath();
  }

  /**
   * Get the PromptQueue of the currently active workflow instance.
   * Returns null if no instance exists yet.
   */
  getActivePromptQueue(): PromptQueue | null {
    const id = this.getViewedWorkflowId(this.PANEL_CLIENT_ID);
    const viewed = id
      ? (this.instances.get(id) ?? this.retiredInstances.get(id))
      : null;
    return viewed?.promptQueue ?? null;
  }

  async updateWorkflowName(
    workflowName: string,
    clientId: string
  ): Promise<void> {
    return this.getInstanceForClient(clientId).updateWorkflowName(workflowName);
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
      this.storedPanelSend?.({
        type: MESSAGE_TYPES.ACTIVE_WORKFLOW_CHANGED,
        workflowId,
      });
      this.dashboardBroadcastHub.notifyWorkflowSummaryUpdated(
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

    // Phase 2: loading a working file creates a new instance alongside any running ones.
    // Must use replayWorkflowStateTo after loading so the panel receives SESSION_RESTORED
    // with actual step state. DashboardBroadcastHub.updateSessionRestored() is a no-op,
    // so SESSION_RESTORED is only deliverable via a direct PostMessageDashboardSink
    // (inside replayWorkflowStateTo). Without it, all step status icons show as idle/pending.
    //
    // Set viewedId BEFORE loadWorkingFile so retireWorkflow (triggered by terminal
    // state during load) sees isViewed=true and keeps the instance in retiredInstances
    // instead of disposing it — otherwise replayWorkflowStateTo can't find it.
    const panelSend = this.storedPanelSend ?? ((_: unknown) => {});

    // Reuse an existing retired instance for this file if one exists.
    // This preserves PTY session associations so terminals survive workflow switches.
    const existingRetiredForPanel = [...this.retiredInstances.values()].find(
      (w) => w.getSummary().workingFilePath === filePath
    );
    if (existingRetiredForPanel) {
      this.setViewedWorkflowId(this.PANEL_CLIENT_ID, existingRetiredForPanel.id);
      await this.replayWorkflowStateTo(
        existingRetiredForPanel.id,
        panelSend,
        this.PANEL_CLIENT_ID
      );
      return;
    }

    const instance = this.buildWorkflowInstance();
    this.instances.set(instance.id, instance);
    this.setViewedWorkflowId(this.PANEL_CLIENT_ID, instance.id);
    await instance.loadWorkingFile(filePath);
    await this.replayWorkflowStateTo(
      instance.id,
      panelSend,
      this.PANEL_CLIENT_ID
    );
  }

  getCurrentPromptFile(): { fileName: string; steps: unknown[] } | null {
    return this.getActiveInstance().getCurrentPromptFile();
  }

  async readWorkingFile(workingFilePath: string): Promise<WorkingFile> {
    return this.getActiveInstance().readWorkingFile(workingFilePath);
  }

  getOutputHistoryManager(): OutputHistoryManager {
    return this.getActiveInstance().outputHistoryManager;
  }

  updateWorkflowPropertyInQueue(
    property: string,
    value: unknown,
    clientId: string
  ): void {
    this.getInstanceForClient(clientId).updateWorkflowPropertyInQueue(
      property,
      value
    );
  }

  async updateWorkingFileProperties(
    properties: Record<string, unknown>,
    options: {
      onlyIfUndefined?: boolean;
      ensureHarnessAndModel?: boolean;
      allowDeletes?: boolean;
    } = {},
    clientId: string
  ): Promise<{ workingFile: WorkingFile; appliedKeys: string[] } | null> {
    return this.getInstanceForClient(clientId).updateWorkingFileProperties(
      properties,
      options
    );
  }

  async updatePromptInQueue(
    index: number,
    text: string,
    properties: unknown,
    promptName?: string,
    clearProperties?: string[],
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<void> {
    return this.getInstanceForClient(clientId).updatePromptInQueue(
      index,
      text,
      properties,
      promptName,
      clearProperties
    );
  }

  async updateFinalStepInQueue(
    finalStep: PromptStep | null,
    clearProperties?: string[],
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<void> {
    return this.getInstanceForClient(clientId).updateFinalStepInQueue(
      finalStep,
      clearProperties
    );
  }

  async ensureEphemeralWorkingFile(
    options: { initialProperties?: Record<string, unknown> } = {},
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<void> {
    return this.getInstanceForClient(clientId).ensureEphemeralWorkingFile(
      options
    );
  }

  async deletePromptFromQueue(
    index: number,
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<void> {
    return this.getInstanceForClient(clientId).deletePromptFromQueue(index);
  }

  async resetWorkflowState(
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<void> {
    return this.getInstanceForClient(clientId).resetWorkflowState();
  }

  async reorderPendingPrompts(
    newPendingOrder: number[],
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<void> {
    return this.getInstanceForClient(clientId).reorderPendingPrompts(
      newPendingOrder
    );
  }

  async syncStepsForUndoRedo(
    steps: WorkflowStep[],
    finalStep: WorkflowStep | null,
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<void> {
    return this.getInstanceForClient(clientId).syncStepsForUndoRedo(
      steps,
      finalStep
    );
  }

  async setStartPosition(
    toIndex: number,
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<void> {
    return this.getInstanceForClient(clientId).setStartPosition(toIndex);
  }

  async executeEphemeralPrompt(
    text: string,
    properties: unknown,
    action: ActionType,
    promptName?: string,
    forceNewWorkflow?: boolean,
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<void> {
    const instance = this.getInstanceForClient(clientId);

    // When this action will trigger a new workflow run, register the initiating client
    // as the PTY controller so TERMINAL_STARTED carries the correct controllerClientId
    // instead of undefined — preventing all observers from racing to claim control.
    const isRunAction =
      action === ACTION_TYPES.RUN ||
      action === ACTION_TYPES.RUN_NEXT ||
      action === ACTION_TYPES.RUN_BEFORE_CURRENT;
    if (isRunAction || forceNewWorkflow) {
      const summary = instance.getSummary();
      const wouldStart =
        forceNewWorkflow ||
        !summary.totalSteps ||
        summary.executionState === EXECUTION_STATES.IDLE ||
        summary.executionState === EXECUTION_STATES.COMPLETED ||
        summary.executionState === EXECUTION_STATES.STOPPED ||
        summary.executionState === EXECUTION_STATES.ERROR;
      if (wouldStart) {
        getPtyProcessManager()?.setPendingController(instance.id, clientId);
      }
    }

    return instance.executeEphemeralPrompt(
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
          const panelSend = this.storedPanelSend ?? ((_: unknown) => {});
          await this.createWorkflowForClient(panelSend, this.PANEL_CLIENT_ID);
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
        `Failed to resume session: ${getErrorMessage(error)}`
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
      instance.setCurrentPromptFile(result.filePath, { steps: [] });
      instance.initializeFileWatcher(result.filePath);

      // Notify the panel about the new draft file via a targeted FILE_SELECTED message.
      this.storedPanelSend?.({
        type: MESSAGE_TYPES.FILE_SELECTED,
        fileName: result.fileName,
        steps: [],
        workflowName: undefined,
        finalStep: null,
        finalStepStatus: null,
        finalStepLoopCount: 0,
        finalStepPhase: null,
      });
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
    // Dispose all retired instances (completed/stopped, not in main map)
    for (const instance of this.retiredInstances.values()) {
      instance.dispose();
    }
    this.retiredInstances.clear();
    this.setViewedWorkflowId(this.PANEL_CLIENT_ID, null);

    for (const instance of this.instances.values()) {
      instance.dispose();
    }
    this.instances.clear();

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
   * Find a workflow instance regardless of whether it is currently executing
   * (in `instances`) or has reached a terminal state but is still alive
   * (in `retiredInstances`).
   *
   * Use this for operations that must work on both live and retired workflows
   * (e.g. resumeWorkflow, executeWorkflow).  Operations that are only valid
   * while a workflow is actively running (pauseWorkflow, stopWorkflow) should
   * keep using `this.instances.get(id)` directly so the semantic boundary
   * stays explicit.
   */
  private findInstance(workflowId: string): WorkflowInstance | undefined {
    return this.instances.get(workflowId) ?? this.retiredInstances.get(workflowId);
  }

  /**
   * Get the active WorkflowInstance, creating one if none exists yet.
   * Always scoped to the panel client. Use getInstanceForClient() when a
   * specific clientId is available (e.g. from a browser message handler).
   */
  private getActiveInstance(): WorkflowInstance {
    const id = this.getViewedWorkflowId(this.PANEL_CLIENT_ID);
    if (id) {
      const inst = this.instances.get(id) ?? this.retiredInstances.get(id);
      if (inst) return inst;
    }

    // Lazily create the initial viewed instance
    const instance = this.buildWorkflowInstance();
    this.setViewedWorkflowId(this.PANEL_CLIENT_ID, instance.id);
    this.instances.set(instance.id, instance);
    return instance;
  }

  /**
   * Get the WorkflowInstance currently viewed by the given client.
   * All callers must supply a valid clientId — "panel" for the VS Code panel,
   * "browser:N" for WebSocket clients. Falls back to the active instance as a
   * last resort but logs a warning so bugs are surfaced immediately.
   */
  private getInstanceForClient(clientId: string): WorkflowInstance {
    if (!this.viewerRegistry.has(clientId)) {
      Log.warn(
        `getInstanceForClient: unregistered clientId "${clientId}" — falling back to active instance. This is likely a bug.`
      );
    }
    const id = this.getViewedWorkflowId(clientId);
    if (id) {
      const inst = this.instances.get(id) ?? this.retiredInstances.get(id);
      if (inst) return inst;
    }
    return this.getActiveInstance();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Per-client viewer registry helpers
  // ─────────────────────────────────────────────────────────────────────────

  private getViewedWorkflowId(clientId: string): string | null {
    return this.viewerRegistry.get(clientId) ?? null;
  }

  private setViewedWorkflowId(
    clientId: string,
    workflowId: string | null
  ): void {
    const prev = this.viewerRegistry.get(clientId);
    this.viewerRegistry.set(clientId, workflowId);
    if (prev !== workflowId) {
      const prevInRetired = prev ? this.retiredInstances.has(prev) : false;
      const prevStillViewed = prev ? this.isWorkflowViewedByAnyClient(prev) : false;
      Log.debug(
        `[setViewedWorkflowId] clientId=${clientId.slice(0, 12)} ` +
          `prev=inst:${prev?.slice(0, 8) ?? "null"}(retired=${prevInRetired},stillViewed=${prevStillViewed}) ` +
          `→ inst:${workflowId?.slice(0, 8) ?? "null"}`
      );
    }
  }

  private isWorkflowViewedByAnyClient(workflowId: string): boolean {
    for (const viewed of this.viewerRegistry.values()) {
      if (viewed === workflowId) return true;
    }
    return false;
  }

  registerClient(clientId: string): void {
    if (!this.viewerRegistry.has(clientId)) {
      this.viewerRegistry.set(clientId, null);
    }
  }

  unregisterClient(clientId: string): void {
    const workflowId = this.getViewedWorkflowId(clientId);
    Log.debug(
      `[unregisterClient] clientId=${clientId.slice(0, 12)} ` +
        `was viewing inst:${workflowId?.slice(0, 8) ?? "null"} ` +
        `(retired=${workflowId ? this.retiredInstances.has(workflowId) : false})`
    );
    this.viewerRegistry.delete(clientId);

    if (!workflowId) return;

    // If the workflow is in retiredInstances and no other client views it, dispose and remove
    if (
      this.retiredInstances.has(workflowId) &&
      !this.isWorkflowViewedByAnyClient(workflowId)
    ) {
      Log.debug(
        `[unregisterClient] disposing retired inst:${workflowId.slice(0, 8)} — no clients viewing it`
      );
      this.retiredInstances.get(workflowId)?.dispose();
      this.retiredInstances.delete(workflowId);
      return;
    }

    // If the workflow is a live idle instance and no other client views it, dispose and remove
    const instance = this.instances.get(workflowId);
    if (instance && !this.isWorkflowViewedByAnyClient(workflowId)) {
      const status = instance.getQueueState().status;
      const isIdle =
        status !== EXECUTION_STATES.RUNNING &&
        status !== EXECUTION_STATES.PAUSED;
      if (isIdle) {
        instance.dispose();
        this.instances.delete(workflowId);
      }
    }
  }

  /**
   * Construct a new WorkflowInstance wired to this orchestrator's integrations.
   */
  private buildWorkflowInstance(): WorkflowInstance {
    const instance = new WorkflowInstance(
      new VsCodeAdapter(this.context),
      this.dashboardBroadcastHub as IDashboardSink,
      this.integrationFactory,
      (harnessOverride?: Harness) =>
        this.resolveDetectorIntegration(harnessOverride),
      (name: string | undefined) =>
        this.propagateWorkflowNameToIntegrations(name),
      () => this.updateStatusBar(),
      this.currentWorkspaceFolder?.uri.fsPath
    );

    Log.debug(`buildWorkflowInstance: created inst:${instance.id.slice(0, 8)}`);

    // Pass MCP server provider so chat harness prompts can inject user-defined MCP servers
    if (this.mcpServerProvider) {
      instance.mcpServerProvider = this.mcpServerProvider;
    }

    // Broadcast summary updates whenever this instance's execution state changes.
    // This covers both active and inactive workflows so the multi-workflow list
    // stays in sync regardless of which workflow is currently displayed.
    instance.promptQueue.onDidChangeState((state) => {
      const summary = instance.getSummary();
      const inRegistry = this.instances.has(instance.id);

      Log.debug(
        `[onDidChangeState] inst:${instance.id.slice(0, 8)} state=${state.status} name="${summary.workflowName || "(empty)"}" ` +
          `inRegistry=${inRegistry} registrySize=${this.instances.size} ` +
          `fp=${summary.filePath ? path.basename(summary.filePath) : "?"} step=${workflowDisplayStep(summary)}/${summary.totalSteps}`
      );

      // Register in the running/paused registry whenever this instance enters
      // RUNNING or PAUSED and is not already tracked.  Using the registry
      // membership check (rather than a one-shot closure flag) lets a retired
      // instance be re-registered if the user restarts it from the dashboard.
      // Doing this here (rather than eagerly in executeWorkflow) guarantees
      // that getWorkflowSummaries() never returns an IDLE workflow and that
      // notifyWorkflowAdded() always fires with an accurate RUNNING/PAUSED
      // state — eliminating the race condition where a GET_WORKFLOWS_LIST
      // request processed before the runtime entered RUNNING would return an
      // IDLE summary that the webview filter drops, incorrectly clearing
      // loadedWorkflows.
      if (
        (state.status === EXECUTION_STATES.RUNNING ||
          state.status === EXECUTION_STATES.PAUSED) &&
        !inRegistry
      ) {
        this.instances.set(instance.id, instance);
        Log.debug(
          `onDidChangeState: registered inst:${instance.id.slice(0, 8)} in running registry on ${state.status} ` +
            `name="${summary.workflowName || "(empty)"}" (total: ${this.instances.size})`
        );
        this.dashboardBroadcastHub.notifyWorkflowAdded(summary);
      }

      this.dashboardBroadcastHub.notifyWorkflowSummaryUpdated(summary);

      // Auto-retire when a workflow completes, errors, or stops.
      // All dashboard messages (notifyWorkflowSummaryUpdated) have already been
      // sent synchronously above, so there's nothing to wait for.
      // Guard with inRegistry — workflows restored from disk in a terminal
      // state are never in this.instances, so there is nothing to retire.
      if (
        inRegistry &&
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
      case Harness.QwenCli:
        return this.qwenCliIntegration;
      case Harness.GeminiCli:
        return this.geminiCliIntegration;
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
    this.qwenCliIntegration.setWorkflowName(name);
    this.geminiCliIntegration.setWorkflowName(name);
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
    for (const [instanceId, instance] of [...this.instances.entries()]) {
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
      steps?: unknown[];
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
    const totalSteps = workingFile.steps?.length ?? 0;

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
        this.dashboardBroadcastHub.notifyWorkflowSummaryUpdated(updatedSummary);

        // If the CLI extended the queue, send the new prompts so the WorkflowStepsPanel reflects them
        if (updatedSummary.totalSteps > prevTotalSteps) {
          const provider = this.dashboardBroadcastHub;
          fs.promises
            .readFile(workingFilePath, "utf8")
            .then((content) => {
              const wf = JSON.parse(content) as { steps?: unknown[] };
              if (wf.steps) {
                Log.debug(
                  `[WorkflowOrchestrator] CLI extended queue for "${workflowId}": ${prevTotalSteps} → ${updatedSummary.totalSteps} steps`
                );
                provider.notifyCliPromptsExtended(workflowId, wf.steps);
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
    this.dashboardBroadcastHub.notifyWorkflowAdded(summary);
    Log.info(
      `[WorkflowOrchestrator] CLI watch session started for "${workflowId}"`
    );
  }

  /**
   * Send full workflow state to the dashboard when switching to a CLI-managed workflow.
   * Sends SESSION_RESTORED with the current prompts, then replays all captured outputs.
   * When `sink` is provided, sends only to that single client (per-client replay);
   * otherwise broadcasts to all clients via the hub.
   */
  private async sendCliWorkflowFullStateToDashboard(
    workflowId: string,
    cliEntry: { session: CliWatchSession; summary: WorkflowSummary },
    sink?: IDashboardSink
  ): Promise<void> {
    const workingFilePath = cliEntry.summary.workingFilePath;
    if (!workingFilePath) {
      return;
    }

    // Read the latest working file to get current prompt list and step position
    let steps: WorkflowStep[] = [];
    let currentIndex = cliEntry.summary.currentStep ?? 0;
    let finalStep: WorkflowStep | null = null;
    let finalStepRuntime:
      | {
          status?: StepStatus;
          loopCount: number;
          phase: FinalStepPhase;
        }
      | undefined;

    try {
      const content = await fs.promises.readFile(workingFilePath, "utf8");
      const workingFile = JSON.parse(content) as WorkingFile;
      steps = ((workingFile.steps as WorkflowStep[]) ?? []).map((p) => ({
        ...p,
        // Strip any existing status so loadWorkflow sets it from the results array
        status: undefined as unknown as string,
      })) as WorkflowStep[];
      currentIndex = workingFile._runtime?.currentIndex ?? currentIndex;
      finalStep = (workingFile.finalStep as WorkflowStep | undefined) ?? null;
      finalStepRuntime = workingFile._runtime?.finalStep
        ? {
            status: workingFile._runtime.finalStep.status,
            loopCount: workingFile._runtime.finalStep.loopCount,
            phase: workingFile._runtime.finalStep.phase,
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
    const results = steps.map((_, i) => ({
      status:
        i < currentIndex
          ? STEP_STATUS.COMPLETED
          : i === currentIndex
            ? STEP_STATUS.RUNNING
            : STEP_STATUS.PENDING,
    }));

    const fileName = path.basename(workingFilePath);
    const target: IDashboardSink = sink ?? this.dashboardBroadcastHub;
    await target.updateSessionRestored(
      fileName,
      steps,
      results,
      cliEntry.summary.executionState,
      currentIndex,
      cliEntry.summary.workflowName,
      finalStep,
      finalStepRuntime
    );

    // Replay all captured CLI outputs from the active history file
    const historyFilePath = cliEntry.session.getActiveHistoryFilePath();
    if (historyFilePath) {
      if (sink) {
        // Per-client replay: send directly to the sink without updating lastKnown counts
        await this.replayCliHistoryFileTo(historyFilePath, sink);
      } else {
        await this.replayCliWatchHistoryFile(workflowId, historyFilePath);
      }
    }
  }

  /**
   * Replay CLI watch history outputs to a single explicit sink.
   * Does NOT update lastKnownOutputCount — used for per-client replays only.
   */
  private async replayCliHistoryFileTo(
    historyFilePath: string,
    sink: IDashboardSink
  ): Promise<void> {
    try {
      const history =
        await this.getOutputHistoryManager().loadHistory(historyFilePath);
      for (const entry of history.orderedEntries) {
        if (
          entry.kind === OUTPUT_HISTORY_KINDS.CLI &&
          entry.target.kind === FINAL_STEP_PHASES.QUEUE
        ) {
          const stepIndex = (
            entry.target as {
              kind: typeof FINAL_STEP_PHASES.QUEUE;
              stepIndex: number;
            }
          ).stepIndex;
          sink.updateCliOutput(stepIndex, entry.cliOutput as CliOutput);
        }
      }
    } catch (err) {
      Log.warn(`[WorkflowOrchestrator] replayCliHistoryFileTo: failed:`, err);
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
      const history =
        await this.getOutputHistoryManager().loadHistory(historyFilePath);

      const cliOutputsByStep = new Map<number, unknown[]>();
      for (const historyEntry of history.orderedEntries) {
        if (
          historyEntry.kind === OUTPUT_HISTORY_KINDS.CLI &&
          historyEntry.target.kind === FINAL_STEP_PHASES.QUEUE
        ) {
          const stepIndex = (
            historyEntry.target as {
              kind: typeof FINAL_STEP_PHASES.QUEUE;
              stepIndex: number;
            }
          ).stepIndex;
          const arr = cliOutputsByStep.get(stepIndex) ?? [];
          arr.push(historyEntry.cliOutput);
          cliOutputsByStep.set(stepIndex, arr);
        }
      }

      for (const [stepIndex, outputs] of cliOutputsByStep) {
        // Update lastKnown so subsequent incremental handleCliWatchOutput calls
        // don't re-send these outputs
        entry.session.getAndUpdateLastKnownOutputCount(
          stepIndex,
          outputs.length
        );

        // Send ALL outputs from the beginning (full replay, not diff)
        for (let i = 0; i < outputs.length; i++) {
          this.dashboardBroadcastHub.notifyCliWatchOutput(
            workflowId,
            stepIndex,
            outputs[i] as CliOutput
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

    this.getOutputHistoryManager()
      .loadHistory(historyFilePath)
      .then((history) => {
        const cliOutputsByStep = new Map<number, unknown[]>();
        for (const historyEntry of history.orderedEntries) {
          if (
            historyEntry.kind === OUTPUT_HISTORY_KINDS.CLI &&
            historyEntry.target.kind === FINAL_STEP_PHASES.QUEUE
          ) {
            const stepIndex = (
              historyEntry.target as {
                kind: typeof FINAL_STEP_PHASES.QUEUE;
                stepIndex: number;
              }
            ).stepIndex;
            const arr = cliOutputsByStep.get(stepIndex) ?? [];
            arr.push(historyEntry.cliOutput);
            cliOutputsByStep.set(stepIndex, arr);
          }
        }

        for (const [stepIndex, outputs] of cliOutputsByStep) {
          const lastKnown = entry.session.getAndUpdateLastKnownOutputCount(
            stepIndex,
            outputs.length
          );

          // Send only new outputs
          for (let i = lastKnown; i < outputs.length; i++) {
            this.dashboardBroadcastHub.notifyCliWatchOutput(
              workflowId,
              stepIndex,
              outputs[i] as CliOutput
            );
          }
        }
      })
      .catch((err: unknown) => {
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
          steps?: unknown[];
          workflowName?: string;
          startedAt?: number;
        };

        let finalState =
          workingFile._runtime?.executionState ?? EXECUTION_STATES.STOPPED;

        // If still shows "running", normalize to "stopped" on disk
        if (finalState === EXECUTION_STATES.RUNNING) {
          finalState = EXECUTION_STATES.STOPPED;
          if (workingFile._runtime) {
            workingFile._runtime.executionState = EXECUTION_STATES.STOPPED;
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
          totalSteps: workingFile.steps?.length ?? entry.summary.totalSteps,
          managedBy: undefined, // no longer CLI-managed
        };

        // Update the dashboard: send final state then dismiss from Running section
        this.dashboardBroadcastHub.notifyWorkflowSummaryUpdated(finalSummary);
        this.dashboardBroadcastHub.notifyWorkflowDismissed(workflowId);

        void this.saveState();
      })
      .catch((err) => {
        Log.warn(
          `[WorkflowOrchestrator] handleCliSessionFinished: failed to read working file:`,
          err
        );
        // Still dismiss from the dashboard
        this.dashboardBroadcastHub.notifyWorkflowDismissed(workflowId);
      });
  }
}
