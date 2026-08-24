import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { HarnessIntegration, HarnessStatus } from "./HarnessIntegration";
import { CliIntegration } from "./harness/CliIntegration";
import { IntegrationFactory } from "./IntegrationFactory";
import { HarnessCapabilityRegistry } from "./HarnessCapabilityRegistry";
import { WorkflowInstance } from "./WorkflowInstance";
import {
  ExecutionPreviewService,
  type ExecutionPreviewHarness,
} from "./ExecutionPreviewService";
import { WorkingFileManager } from "./WorkingFileManager";
import type { ExecutionWorkspace } from "../types/WorkflowContextTypes";
import { RunContinuationService } from "./orchestration/RunContinuationService";
import { createPriorContextResolver } from "./orchestration/AddressedPriorContextResolver";
import {
  buildDefinitionSnapshot,
  buildEphemeralWorkflowStep,
  buildPromptStepProperties,
  buildScriptStepFromProperties,
  sanitizeClipboardWorkflowStep,
  stripViewOnlyWorkflowStepFields,
} from "./WorkflowStepSanitizer";
import { PromptQueue } from "./PromptQueue";
import {
  QueueState,
  WorkingFile,
  WorkflowSummary,
  WorkflowRunnerLock,
  EXECUTION_STATES,
  type PromptFile,
  type WorkflowStep,
  type WorkflowKey,
  type RunRef,
  type WorkflowRunAddress,
  type WorkflowViewAddress,
  type WorktreeRunProjection,
  projectWorktreeRuntime,
  workflowDisplayStep,
} from "../types/CtrlYokeTypes";
import {
  ACTION_TYPES,
  HARNESS_IDS,
  LOCK_STATUS,
  FINAL_STEP_PHASES,
  OUTPUT_HISTORY_KINDS,
  MESSAGE_TYPES,
  PANEL_CLIENT_ID,
  RUNNER_IDS,
  STEP_STATUS,
  STEP_TYPES,
  TERMINAL_SESSION_STATUS,
  USER_FEEDBACK_SEVERITY,
  type EndConditionScriptType,
  type HarnessId,
  type QueuePosition,
  type ActionType,
  type StepStatus,
  type FinalStepPhase,
  type WorktreeManagementAction,
} from "../types/DashboardConstants";
import type { IDashboardSink } from "../types/IDashboardSink";
import { PostMessageDashboardSink } from "../ui/PostMessageDashboardSink";
import { WorkflowTaggedSink } from "./WorkflowTaggedSink";
import type {
  CliOutput,
  ActiveTerminalWorkflowRef,
  RunViewLoadedMessage,
  RunSummariesLoadedMessage,
  WorkflowDefinitionMutation,
  WorkflowViewIdentityMessage,
  ExecutionPreviewScope,
} from "../types/WebviewMessageTypes";
import { StatusBarManager } from "../ui/StatusBarManager";
import { Log } from "../utils/Log";
import { getErrorMessage } from "../utils/ErrorUtils";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { OutputHistoryManager } from "./orchestration/OutputHistoryManager";
import { clearRunSummaryCache } from "./orchestration/RunSummaryCache";
import { EndConditionEvaluator } from "./EndConditionEvaluator";
import { WorkflowLockManager } from "../utils/WorkflowLockManager";
import * as WorkflowPaths from "../utils/WorkflowPaths";
import { WorkflowLineageRepository } from "./orchestration/WorkflowLineageRepository";
import { CliWatchSession } from "./orchestration/CliWatchSession";
import { HarnessUsageService } from "./harness/shared/usage/HarnessUsageService";
import { WorkspaceStatsService } from "./harness/shared/usage/WorkspaceStatsService";
import type { WorkspaceStatsSnapshot } from "../types/UsageTypes";
import {
  getPtyProcessManager,
  ptyPostMessage,
} from "./harness/PtyProcessManager";

// Orchestration classes that remain at orchestrator level
import { WorkflowCommandHandler } from "./orchestration/WorkflowCommandHandler";
import { WorkspaceSessionManager } from "./orchestration/WorkspaceSessionManager";
import { WorkspaceInitializer } from "./orchestration/WorkspaceInitializer";
import {
  WorktreeManager,
  type WorktreeInfo,
  type WorktreeSyncResult,
} from "./orchestration/WorktreeManager";
import { PromptFileParser } from "./PromptFileParser";
import { VsCodeAdapter } from "../platform/VsCodeAdapter";
import { PropertyResolver } from "../utils/PropertyResolver";
import type { UserFeedbackSink } from "./UserFeedbackSink";
import { notifyUserFeedback } from "./UserFeedbackSink";
import { getVsCodeWorkspaceFolder } from "../platform/VsCodeWorkspaceRoot";
import {
  DashboardBroadcastHub,
  type DashboardClient,
} from "../ui/DashboardBroadcastHub";
import { promptBatchApprovalForPendingWorkspaceSecretGrants } from "../ui/SecretGrantsTrustPrompt";

/**
 * WorkflowOrchestrator
 *
 * RESPONSIBILITY: Workflow Registry & Cross-Cutting Concerns
 *
 * Manages the registry of WorkflowInstance objects and owns resources that
 * are shared or orchestrator-scoped:
 *   - Four harness integrations (created once, shared for Phase 1)
 *   - StatusBarManager
 *   - WorkflowCommandHandler
 *   - WorkspaceSessionManager (workspace-level session discovery)
 *   - dashboardReady / orchestratorInitialized gates
 *
 * Phase 1: Always holds exactly one WorkflowInstance (the active one).
 * Phase 2: Will hold many instances in parallel; `activeWorkflowId` decides
 *          which one is displayed in the dashboard.
 */

/**
 * Compare two working-file paths ignoring separator style. Navigation routes
 * are forward-slash normalized (for shareable URLs / browser history), but
 * instance summaries carry native paths (backslashes on Windows). A raw `===`
 * misses on Windows, so a LOAD_WORKFLOW carrying a route-normalized path would
 * fail to match the live running instance and build a fresh STOPPED duplicate.
 */
function sameWorkingFilePath(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  if (a == null || b == null) return a === b;
  return a.replace(/\\/g, "/") === b.replace(/\\/g, "/");
}

/**
 * Whether a resident instance still owns an execution for its lineage.
 *
 * Instances can remain resident while idle (for example, after startup
 * restoration), so registry membership alone must not be interpreted as a
 * running workflow.
 */
function isExecutionOwnerState(status: QueueState["status"]): boolean {
  return (
    status === EXECUTION_STATES.RUNNING ||
    status === EXECUTION_STATES.PAUSING ||
    status === EXECUTION_STATES.PAUSED ||
    status === EXECUTION_STATES.CANCELLING
  );
}

/**
 * Whether an instance has finished the execution it was prepared for. Used to
 * expire a `lineageExecutionOwners` entry on read: nothing deletes those
 * entries, so a spent one must not keep outranking the lineage's other
 * residents. A status-less instance (lightweight test double) is not finished.
 */
function isSpentExecutionOwnerState(status: QueueState["status"]): boolean {
  return (
    status === EXECUTION_STATES.COMPLETED ||
    status === EXECUTION_STATES.ERROR ||
    status === EXECUTION_STATES.STOPPED
  );
}

/**
 * A `lineageExecutionOwners` entry. `promoted` is false from the moment a run
 * action parks its incoming instance until that instance's own state
 * transitions into an execution-owner state at least once — only then can a
 * later terminal status mean "this claim's run is over" rather than "this
 * instance's *previous* run left it terminal, and the one it was just
 * prepared for has not started yet". Continuing an already-completed run
 * reuses that same retired instance, so at claim time its status is still
 * whatever the prior run left it at (typically COMPLETED) — unlike a Re-run's
 * freshly built instance, which starts IDLE. Without the `promoted` gate,
 * `isSpentExecutionOwnerState` cannot tell those two apart and discards the
 * still-valid claim, letting some other resident of the lineage (e.g. a live
 * idle instance browsing another run) win the tie-break instead.
 */
interface LineageExecutionClaim {
  instanceId: string;
  promoted: boolean;
}

interface DefinitionRollbackInvalidation {
  fromRevision: number;
  restoredRevision: number;
  descriptorRevision: number;
}

function buildPromptStepChange(
  text: string,
  properties: unknown,
  promptName?: string,
  clearProperties?: string[]
): { replace: WorkflowStep; clearProperties?: string[] } {
  const props = properties as Record<string, unknown>;
  return props?.type === STEP_TYPES.SCRIPT
    ? {
        replace: buildScriptStepFromProperties(text, props, promptName),
        clearProperties,
      }
    : {
        replace: {
          prompt: text,
          ...(promptName !== undefined && {
            name: promptName || undefined,
          }),
          ...buildPromptStepProperties(properties),
        },
        clearProperties,
      };
}

/**
 * The view address an instance's own queue currently describes: its draft while
 * the lineage has never executed, otherwise the run it holds open. `null` until
 * the instance has a lineage at all (a blank, never-edited new workflow).
 */
/** Structural equality for two stable client view addresses. */
function sameViewAddress(
  a: WorkflowViewAddress | null | undefined,
  b: WorkflowViewAddress | null | undefined
): boolean {
  if (!a || !b) return false;
  if (a.workflowKey !== b.workflowKey || a.kind !== b.kind) return false;
  return a.kind !== "run" || (b.kind === "run" && a.runRef === b.runRef);
}

function lineageAddressOf(
  state: QueueState | undefined
): WorkflowViewAddress | null {
  if (!state?.workflowKey) return null;
  return state.runRef
    ? { workflowKey: state.workflowKey, kind: "run", runRef: state.runRef }
    : { workflowKey: state.workflowKey, kind: "draft" };
}

interface WorkflowReplayOptions {
  skipTerminalReplay?: boolean;
}

/**
 * The half of a run-view snapshot that depends only on the address, so every
 * client viewing that address receives identical values.
 *
 * Reading it is by far the most expensive part of a view load — `getRunSummaries`
 * alone reads a manifest *and* a working file for every run in the lineage, and
 * the addressed run's timeline is read on top of that. A fan-out to several
 * clients therefore reads this once and shares it (`publishRunViewToClients`).
 * Delivery treats it as immutable: it is handed to more than one sink, so
 * nothing may mutate a field here after `readAddressedRunView` returns.
 */
interface AddressedRunView {
  workingFile: WorkingFile;
  history: RunViewLoadedMessage["history"];
  runSummaries: RunViewLoadedMessage["runSummaries"];
  workflowProperties: RunViewLoadedMessage["workflowProperties"];
  descriptorRevision: number;
  isSystemGenerated: boolean;
}

export class WorkflowOrchestrator {
  // ─────────────────────────────────────────────────────────────────────────
  // Instance registry
  // ─────────────────────────────────────────────────────────────────────────

  /** Instance registry — running/paused instances plus idle instances loaded via browser client.
   * Keyed by WorkflowInstance.id (UUID). */
  private readonly instances: Map<string, WorkflowInstance> = new Map();
  private readonly lineageRepository = new WorkflowLineageRepository();

  /** CLI-managed workflows being watched (keyed by workflowId) */
  private readonly cliSessions: Map<
    string,
    { session: CliWatchSession; summary: WorkflowSummary }
  > = new Map();

  /** Watcher for *.runner.json creation (Entry Point 3: CLI starts while VS Code is open) */
  private runnerJsonCreateWatcher?: vscode.FileSystemWatcher;
  /** Polling fallback for VS Code builds that do not deliver external recursive events. */
  private runnerJsonDiscoveryPollInterval?: ReturnType<typeof setInterval>;
  /**
   * Last `runner.json` mtime already handed to `handleRunnerJsonEvent`, keyed by
   * lock path. The poll fires every second for the host's lifetime, so without
   * this every stale lock in the runs root would be re-read and re-`checkLock`ed
   * on every tick. A new lock has no entry and is processed immediately.
   */
  private readonly polledRunnerJsonMtimes = new Map<string, number>();

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

  /** Client-local displayed address. This is intentionally separate from the
   * instance registry: changing it must never rebind a shared PromptQueue. */
  private readonly viewAddressRegistry = new Map<
    string,
    WorkflowViewAddress | null
  >();
  /** Per-client addressed-view transport, used for targeted invalidation. */
  private readonly viewMessageSinks = new Map<
    string,
    (message: unknown) => void
  >();
  /** Clients mid-rebind, so the replay's own run-view load cannot re-enter. */
  private readonly lineageBindingClients = new Set<string>();
  /** Lineage → instance most recently prepared to execute it (see
   * {@link getLineageExecutionOwners}); disambiguates retired duplicates. */
  private readonly lineageExecutionOwners = new Map<
    WorkflowKey,
    LineageExecutionClaim
  >();

  /** Retired instances keyed by workflowId — held until no client views them. */
  private retiredInstances = new Map<string, WorkflowInstance>();

  // ─────────────────────────────────────────────────────────────────────────
  // Cross-cutting concerns
  // ─────────────────────────────────────────────────────────────────────────
  private readonly dashboardBroadcastHub = new DashboardBroadcastHub();
  private readonly harnessUsageService?: HarnessUsageService;
  private readonly workspaceStatsService?: WorkspaceStatsService;
  private readonly integrationFactory: IntegrationFactory;
  private readonly compatibilityRegistry: HarnessCapabilityRegistry;
  private readonly statusBarManager: StatusBarManager;
  private currentWorkspaceFolder: vscode.WorkspaceFolder | undefined;

  // Harness integrations — created once at startup
  private readonly copilotCliIntegration: CliIntegration;
  private readonly claudeCliIntegration: CliIntegration;
  private readonly codexCliIntegration: CliIntegration;
  private readonly openCodeCliIntegration: CliIntegration;
  private readonly qwenCliIntegration: CliIntegration;
  private readonly antigravityCliIntegration: CliIntegration;

  // Orchestration helpers
  private readonly workflowCommandHandler: WorkflowCommandHandler;
  private readonly workspaceSessionManager: WorkspaceSessionManager;
  private readonly promptFileParser: PromptFileParser;
  /** Evaluator used by the dashboard's in-app starter-script control. */
  private readonly endConditionEvaluator: EndConditionEvaluator;

  // Initialization gates
  private dashboardReady: boolean = false;
  private orchestratorInitialized: boolean = false;
  /** Guards triggerStartupAutoLoadIfReady so triggerAutoLoad fires at most once. */
  private startupAutoLoadTriggered: boolean = false;
  /** Timestamp (ms) when setDashboardReady was first called — used to compute READY→STARTUP_COMPLETE latency. */
  private dashboardReadyAt: number = 0;
  /** Set when ctrlyoke has not yet been initialized in this workspace. Blocks startup auto-load until resolved. */
  private workspaceInitPending: boolean = false;
  /** The workspace root path waiting for ctrlyoke initialization. */
  private pendingInitWorkspaceRoot: string | undefined;
  /** Set on first-ever workspace init — blocks startup until the user chooses a panel layout preference. */
  private layoutPreferencePending: boolean = false;

  /**
   * WorkflowId of the first workflow successfully replayed to the panel during the current
   * startup sequence, or null if no startup replay has occurred yet. Used to suppress
   * redundant replays from subsequent READY messages (BootstrapApp → App.tsx →
   * CLIENT_ID_ASSIGNED each trigger handleClientReady). Every extra replay sends
   * SESSION_RESTORED which clears historyOutputs, causing a visible output flash before
   * OUTPUT_HISTORY_LOADED restores it. After _autoLoadHasSettled, this field is irrelevant
   * as replays are always allowed (reconnect / webview reload).
   */
  private panelStartupReplayedWorkflowId: string | null = null;

  /**
   * The panel's viewed workflowId as of the last `setDashboardReady()`, i.e. the
   * instance startup hydration left the panel on. `triggerAutoLoad` compares the
   * panel's *current* viewed id against this to detect that something moved the
   * view while the auto-load was still deferred behind `initialize()`.
   *
   * Only the user can move it in that window (new workflow, switch, open a run),
   * so a mismatch means the auto-load would be loading the most-recent session
   * *into the instance the user just chose* — `triggerAutoLoad` resolves the
   * target through `getActiveInstance()`, which is whatever the panel views now,
   * not the instance startup picked. That silently replaced a brand-new workflow
   * with the previous session's steps and name, then rebound the view to the
   * recent lineage's older instance. The pre-existing `panelWorkingFilePath`
   * guard does not cover it: a just-created workflow has no working file until
   * the user types, so the guard falls through precisely in the racy case.
   */
  private startupPanelViewedId: string | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    dashboardProvider: DashboardClient | undefined,
    private readonly userFeedbackSink: UserFeedbackSink
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
    // Workspace — the folder matching the resolved `.ctrlyoke` root
    // (honors the `.code-workspace` dir and `ctrlyoke.workspaceDirectory`).
    this.currentWorkspaceFolder = getVsCodeWorkspaceFolder();
    if (this.currentWorkspaceFolder) {
      this.harnessUsageService = new HarnessUsageService(
        this.currentWorkspaceFolder.uri.fsPath,
        undefined,
        undefined,
        (snapshots) => this.dashboardBroadcastHub.updateHarnessUsage(snapshots),
        Date.now,
        {
          isEnabled: () => ConfigurationUtils.shouldTrackHarnessUsage(),
          isProviderRefreshEnabled: () =>
            ConfigurationUtils.shouldRefreshHarnessUsage(),
          shouldPersistObservedUsage: () =>
            ConfigurationUtils.shouldPersistObservedHarnessUsage(),
        }
      );
      this.workspaceStatsService = new WorkspaceStatsService(
        this.currentWorkspaceFolder.uri.fsPath
      );
    }

    this.integrationFactory = new IntegrationFactory(
      new VsCodeAdapter(context),
      this.userFeedbackSink,
      this.harnessUsageService?.getProviderUsageIngestPort()
    );
    this.compatibilityRegistry = new HarnessCapabilityRegistry();

    // Create the shared CLI harness integrations
    this.copilotCliIntegration = this.integrationFactory.createCopilotCli();
    this.claudeCliIntegration = this.integrationFactory.createClaudeCli();
    this.codexCliIntegration = this.integrationFactory.createCodexCli();
    this.openCodeCliIntegration = this.integrationFactory.createOpenCodeCli();
    this.qwenCliIntegration = this.integrationFactory.createQwenCli();
    this.antigravityCliIntegration =
      this.integrationFactory.createAntigravityCli();

    // Status bar
    this.statusBarManager = new StatusBarManager(context);

    // Shared parsers / orchestration helpers
    this.promptFileParser = new PromptFileParser(
      new VsCodeAdapter(context),
      this.userFeedbackSink
    );
    this.workspaceSessionManager = new WorkspaceSessionManager(
      this.promptFileParser,
      new VsCodeAdapter(context)
    );
    this.endConditionEvaluator = new EndConditionEvaluator(
      new VsCodeAdapter(context)
    );
    this.workflowCommandHandler = new WorkflowCommandHandler(
      this.userFeedbackSink
    );

    // Wire harness status subscriptions
    const defaultIntegration = this.getDefaultIntegration();
    const allIntegrations: Array<[HarnessId, CliIntegration]> = [
      [HARNESS_IDS.COPILOT_CLI, this.copilotCliIntegration],
      [HARNESS_IDS.CLAUDE_CLI, this.claudeCliIntegration],
      [HARNESS_IDS.CODEX_CLI, this.codexCliIntegration],
      [HARNESS_IDS.OPENCODE_CLI, this.openCodeCliIntegration],
      [HARNESS_IDS.QWEN_CLI, this.qwenCliIntegration],
      [HARNESS_IDS.ANTIGRAVITY_CLI, this.antigravityCliIntegration],
    ];
    for (const [harnessId, integration] of allIntegrations) {
      const installHint = integration.getInstallHint();
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
              status === HarnessStatus.Ready,
              installHint
            );
          }
        })
      );
    }

    this.updateStatusBar();
    void this.harnessUsageService?.initialize();
    Log.debug("WorkflowOrchestrator initialized");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Dashboard provider registry
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Register an additional dashboard client to receive orchestrator and
   * workflow-instance updates.
   *
   * @keep Standalone server API; see dev/backlog/STANDALONE_SERVER_PLAN.md.
   */
  public addDashboardProvider(provider: DashboardClient): void {
    this.dashboardBroadcastHub.addClient(provider);
  }

  /** @keep Standalone server API; see dev/backlog/STANDALONE_SERVER_PLAN.md. */
  public removeDashboardProvider(provider: DashboardClient): void {
    this.dashboardBroadcastHub.removeClient(provider);
  }

  public getDashboardBroadcastHub(): DashboardBroadcastHub {
    return this.dashboardBroadcastHub;
  }

  public getHarnessUsageService(): HarnessUsageService | undefined {
    return this.harnessUsageService;
  }

  public async refreshHarnessUsage(): Promise<void> {
    if (!ConfigurationUtils.shouldRefreshHarnessUsage()) return;
    await this.harnessUsageService?.refreshAllHarnessUsage();
  }

  public getWorkspaceStatsService(): WorkspaceStatsService | undefined {
    return this.workspaceStatsService;
  }

  public async refreshWorkspaceStats(): Promise<
    WorkspaceStatsSnapshot | undefined
  > {
    const snapshot = await this.workspaceStatsService?.refresh();
    if (snapshot) {
      this.dashboardBroadcastHub.updateWorkspaceStats(snapshot);
    }
    return snapshot;
  }

  /** Shared installed-version-aware capability registry for dashboard consumers. */
  public getCompatibilityRegistry(): HarnessCapabilityRegistry {
    return this.compatibilityRegistry;
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
          existingStatus === EXECUTION_STATES.PAUSING ||
          existingStatus === EXECUTION_STATES.PAUSED
        ) {
          Log.info(
            `createWorkflow: duplicate detected — existing inst:${existing.id.slice(0, 8)} is ${existingStatus}`
          );
          // The running-instance policy is to reuse the existing workflow.
          // Keep this safe default explicit now that the native choice prompt
          // is no longer allowed to override it from a shared core path.
          const panelSend = this.storedPanelSend ?? ((_: unknown) => {});
          await this.replayWorkflowStateTo(
            existing.id,
            panelSend,
            this.PANEL_CLIENT_ID
          );
          return existing;
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
        viewedStatus !== EXECUTION_STATES.PAUSING &&
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
  /**
   * Move an instance into the live registry, enforcing the invariant that an
   * instance lives in EITHER `instances` OR `retiredInstances` — never both.
   *
   * The inverse of {@link retireWorkflow}. Used when a retired instance becomes
   * active again (a multi-step run that briefly hit a terminal state, or a
   * restart from the dashboard). Leaving a stale `retiredInstances` copy behind
   * makes the still-running workflow look retired to `setViewedWorkflowId` and
   * `unregisterClient`, which can dispose the shared instance object out from
   * under the live run.
   *
   * @returns true if a stale retired entry was removed.
   */
  private promoteInstanceToLive(instance: WorkflowInstance): boolean {
    this.instances.set(instance.id, instance);
    return this.retiredInstances.delete(instance.id);
  }

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
      `retireWorkflow: inst:${workflowId.slice(0, 8)} name=\"${instance.getSummary().workflowName || "(empty)"}\" ` +
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

  /** @keep Standalone server API; see dev/backlog/STANDALONE_SERVER_PLAN.md. */
  getAllWorkflows(): WorkflowInstance[] {
    return [...this.instances.values()];
  }

  getRunningWorkflows(): WorkflowInstance[] {
    return [...this.instances.values()].filter((w) => {
      const status = w.getQueueState().status;
      return (
        status === EXECUTION_STATES.RUNNING ||
        status === EXECUTION_STATES.PAUSING
      );
    });
  }

  getUserFeedbackSink(): UserFeedbackSink {
    return this.userFeedbackSink;
  }

  /** @keep Standalone server API; see dev/backlog/STANDALONE_SERVER_PLAN.md. */
  getActiveWorkflow(): WorkflowInstance | undefined {
    const id = this.getViewedWorkflowId(this.PANEL_CLIENT_ID);
    if (id) {
      return (
        this.instances.get(id) ?? this.retiredInstances.get(id) ?? undefined
      );
    }
    return undefined;
  }

  /** @keep Standalone server API; see dev/backlog/STANDALONE_SERVER_PLAN.md. */
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
    options?: WorkflowReplayOptions
  ): Promise<void> {
    const sink = new PostMessageDashboardSink(send);

    // Seed this client with the global active-terminal set so the dropdown
    // terminal icon is correct for *every* workflow immediately — not just the
    // one being replayed. Browser clients only receive per-workflow terminal
    // replay, so without this they would only ever see the icon for the
    // currently-viewed workflow and lose it on switch. Sent on every replay
    // (initial connect and workflow switches) regardless of skipTerminalReplay.
    send({
      type: MESSAGE_TYPES.ACTIVE_TERMINAL_WORKFLOWS,
      workflows: this.getActiveTerminalWorkflowRefs(),
    });

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
      const workingFilePath = instance.getSummary().workingFilePath ?? null;
      send({
        type: MESSAGE_TYPES.ACTIVE_WORKFLOW_CHANGED,
        workflowId,
        workingFilePath,
      });
      // Update viewerRegistry immediately — before any awaits — so that retireWorkflow
      // called from a concurrent state-change event sees isViewed=true and keeps the
      // instance in retiredInstances rather than discarding it. Moving this after the
      // awaits created a race: the workflow could complete during
      // replayOutputHistoryTo, causing retirement with stale (false) isViewed.
      this.setViewedWorkflowId(clientId, workflowId);

      // Load the addressed disk snapshot before replaying the live in-memory state.
      // RUN_VIEW_LOADED resets the webview's live output store, so sending it after
      // replayFullStateTo caused newly connected browser clients to discard the full
      // reconnect buffer and display only the potentially incomplete on-disk history.
      const queueState = instance.getQueueState();
      if (queueState.workflowKey) {
        await this.loadRunViewForClient(
          queueState.runRef
            ? {
                workflowKey: queueState.workflowKey,
                kind: "run",
                runRef: queueState.runRef,
              }
            : { workflowKey: queueState.workflowKey, kind: "draft" },
          send,
          clientId
        );
      }

      instance.replayFullStateTo(sink);
      await instance.replayOutputHistoryTo(send);
      // The addressed RUN_VIEW_LOADED above set the client's displayed view
      // address, but replayFullStateTo's SESSION_RESTORED then ran
      // applyWorkflowChange() on the client, which clears that address and
      // revisions as part of resetting cross-workflow state — and unlike the
      // output store it re-populates via replayOutputHistoryTo, nothing
      // re-publishes the address. Left cleared, the header loses its run
      // identity and the Run/Re-run control collapses to the disabled "Load a
      // workflow to run" state. Re-publish the authoritative identity now.
      // WORKFLOW_VIEW_IDENTITY touches only address/revisions, so it restores
      // the address without disturbing the live output just replayed.
      if (queueState.workflowKey) {
        const identity = await this.getViewIdentity(clientId);
        if (identity) {
          send(identity);
        }
      }
      // Replay active terminal sessions to the client so it can render the live
      // terminal. Only needed for initial connections and reloads where the
      // client's xterm.js registry has been wiped. Callers that know the client's
      // registry is intact (workflow switches, panel setDashboardReady) pass
      // skipTerminalReplay: true so we don't clear and dispose live xtermjs
      // instances that already hold the correct scrollback.
      if (!options?.skipTerminalReplay) {
        this.replayTerminalSessionsTo(workflowId, send, clientId);
      }
      // setViewedWorkflowId already called before awaits above.
      return;
    }

    // CLI-managed session
    const cliEntry = this.cliSessions.get(workflowId);
    if (cliEntry) {
      send({
        type: MESSAGE_TYPES.ACTIVE_WORKFLOW_CHANGED,
        workflowId,
        workingFilePath: cliEntry.summary.workingFilePath ?? null,
      });
      // Update viewerRegistry before the await for the same reason as above.
      this.setViewedWorkflowId(clientId, workflowId);
      await this.sendCliWorkflowFullStateToDashboard(
        workflowId,
        cliEntry,
        sink
      );
    } else {
      Log.warn(
        `replayWorkflowStateTo: workflowId "${workflowId.slice(0, 8)}" not found`
      );
    }
  }

  /** Replay PTY metadata and scrollback without touching workflow/output state. */
  private replayTerminalSessionsTo(
    workflowId: string,
    send: (message: unknown) => void,
    clientId: string
  ): void {
    const ptyManager = getPtyProcessManager();
    if (!ptyManager) return;

    const sessionsForWorkflow = ptyManager.getSessionsForWorkflow(workflowId);
    Log.debug(
      `[replayTerminalSessionsTo] terminal replay for inst:${workflowId.slice(0, 8)} — ` +
        `found ${sessionsForWorkflow.length} PTY session(s): ` +
        `[${sessionsForWorkflow.map((s) => `${s.id.slice(0, 8)}(status=${s.status},kind=${s.kind})`).join(", ") || "none"}]`
    );
    for (const session of sessionsForWorkflow) {
      // Auto-assign controller to the first client to reconnect for this session.
      // Use assignController (not direct mutation) so workflowRunControllers is
      // updated — ensuring subsequent step PTY spawns inherit the same controller.
      // Broadcast TERMINAL_CONTROLLER_CHANGED to all clients so no other client
      // continues to think it is still the controller (prevents dual-controller).
      if (session.controllerClientId === undefined) {
        ptyManager.assignController(session.id, clientId);
        ptyPostMessage({
          type: MESSAGE_TYPES.TERMINAL_CONTROLLER_CHANGED,
          workflowId: session.workflowId,
          sessionId: session.id,
          controllerClientId: clientId,
        });
      }
      Log.debug(
        `[replayTerminalSessionsTo] sending TERMINAL_STARTED for session ${session.id.slice(0, 8)} ` +
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

  /**
   * Build the global set of workflows that currently have at least one running
   * PTY session, each paired with its stable execution address so clients can
   * match both loaded and recent rows without a mutable working-file path.
   * Source of truth is the PtyProcessManager, resolved against live,
   * retired, and CLI-managed instances for path lookup.
   */
  getActiveTerminalWorkflowRefs(): ActiveTerminalWorkflowRef[] {
    const ptyManager = getPtyProcessManager();
    if (!ptyManager) {
      return [];
    }
    return ptyManager
      .getWorkflowIdsWithRunningSessions()
      .map((workflowId) => {
        const instance =
          this.instances.get(workflowId) ??
          this.retiredInstances.get(workflowId);
        const summary =
          instance?.getSummary() ?? this.cliSessions.get(workflowId)?.summary;
        if (!summary?.workflowKey || !summary.runRef) {
          return undefined;
        }
        return {
          workflowId,
          workflowKey: summary.workflowKey,
          runRef: summary.runRef,
        };
      })
      .filter((ref): ref is ActiveTerminalWorkflowRef => ref !== undefined);
  }

  /**
   * Broadcast the global active-terminal set to every client (panel + browser
   * tabs). Called whenever a PTY session starts or ends so the dropdown
   * terminal icon stays in sync across all workflows regardless of which one
   * each client is viewing.
   */
  broadcastActiveTerminalWorkflows(): void {
    this.dashboardBroadcastHub.postMessage({
      type: MESSAGE_TYPES.ACTIVE_TERMINAL_WORKFLOWS,
      workflows: this.getActiveTerminalWorkflowRefs(),
    });
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
    clientId: string,
    options?: {
      /**
       * When true, load/register the workflow instance without sending
       * SESSION_RESTORED / OUTPUT_HISTORY_LOADED to the client.
       * Used by handleClientReady to suppress duplicate startup replays
       * — every extra replay sends SESSION_RESTORED which clears historyOutputs
       * and causes a visible output flash.
       */
      skipReplay?: boolean;
    }
  ): Promise<void> {
    // Parse working file path to get workflowId (used for CLI session lookup)
    const workflowId =
      WorkflowPaths.parseWorkingFileAddressFromPath(filePath)?.workflowKey ??
      "";

    // Check for CLI-managed session first
    const cliEntry = this.cliSessions.get(workflowId);
    if (cliEntry) {
      // setViewedWorkflowId is normally called inside replayWorkflowStateTo; call
      // it explicitly here so the viewer registry stays consistent when skipping.
      this.setViewedWorkflowId(clientId, workflowId);
      if (!options?.skipReplay) {
        await this.replayWorkflowStateTo(workflowId, send, clientId);
      }
      return;
    }

    // If startup has not finished wiring CLI watch sessions yet, a preferred
    // working-file load can arrive before setupCliWatching() sees an active CLI
    // lock. Register the CLI session first so a dashboard view load never
    // converts an actively CLI-managed RUNNING file to a VS Code instance.
    if (await this.ensureCliWatchSession(filePath)) {
      this.setViewedWorkflowId(clientId, workflowId);
      if (!options?.skipReplay) {
        await this.replayWorkflowStateTo(workflowId, send, clientId);
      }
      return;
    }

    // Check if already in instances registry by working file path
    const existing = [...this.instances.values()].find((w) =>
      sameWorkingFilePath(w.getSummary().workingFilePath, filePath)
    );
    if (existing) {
      this.setViewedWorkflowId(clientId, existing.id);
      if (!options?.skipReplay) {
        await this.replayWorkflowStateTo(existing.id, send, clientId);
      }
      return;
    }

    // Check retired instances (completed/stopped workflows) by working file path.
    // Reuse the existing retired instance so its PTY sessions remain accessible.
    const existingRetired = [...this.retiredInstances.values()].find((w) =>
      sameWorkingFilePath(w.getSummary().workingFilePath, filePath)
    );
    if (existingRetired) {
      this.setViewedWorkflowId(clientId, existingRetired.id);
      if (!options?.skipReplay) {
        await this.replayWorkflowStateTo(existingRetired.id, send, clientId);
      }
      return;
    }

    // Not in registry — load file without touching the panel's viewed workflow.
    Log.debug(
      `[loadWorkflowForClient] inst not found in live/retired/CLI for ` +
        `"${path.basename(filePath)}" — creating fresh instance (clientId=${clientId.slice(0, 12)})`
    );
    await this.loadFreshInstanceAndReplay(filePath, clientId, send, options);
  }

  /**
   * Create a fresh WorkflowInstance, load it from a working file, and replay its
   * state to the client.
   *
   * Set viewedId BEFORE loadWorkingFile so retireWorkflow (triggered by terminal
   * state during load) sees isViewed=true and keeps the instance in retiredInstances
   * instead of disposing it immediately. If loadWorkingFile throws (e.g. the
   * working file path is missing/invalid), discard the broken instance and roll
   * the viewer registry back to whatever was viewed before — otherwise the viewer
   * is left pointing at an empty instance while the webview keeps showing the
   * previously-loaded workflow, and subsequent prompts get sent to the wrong place.
   */
  private async loadFreshInstanceAndReplay(
    filePath: string,
    clientId: string,
    send: (message: unknown) => void,
    options?: { skipReplay?: boolean }
  ): Promise<void> {
    const previousViewedId = this.getViewedWorkflowId(clientId);
    const instance = this.buildWorkflowInstance();
    this.instances.set(instance.id, instance);
    this.setViewedWorkflowId(clientId, instance.id);
    try {
      await instance.loadWorkingFile(filePath);
    } catch (error) {
      this.instances.delete(instance.id);
      this.setViewedWorkflowId(clientId, previousViewedId);
      throw error;
    }
    if (!options?.skipReplay) {
      await this.replayWorkflowStateTo(instance.id, send, clientId);
    }
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
    const workflowId =
      WorkflowPaths.parseWorkingFileAddressFromPath(workingFilePath)
        ?.workflowKey ?? "";
    if (!workflowId) {
      return false;
    }

    // Already tracked — nothing to do
    if (this.cliSessions.has(workflowId)) {
      return true;
    }

    const workspaceFolderPath = this.currentWorkspaceFolder?.uri.fsPath;
    if (!workspaceFolderPath) {
      return false;
    }

    const lockStatus = await WorkflowLockManager.checkLock(
      workspaceFolderPath,
      workflowId
    );
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
    await this.context.workspaceState.update("ctrlyoke.loadedWorkflows", []);
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
          [HARNESS_IDS.CLAUDE_CLI]: "Claude Code CLI",
          [HARNESS_IDS.CODEX_CLI]: "Codex CLI",
          [HARNESS_IDS.COPILOT_CLI]: "Copilot CLI",
          [HARNESS_IDS.OPENCODE_CLI]: "OpenCode CLI",
          [HARNESS_IDS.QWEN_CLI]: "Qwen Code CLI",
          [HARNESS_IDS.ANTIGRAVITY_CLI]: "Antigravity CLI",
        }[integrationMode] || "Copilot CLI";
      Log.info(`🔄 Default integration: ${modeLabel}`);

      await Promise.all([
        this.copilotCliIntegration.initialize(),
        this.claudeCliIntegration.initialize(),
        this.codexCliIntegration.initialize(),
        this.openCodeCliIntegration.initialize(),
        this.qwenCliIntegration.initialize(),
        this.antigravityCliIntegration.initialize(),
      ]);

      if (this.currentWorkspaceFolder) {
        await this.workspaceSessionManager.discoverPromptFiles(
          this.currentWorkspaceFolder.uri.fsPath
        );
        // Must run after harness init and before auto-load so stale RUNNING files
        // are normalized and CLI-managed workflows are registered.
        await this.setupCliWatching();
        await this.discoverWorktreesOnActivation();
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
      notifyUserFeedback(
        this.userFeedbackSink,
        USER_FEEDBACK_SEVERITY.ERROR,
        `ctrlyoke: Initialization failed: ${error}`
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

  /**
   * Mark ctrlyoke as not yet initialized in this workspace. Blocks startup
   * auto-load and broadcasts WORKSPACE_INIT_REQUIRED to the webview instead of
   * STARTUP_COMPLETE until handleInitializeWorkspace() is called.
   */
  setWorkspaceInitPending(workspaceRoot: string): void {
    this.workspaceInitPending = true;
    this.pendingInitWorkspaceRoot = workspaceRoot;
    Log.info(
      `ctrlyoke: Workspace initialization pending for "${workspaceRoot}"`
    );
  }

  /**
   * Called when the user approves ctrlyoke initialization from the dashboard.
   * Creates the .ctrlyoke/ directory scaffold, then resumes the normal
   * startup sequence (triggers auto-load and broadcasts STARTUP_COMPLETE).
   */
  async handleInitializeWorkspace(): Promise<void> {
    const workspaceRoot =
      this.pendingInitWorkspaceRoot ?? this.currentWorkspaceFolder?.uri.fsPath;

    if (!workspaceRoot) {
      Log.warn(
        "ctrlyoke: handleInitializeWorkspace called with no workspace root"
      );
      return;
    }

    let isNew = false;
    try {
      isNew = await WorkspaceInitializer.initializeIfNeeded(workspaceRoot);
      // .ctrlyoke/ now exists — start file logging for this session.
      Log.enableWorkspaceFileLogging();
    } catch (err) {
      Log.warn("ctrlyoke: Workspace initialization failed:", err);
    }

    this.workspaceInitPending = false;
    this.pendingInitWorkspaceRoot = undefined;
    this.layoutPreferencePending = isNew;
    await this.triggerStartupAutoLoadIfReady();
  }

  /**
   * Called when the user dismisses the first-install layout tip. Resumes startup.
   */
  async handleLayoutPreference(): Promise<void> {
    this.layoutPreferencePending = false;
    await this.triggerStartupAutoLoadIfReady();
  }

  async setDashboardReady(panelSend?: (msg: unknown) => void): Promise<void> {
    Log.info("✅ Dashboard is ready");
    this.dashboardReady = true;
    if (!this.dashboardReadyAt) {
      this.dashboardReadyAt = Date.now();
    }

    if (panelSend) {
      this.storedPanelSend = panelSend;
      if (this._autoLoadHasSettled) {
        // Startup already finished (webview reload or reconnect) — replay now so
        // the panel re-hydrates immediately. Skip terminal replay: the READY
        // handler's PTY reconnect loop sends TERMINAL_STARTED + reconnect buffers.
        const viewedId = this.getViewedWorkflowId(this.PANEL_CLIENT_ID);
        if (viewedId) {
          await this.replayWorkflowStateTo(
            viewedId,
            panelSend,
            this.PANEL_CLIENT_ID,
            { skipTerminalReplay: true }
          );
        }
      }
      // If startup is still in progress (!_autoLoadHasSettled), skip the replay
      // here. The first READY's handleClientReady handles the initial replay;
      // subsequent READY messages (App.tsx, CLIENT_ID_ASSIGNED) are suppressed by
      // the panelStartupReplayedWorkflowId guard. triggerAutoLoad skips the replay
      // when handleClientReady has already sent one for the same workflowId.
    }

    // Snapshot the instance startup hydration left the panel on, so a deferred
    // auto-load can tell whether the view has since moved. Re-recorded on each
    // pre-settle READY (the panel sends three during boot, and the first can land
    // before handleClientReady has finished hydrating the persisted view — a stale
    // null here would read as "the user moved it" on a perfectly healthy startup).
    // Frozen once startup settles so a later reconnect can't rewrite history.
    if (!this._autoLoadHasSettled) {
      this.startupPanelViewedId = this.getViewedWorkflowId(
        this.PANEL_CLIENT_ID
      );
    }

    if (this.orchestratorInitialized) {
      await this.triggerStartupAutoLoadIfReady();
    } else {
      Log.debug(
        "Orchestrator not yet initialized — deferring auto-load until init completes"
      );
    }
  }

  /**
   * True once `initialize()` has finished. Commands that *start* execution are
   * refused until then: nothing in ctrlyoke ever auto-starts a workflow, so a
   * run-starting command arriving mid-startup is a replayed/stray one (a hosted
   * client flushing a queued click across an extension-host restart is the
   * known case), and honoring it launches AI work the user never asked for.
   */
  isInitialized(): boolean {
    return this.orchestratorInitialized;
  }

  private async triggerStartupAutoLoadIfReady(): Promise<void> {
    if (
      this.startupAutoLoadTriggered ||
      !this.dashboardReady ||
      !this.orchestratorInitialized
    ) {
      return;
    }

    if (this.workspaceInitPending) {
      this.dashboardBroadcastHub.postMessage({
        type: MESSAGE_TYPES.WORKSPACE_INIT_REQUIRED,
      });
      return;
    }

    if (this.layoutPreferencePending) {
      this.dashboardBroadcastHub.postMessage({
        type: MESSAGE_TYPES.SHOW_LAYOUT_TIP,
      });
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
        const panelViewedId = this.getViewedWorkflowId(this.PANEL_CLIENT_ID);
        const panelViewed = panelViewedId
          ? (this.instances.get(panelViewedId) ??
            this.retiredInstances.get(panelViewedId))
          : null;
        const panelWorkingFilePath = panelViewed?.getSummary().workingFilePath;

        // The user moved the view while this auto-load sat behind initialize().
        // Loading the most-recent session now would land in *their* instance
        // (getActiveInstance() follows the panel), overwriting the workflow they
        // just created or opened. Their choice wins; the recent session stays on
        // disk and is still reachable from the workflow dropdown.
        if (panelViewedId && panelViewedId !== this.startupPanelViewedId) {
          Log.info(
            `triggerAutoLoad: skipping auto-load — panel view moved during startup ` +
              `(inst:${this.startupPanelViewedId?.slice(0, 8) ?? "null"} → inst:${panelViewedId.slice(0, 8)}); ` +
              `keeping the user's workflow`
          );
          loadedWorkflowId = panelViewedId;
          return;
        }

        if (panelViewedId && panelWorkingFilePath) {
          Log.debug(
            `triggerAutoLoad: keeping panel's persisted workflow "${path.basename(panelWorkingFilePath)}" instead of loading most recent`
          );
          loadedWorkflowId = panelViewedId;
          // Replay state to the panel now that startup is complete. Skip the replay
          // if handleClientReady already sent a successful startup replay for this
          // same workflow — replaying again would send SESSION_RESTORED which clears
          // historyOutputs and causes a visible output flash.
          const alreadyReplayed =
            this.panelStartupReplayedWorkflowId === panelViewedId;
          if (!alreadyReplayed && this.storedPanelSend) {
            await this.replayWorkflowStateTo(
              panelViewedId,
              this.storedPanelSend,
              this.PANEL_CLIENT_ID
            );
          } else if (alreadyReplayed) {
            Log.debug(
              `triggerAutoLoad: skipping panel replay — already replayed during startup for inst:${panelViewedId.slice(0, 8)}`
            );
          }
          return;
        }
        Log.debug("Triggering auto-load of recent session");

        await this.workspaceSessionManager.autoLoadRecentSession(
          this.currentWorkspaceFolder.uri.fsPath,
          async (workingFilePath: string) => {
            // Skip auto-loading if this working file is actively managed by the CLI.
            // The CliWatchSession was already created in setupCliWatching(), so the
            // workflow is already visible in the Running section — auto-loading it
            // as a VS Code instance would create a conflicting viewedInstance.
            const address =
              WorkflowPaths.parseWorkingFileAddressFromPath(workingFilePath);
            const lockStatus = address
              ? await WorkflowLockManager.checkLock(
                  this.currentWorkspaceFolder!.uri.fsPath,
                  address.workflowKey
                )
              : LOCK_STATUS.NONE;
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
            // + OUTPUT_HISTORY_LOADED). This is required because
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
            // Capture the loaded workflow ID so the finally block can resolve
            // the promise and browser clients can replay the correct session.
            loadedWorkflowId = instance.id;
          }
        );
      }
    } finally {
      // The panel's WORKFLOW_PROPERTIES_UPDATE / WORKFLOW_LOADED follow-up must
      // fire on every exit path, not just the two that load something: the
      // webview treats WORKFLOW_LOADED as "startup settled, editing is safe", so
      // a path that settled without it (no recent session found, auto-load
      // disabled, the user-took-over skip above, or a thrown error) left the
      // properties panel disabled with no second chance. Ordered before the
      // broadcast so STARTUP_COMPLETE stays the last startup message.
      if (this.storedPostAutoLoadCallback) {
        const callback = this.storedPostAutoLoadCallback;
        this.storedPostAutoLoadCallback = undefined;
        try {
          await callback();
        } catch (error) {
          Log.error("[startup] post-auto-load callback failed:", error);
        }
      }

      // Always settle the promise and broadcast STARTUP_COMPLETE, regardless of
      // whether a session was found or an exception occurred. This ensures:
      // - Browser clients awaiting awaitStartupAutoLoad() unblock immediately.
      // - The webview overlay lifts via hub broadcast (panel fresh startup).
      const readyToCompleteMs = this.dashboardReadyAt
        ? Date.now() - this.dashboardReadyAt
        : -1;
      Log.debug(
        `[startup] Broadcasting STARTUP_COMPLETE — session: ${loadedWorkflowId ?? "none"}, READY→COMPLETE: ${readyToCompleteMs}ms`
      );
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
    modeOverride?: HarnessId,
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

    return instance.executeLoadedPromptFile(modeOverride, continueFromCurrent);
  }

  async executeLoadedPromptFile(
    modeOverride?: HarnessId,
    continueFromCurrent?: boolean
  ): Promise<void> {
    return this.executeWorkflow(undefined, modeOverride, continueFromCurrent);
  }

  async executePromptFile(
    filePath: string,
    modeOverride?: HarnessId
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

  /**
   * A run-addressed mutation re-routes this legacy "Queue from File" action
   * through the addressed continuation contract: a promoted run has no
   * pending queue to append into, so appending necessarily means running the
   * new tail. Draft/ephemeral targets keep the original instance-bound
   * queue-only behavior.
   */
  async appendFromFileForClient(
    mutation: WorkflowDefinitionMutation | undefined,
    filePath: string,
    clientId: string,
    position?: QueuePosition
  ): Promise<void> {
    if (!mutation || mutation.address.kind !== "run") {
      return this.getInstanceForClient(clientId).appendFromFile(
        filePath,
        position
      );
    }
    const parsed = await this.promptFileParser.parsePromptFile(filePath);
    if (!parsed?.steps?.length) {
      throw new Error("No steps found in file");
    }
    await this.appendAndContinueAtRun(
      mutation.address,
      parsed.steps,
      mutation.expectedDefinitionRevision,
      mutation.expectedDescriptorRevision,
      clientId
    );
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

  /** Runtime controls resolve the live instance from its stable execution address. */
  async pauseAtRun(address: WorkflowRunAddress): Promise<void> {
    return this.getExecutionInstanceAtRun(address).pause();
  }

  async cancelPauseAtRun(address: WorkflowRunAddress): Promise<void> {
    return this.getExecutionInstanceAtRun(address).cancelPause();
  }

  async resumeAtRun(address: WorkflowRunAddress): Promise<void> {
    return this.getExecutionInstanceAtRun(address).resume();
  }

  async stopAtRun(address: WorkflowRunAddress): Promise<void> {
    return this.getExecutionInstanceAtRun(address).stop();
  }

  private getExecutionInstanceAtRun(
    address: WorkflowRunAddress
  ): WorkflowInstance {
    const instance = [...this.instances.values()].find((candidate) => {
      const state = candidate.getQueueState();
      return (
        state.workflowKey === address.workflowKey &&
        state.runRef === address.runRef
      );
    });
    if (!instance) {
      throw new Error("The requested run is no longer executing");
    }
    return instance;
  }

  /**
   * Pause a specific workflow by ID.
   * Used by per-workflow controls in the dropdown; allows pausing non-active instances.
   *
   * @keep Standalone server API; see dev/backlog/STANDALONE_SERVER_PLAN.md.
   */
  async pauseWorkflow(workflowId: string): Promise<void> {
    const instance = this.instances.get(workflowId);
    if (!instance) {
      Log.warn(
        `pauseWorkflow: inst:${workflowId.slice(0, 8)} not found in registry`
      );
      return;
    }
    Log.debug(`pauseWorkflow: inst:${workflowId.slice(0, 8)}`);
    return instance.pause();
  }

  /**
   * Cancel a pending pause for a specific workflow by ID.
   *
   * @keep Standalone server API; see dev/backlog/STANDALONE_SERVER_PLAN.md.
   */
  async cancelPauseWorkflow(workflowId: string): Promise<void> {
    const instance = this.instances.get(workflowId);
    if (!instance) {
      Log.warn(
        `cancelPauseWorkflow: inst:${workflowId.slice(0, 8)} not found in registry`
      );
      return;
    }
    Log.debug(`cancelPauseWorkflow: inst:${workflowId.slice(0, 8)}`);
    return instance.cancelPause();
  }

  /**
   * Resume a specific workflow by ID.
   * Used by per-workflow controls in the dropdown; allows resuming non-active instances.
   *
   * @param workingFilePath - Working file path forwarded from the webview. Used as a
   *   fallback when the instance has been evicted from retiredInstances (e.g. after a
   *   panel hide/show cycle disposed it). Reloads from disk so the resume can proceed.
   * @keep Standalone server API; see dev/backlog/STANDALONE_SERVER_PLAN.md.
   */
  async resumeWorkflow(
    workflowId: string,
    workingFilePath?: string
  ): Promise<void> {
    let instance = this.findInstance(workflowId);
    if (!instance) {
      if (workingFilePath && this.storedPanelSend) {
        // Instance was evicted from retiredInstances. Reload from the working file so
        // the resume can proceed. loadWorkflowForClient handles deduplication (reuses
        // any existing retired instance by file path) and replays state to the panel.
        Log.debug(
          `resumeWorkflow: inst:${workflowId.slice(0, 8)} not found — reloading from ${path.basename(workingFilePath)}`
        );
        await this.loadWorkflowForClient(
          workingFilePath,
          this.storedPanelSend,
          this.PANEL_CLIENT_ID
        );
        instance = [...this.retiredInstances.values()].find((w) =>
          sameWorkingFilePath(w.getSummary().workingFilePath, workingFilePath)
        );
        if (!instance) {
          Log.warn(
            `resumeWorkflow: inst:${workflowId.slice(0, 8)} reload from working file produced no instance`
          );
          return;
        }
      } else {
        Log.warn(
          `resumeWorkflow: inst:${workflowId.slice(0, 8)} not found in registry`
        );
        return;
      }
    }
    // If the instance is retired (terminal state reached but still alive),
    // remove it from retiredInstances so it can re-register in this.instances
    // when it transitions to RUNNING/PAUSED via the onDidChangeState listener.
    if (this.retiredInstances.has(instance.id)) {
      this.retiredInstances.delete(instance.id);
    }
    Log.debug(`resumeWorkflow: inst:${workflowId.slice(0, 8)}`);
    return instance.resume();
  }

  /**
   * Stop a specific workflow by ID.
   * Used by per-workflow controls in the dropdown; allows stopping non-active instances.
   *
   * @keep Standalone server API; see dev/backlog/STANDALONE_SERVER_PLAN.md.
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

    const workspaceFolderPath = this.currentWorkspaceFolder?.uri.fsPath;
    const lock = workspaceFolderPath
      ? await WorkflowLockManager.readLock(
          workspaceFolderPath,
          workflowId as WorkflowKey
        )
      : null;
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
    const instance = this.registerNewInstance(clientId);
    await this.replayWorkflowStateTo(instance.id, send, clientId);
  }

  /**
   * Create a fresh workflow instance seeded from an already-substituted
   * template, for either the panel or a browser client. There is no durable
   * source file — the working file created here is the only artifact, with
   * `originalFile` left undefined so Save As is the only way to export a copy.
   */
  async createWorkflowFromTemplateForClient(
    promptFile: PromptFile,
    displayName: string,
    send: (msg: unknown) => void,
    clientId: string
  ): Promise<WorkflowInstance> {
    const instance = this.registerNewInstance(clientId);
    await instance.loadFromTemplate(promptFile, displayName);
    await this.replayWorkflowStateTo(instance.id, send, clientId);
    return instance;
  }

  /**
   * Load a workspace prompt file into a fresh instance for one client.
   *
   * The client-scoped counterpart of {@link loadPromptFile}, which always
   * retargets the VS Code panel. "Load from File" names a *source* file (the
   * standalone file picker and the workspace-editor context menu both do), so
   * this goes through `loadPromptFile` to create the lineage's draft — not
   * through `loadWorkflowForClient`, which expects an existing working file
   * under run storage.
   */
  async loadPromptFileForClient(
    filePath: string,
    send: (msg: unknown) => void,
    clientId: string
  ): Promise<WorkflowInstance> {
    const instance = this.registerNewInstance(clientId);
    await instance.loadPromptFile(filePath);
    await this.replayWorkflowStateTo(instance.id, send, clientId);
    return instance;
  }

  /** Build a fresh workflow instance, register it, and make it the client's viewed workflow. */
  private registerNewInstance(clientId: string): WorkflowInstance {
    const instance = this.buildWorkflowInstance();
    this.instances.set(instance.id, instance);
    this.setViewedWorkflowId(clientId, instance.id);
    return instance;
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
    options?: {
      skipTerminalReplay?: boolean;
      preferredViewAddress?: WorkflowViewAddress;
    }
  ): Promise<void> {
    this.registerClient(clientId, send);

    // For the panel, suppress duplicate replays after the first one during startup.
    // Multiple READY messages arrive during startup (BootstrapApp → App.tsx →
    // CLIENT_ID_ASSIGNED), and each replay sends SESSION_RESTORED which clears
    // historyOutputs, causing a visible output flash before OUTPUT_HISTORY_LOADED
    // restores it. After _autoLoadHasSettled, replays are always allowed (reconnect /
    // webview reload).
    const skipPanelStartupReplay =
      clientId === this.PANEL_CLIENT_ID &&
      !this._autoLoadHasSettled &&
      this.panelStartupReplayedWorkflowId !== null;

    if (options?.preferredViewAddress) {
      try {
        await this.loadRunViewForClient(
          options.preferredViewAddress,
          send,
          clientId,
          undefined,
          undefined,
          true
        );
        // Record the replayed workflowId after the first successful panel startup replay.
        if (
          !skipPanelStartupReplay &&
          clientId === this.PANEL_CLIENT_ID &&
          !this._autoLoadHasSettled
        ) {
          const replayedId = this.getViewedWorkflowId(this.PANEL_CLIENT_ID);
          if (replayedId) this.panelStartupReplayedWorkflowId = replayedId;
        }
        send({
          type: MESSAGE_TYPES.WORKFLOWS_LIST,
          workflows: this.getWorkflowSummaries(),
        });
        return;
      } catch (error) {
        Log.warn(
          `handleClientReady: preferred view is not available, falling back: ${JSON.stringify(options.preferredViewAddress)}`,
          error
        );
      }
    }
    let viewedId = this.getViewedWorkflowId(clientId);

    // Browser clients connecting for the first time have no viewed workflow.
    // Re-check the queue on disk at READY time so reconnects without persisted
    // tab state fall back to the actual most recently modified workflow, not
    // whatever the panel happened to load earlier in the session.
    if (!viewedId && clientId !== this.PANEL_CLIENT_ID) {
      const workspaceFolderPath = this.currentWorkspaceFolder?.uri.fsPath;
      if (workspaceFolderPath) {
        const mostRecentWorkingFilePath =
          await this.workspaceSessionManager.getMostRecentWorkingFilePath(
            workspaceFolderPath
          );
        if (mostRecentWorkingFilePath) {
          await this.loadWorkflowForClient(
            mostRecentWorkingFilePath,
            send,
            clientId
          );
          send({
            type: MESSAGE_TYPES.WORKFLOWS_LIST,
            workflows: this.getWorkflowSummaries(),
          });
          return;
        }
      }

      // If there is no recent working file on disk, fall back to whatever the
      // panel is currently viewing so browser clients still inherit some state.
      viewedId = this.getViewedWorkflowId(this.PANEL_CLIENT_ID);
    }

    if (viewedId) {
      if (!skipPanelStartupReplay) {
        await this.replayWorkflowStateTo(viewedId, send, clientId, options);
        // Record the replayed workflowId after the first successful panel startup replay.
        if (clientId === this.PANEL_CLIENT_ID && !this._autoLoadHasSettled) {
          this.panelStartupReplayedWorkflowId = viewedId;
        }
      } else {
        Log.debug(
          `handleClientReady: skipping duplicate panel startup replay for inst:${viewedId.slice(0, 8)}`
        );
      }
    }
    send({
      type: MESSAGE_TYPES.WORKFLOWS_LIST,
      workflows: this.getWorkflowSummaries(),
    });
  }

  getQueueState(clientId: string): QueueState {
    return this.getInstanceForClient(clientId).getQueueState();
  }

  /**
   * Build one dry-run snapshot from the definition currently addressed by a
   * dashboard client. The addressed file is read at request time so external
   * and unsaved working-file changes are included; no preview state is cached.
   */
  async buildExecutionPreviewForClient(
    clientId: string,
    scope: ExecutionPreviewScope,
    editorSnapshot?: import("../types/WebviewMessageTypes").ExecutionPreviewEditorSnapshot
  ): Promise<{
    address: WorkflowViewAddress;
    displayedDefinitionRevision: number;
    preview: import("../types/ExecutionPreviewTypes").WorkflowExecutionPreview;
  }> {
    const instance =
      clientId === this.PANEL_CLIENT_ID
        ? this.getActiveInstance()
        : this.getBoundInstance(clientId);
    const state = instance?.getQueueState();
    const address = this.getViewAddress(clientId) ?? lineageAddressOf(state);
    if (!address) {
      throw new Error("No workflow is loaded");
    }

    const sourcePath = this.getViewFilePath(clientId);
    const instanceAddress = lineageAddressOf(state);
    const canUseCurrentInstanceState =
      !!instance &&
      (sourcePath === null || sameViewAddress(address, instanceAddress));
    let workflow: WorkingFile | undefined;
    if (sourcePath) {
      try {
        workflow = JSON.parse(
          await fs.promises.readFile(sourcePath, "utf8")
        ) as WorkingFile;
      } catch (error) {
        if (!canUseCurrentInstanceState) {
          throw error;
        }
      }
    }
    if (!workflow && canUseCurrentInstanceState && instance) {
      const queueWorkflow = instance.promptQueue.getWorkflowFile();
      workflow = {
        ...queueWorkflow,
        workflowName: state?.workflowName ?? "",
        startedAt: 0,
        definitionRevision: state?.definitionRevision ?? 1,
        steps: state?.steps ?? queueWorkflow.steps ?? [],
      };
    }
    if (!workflow) {
      throw new Error("The addressed workflow file is unavailable");
    }

    // Queue edits are the in-memory editor state. Overlay them only when the
    // instance owns this exact addressed lineage; a client browsing an older
    // run must remain sourced from that run's working file.
    if (canUseCurrentInstanceState && instance && state) {
      workflow = {
        ...workflow,
        ...instance.promptQueue.getWorkflowFile(),
        steps: state.steps,
        // getWorkflowFile() is typed as PromptFile but the object behind it
        // is the WorkingFile captured at load time, so its definitionRevision
        // is frozen at whatever the file held on load — updateWorkflowProperty
        // patches individual keys into that same object without ever
        // advancing this one. state.definitionRevision is the queue's live
        // counter (kept current by setDefinitionRevision on every property
        // write) and is what the dry-run response must report, or every
        // preview after the first property edit permanently reads as stale.
        definitionRevision: state.definitionRevision,
      };
    }

    // The editor is intentionally local until Update is pressed. Overlay its
    // one-shot snapshot so a dry run answers the question the user just asked,
    // including unsaved text and property changes, without mutating the queue
    // or working file.
    if (editorSnapshot) {
      workflow = { ...workflow };
      if (editorSnapshot.isFinalStep) {
        workflow.finalStep = editorSnapshot.step;
      } else if (
        editorSnapshot.stepIndex !== undefined &&
        editorSnapshot.stepIndex >= 0 &&
        editorSnapshot.stepIndex <= (workflow.steps ?? []).length
      ) {
        const steps = [...(workflow.steps ?? [])];
        steps[editorSnapshot.stepIndex] = editorSnapshot.step;
        workflow.steps = steps;
      }
    }

    const workspaceRoot = this.requireWorkspaceRoot();
    const platform = new VsCodeAdapter(this.context);
    const previewSourcePath = sourcePath ?? state?.workingFilePath;
    const outputHistoryManager = this.getOutputHistoryManager();
    const historyFilePath =
      address.kind === "run"
        ? outputHistoryManager.getHistoryFilePath(
            address.workflowKey,
            address.runRef
          )
        : "";
    const service = new ExecutionPreviewService({
      defaults: PropertyResolver.createContext({ hostCanProvidePty: true })
        .defaults,
      capabilities: await this.compatibilityRegistry.getSnapshot(),
      getHarness: (harnessId, executionWorkspace) =>
        this.getExecutionPreviewHarness(harnessId, executionWorkspace),
      workspaceRoot,
      workspaceRoots: platform.getWorkspaceRoots(),
      approvedExternalRoots:
        platform.getApprovedExternalFileRoots?.(workspaceRoot),
      namedWorkspaceRoots: platform.getNamedWorkspaceRoots(),
      extensionPath: platform.getExtensionPath(),
      hostCanProvidePty: true,
      cwd: workspaceRoot,
      platform: process.platform,
      dynamicQueueConfig: ConfigurationUtils.getDynamicQueueConfig(),
      secretStore: platform.getSecretStore?.(),
      resolvePriorContextItems: createPriorContextResolver({
        workspaceRoot,
        historyFilePath,
        outputResolver: outputHistoryManager.getRunOutputResolver(),
      }),
    });
    const preview = await service.build({
      workflow,
      scope,
      workflowName: workflow.workflowName,
      sourcePath: previewSourcePath,
      sourceDefinitionPath:
        (await this.getViewSourceDefinitionPath(clientId)) ?? undefined,
      workingFilePath: previewSourcePath,
      definitionRevision: workflow.definitionRevision,
    });
    return {
      address,
      displayedDefinitionRevision: workflow.definitionRevision,
      preview,
    };
  }

  /**
   * Resolve the shared planning helpers for one harness. The ordinary path
   * reuses the long-lived per-harness singletons created at startup. When a
   * worktree-remapped `executionWorkspace` is supplied (see
   * `ExecutionPreviewService.buildWorktreePreview`), those singletons cannot
   * be reused — they are bound to the default no-worktree workspace for the
   * lifetime of the extension — so a throwaway preview-only integration is
   * constructed for just this call via `IntegrationFactory.createForPreview`,
   * the same no-side-effect seam the standalone CLI binary's dry run uses.
   */
  private getExecutionPreviewHarness(
    harnessId: HarnessId,
    executionWorkspace?: ExecutionWorkspace
  ): ExecutionPreviewHarness {
    if (executionWorkspace) {
      return this.integrationFactory
        .createForPreview(harnessId, executionWorkspace)
        .getExecutionPreviewHarness();
    }
    switch (harnessId) {
      case HARNESS_IDS.CLAUDE_CLI:
        return this.claudeCliIntegration.getExecutionPreviewHarness();
      case HARNESS_IDS.CODEX_CLI:
        return this.codexCliIntegration.getExecutionPreviewHarness();
      case HARNESS_IDS.OPENCODE_CLI:
        return this.openCodeCliIntegration.getExecutionPreviewHarness();
      case HARNESS_IDS.QWEN_CLI:
        return this.qwenCliIntegration.getExecutionPreviewHarness();
      case HARNESS_IDS.ANTIGRAVITY_CLI:
        return this.antigravityCliIntegration.getExecutionPreviewHarness();
      case HARNESS_IDS.COPILOT_CLI:
      default:
        return this.copilotCliIntegration.getExecutionPreviewHarness();
    }
  }

  getViewAddress(clientId: string): WorkflowViewAddress | null {
    return this.getViewAddressRegistry().get(clientId) ?? null;
  }

  /**
   * Return the authored source definition for a client's addressed lineage.
   * This deliberately reads the lineage descriptor rather than deriving a
   * semantic base from the draft/run working-copy path in run storage.
   */
  async getViewSourceDefinitionPath(clientId: string): Promise<string | null> {
    const address = this.getViewAddress(clientId);
    const workspaceRoot = this.currentWorkspaceFolder?.uri.fsPath;
    if (!address || !workspaceRoot) {
      return null;
    }

    try {
      const descriptor = await this.lineageRepository.readDescriptor(
        workspaceRoot,
        address.workflowKey
      );
      return descriptor.originalFile ?? null;
    } catch (error) {
      Log.debug(
        `[WorkflowOrchestrator] Could not read source definition for ${clientId}: ${getErrorMessage(error)}`
      );
      return null;
    }
  }

  /**
   * Current address and revisions of a client's editing target, read from disk.
   *
   * Every definition write advances `definitionRevision`, and a client that
   * does not learn the new value fails its *next* optimistic mutation. The
   * caller publishes this after a write so cheap mutation paths stay addressable
   * without paying for a full `RUN_VIEW_LOADED` snapshot.
   */
  /**
   * The definition file a client is *viewing*, which is not always the file its
   * bound instance owns: `loadRunViewForClient` moves the address without
   * rebinding an executor, so anything that reads a client's current definition
   * must resolve it from the address. Reading `getQueueState(clientId)` instead
   * returns the previously bound workflow's file — or none at all.
   */
  getViewFilePath(clientId: string): string | null {
    const address = this.getViewAddress(clientId);
    const workspaceRoot = this.currentWorkspaceFolder?.uri.fsPath;
    if (!address || !workspaceRoot) {
      return null;
    }
    return this.resolveAddressFilePath(workspaceRoot, address);
  }

  /** The definition file an address names. Sole place layout is applied. */
  private resolveAddressFilePath(
    workspaceRoot: string,
    address: WorkflowViewAddress
  ): string {
    return address.kind === "draft"
      ? WorkflowPaths.draftFilePath(workspaceRoot, address.workflowKey)
      : WorkflowPaths.runFilePath(
          workspaceRoot,
          address.workflowKey,
          address.runRef
        );
  }

  private resolveAddressDirectory(
    workspaceRoot: string,
    address: WorkflowViewAddress
  ): string {
    return address.kind === "draft"
      ? WorkflowPaths.draftDir(workspaceRoot, address.workflowKey)
      : WorkflowPaths.runDir(
          workspaceRoot,
          address.workflowKey,
          address.runRef
        );
  }

  async getViewIdentity(
    clientId: string
  ): Promise<WorkflowViewIdentityMessage | null> {
    const address = this.getViewAddress(clientId);
    const filePath = this.getViewFilePath(clientId);
    const workspaceRoot = this.currentWorkspaceFolder?.uri.fsPath;
    if (!address || !filePath || !workspaceRoot) {
      return null;
    }
    try {
      const [content, descriptor] = await Promise.all([
        fs.promises.readFile(filePath, "utf8"),
        this.lineageRepository.readDescriptor(
          workspaceRoot,
          address.workflowKey
        ),
      ]);
      return {
        type: MESSAGE_TYPES.WORKFLOW_VIEW_IDENTITY,
        address,
        runDirectory: this.resolveAddressDirectory(workspaceRoot, address),
        definitionRevision:
          (JSON.parse(content) as WorkingFile).definitionRevision ?? 1,
        descriptorRevision: descriptor.revision,
      };
    } catch (error) {
      Log.warn(
        `[WorkflowOrchestrator] Could not resolve view identity for ${clientId}: ${getErrorMessage(error)}`
      );
      return null;
    }
  }

  /**
   * Publishes one client's authoritative identity to **every** client viewing
   * the same address, not just the client whose action produced the write.
   *
   * `definitionRevision` is per-address optimistic-concurrency state, so a
   * write made by client A supersedes the revision every other viewer of that
   * address is holding. Publishing only to the actor left those viewers armed
   * with a stale revision, and their next edit — or their next Run — was
   * rejected as a conflict with no way to recover short of reloading the view.
   */
  async publishViewIdentityToViewers(
    clientId: string
  ): Promise<WorkflowViewIdentityMessage | null> {
    const identity = await this.getViewIdentity(clientId);
    if (!identity) return null;
    for (const [otherId, send] of this.getViewMessageSinks()) {
      if (otherId === clientId) continue;
      if (sameViewAddress(this.getViewAddress(otherId), identity.address)) {
        send(identity);
      }
    }
    return identity;
  }

  /** Defensive for lightweight unit-test instances created without constructors. */
  private getViewAddressRegistry(): Map<string, WorkflowViewAddress | null> {
    const initialized = this.viewAddressRegistry;
    if (initialized) {
      return initialized;
    }
    const partial = this as unknown as {
      viewAddressRegistry?: Map<string, WorkflowViewAddress | null>;
    };
    return (partial.viewAddressRegistry ??= new Map());
  }

  private getViewMessageSinks(): Map<string, (message: unknown) => void> {
    const initialized = this.viewMessageSinks;
    if (initialized) return initialized;
    const partial = this as unknown as {
      viewMessageSinks?: Map<string, (message: unknown) => void>;
    };
    return (partial.viewMessageSinks ??= new Map());
  }

  /** Defensive for lightweight unit-test instances created without constructors. */
  private getLineageBindingClients(): Set<string> {
    const initialized = this.lineageBindingClients;
    if (initialized) return initialized;
    const partial = this as unknown as { lineageBindingClients?: Set<string> };
    return (partial.lineageBindingClients ??= new Set());
  }

  /**
   * lineage → the instance most recently prepared to execute it. Entries are
   * only ever read as a tie-break between *resident* instances, so one going
   * stale (its instance disposed) is inert rather than wrong, and a lineage
   * never accumulates more than one entry.
   *
   * Defensive for lightweight unit-test instances created without constructors.
   */
  private getLineageExecutionOwners(): Map<WorkflowKey, LineageExecutionClaim> {
    const initialized = this.lineageExecutionOwners;
    if (initialized) return initialized;
    const partial = this as unknown as {
      lineageExecutionOwners?: Map<WorkflowKey, LineageExecutionClaim>;
    };
    return (partial.lineageExecutionOwners ??= new Map());
  }

  /**
   * Instances are lineage-scoped: viewing *any* run of a lineage binds to its
   * single runtime owner, so every run view renders the same TerminalView; the
   * addressed RunRef only controls the definition/history snapshot and its
   * live-run indicator.
   *
   * Ranked, because one lineage can hold several residents at once:
   *   1. an instance actually executing this lineage;
   *   2. the instance prepared to execute it (see
   *      {@link switchClientToPreparedExecution}), until that execution ends;
   *   3. any live instance;
   *   4. among retired, the one owning the lineage's running PTY, else the first.
   *
   * Both execution rules must outrank plain residency, and this is the whole
   * reason `lineageExecutionOwners` exists. A run action parks its incoming
   * instance in `retiredInstances` until the RUNNING transition promotes it, and
   * whatever the client was already bound to is a resident of the same lineage:
   * a *retired* one still owning the PTY being torn down (Re-run after a
   * completed run), or — when the client is merely browsing an older run of a
   * lineage nothing has executed this session — a *live* idle one. Both outrank
   * the incoming instance on residency alone. The failure is silent and reads as
   * a UI bug rather than a binding one: `replayWorkflowStateTo` binds the client
   * to the incoming instance and its own `loadRunViewForClient` immediately
   * rebinds it back (two `[setViewedWorkflowId]` lines back-to-back in the
   * session log, the second reverting), after which the executing run's
   * TERMINAL_STARTED and every output message carry a `workflowId` the client no
   * longer considers active and are dropped — the run executes to completion on
   * disk while the dashboard sits on the previously viewed run's history.
   */
  private findInstanceForLineage(
    workflowKey: WorkflowKey
  ): WorkflowInstance | undefined {
    const matches = (instance: WorkflowInstance) =>
      instance.getQueueState().workflowKey === workflowKey;
    // Live first so it wins every "first match" below. The maps are normally
    // disjoint, but a promotion that races a read can briefly leave an instance
    // in both, and a duplicate would corrupt the single-resident fast path.
    const live = [...this.instances.values()].filter(matches);
    const liveIds = new Set(live.map((instance) => instance.id));
    const retired = [...this.retiredInstances.values()].filter(
      (instance) => matches(instance) && !liveIds.has(instance.id)
    );
    const residents = [...live, ...retired];
    if (residents.length <= 1) {
      return residents[0];
    }

    const executing = residents.find((instance) =>
      isExecutionOwnerState(instance.getQueueState().status)
    );
    if (executing) {
      return executing;
    }

    // Only until the execution it describes finishes: nothing deletes these
    // entries, so a spent one would otherwise outrank a live instance forever.
    // The window this covers is real and unavoidable — a prepared instance has
    // not transitioned to RUNNING yet, so rule 1 cannot see it. Before that
    // transition (`!claim.promoted`) the instance's status can only be
    // leftover from *its own previous* execution — e.g. a continuation reusing
    // the run's own retired, COMPLETED instance — so it must not be read as
    // this claim already being spent.
    const claim = this.getLineageExecutionOwners().get(workflowKey);
    const prepared = residents.find((instance) => {
      if (!claim || instance.id !== claim.instanceId) return false;
      if (!claim.promoted) return true;
      return !isSpentExecutionOwnerState(instance.getQueueState().status);
    });
    if (prepared) {
      return prepared;
    }

    if (live.length > 0) {
      return live[0];
    }

    const activeTerminalOwnerIds = new Set(
      this.getActiveTerminalWorkflowRefs()
        .filter((ref) => ref.workflowKey === workflowKey)
        .map((ref) => ref.workflowId)
    );
    return (
      retired.find((instance) => activeTerminalOwnerIds.has(instance.id)) ??
      retired[0]
    );
  }

  /**
   * Moving a client's view address is not a read-only act. Everything
   * instance-scoped — the terminal pane's `workflowId`, live-message
   * filtering, prompt-editor execution, and every edit that still falls
   * through to `getInstanceForClient` — resolves through the client's *bound
   * instance*, not its address. Leaving that binding on the previously viewed
   * lineage is what made a switched-to workflow keep showing the old
   * workflow's terminals and then run the old workflow's steps and settings.
   *
   * Binding is lineage-scoped, never run-scoped: viewing an older run of a
   * lineage adopts the same instance that owns its executing run, so this can
   * neither fork a second instance for one lineage nor redirect an executor to
   * a different run. Only a lineage with no resident instance at all
   * materializes a fresh one.
   */
  private async bindClientToAddressedLineage(
    address: WorkflowViewAddress,
    send: (message: unknown) => void,
    clientId: string
  ): Promise<string | null> {
    const binding = this.getLineageBindingClients();
    // A nested client transition must not bind/replay the same lineage twice.
    if (binding.has(clientId)) return null;

    const boundId = this.getViewedWorkflowId(clientId);
    const resident = this.cliSessions.has(address.workflowKey)
      ? address.workflowKey
      : this.findInstanceForLineage(address.workflowKey)?.id;
    if (boundId === resident) return null;

    binding.add(clientId);
    try {
      // A CLI-managed lineage is registered under its workflowKey, not a UUID.
      if (resident) {
        this.setViewedWorkflowId(clientId, resident);
        return resident;
      }
      await this.loadFreshInstanceAndReplay(
        this.resolveAddressFilePath(this.requireWorkspaceRoot(), address),
        clientId,
        send,
        { skipReplay: true }
      );
      return this.getViewedWorkflowId(clientId);
    } finally {
      binding.delete(clientId);
    }
  }

  /**
   * Loads one addressed definition and its matching timeline as a single
   * client-local snapshot. It never calls loadWorkingFile() on an instance
   * owned by another run, so a client browsing an older run cannot change the
   * queue, watcher, lock, or harness environment of an execution in this
   * lineage.
   */
  async loadRunViewForClient(
    address: WorkflowViewAddress,
    send: (message: unknown) => void,
    clientId: string,
    requestId?: string,
    definitionRollback?: DefinitionRollbackInvalidation,
    announceReplayBoundary = false
  ): Promise<void> {
    const workspaceRoot = this.currentWorkspaceFolder?.uri.fsPath;
    if (!workspaceRoot) {
      throw new Error("No workspace folder is open");
    }

    const boundWorkflowId = await this.bindClientToAddressedLineage(
      address,
      send,
      clientId
    );
    const view = await this.readAddressedRunView(
      workspaceRoot,
      address,
      `request=${requestId ?? "none"}`
    );
    this.deliverRunView(
      address,
      view,
      send,
      clientId,
      boundWorkflowId,
      requestId,
      definitionRollback,
      announceReplayBoundary
    );
  }

  /**
   * Publishes one addressed view to several clients from a single set of disk
   * reads — the fan-out counterpart of `loadRunViewForClient`.
   *
   * The reads are address-derived and therefore identical per client (see
   * `AddressedRunView`), so looping `loadRunViewForClient` re-read every one of
   * them concurrently: for a lineage with N runs that is 2N manifest/working-file
   * reads *per client*, issued in the same millisecond. On the draft→run
   * promotion those reads land on a directory the executor has just created and
   * is actively writing, which is how a two-client first run reliably starved
   * the executor's own working-file write.
   *
   * Binding stays per client and runs first: it can materialize an instance that
   * loads the addressed file, so the shared read must observe the settled state.
   */
  private async publishRunViewToClients(
    address: WorkflowViewAddress,
    targets: ReadonlyArray<{
      clientId: string;
      send: (message: unknown) => void;
    }>,
    definitionRollback?: DefinitionRollbackInvalidation
  ): Promise<void> {
    if (targets.length === 0) {
      return;
    }
    const workspaceRoot = this.currentWorkspaceFolder?.uri.fsPath;
    if (!workspaceRoot) {
      throw new Error("No workspace folder is open");
    }

    const boundWorkflowIds = new Map<string, string | null>();
    for (const target of targets) {
      boundWorkflowIds.set(
        target.clientId,
        await this.bindClientToAddressedLineage(
          address,
          target.send,
          target.clientId
        )
      );
    }

    const view = await this.readAddressedRunView(
      workspaceRoot,
      address,
      `clients=${targets.length}`
    );

    for (const target of targets) {
      this.deliverRunView(
        address,
        view,
        target.send,
        target.clientId,
        boundWorkflowIds.get(target.clientId) ?? null,
        undefined,
        definitionRollback
      );
    }
  }

  /**
   * Reads every part of a run-view snapshot that depends only on the address.
   * The result is shared across clients by `publishRunViewToClients`, so it must
   * stay free of per-client state and must not be mutated by its consumers.
   */
  private async readAddressedRunView(
    workspaceRoot: string,
    address: WorkflowViewAddress,
    logContext: string
  ): Promise<AddressedRunView> {
    const startTime = Date.now();
    const addressLabel = `${address.workflowKey}/${address.kind === "run" ? address.runRef : "draft"}`;
    const logPrefix = `[readAddressedRunView] ${logContext} address=${addressLabel}`;

    const filePath = this.resolveAddressFilePath(workspaceRoot, address);
    const content = await fs.promises.readFile(filePath, "utf-8");
    const workingFile = JSON.parse(content) as WorkingFile;
    Log.debug(`${logPrefix} definition read at ${Date.now() - startTime}ms`);

    const historyManager = new OutputHistoryManager(workspaceRoot);
    const [history, runSummaries, descriptor] = await Promise.all([
      address.kind === "run"
        ? historyManager.loadHistory(
            historyManager.getHistoryFilePath(
              address.workflowKey,
              address.runRef
            )
          )
        : Promise.resolve(null),
      historyManager.getRunSummaries(address.workflowKey),
      this.lineageRepository.readDescriptor(workspaceRoot, address.workflowKey),
    ]);
    Log.debug(
      `${logPrefix} summaries/descriptor/history read at ${Date.now() - startTime}ms`
    );

    const { prompt, steps, finalStep, ...workflowProperties } = workingFile;
    void prompt;
    void steps;
    void finalStep;

    return {
      workingFile,
      history,
      runSummaries,
      workflowProperties,
      descriptorRevision: descriptor.revision,
      isSystemGenerated: descriptor.isSystemGenerated ?? false,
    };
  }

  /**
   * Applies one already-read addressed view to a single client: the registry
   * writes, the authoritative snapshot, and the live overlay that follows it.
   *
   * Deliberately synchronous — everything here is per-client in-memory work, so
   * a fan-out pays for the disk reads exactly once.
   */
  private deliverRunView(
    address: WorkflowViewAddress,
    view: AddressedRunView,
    send: (message: unknown) => void,
    clientId: string,
    boundWorkflowId: string | null,
    requestId?: string,
    definitionRollback?: DefinitionRollbackInvalidation,
    announceReplayBoundary = false
  ): void {
    const { workingFile } = view;
    const executionRunRef = this.findExecutionRunRef(address.workflowKey);
    const workspaceRoot = this.currentWorkspaceFolder?.uri.fsPath;
    this.getViewAddressRegistry().set(clientId, address);
    this.getViewMessageSinks().set(clientId, send);
    const snapshot: RunViewLoadedMessage = {
      type: MESSAGE_TYPES.RUN_VIEW_LOADED,
      requestId,
      address,
      ...(workspaceRoot
        ? { runDirectory: this.resolveAddressDirectory(workspaceRoot, address) }
        : {}),
      workingFile,
      history: view.history,
      runSummaries: view.runSummaries,
      workflowProperties: view.workflowProperties,
      executionRunRef,
      pendingRewind: workingFile._runtime?.pendingRewind,
      descriptorRevision: view.descriptorRevision,
      isSystemGenerated: view.isSystemGenerated,
      ...(definitionRollback &&
      (workingFile.definitionRevision ?? 1) ===
        definitionRollback.restoredRevision &&
      view.descriptorRevision === definitionRollback.descriptorRevision
        ? {
            definitionRollback: {
              fromRevision: definitionRollback.fromRevision,
            },
          }
        : {}),
    };

    // Only a live view can hold in-memory output the timeline read above could
    // have missed: the run that is actually executing, or a draft, which has no
    // persisted timeline of its own. Every other addressed run is *fully*
    // described by the history snapshot, so replaying the bound instance's
    // buffer there re-sends an earlier execution's output on top of it. This
    // must be evaluated independently of `boundWorkflowId` — that is non-null on
    // every lineage switch, so folding the check into the `??` fallback below
    // left it unreachable in exactly the case that matters.
    const isLiveAddress =
      address.kind === "draft" ||
      (address.kind === "run" && address.runRef === executionRunRef);
    const runtimeWorkflowId =
      boundWorkflowId ??
      (isLiveAddress ? this.getViewedWorkflowId(clientId) : null);
    const boundInstance = runtimeWorkflowId
      ? this.findInstance(runtimeWorkflowId)
      : undefined;
    const announcedWorkflowId =
      boundWorkflowId ??
      (announceReplayBoundary ? this.getViewedWorkflowId(clientId) : null);
    if (announcedWorkflowId) {
      const announcedInstance = this.findInstance(announcedWorkflowId);
      // Announce the new active instance before transferring the potentially
      // large history snapshot. Client-ready preferred-address replays must do
      // this even when the instance binding is unchanged: a resumed mobile page
      // can retain workflowStore content that no longer matches its retained
      // applied address, and the requestless announcement invalidates that
      // association before the authoritative snapshot reaches the stale guard.
      send({
        type: MESSAGE_TYPES.ACTIVE_TERMINAL_WORKFLOWS,
        workflows: this.getActiveTerminalWorkflowRefs(),
      });
      send({
        type: MESSAGE_TYPES.ACTIVE_WORKFLOW_CHANGED,
        workflowId: announcedWorkflowId,
        workingFilePath:
          announcedInstance?.getSummary().workingFilePath ??
          this.cliSessions.get(announcedWorkflowId)?.summary.workingFilePath ??
          null,
        // Announcing before the snapshot must not read as a backend-initiated
        // switch: without the requestId the client cancels its own in-flight
        // request and then drops the requestful RUN_VIEW_LOADED that follows.
        requestId,
      });
    }

    // This is the one authoritative definition/runtime/history application for
    // the addressed switch. Nothing after it may emit FILE_SELECTED,
    // SESSION_RESTORED, RUN_VIEW_LOADED, or OUTPUT_HISTORY_LOADED.
    send(snapshot);
    Log.debug(
      `[deliverRunView] client=${clientId.slice(0, 12)} address=${address.workflowKey}/${address.kind === "run" ? address.runRef : "draft"} snapshot sent`
    );

    // Overlay only in-memory output that may have arrived after the timeline
    // read, then restore PTY metadata/scrollback. Neither path resets the
    // snapshot, so completed/fresh instances keep their persisted output.
    //
    // The overlay is a stream of *live* updates, not a snapshot, so it is tagged
    // with the instance it describes: every per-workflow guard in the webview is
    // conditional on `message.workflowId`, which means an untagged overlay is
    // accepted unconditionally by whatever view the client is displaying by the
    // time it arrives — including a workflow the user switched to in between.
    if (runtimeWorkflowId && isLiveAddress) {
      boundInstance?.replayBufferedOutputTo(
        new WorkflowTaggedSink(
          new PostMessageDashboardSink(send),
          runtimeWorkflowId
        )
      );
    }
    if (boundWorkflowId) {
      this.replayTerminalSessionsTo(boundWorkflowId, send, clientId);
    }
  }

  /**
   * Fetches one lineage's manifest-only run list for the run-navigation dropdown's
   * drill-in panel. Unlike `loadRunViewForClient`, this never binds a client to the
   * lineage, loads a working file, or replays PTY/output state — it is a pure,
   * request-correlated summary fetch so drilling into another lineage's runs cannot
   * change what the caller is currently viewing.
   */
  async loadRunSummariesForClient(
    workflowKey: WorkflowKey,
    send: (message: unknown) => void,
    requestId: string
  ): Promise<void> {
    const workspaceRoot = this.currentWorkspaceFolder?.uri.fsPath;
    if (!workspaceRoot) {
      throw new Error("No workspace folder is open");
    }
    const historyManager = new OutputHistoryManager(workspaceRoot);
    const [runSummaries, descriptor] = await Promise.all([
      historyManager.getRunSummaries(workflowKey),
      this.lineageRepository.readDescriptor(workspaceRoot, workflowKey),
    ]);
    const snapshot: RunSummariesLoadedMessage = {
      type: MESSAGE_TYPES.RUN_SUMMARIES_LOADED,
      requestId,
      workflowKey,
      descriptorRevision: descriptor.revision,
      lastModifiedAt: descriptor.lastModifiedAt,
      runSummaries,
      executionRunRef: this.findExecutionRunRef(workflowKey),
    };
    send(snapshot);
  }

  /**
   * Resolves a definition mutation against the requesting client's addressed
   * view. A promoted run is validated in place (no draft fork, no instance
   * rebinding) — the actual write happens in the caller's subsequent per-op
   * call, either against a reused live instance or the static `*AtRun`
   * primitives. Editing an already-existing draft still goes through this
   * client's bound draft instance, unchanged.
   */
  async prepareDefinitionMutation(
    mutation: WorkflowDefinitionMutation | undefined,
    clientId: string
  ): Promise<void> {
    const viewed = this.getViewAddress(clientId);
    // A brand-new, as-yet-unaddressed editor still uses the ephemeral workflow
    // path. Once a client is viewing a persisted draft/run, revision context is
    // mandatory so a stale UI cannot silently alter a promoted definition.
    if (!mutation) {
      if (viewed?.kind === "run" || viewed?.kind === "draft") {
        throw new Error(
          "Definition mutation is missing its addressed revision context"
        );
      }
      return;
    }
    if (
      !viewed ||
      viewed.workflowKey !== mutation.address.workflowKey ||
      viewed.kind !== mutation.address.kind ||
      (viewed.kind === "run" &&
        mutation.address.kind === "run" &&
        viewed.runRef !== mutation.address.runRef)
    ) {
      throw new Error(
        "Definition mutation no longer targets this client's viewed run " +
          `(targeted: ${WorkflowOrchestrator.describeViewAddress(mutation.address)}, ` +
          `viewing: ${WorkflowOrchestrator.describeViewAddress(viewed)})`
      );
    }
    const workspaceRoot = this.currentWorkspaceFolder?.uri.fsPath;
    if (!workspaceRoot) {
      throw new Error("No workspace folder is open");
    }

    if (mutation.address.kind === "run") {
      // Editing a run whose resident instance owns the lineage lock is done in
      // place against its live queue. This includes active execution and a
      // completed named-worktree run retaining an injectable PTY. Both must
      // bypass the cross-process validator, which correctly rejects a lock held
      // by anyone except the local resident owner.
      const resident = this.findResidentInstanceForRun(
        mutation.address.workflowKey,
        mutation.address.runRef
      );
      const isLocallyOwnedRun =
        resident !== undefined &&
        (this.findExecutionRunRef(mutation.address.workflowKey) ===
          mutation.address.runRef ||
          resident.ownsRunnerLock());
      if (isLocallyOwnedRun) {
        const liveRevision = resident.getQueueState().definitionRevision;
        if (liveRevision !== mutation.expectedDefinitionRevision) {
          throw new Error(
            `Definition revision conflict: expected ${mutation.expectedDefinitionRevision}, found ${liveRevision}`
          );
        }
        // No descriptor check here: this run's own definition head is what's
        // being edited, and the lineage descriptor is not touched by that
        // write. Checking it would spuriously reject this edit whenever
        // unrelated lineage activity (another run's rewind, a favorite
        // toggle, a second run being promoted) bumps the shared descriptor
        // revision. See `core.instructions.md`.
        resident.expectDefinitionRevision(mutation.expectedDefinitionRevision);
        return;
      }

      const target = await RunContinuationService.validateContinuationTarget(
        workspaceRoot,
        mutation.address.workflowKey,
        mutation.address.runRef,
        this.lineageRepository,
        "edit"
      );
      if (target.definitionRevision !== mutation.expectedDefinitionRevision) {
        throw new Error(
          `Definition revision conflict: expected ${mutation.expectedDefinitionRevision}, found ${target.definitionRevision}`
        );
      }
      // No descriptor-revision check: see the executing-run branch above.
      // If a live instance already owns this exact run (executing/paused, or
      // simply loaded), prime its next definition write with the client's
      // observed revision — mirroring the draft-instance carve-out below.
      this.findResidentInstanceForRun(
        mutation.address.workflowKey,
        mutation.address.runRef
      )?.expectDefinitionRevision(mutation.expectedDefinitionRevision);
      return;
    }

    const [descriptor, draft] = await Promise.all([
      this.lineageRepository.readDescriptor(
        workspaceRoot,
        mutation.address.workflowKey
      ),
      fs.promises.readFile(
        WorkflowPaths.draftFilePath(
          workspaceRoot,
          mutation.address.workflowKey
        ),
        "utf8"
      ),
    ]);
    const draftRevision =
      (JSON.parse(draft) as WorkingFile).definitionRevision ?? 1;
    if (descriptor.revision !== mutation.expectedDescriptorRevision) {
      throw new Error(
        `Descriptor revision conflict: expected ${mutation.expectedDescriptorRevision}, found ${descriptor.revision}`
      );
    }
    if (draftRevision !== mutation.expectedDefinitionRevision) {
      throw new Error(
        `Definition revision conflict: expected ${mutation.expectedDefinitionRevision}, found ${draftRevision}`
      );
    }
    this.getInstanceForClient(clientId).expectDefinitionRevision(
      mutation.expectedDefinitionRevision
    );
  }

  /**
   * Workflow settings use the same addressed revision and resident-owner
   * routing as every other definition mutation. Keeping this entry point as a
   * delegate preserves the UI-facing API without maintaining a second lock
   * policy that can drift from `prepareDefinitionMutation`.
   */
  async prepareWorkflowPropertiesMutation(
    mutation: WorkflowDefinitionMutation | undefined,
    clientId: string
  ): Promise<void> {
    await this.prepareDefinitionMutation(mutation, clientId);
  }

  /**
   * Finds an already-loaded `WorkflowInstance` bound to this exact run,
   * regardless of which client owns it. A client merely viewing a run (via
   * `loadRunViewForClient`) never binds an instance, so `getInstanceForClient`
   * cannot be used for this lookup — only an instance that actually loaded
   * this run's working file (executing, paused, or otherwise still resident)
   * qualifies.
   */
  private findResidentInstanceForRun(
    workflowKey: WorkflowKey,
    runRef: RunRef
  ): WorkflowInstance | undefined {
    const matches = (instance: WorkflowInstance) => {
      const state = instance.getQueueState();
      return state.workflowKey === workflowKey && state.runRef === runRef;
    };
    const instances = this.instances ?? new Map();
    const retiredInstances = this.retiredInstances ?? new Map();
    return (
      [...instances.values()].find(matches) ??
      [...retiredInstances.values()].find(matches)
    );
  }

  private requireWorkspaceRoot(): string {
    const workspaceRoot = this.currentWorkspaceFolder?.uri.fsPath;
    if (!workspaceRoot) {
      throw new Error("No workspace folder is open");
    }
    return workspaceRoot;
  }

  /**
   * Dual-path resolver for a run-addressed dashboard mutation: reuse an
   * already-loaded live instance for this exact run if one exists (its own
   * dashboardSink push covers its owning client), otherwise apply a static,
   * descriptor+revision-locked `WorkingFileManager.*AtRun` write directly to
   * disk. Either way, every other client currently viewing this run is
   * refreshed afterward — mirroring the existing `setStartPositionAtRun`
   * precedent.
   */
  private async applyRunAddressedMutation(
    runAddress: WorkflowRunAddress,
    liveEdit: (instance: WorkflowInstance) => Promise<void>,
    staticEdit: (workspaceRoot: string) => Promise<void>,
    invalidation: "snapshot" | "properties" = "snapshot"
  ): Promise<void> {
    const live = this.findResidentInstanceForRun(
      runAddress.workflowKey,
      runAddress.runRef
    );
    if (live) {
      await liveEdit(live);
    } else {
      await staticEdit(this.requireWorkspaceRoot());
    }
    if (invalidation === "properties") {
      await this.invalidateRunViewProperties(
        runAddress.workflowKey,
        runAddress.runRef
      );
    } else {
      await this.invalidateRunViews(runAddress.workflowKey, runAddress.runRef);
    }
  }

  private findExecutionRunRef(workflowKey: WorkflowKey): RunRef | undefined {
    for (const instance of this.instances.values()) {
      const state = instance.getQueueState();
      if (
        state.workflowKey === workflowKey &&
        isExecutionOwnerState(state.status)
      ) {
        return instance.getExecutionRunRef() ?? state.runRef;
      }
    }
    const cli = this.cliSessions.get(workflowKey);
    return cli
      ? WorkflowPaths.parseWorkingFileAddressFromPath(
          cli.summary.workingFilePath ?? ""
        )?.runRef
      : undefined;
  }

  clearWorkingFilePath(clientId: string): void {
    this.getInstanceForClient(clientId).clearWorkingFilePath();
  }

  /**
   * Get the PromptQueue of the workflow instance a client is viewing.
   * Returns null if that client has no instance. Defaults to the panel because
   * VS Code commands act on what the panel shows.
   */
  getActivePromptQueue(
    clientId: string = this.PANEL_CLIENT_ID
  ): PromptQueue | null {
    return this.getBoundInstance(clientId)?.promptQueue ?? null;
  }

  async updateWorkflowName(
    mutation: WorkflowDefinitionMutation | undefined,
    workflowName: string,
    clientId: string
  ): Promise<
    { definitionRevision: number; descriptorRevision: number } | undefined
  > {
    if (!mutation || mutation.address.kind !== "run") {
      await this.getInstanceForClient(clientId).updateWorkflowName(
        workflowName
      );
      return undefined;
    }
    const runAddress = mutation.address;
    let latest:
      | { definitionRevision: number; descriptorRevision: number }
      | undefined;
    await this.applyRunAddressedMutation(
      runAddress,
      (instance) => instance.updateWorkflowName(workflowName),
      async (workspaceRoot) => {
        const written = await WorkingFileManager.updateWorkflowNameAtRun(
          workspaceRoot,
          runAddress.workflowKey,
          runAddress.runRef,
          workflowName,
          mutation.expectedDefinitionRevision,
          this.lineageRepository
        );
        latest = {
          definitionRevision: written.definitionRevision,
          descriptorRevision: written.descriptorRevision,
        };
      },
      // A rename leaves steps/output untouched — same as any other property
      // write — so viewers only need the lightweight properties push, not a
      // full RUN_VIEW_LOADED snapshot. The live branch above already tells
      // every viewer the new name via the WORKFLOW_NAME_UPDATED broadcast
      // (WorkflowInstance.updateWorkflowName → onQueueStateChanged →
      // dashboardSink.updateWorkflowName); a "snapshot" invalidation here was
      // redundant for that and actively harmful for the acting client, whose
      // own bumped definitionRevision always makes RUN_VIEW_LOADED look like
      // a genuine new view and clear its entire zundo undo/redo history —
      // right after the WORKFLOW_NAME_UPDATED broadcast had just made the
      // rename undoable.
      "properties"
    );
    return latest;
  }

  async loadWorkingFile(filePath: string): Promise<void> {
    const workflowId =
      WorkflowPaths.parseWorkingFileAddressFromPath(filePath)?.workflowKey ??
      "";

    // If already tracked as a CLI session, switch the panel view to it (Entry Point 2)
    const existingCliEntry = this.cliSessions.get(workflowId);
    if (existingCliEntry) {
      Log.debug(
        `loadWorkingFile: "${workflowId}" is CLI-managed (session exists) — switching view`
      );
      this.storedPanelSend?.({
        type: MESSAGE_TYPES.ACTIVE_WORKFLOW_CHANGED,
        workflowId,
        workingFilePath: existingCliEntry.summary.workingFilePath ?? null,
      });
      this.dashboardBroadcastHub.notifyWorkflowSummaryUpdated(
        existingCliEntry.summary
      );
      return;
    }

    // Check for an active CLI lock before creating a VS Code instance (Entry Point 2)
    const workspaceFolderPathForLock = this.currentWorkspaceFolder?.uri.fsPath;
    const lockStatus =
      workflowId && workspaceFolderPathForLock
        ? await WorkflowLockManager.checkLock(
            workspaceFolderPathForLock,
            workflowId
          )
        : LOCK_STATUS.NONE;
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
    const panelSend = this.storedPanelSend ?? ((_: unknown) => {});

    // Reuse an existing retired instance for this file if one exists.
    // This preserves PTY session associations so terminals survive workflow switches.
    const existingRetiredForPanel = [...this.retiredInstances.values()].find(
      (w) => sameWorkingFilePath(w.getSummary().workingFilePath, filePath)
    );
    if (existingRetiredForPanel) {
      this.setViewedWorkflowId(
        this.PANEL_CLIENT_ID,
        existingRetiredForPanel.id
      );
      await this.replayWorkflowStateTo(
        existingRetiredForPanel.id,
        panelSend,
        this.PANEL_CLIENT_ID
      );
      return;
    }

    await this.loadFreshInstanceAndReplay(
      filePath,
      this.PANEL_CLIENT_ID,
      panelSend
    );
  }

  /**
   * The prompt file a client's bound instance owns. Defaults to the panel,
   * whose instance is lazily created if it does not exist yet; a non-panel
   * client that is not bound to an instance resolves to null rather than
   * borrowing the panel's.
   */
  getCurrentPromptFile(
    clientId: string = this.PANEL_CLIENT_ID
  ): { fileName: string; steps: unknown[] } | null {
    if (clientId === this.PANEL_CLIENT_ID) {
      return this.getActiveInstance().getCurrentPromptFile();
    }
    return this.getBoundInstance(clientId)?.getCurrentPromptFile() ?? null;
  }

  /** @keep Standalone server API; see dev/backlog/STANDALONE_SERVER_PLAN.md. */
  async readWorkingFile(workingFilePath: string): Promise<WorkingFile> {
    return this.getActiveInstance().readWorkingFile(workingFilePath);
  }

  getOutputHistoryManager(): OutputHistoryManager {
    return this.getActiveInstance().outputHistoryManager;
  }

  /** Merge a persisted managed run into its captured source checkout. */
  async mergeManagedWorktreeAtRun(
    address: Extract<WorkflowViewAddress, { kind: "run" }>
  ): Promise<WorktreeRunProjection> {
    const workspaceRoot = this.requireWorkspaceRoot();
    const workingFilePath = WorkflowPaths.runFilePath(
      workspaceRoot,
      address.workflowKey,
      address.runRef
    );
    const workingFile = JSON.parse(
      await fs.promises.readFile(workingFilePath, "utf8")
    ) as WorkingFile;
    const runtime = workingFile._runtime?.worktree;
    if (!runtime || runtime.mode !== "managed") {
      throw new Error("Merge is available only for managed worktree runs.");
    }
    if (runtime.branchState !== "present") {
      throw new Error("The managed worktree branch is no longer present.");
    }
    const executionWorkspace = {
      stateRoot: workspaceRoot,
      executionRoot: runtime.executionRoot,
      executionCheckoutRoot: runtime.executionCheckoutRoot,
      sourceCheckoutRoot: runtime.sourceCheckoutRoot,
      workspaceRoots: runtime.namedWorkspaceRoots.map((root) => root.fsPath),
      namedWorkspaceRoots: runtime.namedWorkspaceRoots,
      approvedExternalRoots: [],
    };
    const info: WorktreeInfo = {
      mode: runtime.mode,
      origin: runtime.origin,
      lifecycleOwner: runtime.lifecycleOwner,
      branchName: runtime.branchName,
      worktreePath: runtime.worktreePath,
      sourceCheckoutRoot: runtime.sourceCheckoutRoot,
      baseCommit: runtime.baseCommit,
      ...(runtime.targetBranch ? { targetBranch: runtime.targetBranch } : {}),
      workflowKey: address.workflowKey,
      runRef: address.runRef,
      createdAt: workingFile.startedAt ?? Date.now(),
      executionWorkspace,
      dirty: runtime.dirty ?? false,
      ...(runtime.sourceCheckoutDirty !== undefined
        ? { sourceCheckoutDirty: runtime.sourceCheckoutDirty }
        : {}),
    };
    const result = await new WorktreeManager().mergeManagedWorktree(info);
    await WorkingFileManager.updateWorktreeRuntimeAtRun(
      workspaceRoot,
      address.workflowKey,
      address.runRef,
      {
        mergeOutcome: result.mergeOutcome,
        ...(result.conflictFiles
          ? { conflictFiles: result.conflictFiles }
          : {}),
        ...(result.message ? { message: result.message } : {}),
        updatedAt: Date.now(),
      }
    );
    const updated = JSON.parse(
      await fs.promises.readFile(workingFilePath, "utf8")
    ) as WorkingFile;
    const projection = projectWorktreeRuntime(updated._runtime?.worktree);
    if (!projection) {
      throw new Error(
        "The managed worktree merge did not produce a runtime projection."
      );
    }
    this.dashboardBroadcastHub.updateWorktreeMerge(address, projection);
    return projection;
  }

  async getWorktreeManagementState() {
    return new WorktreeManager().getManagementState(
      this.requireWorkspaceRoot()
    );
  }

  async refreshWorktreeManagementState() {
    return new WorktreeManager().refreshManagementState(
      this.requireWorkspaceRoot()
    );
  }

  async applyWorktreeManagementAction(options: {
    action: WorktreeManagementAction;
    worktreePath?: string;
    branchName?: string;
    confirmed?: boolean;
  }): Promise<void> {
    await new WorktreeManager().applyManagementAction({
      sourceCheckoutRoot: this.requireWorkspaceRoot(),
      ...options,
    });
  }

  async syncNamedWorktree(worktreePath: string): Promise<WorktreeSyncResult> {
    return new WorktreeManager().syncNamedWorktree({
      sourceCheckoutRoot: this.requireWorkspaceRoot(),
      worktreePath,
    });
  }

  async updateWorkingFileProperties(
    mutation: WorkflowDefinitionMutation | undefined,
    properties: Record<string, unknown>,
    options: {
      onlyIfUndefined?: boolean;
      ensureHarnessAndModel?: boolean;
      allowDeletes?: boolean;
    } = {},
    clientId: string
  ): Promise<{ workingFile: WorkingFile; appliedKeys: string[] } | null> {
    if (!mutation || mutation.address.kind !== "run") {
      return this.getInstanceForClient(clientId).updateWorkingFileProperties(
        properties,
        options
      );
    }
    const runAddress = mutation.address;
    let result: { workingFile: WorkingFile; appliedKeys: string[] } | null =
      null;
    await this.applyRunAddressedMutation(
      runAddress,
      async (instance) => {
        result = await instance.updateWorkingFileProperties(
          properties,
          options
        );
      },
      async (workspaceRoot) => {
        const written = await WorkingFileManager.updatePropertiesAtRun(
          workspaceRoot,
          runAddress.workflowKey,
          runAddress.runRef,
          properties,
          mutation.expectedDefinitionRevision,
          this.lineageRepository,
          { allowDeletes: options.allowDeletes }
        );
        result = {
          workingFile: written.workingFile,
          appliedKeys: written.appliedKeys,
        };
      },
      // Property-only writes leave steps and output untouched, so viewers get
      // a lightweight properties push instead of a full snapshot replay.
      "properties"
    );
    return result;
  }

  async updatePromptInQueue(
    mutation: WorkflowDefinitionMutation | undefined,
    index: number,
    text: string,
    properties: unknown,
    promptName?: string,
    clearProperties?: string[],
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<void> {
    if (!mutation || mutation.address.kind !== "run") {
      return this.getInstanceForClient(clientId).updatePromptInQueue(
        index,
        text,
        properties,
        promptName,
        clearProperties
      );
    }
    const runAddress = mutation.address;
    await this.applyRunAddressedMutation(
      runAddress,
      (instance) =>
        instance.updatePromptInQueue(
          index,
          text,
          properties,
          promptName,
          clearProperties
        ),
      (workspaceRoot) =>
        WorkingFileManager.updateStepAtRun(
          workspaceRoot,
          runAddress.workflowKey,
          runAddress.runRef,
          index,
          buildPromptStepChange(text, properties, promptName, clearProperties),
          mutation.expectedDefinitionRevision,
          this.lineageRepository
        ).then(() => undefined)
    );
  }

  /**
   * Edit a completed nonzero step as one backend-coordinated continuation
   * action. The durable rewind snapshot is created before the prompt changes,
   * so Discard Continuation restores the exact completed definition. The edit
   * then targets the revision pair produced by the rewind instead of racing a
   * separately posted SET_START_POSITION with the client's stale pair.
   */
  async updateCompletedPromptInQueue(
    mutation: WorkflowDefinitionMutation,
    index: number,
    text: string,
    properties: unknown,
    promptName?: string,
    clearProperties?: string[],
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<void> {
    if (mutation.address.kind !== "run" || index <= 0) {
      throw new Error(
        "A same-run completed-step continuation requires a nonzero run step"
      );
    }
    const runAddress = mutation.address;
    const rewind = await this.setStartPositionAtRun(
      runAddress,
      index,
      mutation.expectedDefinitionRevision,
      mutation.expectedDescriptorRevision,
      clientId,
      { invalidateViews: false }
    );
    if (rewind.kind !== "rewind") {
      throw new Error("Completed-step edit did not create a pending rewind");
    }

    try {
      const live = this.findResidentInstanceForRun(
        runAddress.workflowKey,
        runAddress.runRef
      );
      if (live) {
        // beginPendingRewind updated both disk and the resident queue. Arm the
        // following definition write with that new disk revision, not the
        // client's superseded pre-rewind revision.
        live.expectDefinitionRevision(rewind.definitionRevision);
        await live.updatePromptInQueue(
          index,
          text,
          properties,
          promptName,
          clearProperties
        );
      } else {
        await WorkingFileManager.updateStepAtRun(
          this.requireWorkspaceRoot(),
          runAddress.workflowKey,
          runAddress.runRef,
          index,
          buildPromptStepChange(text, properties, promptName, clearProperties),
          rewind.definitionRevision,
          this.lineageRepository
        );
      }
    } catch (error) {
      // The rewind is already durable even if the content edit fails. Publish
      // it so clients see the continuation state they can discard or retry.
      await this.invalidateRunViews(runAddress.workflowKey, runAddress.runRef);
      throw error;
    }

    await this.invalidateRunViews(runAddress.workflowKey, runAddress.runRef);
  }

  async insertWorkflowStepAfterIndex(
    mutation: WorkflowDefinitionMutation | undefined,
    afterIndex: number,
    step: WorkflowStep,
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<void> {
    if (!mutation || mutation.address.kind !== "run") {
      return this.getInstanceForClient(clientId).insertWorkflowStepAfterIndex(
        afterIndex,
        step
      );
    }
    const runAddress = mutation.address;
    await this.applyRunAddressedMutation(
      runAddress,
      (instance) => instance.insertWorkflowStepAfterIndex(afterIndex, step),
      (workspaceRoot) =>
        WorkingFileManager.insertStepAtRun(
          workspaceRoot,
          runAddress.workflowKey,
          runAddress.runRef,
          afterIndex,
          sanitizeClipboardWorkflowStep(step),
          mutation.expectedDefinitionRevision,
          this.lineageRepository
        ).then(() => undefined)
    );
  }

  async updateFinalStepInQueue(
    mutation: WorkflowDefinitionMutation | undefined,
    finalStep: WorkflowStep | null,
    clearProperties?: string[],
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<void> {
    if (!mutation || mutation.address.kind !== "run") {
      return this.getInstanceForClient(clientId).updateFinalStepInQueue(
        finalStep,
        clearProperties
      );
    }
    const runAddress = mutation.address;
    await this.applyRunAddressedMutation(
      runAddress,
      (instance) => instance.updateFinalStepInQueue(finalStep, clearProperties),
      (workspaceRoot) =>
        WorkingFileManager.updateFinalStepAtRun(
          workspaceRoot,
          runAddress.workflowKey,
          runAddress.runRef,
          finalStep,
          clearProperties,
          mutation.expectedDefinitionRevision,
          this.lineageRepository
        ).then(() => undefined)
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
    mutation: WorkflowDefinitionMutation | undefined,
    index: number,
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<void> {
    if (!mutation || mutation.address.kind !== "run") {
      return this.getInstanceForClient(clientId).deletePromptFromQueue(index);
    }
    const runAddress = mutation.address;
    await this.applyRunAddressedMutation(
      runAddress,
      (instance) => instance.deletePromptFromQueue(index),
      (workspaceRoot) =>
        WorkingFileManager.deleteStepAtRun(
          workspaceRoot,
          runAddress.workflowKey,
          runAddress.runRef,
          index,
          mutation.expectedDefinitionRevision,
          this.lineageRepository
        ).then(() => undefined)
    );
  }

  async reorderPendingPrompts(
    mutation: WorkflowDefinitionMutation | undefined,
    newPendingOrder: number[],
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<void> {
    if (!mutation || mutation.address.kind !== "run") {
      return this.getInstanceForClient(clientId).reorderPendingPrompts(
        newPendingOrder
      );
    }
    const runAddress = mutation.address;
    await this.applyRunAddressedMutation(
      runAddress,
      (instance) => instance.reorderPendingPrompts(newPendingOrder),
      (workspaceRoot) =>
        WorkingFileManager.reorderStepsAtRun(
          workspaceRoot,
          runAddress.workflowKey,
          runAddress.runRef,
          newPendingOrder,
          mutation.expectedDefinitionRevision,
          this.lineageRepository
        ).then(() => undefined)
    );
  }

  /**
   * Two sequential addressed writes on the static path (steps, then
   * `finalStep`), matching the instance-bound path's own two separate
   * `promptQueue` calls — not a new atomicity gap, just the existing
   * behavior carried over to the addressed primitives. Returns the resulting
   * revisions only for a static-path write, so a caller chaining a further
   * addressed write (e.g. the dashboard's bundled workflow-properties
   * restore) can target the up-to-date revision instead of the now-stale
   * one this call started with. `undefined` covers both the non-run and
   * live-instance cases, where the instance's own one-shot revision guard —
   * primed by `prepareDefinitionMutation` — already makes a chained
   * instance-bound write safe without passing revisions forward.
   */
  async syncStepsForUndoRedo(
    mutation: WorkflowDefinitionMutation | undefined,
    steps: WorkflowStep[],
    finalStep: WorkflowStep | null,
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<
    { definitionRevision: number; descriptorRevision: number } | undefined
  > {
    if (!mutation || mutation.address.kind !== "run") {
      await this.getInstanceForClient(clientId).syncStepsForUndoRedo(
        steps,
        finalStep
      );
      return undefined;
    }
    const runAddress = mutation.address;
    let latest:
      | { definitionRevision: number; descriptorRevision: number }
      | undefined;
    await this.applyRunAddressedMutation(
      runAddress,
      (instance) => instance.syncStepsForUndoRedo(steps, finalStep),
      async (workspaceRoot) => {
        const stepsResult = await WorkingFileManager.syncStepsForUndoRedoAtRun(
          workspaceRoot,
          runAddress.workflowKey,
          runAddress.runRef,
          steps,
          mutation.expectedDefinitionRevision,
          this.lineageRepository
        );
        latest = {
          definitionRevision: stepsResult.definitionRevision,
          descriptorRevision: stepsResult.descriptorRevision,
        };
        if (finalStep !== null) {
          const persistableFinalStep =
            stripViewOnlyWorkflowStepFields(finalStep);
          const finalStepResult =
            await WorkingFileManager.updatePropertiesAtRun(
              workspaceRoot,
              runAddress.workflowKey,
              runAddress.runRef,
              { finalStep: persistableFinalStep },
              stepsResult.definitionRevision,
              this.lineageRepository
            );
          latest = {
            definitionRevision: finalStepResult.definitionRevision,
            descriptorRevision: finalStepResult.descriptorRevision,
          };
        }
      }
    );
    return latest;
  }

  /**
   * Addressed Phase-3 start-position operation. It never infers a run from
   * "latest": the caller's addressed view, revision pair, and RunRef must all
   * agree. UI/message contracts will call this once they carry that context.
   */
  async setStartPositionAtRun(
    address: { workflowKey: WorkflowKey; runRef: RunRef },
    toIndex: number,
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number,
    clientId: string = this.PANEL_CLIENT_ID,
    options: { invalidateViews?: boolean } = {}
  ): Promise<
    | {
        kind: "seeded";
        runRef: RunRef;
        definitionRevision: number;
        descriptorRevision: number;
      }
    | {
        kind: "rewind";
        definitionRevision: number;
        descriptorRevision: number;
      }
  > {
    if (!Number.isInteger(toIndex) || toIndex < 0) {
      throw new Error("Start position must be a non-negative integer");
    }
    this.assertViewedRunAddress(address, clientId, "Set start position");
    const workspaceRoot = this.currentWorkspaceFolder?.uri.fsPath;
    if (!workspaceRoot) {
      throw new Error("No workspace folder is open");
    }

    const activeForLineage = [...this.instances.values()].find((instance) => {
      const state = instance.getQueueState();
      return (
        state.workflowKey === address.workflowKey &&
        isExecutionOwnerState(state.status)
      );
    });
    if (
      activeForLineage &&
      activeForLineage.getExecutionRunRef() !== address.runRef
    ) {
      throw new Error("Another run in this workflow lineage is executing");
    }

    if (toIndex === 0) {
      if (activeForLineage) {
        throw new Error(
          "Cannot seed a new run while this workflow lineage is executing"
        );
      }
      const seeded = await WorkingFileManager.seedNewRun(
        workspaceRoot,
        address.workflowKey,
        address.runRef,
        {},
        this.lineageRepository,
        {
          definitionRevision: expectedDefinitionRevision,
          descriptorRevision: expectedDescriptorRevision,
        }
        // No execution follows: this seed is a start-position move, and the run
        // stays IDLE until the user presses Run on it.
      );
      const seededAddress: Extract<WorkflowViewAddress, { kind: "run" }> = {
        workflowKey: address.workflowKey,
        kind: "run",
        runRef: seeded.runRef,
      };
      if (options.invalidateViews !== false) {
        // Seeding forks a new run, so — unlike the rewind branch — the client's
        // address itself moves. Publishing is not optional here: the seed
        // advanced the descriptor revision, and a client left on the source
        // address keeps echoing the superseded pair, so its very next mutation
        // (including a second Set Start Position) is rejected as a conflict.
        await this.switchClientToRunAddress(seededAddress, clientId);
        // Whoever stayed on the source run still holds that stale descriptor
        // revision and a run list missing the fork.
        await this.invalidateRunViews(address.workflowKey, address.runRef);
      }
      return {
        kind: "seeded",
        runRef: seeded.runRef,
        definitionRevision: 1,
        descriptorRevision: seeded.allocation.reservationDescriptorRevision,
      };
    }

    const targetPath = WorkflowPaths.runFilePath(
      workspaceRoot,
      address.workflowKey,
      address.runRef
    );
    const target = JSON.parse(
      await fs.promises.readFile(targetPath, "utf8")
    ) as WorkingFile;
    if (toIndex >= (target.steps?.length ?? 0)) {
      throw new Error(
        "Start position must leave at least one suffix step to run"
      );
    }
    const targetState =
      target._runtime?.executionState ?? EXECUTION_STATES.IDLE;
    if (
      targetState === EXECUTION_STATES.RUNNING ||
      targetState === EXECUTION_STATES.PAUSING ||
      targetState === EXECUTION_STATES.CANCELLING
    ) {
      throw new Error(
        `Cannot set start position while in state ${targetState}`
      );
    }
    if (targetState === EXECUTION_STATES.PAUSED && !activeForLineage) {
      throw new Error(
        "Cannot rewind a paused run without its live execution owner"
      );
    }

    const loadedTarget = this.findResidentInstanceForRun(
      address.workflowKey,
      address.runRef
    );
    const result = loadedTarget
      ? await loadedTarget.beginPendingRewind(
          address.workflowKey,
          address.runRef,
          toIndex,
          expectedDefinitionRevision,
          expectedDescriptorRevision
        )
      : await WorkingFileManager.beginPendingRewind(
          workspaceRoot,
          address.workflowKey,
          address.runRef,
          toIndex,
          expectedDefinitionRevision,
          expectedDescriptorRevision,
          this.lineageRepository
        );
    await this.commitPendingRewindRevision(
      address.workflowKey,
      address.runRef,
      result.definitionRevision,
      JSON.parse(await fs.promises.readFile(targetPath, "utf8")) as WorkingFile
    );
    if (options.invalidateViews !== false) {
      await this.invalidateRunViews(address.workflowKey, address.runRef);
    }
    return { kind: "rewind", ...result };
  }

  /** Seed a fresh RunRef from an addressed run and execute that new run. */
  async seedAndExecuteAtRun(
    address: WorkflowRunAddress,
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number,
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<{ runRef: RunRef }> {
    this.assertViewedRunAddress(address, clientId, "Re-run");
    const workspaceRoot = this.currentWorkspaceFolder?.uri.fsPath;
    if (!workspaceRoot) throw new Error("No workspace folder is open");
    if (this.findExecutionRunRef(address.workflowKey)) {
      throw new Error(
        "Cannot seed a new run while this workflow lineage is executing"
      );
    }
    const seeded = await WorkingFileManager.seedNewRun(
      workspaceRoot,
      address.workflowKey,
      address.runRef,
      {},
      this.lineageRepository,
      {
        definitionRevision: expectedDefinitionRevision,
        descriptorRevision: expectedDescriptorRevision,
      },
      // Executed below, so the manifest opens RUNNING.
      EXECUTION_STATES.RUNNING
    );
    await this.closeLineageTerminalsForFreshRun(address.workflowKey);
    const instance = this.buildWorkflowInstance();
    getPtyProcessManager()?.setPendingController(instance.id, clientId);
    let prepared = false;
    let resolvePrepared!: () => void;
    let rejectPrepared!: (error: unknown) => void;
    const preparedPromise = new Promise<void>((resolve, reject) => {
      resolvePrepared = resolve;
      rejectPrepared = reject;
    });
    void instance
      .executeSeededRun(seeded, address.workflowKey, undefined, async () => {
        await this.switchClientToPreparedExecution(instance, clientId);
        prepared = true;
        resolvePrepared();
      })
      .catch((error) => {
        if (!prepared) {
          rejectPrepared(error);
        }
        Log.error(`Failed to execute seeded run: ${getErrorMessage(error)}`);
      });
    // The action is not complete until the initiating client is visibly bound
    // to the seeded run. Execution itself continues in the background.
    await preparedPromise;
    return { runRef: seeded.runRef };
  }

  /**
   * Moves a client onto a run address by pushing it a fresh run-view
   * snapshot, falling back to a bare registry update if no message sink is
   * available (or the push itself fails) — the caller's action must still be
   * complete even without a visible client to follow it.
   *
   * Shared by every path that moves a client's address without the client
   * having asked for that exact address itself: `seedAndExecuteAtRun`'s idle
   * counterpart (a seed forks a new run the client must follow) and
   * `executeDraftAtAddress` (a draft promoted into a run mid-request).
   */
  private async switchClientToRunAddress(
    address: Extract<WorkflowViewAddress, { kind: "run" }>,
    clientId: string
  ): Promise<void> {
    const send =
      this.getViewMessageSinks().get(clientId) ??
      (clientId === this.PANEL_CLIENT_ID ? this.storedPanelSend : undefined);
    if (!send) {
      // No sink to publish through, but the address must still follow along
      // or the client's next addressed mutation targets the stale one.
      this.getViewAddressRegistry().set(clientId, address);
      return;
    }
    try {
      await this.loadRunViewForClient(address, send, clientId);
    } catch (error) {
      Log.warn(
        `[WorkflowOrchestrator] Failed to switch ${clientId} to run ${address.runRef}: ${getErrorMessage(error)}`
      );
      this.getViewAddressRegistry().set(clientId, address);
    }
  }

  /** A different RunRef is a fresh terminal/session boundary for the lineage. */
  private async closeLineageTerminalsForFreshRun(
    workflowKey: WorkflowKey
  ): Promise<void> {
    const residents = new Set([
      ...this.instances.values(),
      ...this.retiredInstances.values(),
    ]);
    await Promise.all(
      [...residents]
        .filter(
          (instance) => instance.getQueueState().workflowKey === workflowKey
        )
        .map((instance) => instance.closeRetainedTerminalsForFreshRun())
    );
  }

  /**
   * Make the initiating client follow a run only after its working file and
   * timeline exist, but before execution can emit any run-scoped messages.
   */
  private async switchClientToPreparedExecution(
    instance: WorkflowInstance,
    clientId: string
  ): Promise<void> {
    if (
      !this.instances.has(instance.id) &&
      !this.retiredInstances.has(instance.id)
    ) {
      // Keep the prepared ID discoverable during replay. The RUNNING state
      // transition promotes it into the live registry immediately afterward.
      this.retiredInstances.set(instance.id, instance);
    }
    // Until that promotion the incoming instance is indistinguishable from the
    // outgoing run's — which is still retired, still owns the PTY being torn
    // down, and therefore wins every heuristic in findInstanceForLineage. Claim
    // the lineage now so the replay below (and any later addressed navigation)
    // resolves to the run the client was just switched to.
    const workflowKey = instance.getQueueState().workflowKey;
    if (workflowKey) {
      this.getLineageExecutionOwners().set(workflowKey, {
        instanceId: instance.id,
        promoted: false,
      });
    }

    const send =
      this.getViewMessageSinks().get(clientId) ??
      (clientId === this.PANEL_CLIENT_ID ? this.storedPanelSend : undefined);
    if (!send) {
      this.setViewedWorkflowId(clientId, instance.id);
      return;
    }
    await this.replayWorkflowStateTo(instance.id, send, clientId);
  }

  /** Execute the exact viewed draft; promoted runs must use seedAndExecuteAtRun. */
  async executeDraftAtAddress(
    address: Extract<WorkflowViewAddress, { kind: "draft" }>,
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number,
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<void> {
    const viewed = this.getViewAddress(clientId);
    if (
      !viewed ||
      viewed.kind !== "draft" ||
      viewed.workflowKey !== address.workflowKey
    ) {
      throw new Error("Run no longer targets this client's viewed draft");
    }
    const workspaceRoot = this.currentWorkspaceFolder?.uri.fsPath;
    if (!workspaceRoot) throw new Error("No workspace folder is open");
    const descriptor = await this.lineageRepository.readDescriptor(
      workspaceRoot,
      address.workflowKey
    );
    if (descriptor.revision !== expectedDescriptorRevision) {
      throw new Error(
        `Descriptor revision conflict: expected ${expectedDescriptorRevision}, found ${descriptor.revision}`
      );
    }
    const draft = JSON.parse(
      await fs.promises.readFile(
        WorkflowPaths.draftFilePath(workspaceRoot, address.workflowKey),
        "utf8"
      )
    ) as WorkingFile;
    if ((draft.definitionRevision ?? 1) !== expectedDefinitionRevision) {
      throw new Error("Definition revision conflict while running draft");
    }
    const instance = this.getInstanceForClient(clientId);
    // Promoting the draft moves this client's own address from draft to the
    // new run — unlike invalidateRunViews (which only refreshes clients
    // already addressed at a run), nothing else tells a client still
    // addressed at the draft that its promotion happened. Without this the
    // client stays on the draft address for the run's entire duration: no
    // RunSummaryBanner, no run-panel entry, until some unrelated navigation
    // (switching workflows and back) happens to force a fresh snapshot.
    // Mirrors seedAndExecuteAtRun: execute without awaiting the full run, and
    // resolve this call once the client is visibly moved onto the promoted
    // run's address rather than once every step has finished.
    let prepared = false;
    let resolvePrepared!: () => void;
    let rejectPrepared!: (error: unknown) => void;
    const preparedPromise = new Promise<void>((resolve, reject) => {
      resolvePrepared = resolve;
      rejectPrepared = reject;
    });
    void instance
      .executeLoadedPromptFile(undefined, false, "", false, async () => {
        const state = instance.getQueueState();
        if (state.workflowKey && state.runRef) {
          await this.switchClientToRunAddress(
            {
              workflowKey: state.workflowKey,
              kind: "run",
              runRef: state.runRef,
            },
            clientId
          );
        }
        prepared = true;
        resolvePrepared();
      })
      .catch((error) => {
        if (!prepared) {
          rejectPrepared(error);
        }
        Log.error(`Failed to execute draft: ${getErrorMessage(error)}`);
      });
    await preparedPromise;
  }

  /** One client action: restore the committed run, then seed and execute a new RunRef. */
  async startNewRunInsteadAtRun(
    address: WorkflowRunAddress,
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number,
    confirmEditedSuffix: boolean,
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<{ runRef: RunRef } | { hasSuffixEdits: true }> {
    this.assertViewedRunAddress(address, clientId, "Start new run instead");
    if (this.findExecutionRunRef(address.workflowKey)) {
      throw new Error(
        "Cannot seed a new run while this workflow lineage is executing"
      );
    }
    const discarded = await this.discardContinuationAtRun(
      address,
      expectedDefinitionRevision,
      expectedDescriptorRevision,
      confirmEditedSuffix,
      clientId,
      false
    );
    if (!discarded.discarded) return { hasSuffixEdits: true };
    return this.seedAndExecuteAtRun(
      address,
      discarded.definitionRevision,
      discarded.descriptorRevision,
      clientId
    );
  }

  /** Human-readable view address for mismatch diagnostics in thrown errors. */
  private static describeViewAddress(
    address: WorkflowViewAddress | null | undefined
  ): string {
    if (!address) {
      return "(none)";
    }
    return address.kind === "run"
      ? `${address.workflowKey}/${address.runRef}`
      : `${address.workflowKey}/draft`;
  }

  private assertViewedRunAddress(
    address: WorkflowRunAddress,
    clientId: string,
    action: string
  ): void {
    const viewed = this.getViewAddress(clientId);
    if (
      !viewed ||
      viewed.kind !== "run" ||
      viewed.workflowKey !== address.workflowKey ||
      viewed.runRef !== address.runRef
    ) {
      throw new Error(
        `${action} no longer targets this client's viewed run ` +
          `(targeted: ${address.workflowKey}/${address.runRef}, ` +
          `viewing: ${WorkflowOrchestrator.describeViewAddress(viewed)})`
      );
    }
  }

  /**
   * Explicit same-run append.  The requested view, both optimistic revisions,
   * the runner lock, and the run's persisted execution state are all checked
   * before the instance is allowed to bind this run for execution.
   */
  async appendAndContinueAtRun(
    address: { workflowKey: WorkflowKey; runRef: RunRef },
    tail: WorkflowStep[],
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number,
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<{ definitionRevision: number; descriptorRevision: number }> {
    const {
      workspaceRoot,
      activeInstance,
      allowInterruptedRun,
      pendingRewindOnThisRun,
    } = await this.validateExplicitContinuationTarget(
      address,
      expectedDefinitionRevision,
      expectedDescriptorRevision,
      clientId
    );
    // Appending to a rewound run commits the rewind first, clearing the
    // descriptor marker and discard snapshot. The definition revision is
    // untouched by the commit, so the append still validates against the
    // observed head; the append itself no longer checks a descriptor
    // revision (see `RunContinuationService.appendStepsToRun`).
    if (pendingRewindOnThisRun) {
      await WorkingFileManager.commitPendingRewind(
        workspaceRoot,
        address.workflowKey,
        address.runRef,
        expectedDefinitionRevision,
        expectedDescriptorRevision,
        this.lineageRepository
      );
    }
    const appended = await RunContinuationService.appendStepsToRun(
      workspaceRoot,
      address.workflowKey,
      address.runRef,
      tail,
      expectedDefinitionRevision,
      this.lineageRepository,
      allowInterruptedRun
    );
    const instance =
      activeInstance ??
      this.findResidentInstanceForRun(address.workflowKey, address.runRef) ??
      this.buildWorkflowInstance();
    getPtyProcessManager()?.setPendingController(instance.id, clientId);
    await instance.executeContinuationAtRun(
      address.workflowKey,
      address.runRef,
      appended.definitionRevision,
      () => this.switchClientToPreparedExecution(instance, clientId)
    );
    await this.invalidateRunViews(address.workflowKey, address.runRef);
    return {
      definitionRevision: appended.definitionRevision,
      descriptorRevision: appended.descriptorRevision,
    };
  }

  /** Continue an unchanged addressed run; no target is inferred from recency. */
  async continueAtRun(
    address: { workflowKey: WorkflowKey; runRef: RunRef },
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number,
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<void> {
    const { workspaceRoot, activeInstance, pendingRewindOnThisRun } =
      await this.validateExplicitContinuationTarget(
        address,
        expectedDefinitionRevision,
        expectedDescriptorRevision,
        clientId
      );
    // Continuing a rewound run commits the rewind: clear the descriptor marker
    // and discard snapshot before execution so the run head is durable and no
    // stale pending state can block later edits/continuations. The definition
    // revision is unchanged, so the continuation still validates below.
    if (pendingRewindOnThisRun) {
      await WorkingFileManager.commitPendingRewind(
        workspaceRoot,
        address.workflowKey,
        address.runRef,
        expectedDefinitionRevision,
        expectedDescriptorRevision,
        this.lineageRepository
      );
    }
    const instance =
      activeInstance ??
      this.findResidentInstanceForRun(address.workflowKey, address.runRef) ??
      this.buildWorkflowInstance();
    getPtyProcessManager()?.setPendingController(instance.id, clientId);
    await instance.executeContinuationAtRun(
      address.workflowKey,
      address.runRef,
      expectedDefinitionRevision,
      () => this.switchClientToPreparedExecution(instance, clientId)
    );
    await this.invalidateRunViews(address.workflowKey, address.runRef);
  }

  private async validateExplicitContinuationTarget(
    address: { workflowKey: WorkflowKey; runRef: RunRef },
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number,
    clientId: string
  ): Promise<{
    workspaceRoot: string;
    activeInstance: WorkflowInstance | undefined;
    allowInterruptedRun: boolean;
    pendingRewindOnThisRun: boolean;
  }> {
    this.assertViewedRunAddress(address, clientId, "Continuation");
    const workspaceRoot = this.currentWorkspaceFolder?.uri.fsPath;
    if (!workspaceRoot) throw new Error("No workspace folder is open");

    const descriptor = await this.lineageRepository.readDescriptor(
      workspaceRoot,
      address.workflowKey
    );
    if (descriptor.revision !== expectedDescriptorRevision) {
      throw new Error(
        `Descriptor revision conflict: expected ${expectedDescriptorRevision}, found ${descriptor.revision}`
      );
    }
    // A pending rewind on the run being continued is not a blocker: continuing
    // it is precisely how the user commits that rewind. Only a draft, or a
    // rewind belonging to a different run, blocks this continuation.
    const pendingRewindOnThisRun =
      descriptor.pendingEdit?.kind === "rewind" &&
      descriptor.pendingEdit.runRef === address.runRef;
    if (descriptor.pendingEdit && !pendingRewindOnThisRun) {
      throw new Error("This workflow has a draft or pending continuation");
    }

    const activeInstance = [...this.instances.values()].find((instance) => {
      const state = instance.getQueueState();
      return (
        state.workflowKey === address.workflowKey &&
        isExecutionOwnerState(state.status)
      );
    });
    if (
      activeInstance &&
      activeInstance.getExecutionRunRef() !== address.runRef
    ) {
      throw new Error("Another run in this workflow lineage is executing");
    }
    if (
      activeInstance &&
      activeInstance.getQueueState().status !== EXECUTION_STATES.PAUSED
    ) {
      throw new Error("Cannot continue while this run is actively executing");
    }

    const lock = await WorkflowLockManager.readLock(
      workspaceRoot,
      address.workflowKey
    );
    const lockStatus = await WorkflowLockManager.checkLock(
      workspaceRoot,
      address.workflowKey
    );
    if (
      lock &&
      lockStatus !== LOCK_STATUS.STALE &&
      lock.runRef !== address.runRef
    ) {
      throw new Error("Another run in this workflow lineage is executing");
    }
    if (lock && lockStatus !== LOCK_STATUS.STALE && !activeInstance) {
      throw new Error("The requested run is executing in another process");
    }

    const target = JSON.parse(
      await fs.promises.readFile(
        WorkflowPaths.runFilePath(
          workspaceRoot,
          address.workflowKey,
          address.runRef
        ),
        "utf8"
      )
    ) as WorkingFile;
    if ((target.definitionRevision ?? 1) !== expectedDefinitionRevision) {
      throw new Error(
        `Definition revision conflict: expected ${expectedDefinitionRevision}, found ${target.definitionRevision ?? 1}`
      );
    }
    const targetState =
      target._runtime?.executionState ?? EXECUTION_STATES.IDLE;
    const activeTarget =
      activeInstance?.getExecutionRunRef() === address.runRef;
    // An orphaned run is adoptable: no resident instance owns it and no live
    // lock names it, so nothing can be executing it and a fresh execution owner
    // can take it over from its own persisted position. This covers PAUSED as
    // well as RUNNING — a host restart routinely leaves paused runs with no
    // owner, and a paused run is the safer of the two to adopt (no in-flight
    // harness turn, and `currentIndex` sits on a clean step boundary). The lock
    // check is what makes it safe in both cases.
    const interruptedRun =
      (targetState === EXECUTION_STATES.RUNNING ||
        targetState === EXECUTION_STATES.PAUSED) &&
      !activeTarget &&
      (lockStatus === LOCK_STATUS.NONE || lockStatus === LOCK_STATUS.STALE);
    if (
      targetState === EXECUTION_STATES.PAUSING ||
      targetState === EXECUTION_STATES.CANCELLING ||
      ((targetState === EXECUTION_STATES.RUNNING ||
        targetState === EXECUTION_STATES.PAUSED) &&
        !activeTarget &&
        !interruptedRun)
    ) {
      throw new Error(`Cannot continue while run is in state ${targetState}`);
    }
    return {
      workspaceRoot,
      activeInstance,
      allowInterruptedRun: interruptedRun,
      pendingRewindOnThisRun,
    };
  }

  /** One lifecycle operation shared by dashboard actions and startup recovery. */
  async discardContinuationAtRun(
    address: { workflowKey: WorkflowKey; runRef: RunRef },
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number,
    confirmEditedSuffix: boolean = false,
    clientId: string = this.PANEL_CLIENT_ID,
    invalidate: boolean = true
  ): Promise<
    | { discarded: false; hasSuffixEdits: true }
    | {
        discarded: true;
        hasSuffixEdits: boolean;
        definitionRevision: number;
        descriptorRevision: number;
      }
  > {
    this.assertViewedRunAddress(address, clientId, "Discard continuation");
    const workspaceRoot = this.currentWorkspaceFolder?.uri.fsPath;
    if (!workspaceRoot) throw new Error("No workspace folder is open");
    const result = await WorkingFileManager.discardPendingRewind(
      workspaceRoot,
      address.workflowKey,
      address.runRef,
      expectedDefinitionRevision,
      expectedDescriptorRevision,
      confirmEditedSuffix,
      this.lineageRepository
    );
    if (!result.discarded) return result;
    if (invalidate) {
      await this.invalidateRunViews(address.workflowKey, address.runRef, {
        fromRevision: expectedDefinitionRevision,
        restoredRevision: result.definitionRevision,
        descriptorRevision: result.descriptorRevision,
      });
    }
    return result;
  }

  private async commitPendingRewindRevision(
    workflowKey: WorkflowKey,
    runRef: RunRef,
    definitionRevision: number,
    workingFile: WorkingFile
  ): Promise<void> {
    const workspaceRoot = this.currentWorkspaceFolder?.uri.fsPath;
    if (!workspaceRoot) throw new Error("No workspace folder is open");
    await new OutputHistoryManager(workspaceRoot).commitDefinitionRevision(
      WorkflowPaths.manifestPath(workspaceRoot, workflowKey, runRef),
      {
        definitionRevision,
        definition: buildDefinitionSnapshot(
          workingFile.workflowName ?? "",
          workingFile.steps ?? [],
          workingFile._runtime?.pendingRewind?.fromStepIndex,
          workingFile.finalStep,
          workingFile.worktree
        ),
      }
    );
  }

  /**
   * Push refreshed workflow properties — not a full run snapshot — to every
   * client viewing the changed run. Property-only writes must not replay
   * `RUN_VIEW_LOADED`: the webview treats that snapshot as a workflow load and
   * rebuilds its entire output model (steps, live timeline, history) with
   * fresh identities, visibly redrawing already-rendered output rows. The
   * bumped `definitionRevision` still reaches viewers via the router's
   * follow-up `publishViewIdentity()`.
   */
  private async invalidateRunViewProperties(
    workflowKey: WorkflowKey,
    runRef: RunRef
  ): Promise<void> {
    const targets = [...this.getViewAddressRegistry().entries()].filter(
      ([, address]) =>
        address?.kind === "run" &&
        address.workflowKey === workflowKey &&
        address.runRef === runRef
    );
    if (targets.length === 0) return;
    const workspaceRoot = this.currentWorkspaceFolder?.uri.fsPath;
    if (!workspaceRoot) return;
    let workingFile: WorkingFile;
    try {
      const filePath = this.resolveAddressFilePath(workspaceRoot, {
        workflowKey,
        kind: "run",
        runRef,
      });
      workingFile = JSON.parse(
        await fs.promises.readFile(filePath, "utf-8")
      ) as WorkingFile;
    } catch (error) {
      Log.warn(
        `[WorkflowOrchestrator] Failed to read run file for properties invalidation: ${getErrorMessage(error)}`
      );
      return;
    }
    const { prompt, steps, finalStep, ...workflowProperties } = workingFile;
    void prompt;
    void steps;
    void finalStep;
    for (const [clientId] of targets) {
      this.getViewMessageSinks().get(clientId)?.({
        type: MESSAGE_TYPES.WORKFLOW_PROPERTIES_UPDATE,
        workflowProperties,
      });
    }
  }

  /**
   * Refresh every connected client viewing the changed stable run identity.
   *
   * All of them are refreshed from one shared read: this runs after every
   * definition mutation, so a per-client read made ordinary editing rescan the
   * whole lineage once per connected client.
   */
  private async invalidateRunViews(
    workflowKey: WorkflowKey,
    runRef: RunRef,
    definitionRollback?: DefinitionRollbackInvalidation
  ): Promise<void> {
    const targets: Array<{
      clientId: string;
      send: (message: unknown) => void;
    }> = [];
    for (const [clientId, address] of this.getViewAddressRegistry()) {
      if (
        address?.kind !== "run" ||
        address.workflowKey !== workflowKey ||
        address.runRef !== runRef
      ) {
        continue;
      }
      const send = this.getViewMessageSinks().get(clientId);
      if (!send) continue;
      targets.push({ clientId, send });
    }
    try {
      await this.publishRunViewToClients(
        { workflowKey, kind: "run", runRef },
        targets,
        definitionRollback
      );
    } catch (error) {
      // Invalidation is a refresh, never the write itself — a failed read must
      // not fail the mutation that triggered it.
      Log.warn(
        `[WorkflowOrchestrator] Failed to invalidate run view for ${targets.length} client(s): ${getErrorMessage(error)}`
      );
    }
  }

  /**
   * Deletes one stable run and rehydrates every client viewing the lineage.
   * A client on the deleted address moves to the newest remaining run (or the
   * draft); clients on another address retain that address but receive refreshed
   * summaries. Keeping this here prevents a UI-only caller from leaving another
   * connected client pointed at a removed directory.
   *
   * `address.runRef` may be any run in the lineage — deliberately not required
   * to be the requesting client's own viewed run. The run-navigation panel
   * (RUN_NAVIGATION_UX_PLAN.md) offers a delete button on every row while
   * browsing a lineage the client may not even be viewing (a drilled-into,
   * non-displayed lineage), so a "must match my own viewed address" guard
   * would reject the common case rather than an edge case.
   */
  async deleteRunAtAddress(
    address: { workflowKey: WorkflowKey; runRef: RunRef },
    send: (message: unknown) => void,
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<void> {
    if (this.findExecutionRunRef(address.workflowKey) === address.runRef) {
      throw new Error("Cannot delete an executing run");
    }
    const workspaceRoot = this.currentWorkspaceFolder?.uri.fsPath;
    if (!workspaceRoot) throw new Error("No workspace folder is open");

    const historyManager = new OutputHistoryManager(workspaceRoot);
    const deletedRunId = (
      await historyManager.getRunSummaries(address.workflowKey)
    ).find((summary) => summary.runRef === address.runRef)?.runId;
    await historyManager.deleteRunByRef(address.workflowKey, address.runRef);
    const remaining = await historyManager.getRunSummaries(address.workflowKey);
    const fallback: WorkflowViewAddress = remaining[0]
      ? {
          workflowKey: address.workflowKey,
          kind: "run",
          runRef: remaining[0].runRef,
        }
      : { workflowKey: address.workflowKey, kind: "draft" };

    const targets = [...this.getViewAddressRegistry().entries()].filter(
      ([, candidate]) => candidate?.workflowKey === address.workflowKey
    );
    const displacedAViewer = targets.some(
      ([, currentAddress]) =>
        currentAddress?.kind === "run" &&
        currentAddress.runRef === address.runRef
    );
    await Promise.all(
      targets.map(async ([targetClientId, currentAddress]) => {
        const targetAddress =
          currentAddress?.kind === "run" &&
          currentAddress.runRef === address.runRef
            ? fallback
            : currentAddress;
        if (!targetAddress) return;
        const targetSend =
          targetClientId === clientId
            ? send
            : this.getViewMessageSinks().get(targetClientId);
        if (!targetSend) return;
        await this.loadRunViewForClient(
          targetAddress,
          targetSend,
          targetClientId
        );
      })
    );

    // Only a client actually looking at the deleted run got moved off it —
    // deleting a different run's row from the navigation panel while viewing
    // something else changes nothing on screen and must stay silent.
    if (displacedAViewer) {
      const fallbackLabel =
        fallback.kind === "run" ? `Run ${remaining[0].runId}` : "the draft";
      notifyUserFeedback(
        this.userFeedbackSink,
        USER_FEEDBACK_SEVERITY.INFO,
        deletedRunId !== undefined
          ? `Run ${deletedRunId} was deleted — you're now viewing ${fallbackLabel}.`
          : `That run was deleted — you're now viewing ${fallbackLabel}.`
      );
    }

    await this.pushRunSummariesRefreshIfNotAlreadyViewing(
      address.workflowKey,
      send,
      targets.map(([targetClientId]) => targetClientId),
      clientId
    );
  }

  /**
   * Deletes every non-executing run of a lineage — the run-navigation panel's
   * "Delete all runs" footer action. Targets an explicit `workflowKey` rather
   * than the requesting client's own active queue, so it works for a
   * drilled-into lineage the client isn't executing or even currently viewing.
   */
  async deleteAllRunsForLineage(
    workflowKey: WorkflowKey,
    send: (message: unknown) => void,
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<void> {
    const workspaceRoot = this.currentWorkspaceFolder?.uri.fsPath;
    if (!workspaceRoot) throw new Error("No workspace folder is open");

    const historyManager = new OutputHistoryManager(workspaceRoot);
    const executionRunRef = this.findExecutionRunRef(workflowKey);
    const runRefs = await historyManager.getRunsForWorkflow(workflowKey);
    for (const runRef of runRefs) {
      if (runRef === executionRunRef) continue;
      try {
        await historyManager.deleteRunByRef(workflowKey, runRef);
      } catch (error) {
        Log.warn(
          `[WorkflowOrchestrator] deleteAllRunsForLineage: failed to delete ${workflowKey}/${runRef}:`,
          error
        );
      }
    }

    const remaining = await historyManager.getRunSummaries(workflowKey);
    const fallback: WorkflowViewAddress = remaining[0]
      ? { workflowKey, kind: "run", runRef: remaining[0].runRef }
      : { workflowKey, kind: "draft" };

    const targets = [...this.getViewAddressRegistry().entries()].filter(
      ([, candidate]) => candidate?.workflowKey === workflowKey
    );
    await Promise.all(
      targets.map(async ([targetClientId, currentAddress]) => {
        const targetAddress =
          currentAddress?.kind === "run" &&
          currentAddress.runRef !== executionRunRef
            ? fallback
            : currentAddress;
        if (!targetAddress) return;
        const targetSend =
          targetClientId === clientId
            ? send
            : this.getViewMessageSinks().get(targetClientId);
        if (!targetSend) return;
        await this.loadRunViewForClient(
          targetAddress,
          targetSend,
          targetClientId
        );
      })
    );

    await this.pushRunSummariesRefreshIfNotAlreadyViewing(
      workflowKey,
      send,
      targets.map(([targetClientId]) => targetClientId),
      clientId
    );
  }

  /**
   * The delete flows above only push a fresh `RUN_VIEW_LOADED` to clients
   * registered as viewers of the lineage (`getViewAddressRegistry`). A client
   * browsing this lineage's run-navigation panel without viewing it — the
   * drilled-into, non-displayed case — is not a "viewer" and would otherwise
   * see a stale run list after deleting from that panel. Push a manifest-only
   * refresh directly to the requester in that case; viewers already got a
   * full snapshot above.
   */
  private async pushRunSummariesRefreshIfNotAlreadyViewing(
    workflowKey: WorkflowKey,
    send: (message: unknown) => void,
    refreshedClientIds: string[],
    clientId: string
  ): Promise<void> {
    if (refreshedClientIds.includes(clientId)) {
      return;
    }
    await this.loadRunSummariesForClient(
      workflowKey,
      send,
      `delete-refresh-${Date.now()}`
    );
  }

  async executeEphemeralPrompt(
    text: string,
    properties: unknown,
    action: ActionType,
    promptName?: string,
    forceNewWorkflow?: boolean,
    clientId: string = this.PANEL_CLIENT_ID,
    mutation?: WorkflowDefinitionMutation
  ): Promise<void> {
    const instance = this.getInstanceForClient(clientId);

    // A prompt-editor submission addressed at a promoted run must target that
    // exact run. The bound instance is only lineage-accurate: its queue holds
    // whatever run it last loaded (typically the latest/executing run), so
    // when the client views a different run of the lineage, appending through
    // the instance would silently mutate the wrong run. Route those through
    // the run-addressed continuation/mutation primitives instead. When the
    // instance owns the addressed run itself (the everyday single-run case,
    // including dynamic append to the executing run), the instance path below
    // already targets the right file.
    if (!forceNewWorkflow && mutation && mutation.address.kind === "run") {
      const runAddress = mutation.address;
      const queueState = instance.getQueueState();
      const instanceOwnsAddressedRun =
        queueState.workflowKey === runAddress.workflowKey &&
        queueState.runRef === runAddress.runRef;
      if (!instanceOwnsAddressedRun) {
        return this.executeEphemeralPromptAtRun(
          runAddress,
          mutation,
          text,
          properties,
          action,
          promptName,
          clientId
        );
      }
    }

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

  /**
   * Prompt-editor submission against an addressed promoted run the client's
   * bound instance does not own (viewing an older run while the instance
   * holds another run of the lineage). Run actions append the step and
   * continue that exact `RunRef`; queue actions append to its definition head
   * without executing. Neither may fall back to the instance's loaded run.
   */
  private async executeEphemeralPromptAtRun(
    runAddress: WorkflowRunAddress,
    mutation: WorkflowDefinitionMutation,
    text: string,
    properties: unknown,
    action: ActionType,
    promptName: string | undefined,
    clientId: string
  ): Promise<void> {
    const step = buildEphemeralWorkflowStep(text, properties, promptName);
    const isRunAction =
      action === ACTION_TYPES.RUN ||
      action === ACTION_TYPES.RUN_NEXT ||
      action === ACTION_TYPES.RUN_BEFORE_CURRENT;
    if (isRunAction) {
      await this.appendAndContinueAtRun(
        runAddress,
        [step],
        mutation.expectedDefinitionRevision,
        mutation.expectedDescriptorRevision,
        clientId
      );
      return;
    }

    // Queue-only: validate the addressed edit (viewed-address + revision
    // checks, resident-instance guard priming), then append the runtime-free
    // tail step to the addressed run head in place.
    await this.prepareDefinitionMutation(mutation, clientId);
    await this.applyRunAddressedMutation(
      runAddress,
      (live) =>
        live.executeEphemeralPrompt(text, properties, action, promptName),
      (workspaceRoot) =>
        WorkingFileManager.appendStepsToRun(
          workspaceRoot,
          runAddress.workflowKey,
          runAddress.runRef,
          [step],
          mutation.expectedDefinitionRevision,
          this.lineageRepository
        ).then(() => undefined)
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Orchestrator-level workflow operations
  // ─────────────────────────────────────────────────────────────────────────

  async resumeSession(): Promise<void> {
    if (!this.currentWorkspaceFolder) {
      notifyUserFeedback(
        this.userFeedbackSink,
        USER_FEEDBACK_SEVERITY.ERROR,
        "No workspace folder open"
      );
      return;
    }

    try {
      const sessions = await this.workspaceSessionManager.discoverSessions(
        this.currentWorkspaceFolder.uri.fsPath
      );

      if (sessions.length === 0) {
        notifyUserFeedback(
          this.userFeedbackSink,
          USER_FEEDBACK_SEVERITY.INFO,
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
          await vscode.commands.executeCommand("ctrlyoke.dashboard.focus");
          Log.info(`Resumed session: ${selected.label}`);
        } catch (loadError) {
          Log.error("Failed to load session:", loadError as Error);
          notifyUserFeedback(
            this.userFeedbackSink,
            USER_FEEDBACK_SEVERITY.ERROR,
            `Failed to load session: ${getErrorMessage(loadError)}`
          );
        }
      }
    } catch (error) {
      Log.error("Failed to resume session:", error as Error);
      notifyUserFeedback(
        this.userFeedbackSink,
        USER_FEEDBACK_SEVERITY.ERROR,
        `Failed to resume session: ${getErrorMessage(error)}`
      );
    }
  }

  async openPanel(): Promise<void> {
    await this.workflowCommandHandler.openPanel();
  }

  async openCurrentPromptFile(): Promise<void> {
    const filePath = this.getActiveInstance().getCurrentPromptFilePath();
    await this.workflowCommandHandler.openCurrentPromptFile(filePath);
  }

  async createSampleScript(
    scriptType: EndConditionScriptType,
    scriptName?: string
  ): Promise<string | null> {
    return this.endConditionEvaluator.createSampleScript(
      scriptType,
      scriptName
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Harness / integration status
  // ─────────────────────────────────────────────────────────────────────────

  async retryHarnessDetection(): Promise<void> {
    await this.getDefaultIntegration().retryDetection();
  }

  /** @keep Standalone server API; see dev/backlog/STANDALONE_SERVER_PLAN.md. */
  getHarnessDetailedStatus() {
    return this.getDefaultIntegration().getDetailedStatus();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Dispose
  // ─────────────────────────────────────────────────────────────────────────

  /** Gracefully stop active instances and flush durable state before disposal. */
  async shutdown(): Promise<void> {
    const instances = new Set([
      ...this.instances.values(),
      ...this.retiredInstances.values(),
    ]);
    const results = await Promise.allSettled(
      [...instances].map((instance) => instance.shutdown())
    );
    for (const result of results) {
      if (result.status === "rejected") {
        Log.warn("Workflow shutdown did not settle cleanly:", result.reason);
      }
    }
  }

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
    if (this.runnerJsonDiscoveryPollInterval !== undefined) {
      clearInterval(this.runnerJsonDiscoveryPollInterval);
      this.runnerJsonDiscoveryPollInterval = undefined;
    }
    this.polledRunnerJsonMtimes.clear();

    this.statusBarManager.dispose();
    this.endConditionEvaluator.dispose();
    this.compatibilityRegistry.dispose();
    // Cancels any in-flight provider quota probe so its subprocess cannot
    // outlive the host (workspace close, extension deactivate).
    this.harnessUsageService?.dispose();
    // The run-summary cache is module-level, so nothing else drops it when the
    // host tears down (workspace close, extension deactivate).
    clearRunSummaryCache();
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
    return (
      this.instances.get(workflowId) ?? this.retiredInstances.get(workflowId)
    );
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
    return this.getBoundInstance(clientId) ?? this.getActiveInstance();
  }

  /**
   * The instance a client is bound to, or null — the strict counterpart of
   * `getInstanceForClient`, which falls back to the panel's instance. Read
   * paths that describe a *specific* client (its INIT payload, its prompt
   * file) must use this: the fallback would hand a client with no binding of
   * its own the panel's workflow, and browser clients are unbound on every
   * reconnect because `unregisterClient` clears their viewed id.
   */
  private getBoundInstance(clientId: string): WorkflowInstance | null {
    const id = this.getViewedWorkflowId(clientId);
    if (!id) return null;
    return this.instances.get(id) ?? this.retiredInstances.get(id) ?? null;
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
      // The address must follow the instance this client now edits; keeping the
      // previous workflow's address would point every addressed guard, and every
      // lineage-scoped command, at a workflow the client no longer has open.
      const adopted = workflowId
        ? (this.instances.get(workflowId) ??
          this.retiredInstances.get(workflowId))
        : undefined;
      this.getViewAddressRegistry().set(
        clientId,
        lineageAddressOf(adopted?.getQueueState())
      );
      const prevInRetired = prev ? this.retiredInstances.has(prev) : false;
      const prevStillViewed = prev
        ? this.isWorkflowViewedByAnyClient(prev)
        : false;
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

  /**
   * `send` registers this client's addressed-view channel. It must be supplied
   * by every real connection: server-initiated view pushes (`syncExecutingRunViews`,
   * `invalidateRunViews`) silently skip clients with no sink, and a client that
   * never explicitly loaded a run view — the whole "new workflow → queue → run"
   * path — would otherwise never be told its draft was promoted to a run, and
   * would keep offering "Run draft" for a run that has already finished.
   */
  registerClient(clientId: string, send?: (message: unknown) => void): void {
    if (!this.viewerRegistry.has(clientId)) {
      this.viewerRegistry.set(clientId, null);
    }
    const viewAddresses = this.getViewAddressRegistry();
    if (!viewAddresses.has(clientId)) {
      viewAddresses.set(clientId, null);
    }
    if (send) {
      this.getViewMessageSinks().set(clientId, send);
    }
  }

  unregisterClient(clientId: string): void {
    const workflowId = this.getViewedWorkflowId(clientId);
    const ptyManager = getPtyProcessManager();
    const ptyCount =
      workflowId && ptyManager
        ? ptyManager.getSessionsForWorkflow(workflowId).length
        : 0;
    Log.debug(
      `[unregisterClient] clientId=${clientId.slice(0, 12)} ` +
        `was viewing inst:${workflowId?.slice(0, 8) ?? "null"} ` +
        `(retired=${workflowId ? this.retiredInstances.has(workflowId) : false}, activePty=${ptyCount})`
    );
    this.viewerRegistry.delete(clientId);
    this.getViewAddressRegistry().delete(clientId);
    this.getViewMessageSinks().delete(clientId);

    if (!workflowId) return;

    // If the workflow is in retiredInstances and no other client views it, consider disposal.
    if (
      this.retiredInstances.has(workflowId) &&
      !this.isWorkflowViewedByAnyClient(workflowId)
    ) {
      // Don't dispose while PTY sessions are still running. The instance must remain in
      // retiredInstances so a reconnecting viewer (e.g. browser page refresh) can find it
      // by workflowId and receive TERMINAL_STARTED for the still-live sessions.
      // Cleanup happens on the next unregisterClient call after those sessions have ended.
      if (ptyCount > 0) {
        Log.debug(
          `[unregisterClient] keeping retired inst:${workflowId.slice(0, 8)} — ` +
            `${ptyCount} active PTY session(s) still running`
        );
        return;
      }
      Log.debug(
        `[unregisterClient] disposing retired inst:${workflowId.slice(0, 8)} — no viewers, no active PTY sessions`
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
        status !== EXECUTION_STATES.PAUSING &&
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
      (harnessOverride?: HarnessId) =>
        this.resolveDetectorIntegration(harnessOverride),
      (name: string | undefined) =>
        this.propagateWorkflowNameToIntegrations(name),
      () => this.updateStatusBar(),
      this.currentWorkspaceFolder?.uri.fsPath,
      true,
      this.compatibilityRegistry,
      this.userFeedbackSink,
      () => this.harnessUsageService?.getHarnessUsageSnapshots() ?? [],
      (harnessId) =>
        this.harnessUsageService?.refreshHarnessUsage(harnessId) ??
        Promise.resolve(),
      promptBatchApprovalForPendingWorkspaceSecretGrants
    );

    Log.debug(`buildWorkflowInstance: created inst:${instance.id.slice(0, 8)}`);

    // Tracks the lineage identity this instance last reported, so the address
    // registry is refreshed on the transition rather than on every state change.
    let lastLineageIdentity = "";

    // Broadcast summary updates whenever this instance's execution state changes.
    // This covers both active and inactive workflows so the multi-workflow list
    // stays in sync regardless of which workflow is currently displayed.
    instance.promptQueue.onDidChangeState((state) => {
      const summary = instance.getSummary();
      const inRegistry = this.instances.has(instance.id);

      const lineageIdentity = `${state.workflowKey ?? ""}|${state.runRef ?? ""}`;
      if (lineageIdentity !== lastLineageIdentity) {
        lastLineageIdentity = lineageIdentity;
        this.adoptInstanceLineageAddress(instance, state);
      }

      Log.debug(
        `[onDidChangeState] inst:${instance.id.slice(0, 8)} state=${state.status} name="${summary.workflowName || "(empty)"}" ` +
          `inRegistry=${inRegistry} registrySize=${this.instances.size} ` +
          `fp=${summary.filePath ? path.basename(summary.filePath) : "?"} step=${workflowDisplayStep(summary)}/${summary.totalSteps}`
      );

      // Mark this instance's lineageExecutionOwners claim (if any) promoted the
      // first time it actually reaches an execution-owner state. Until this
      // fires, a terminal status on the claimed instance is leftover from its
      // *previous* run (e.g. continuing an already-COMPLETED run reuses that
      // same retired instance) and must not be read as this claim being spent
      // — see `findInstanceForLineage` and `LineageExecutionClaim`.
      if (state.workflowKey && isExecutionOwnerState(state.status)) {
        const owners = this.getLineageExecutionOwners();
        const claim = owners.get(state.workflowKey);
        if (claim && claim.instanceId === instance.id && !claim.promoted) {
          owners.set(state.workflowKey, { ...claim, promoted: true });
        }
      }

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
          state.status === EXECUTION_STATES.PAUSING ||
          state.status === EXECUTION_STATES.PAUSED) &&
        !inRegistry
      ) {
        const wasRetired = this.promoteInstanceToLive(instance);
        Log.debug(
          `onDidChangeState: registered inst:${instance.id.slice(0, 8)} in running registry on ${state.status} ` +
            `name="${summary.workflowName || "(empty)"}" (total: ${this.instances.size})` +
            (wasRetired ? " — removed stale retiredInstances entry" : "")
        );
        this.dashboardBroadcastHub.notifyWorkflowAdded(summary);

        // If the panel is currently viewing a blank placeholder (no steps, no working file)
        // and this workflow was started outside the normal panel launch path (inRegistry=false),
        // auto-update viewerRegistry so subsequent executeEphemeralPrompt and retireWorkflow
        // calls resolve to this running instance instead of the blank placeholder.
        const panelViewedId = this.getViewedWorkflowId(this.PANEL_CLIENT_ID);
        if (panelViewedId !== instance.id) {
          const panelViewed = panelViewedId
            ? (this.instances.get(panelViewedId) ??
              this.retiredInstances.get(panelViewedId))
            : null;
          const panelSummary = panelViewed?.getSummary();
          const panelViewedIsBlank =
            !panelViewed ||
            (!panelSummary?.workingFilePath &&
              (panelSummary?.totalSteps ?? 0) === 0);
          if (panelViewedIsBlank) {
            this.setViewedWorkflowId(this.PANEL_CLIENT_ID, instance.id);
            Log.debug(
              `onDidChangeState: auto-switched panel viewerRegistry to running inst:${instance.id.slice(0, 8)} (panel had blank placeholder)`
            );
          }
        }
      }

      this.dashboardBroadcastHub.notifyWorkflowSummaryUpdated(summary);

      // A draft is promoted to a RunRef immediately before execution starts.
      // Rebind clients viewing that instance from the draft snapshot to the
      // executing run so subsequent dashboard property edits address and
      // persist to the same run working file as the executor.
      //
      // Terminal states matter for the same reason and are not redundant: a run
      // start that throws after the promotion published its run (harness
      // unavailable, lock contention, timeline init) never reaches RUNNING, and
      // the draft those clients are addressing was deleted by that promotion.
      // Without this they are stranded on a file that no longer exists, while
      // the definition they spent the session building sits in the promoted run
      // nothing has pointed them at.
      if (
        state.status === EXECUTION_STATES.RUNNING ||
        state.status === EXECUTION_STATES.ERROR ||
        state.status === EXECUTION_STATES.STOPPED ||
        state.status === EXECUTION_STATES.COMPLETED
      ) {
        this.syncExecutingRunViews(instance);
      }

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

  /**
   * Adopts an instance's own lineage as the view address of every client bound
   * to it, whenever that instance's lineage identity changes.
   *
   * The other writers of the address registry — `loadRunViewForClient` and
   * `syncExecutingRunViews` — are never involved when an instance creates a
   * lineage for itself (first property edit or rename on a brand-new
   * workflow). Without this, such a client keeps the address of whatever it
   * viewed previously, and every addressed guard then validates revisions of a
   * file the client is not editing — or a lineage-scoped command reaches into
   * the wrong workflow.
   *
   * A client already addressed *inside* this lineage is never repointed here,
   * because a silent registry write is the wrong answer for both clients that
   * can be in that position when a lineage gains a RunRef:
   *   - the one holding the lineage draft the promotion just deleted, which
   *     must be *shown* the new run — {@link syncExecutingRunViews} does that,
   *     and it can only recognise that client while its address still reads
   *     `draft`;
   *   - one deliberately reading an older run of the same lineage, which keeps
   *     its view (only the run's initiator follows a promotion).
   * Moving either one here left the backend addressing a run the client had
   * never been told about, so its next edit or run action was rejected against
   * an address it was not displaying.
   */
  private adoptInstanceLineageAddress(
    instance: WorkflowInstance,
    state: QueueState
  ): void {
    const address = lineageAddressOf(state);

    for (const [clientId, viewedInstanceId] of this.viewerRegistry) {
      if (viewedInstanceId !== instance.id) {
        continue;
      }
      if (
        address?.kind === "run" &&
        this.getViewAddress(clientId)?.workflowKey === address.workflowKey
      ) {
        continue;
      }
      this.getViewAddressRegistry().set(clientId, address);
    }
  }

  /**
   * Moves every client still holding this lineage's draft onto the run that
   * replaced it, and publishes that run's view to them.
   *
   * The draft file is deleted by the promotion, so this is the only thing that
   * keeps such a client addressable at all: left on the draft it offers "Run
   * draft" for a run that has already finished, and every addressed action it
   * sends is rejected because the backend resolved a file that no longer
   * exists.
   *
   * Called on the run's terminal states as well as RUNNING, so a start that
   * failed after publishing its run still lands those clients on it — that run
   * holds the definition the draft used to, and the header's Resume/Run gives
   * them a one-click retry there.
   */
  private syncExecutingRunViews(instance: WorkflowInstance): void {
    const state = instance.getQueueState();
    if (!state.workflowKey || !state.runRef) {
      return;
    }
    const address: Extract<WorkflowViewAddress, { kind: "run" }> = {
      workflowKey: state.workflowKey,
      kind: "run",
      runRef: state.runRef,
    };

    const targets: Array<{
      clientId: string;
      send: (message: unknown) => void;
    }> = [];
    for (const [clientId, viewedInstanceId] of this.viewerRegistry) {
      if (viewedInstanceId !== instance.id) {
        continue;
      }
      const viewedAddress = this.getViewAddress(clientId);
      if (
        viewedAddress?.kind !== "draft" ||
        viewedAddress.workflowKey !== state.workflowKey
      ) {
        continue;
      }
      // Move the address before publishing, not after: the publish is
      // asynchronous, the draft this client is addressing is already gone, and
      // RUNNING is emitted repeatedly — an unmoved address would send a fresh
      // snapshot on every one of them.
      this.getViewAddressRegistry().set(clientId, address);
      const send =
        this.getViewMessageSinks().get(clientId) ??
        (clientId === this.PANEL_CLIENT_ID ? this.storedPanelSend : undefined);
      if (!send) {
        continue;
      }
      targets.push({ clientId, send });
    }
    if (targets.length === 0) {
      return;
    }
    // One shared read for the whole fan-out. This is the promotion path, so the
    // run directory it reads was created milliseconds ago and the executor is
    // writing its first `_runtime` update into it right now — a per-client read
    // here is what turned every additional draft holder into extra contention
    // against that write.
    void this.publishRunViewToClients(address, targets).catch((error) =>
      Log.warn(
        `[WorkflowOrchestrator] Failed to switch ${targets.length} client(s) to executing run: ${getErrorMessage(error)}`
      )
    );
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
    harnessOverride?: HarnessId
  ): HarnessIntegration {
    const harness = harnessOverride ?? ConfigurationUtils.getIntegrationMode();
    switch (harness) {
      case HARNESS_IDS.CLAUDE_CLI:
        return this.claudeCliIntegration;
      case HARNESS_IDS.CODEX_CLI:
        return this.codexCliIntegration;
      case HARNESS_IDS.OPENCODE_CLI:
        return this.openCodeCliIntegration;
      case HARNESS_IDS.QWEN_CLI:
        return this.qwenCliIntegration;
      case HARNESS_IDS.ANTIGRAVITY_CLI:
        return this.antigravityCliIntegration;
      case HARNESS_IDS.COPILOT_CLI:
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
    this.antigravityCliIntegration.setWorkflowName(name);
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

    const runsRootDir = WorkflowPaths.runsRoot(workspaceFolderPath);

    // VS Code cannot reliably observe an external directory that does not
    // exist yet. Create the project state and .runs directories before
    // installing the discovery watcher below.
    try {
      await fs.promises.mkdir(runsRootDir, { recursive: true });
    } catch (err) {
      Log.warn(
        `[WorkflowOrchestrator] setupCliWatching: unable to create runs root "${runsRootDir}" — CLI discovery watcher not installed:`,
        err
      );
      return;
    }

    // Normalize stale locks and get active-cli paths
    let activeCliPaths: string[];
    let recoveredPaths: string[];
    try {
      const workflowKeys =
        await this.lineageRepository.listLineageKeys(workspaceFolderPath);
      const normalized = await WorkflowLockManager.normalizeStaleLocks(
        workspaceFolderPath,
        workflowKeys
      );
      activeCliPaths = normalized.activeCliRunFiles;
      recoveredPaths = normalized.recoveredRunFiles;
    } catch (err) {
      Log.warn(
        "[WorkflowOrchestrator] setupCliWatching: normalizeStaleLocks failed:",
        err
      );
      activeCliPaths = [];
      recoveredPaths = [];
    }

    // Prune `.creating-*` staging dirs orphaned by an allocateRun that never reached
    // finalizeAllocatedRun (crash, disk full, thrown validation error). Kept off the
    // blocks above/below so a failure here can't discard their recovery results.
    try {
      const workflowKeys =
        await this.lineageRepository.listLineageKeys(workspaceFolderPath);
      for (const workflowKey of workflowKeys) {
        await this.lineageRepository.pruneStaleStagingDirs(
          workspaceFolderPath,
          workflowKey
        );
      }
    } catch (err) {
      Log.warn(
        "[WorkflowOrchestrator] setupCliWatching: pruneStaleStagingDirs failed:",
        err
      );
    }

    // Close out history manifests left RUNNING by the dead owner. Kept off the
    // block above so a recovery failure cannot discard activeCliPaths and
    // silently leave CLI-managed workflows unwatched.
    try {
      const historyManager = new OutputHistoryManager(workspaceFolderPath);
      for (const recoveredPath of recoveredPaths) {
        const recoveredAddress = WorkflowPaths.parseRunFilePath(
          workspaceFolderPath,
          recoveredPath
        );
        if (!recoveredAddress) {
          continue;
        }
        let stepCount = 0;
        try {
          const recoveredWorkingFile = JSON.parse(
            await fs.promises.readFile(recoveredPath, "utf8")
          ) as { steps?: unknown[] };
          stepCount = recoveredWorkingFile.steps?.length ?? 0;
        } catch {
          // The history manifest can still be finalized without a step count.
        }
        await historyManager.recoverInterruptedRun(
          recoveredAddress.workflowKey,
          stepCount
        );
      }
    } catch (err) {
      Log.warn(
        "[WorkflowOrchestrator] setupCliWatching: interrupted-run recovery failed:",
        err
      );
    }

    // Create CliWatchSession for each active-cli workflow (Entry Point 1)
    for (const workingFilePath of activeCliPaths) {
      await this.startCliWatchSession(workingFilePath, workspaceFolderPath);
    }

    // Entry Point 3: Watch for new runner.json files created while VS Code is open
    this.setupRunnerJsonCreateWatcher(workspaceFolderPath, runsRootDir);
  }

  /** Read-only activation report for managed and user-owned Git worktrees. */
  private async discoverWorktreesOnActivation(): Promise<void> {
    const workspaceFolderPath = this.currentWorkspaceFolder?.uri.fsPath;
    if (!workspaceFolderPath) return;

    try {
      const report = await new WorktreeManager().discoverActivationState({
        sourceCheckoutRoot: workspaceFolderPath,
      });
      const inUse = report.worktrees.filter((entry) => entry.inUse);
      const prunable = report.worktrees.filter((entry) => entry.prunableReason);

      Log.info(
        `[WorktreeRecovery] activation discovered ${report.worktrees.length} worktree(s), ` +
          `${report.recoverableManagedWorktrees.length} recoverable managed, ` +
          `${report.staleManagedWorktrees.length} stale managed record(s), ` +
          `${prunable.length} prunable entr${prunable.length === 1 ? "y" : "ies"}.`
      );
      for (const entry of inUse) {
        const owners = entry.leaseOwners
          .map(
            ({ lease, ageMs }) =>
              `workflow ${lease.workflowKey}, run ${lease.runRef}; ` +
              `${lease.runner} instance ${lease.instanceId}, PID ${lease.pid}; ` +
              `state root ${lease.stateRoot}; lease age ${Math.floor(ageMs / 1000)}s`
          )
          .join(" | ");
        Log.warn(
          `[WorktreeRecovery] worktree in use: ${entry.worktreePath} — ${owners}`
        );
      }
      for (const entry of prunable) {
        Log.warn(
          `[WorktreeRecovery] Git reports a prunable worktree entry: ${entry.worktreePath}` +
            `${entry.prunableReason ? ` (${entry.prunableReason})` : ""}. No automatic prune was performed.`
        );
      }
      for (const record of report.staleManagedWorktrees) {
        Log.warn(
          `[WorktreeRecovery] managed worktree requires reconciliation: ${record.branchName} at ${record.worktreePath}. ` +
            "Activation is read-only; no directory or branch was deleted."
        );
      }
    } catch (error) {
      Log.warn("[WorktreeRecovery] activation discovery failed:", error);
    }
  }

  /**
   * Watch for new *.runner.json files so we detect when the CLI starts a workflow
   * while VS Code is already open.
   */
  private setupRunnerJsonCreateWatcher(
    workspaceFolderPath: string,
    runsRootDir: string
  ): void {
    const pattern = new vscode.RelativePattern(
      vscode.Uri.file(runsRootDir),
      "*/runner.json"
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
      await this.handleRunnerJsonEvent(uri.fsPath, workspaceFolderPath);
    });

    // VS Code 1.133 on Windows did not deliver the recursive event for a
    // runner file created below an external RelativePattern base. Keep the
    // watcher for hosts that do support it, but poll the small lineage-root
    // directory as a reliable discovery fallback.
    this.runnerJsonDiscoveryPollInterval = setInterval(() => {
      void this.pollRunnerJsonDiscovery(runsRootDir, workspaceFolderPath);
    }, 1_000);
  }

  private async pollRunnerJsonDiscovery(
    runsRootDir: string,
    workspaceFolderPath: string
  ): Promise<void> {
    try {
      const entries = await fs.promises.readdir(runsRootDir, {
        withFileTypes: true,
      });
      const seenRunnerPaths = new Set<string>();
      await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          // The lineage directory name *is* the workflowKey, so an already
          // watched run can be skipped without touching the filesystem.
          .filter((entry) => !this.cliSessions.has(entry.name))
          .map(async (entry) => {
            // WorkflowPaths owns every `.runs` path; it rejects a directory
            // name that is not a valid workflowKey, which is not a lineage.
            let runnerPath: string;
            try {
              runnerPath = WorkflowPaths.runnerLockPath(
                workspaceFolderPath,
                entry.name as WorkflowKey
              );
            } catch {
              return;
            }
            let mtimeMs: number;
            try {
              ({ mtimeMs } = await fs.promises.stat(runnerPath));
            } catch {
              return;
            }
            seenRunnerPaths.add(runnerPath);
            if (this.polledRunnerJsonMtimes.get(runnerPath) === mtimeMs) {
              return;
            }
            this.polledRunnerJsonMtimes.set(runnerPath, mtimeMs);
            await this.handleRunnerJsonEvent(runnerPath, workspaceFolderPath);
          })
      );
      // Drop locks that have been released so a later run at the same path is
      // treated as new rather than being suppressed by a remembered mtime.
      for (const trackedPath of this.polledRunnerJsonMtimes.keys()) {
        if (!seenRunnerPaths.has(trackedPath)) {
          this.polledRunnerJsonMtimes.delete(trackedPath);
        }
      }
    } catch (err) {
      Log.debug(
        `[WorkflowOrchestrator] pollRunnerJsonDiscovery: unable to scan "${runsRootDir}":`,
        err
      );
    }
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

    if (lock.runner !== RUNNER_IDS.CLI) {
      return;
    }

    // The lock itself names the exact lineage/run — no path-basename derivation needed.
    const workflowId = lock.workflowKey;
    const workingFilePath = WorkflowPaths.runFilePath(
      workspaceFolderPath,
      lock.workflowKey,
      lock.runRef
    );

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
    const status = await WorkflowLockManager.checkLock(
      workspaceFolderPath,
      workflowId
    );
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
    const address =
      WorkflowPaths.parseWorkingFileAddressFromPath(workingFilePath);
    if (!address?.runRef) {
      Log.warn(
        `[WorkflowOrchestrator] startCliWatchSession: "${workingFilePath}" is not a promoted run file — skipping`
      );
      return;
    }
    const { workflowKey, runRef } = address;
    const workflowId = workflowKey;

    // Retire any existing VS Code WorkflowInstance tracking this same working file.
    // This prevents a conflict where VS Code auto-loaded the workflow in PAUSED state
    // and the CLI is now taking over execution. Without this, the PAUSED instance
    // stays in the Running Workflows section alongside the CLI watch session.
    for (const [instanceId, instance] of [...this.instances.entries()]) {
      if (
        sameWorkingFilePath(
          instance.getSummary().workingFilePath,
          workingFilePath
        )
      ) {
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
      _runtime?: {
        currentIndex?: number;
        executionState?: string;
        tokenTotals?: WorkflowSummary["tokenTotals"];
      };
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
      managedBy: RUNNER_IDS.CLI,
      tokenTotals: workingFile._runtime?.tokenTotals,
    };

    const session = new CliWatchSession(
      workingFilePath,
      workflowKey,
      runRef,
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
          managedBy: RUNNER_IDS.CLI,
        };
        entry.summary = updatedSummary;
        this.dashboardBroadcastHub.notifyWorkflowSummaryUpdated(updatedSummary);

        // If the CLI extended the queue, send the new prompts so the WorkflowStepsPanel reflects them
        if (updatedSummary.totalSteps > prevTotalSteps) {
          const provider = this.dashboardBroadcastHub;
          fs.promises
            .readFile(workingFilePath, "utf8")
            .then((content) => {
              const wf = JSON.parse(content) as {
                steps?: unknown[];
                definitionRevision?: number;
              };
              if (wf.steps) {
                Log.debug(
                  `[WorkflowOrchestrator] CLI extended queue for "${workflowId}": ${prevTotalSteps} → ${updatedSummary.totalSteps} steps`
                );
                provider.notifyCliPromptsExtended(
                  workflowId,
                  wf.steps,
                  wf.definitionRevision ?? 1
                );
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
          _runtime?: {
            executionState?: string;
            currentIndex?: number;
            tokenTotals?: WorkflowSummary["tokenTotals"];
          };
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
          tokenTotals: workingFile._runtime?.tokenTotals,
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
