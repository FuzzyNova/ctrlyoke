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
  type RunnerHostIdentity,
  EXECUTION_STATES,
  type PromptFile,
  type WorkflowStep,
  type WorkflowKey,
  type RunRef,
  type WorkflowRunAddress,
  type WorkflowViewAddress,
  type CoordinationScopeSnapshot,
  type WorktreeRunProjection,
  type WorkspaceWorktreeOwnership,
  projectWorktreeRuntime,
} from "../types/CtrlYokeTypes";
import {
  ACTION_TYPES,
  EXTERNAL_EXECUTION_RESOLUTION_KINDS,
  HARNESS_IDS,
  MESSAGE_TYPES,
  PANEL_CLIENT_ID,
  RUNNER_IDS,
  STEP_TYPES,
  USER_FEEDBACK_SEVERITY,
  WORKTREE_EDIT_KINDS,
  WORKTREE_BRANCH_STATES,
  WORKTREE_MODES,
  type EndConditionScriptType,
  type HarnessId,
  type QueuePosition,
  type ActionType,
  type WorktreeManagementAction,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "../types/DashboardConstants";
import type { IDashboardSink } from "../types/IDashboardSink";
import { PostMessageDashboardSink } from "../ui/PostMessageDashboardSink";
import type {
  DisposableRegistry,
  FileWatcherFactory,
  KeyValueStore,
  StatusBarSink,
} from "./HostPorts";
import type {
  ActiveTerminalWorkflowRef,
  WorkflowDefinitionMutation,
  WorkflowViewIdentityMessage,
  ExecutionPreviewScope,
  TerminalStartedMessage,
} from "../types/WebviewMessageTypes";
import type { PendingParallelGroupRange } from "./ParallelGroupTopology";
import { Log } from "../utils/Log";
import { getErrorMessage } from "../utils/ErrorUtils";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { ExternalRootsTrustStore } from "../config/ExternalRootsTrustStore";
import { OutputHistoryManager } from "./orchestration/OutputHistoryManager";
import { clearRunSummaryCache } from "./orchestration/RunSummaryCache";
import { EndConditionEvaluator } from "./EndConditionEvaluator";
import * as WorkflowPaths from "../utils/WorkflowPaths";
import { WorkflowLineageRepository } from "./orchestration/WorkflowLineageRepository";
import { DefinitionAuthorLedger } from "./orchestration/DefinitionAuthorLedger";
import {
  assertDefinitionRevision,
  assertDescriptorRevision,
} from "./orchestration/RevisionPrecondition";
import {
  ExecutionRootCoordinationWatchSession,
  readCoordinationScopeSnapshot,
} from "./orchestration/ExecutionRootCoordinationWatchSession";
import type { ExternalExecutionResolution } from "./orchestration/ExternalExecutionResolver";
import {
  ExternalRunWatchCoordinator,
  type ExternalRunWatchInstance,
} from "./orchestration/ExternalRunWatchCoordinator";
import {
  deleteWorkflowStopRequest,
  waitForWorkflowStopRequestPickup,
  writeWorkflowStopRequest,
} from "../utils/WorkflowStopRequest";
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
  WorkflowInstanceRegistry,
  type LineageExecutionClaim,
  lineageAddressOf,
} from "./orchestration/WorkflowInstanceRegistry";
import {
  RunViewPublisher,
  type DefinitionRollbackInvalidation,
  type StepColorInvalidation,
  sameViewAddress,
} from "./orchestration/RunViewPublisher";
import {
  RunLifecycleService,
  type ExplicitContinuationValidation,
  type RunLifecycleViewPort,
} from "./orchestration/RunLifecycleService";
import {
  WorktreeManager,
  type WorktreeInfo,
  type WorktreeSyncResult,
} from "./orchestration/WorktreeManager";
import { PromptFileParser } from "./PromptFileParser";
import type { PlatformAdapter } from "../platform/PlatformAdapter";
import { PropertyResolver } from "../utils/PropertyResolver";
import type { UserFeedbackSink } from "./UserFeedbackSink";
import { notifyUserFeedback } from "./UserFeedbackSink";
import {
  DashboardBroadcastHub,
  type DashboardClient,
} from "../ui/DashboardBroadcastHub";
import { promptBatchApprovalForPendingWorkspaceSecretGrants } from "../ui/SecretGrantsTrustPrompt";
import { promptBatchApprovalForPendingWorkflowExternalRoots } from "../ui/ExternalFileTrustPrompt";
import {
  NullUserInteractionPort,
  type UserInteractionPort,
} from "../ui/UserInteractionPort";
import { TypedEmitter } from "../utils/TypedEmitter";

/**
 * WorkflowOrchestrator
 *
 * RESPONSIBILITY: Workflow Registry & Cross-Cutting Concerns
 *
 * Manages the registry of WorkflowInstance objects and owns resources that
 * are shared or orchestrator-scoped:
 *   - Six harness integrations (created once and shared by workflow instances)
 *   - injected host services
 *   - WorkflowCommandHandler
 *   - WorkspaceSessionManager (workspace-level session discovery)
 *   - dashboardReady / orchestratorInitialized gates
 *
 * Holds active and retired workflow instances in registry-owned maps; the
 * active workflow ID decides which one is displayed in the dashboard.
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
interface WorkflowReplayOptions {
  skipTerminalReplay?: boolean;
}

export interface WorkflowOrchestratorDependencies {
  platform: PlatformAdapter;
  /**
   * Resolves the workspace folder path. The orchestrator samples this once
   * during construction to preserve the previous workspace-folder semantics.
   */
  workspaceFolderPathResolver: () => string | undefined;
  dashboardProvider?: DashboardClient;
  userFeedbackSink: UserFeedbackSink;
  runnerHostIdentity: RunnerHostIdentity;
  fileWatcherFactory: FileWatcherFactory;
  statusBarSink?: StatusBarSink;
  disposableRegistry: DisposableRegistry;
  workspaceState: KeyValueStore;
  /**
   * Resolves the host's current workspace-trust state. Headless hosts are
   * trusted by default because they have no VS Code trust lifecycle.
   */
  isWorkspaceTrusted?: () => boolean;
  userInteractionPort?: UserInteractionPort;
}

export type ResumableSession = Awaited<
  ReturnType<WorkspaceSessionManager["discoverSessions"]>
>[number];

export class WorkflowOrchestrator {
  // ─────────────────────────────────────────────────────────────────────────
  // Instance registry
  // ─────────────────────────────────────────────────────────────────────────

  private workflowInstanceRegistryInstance?: WorkflowInstanceRegistry;
  private get workflowInstanceRegistry(): WorkflowInstanceRegistry {
    return (this.workflowInstanceRegistryInstance ??=
      this.createWorkflowInstanceRegistry());
  }
  private set workflowInstanceRegistry(value: WorkflowInstanceRegistry) {
    this.workflowInstanceRegistryInstance = value;
  }

  private runViewPublisherInstance?: RunViewPublisher;
  private get runViewPublisher(): RunViewPublisher {
    return (this.runViewPublisherInstance ??= this.createRunViewPublisher());
  }
  private set runViewPublisher(value: RunViewPublisher) {
    this.runViewPublisherInstance = value;
  }

  /** Builds the instance registry with this orchestrator as its host. */
  private createWorkflowInstanceRegistry(): WorkflowInstanceRegistry {
    // Every member reads through `this` at call time rather than capturing the
    // field's value here: the orchestrator's collaborators are replaceable
    // seams, and a captured reference would pin the registry to whichever
    // object happened to exist when it was built.
    const orchestrator = this;
    return new WorkflowInstanceRegistry({
      get platform() {
        return orchestrator.platform;
      },
      get dashboardSink() {
        return orchestrator.dashboardBroadcastHub as IDashboardSink;
      },
      get dashboardBroadcast() {
        return orchestrator.dashboardBroadcastHub;
      },
      get integrationFactory() {
        return orchestrator.integrationFactory;
      },
      resolveDetectorIntegration: (harnessOverride) =>
        this.resolveDetectorIntegration(harnessOverride),
      propagateWorkflowNameToIntegrations: (name) =>
        this.propagateWorkflowNameToIntegrations(name),
      updateStatusBar: () => this.updateStatusBar(),
      get currentWorkspaceFolderPath() {
        return orchestrator.currentWorkspaceFolderPath;
      },
      get compatibilityRegistry() {
        return orchestrator.compatibilityRegistry;
      },
      get userFeedbackSink() {
        return orchestrator.userFeedbackSink;
      },
      getHarnessUsageSnapshots: () =>
        this.harnessUsageService?.getHarnessUsageSnapshots() ?? [],
      refreshHarnessUsage: async (harnessId) => {
        await this.harnessUsageService?.refreshHarnessUsage(harnessId);
      },
      approveSecretGrantsForWorkflow: (workflow, workspaceRoot) =>
        this.approveSecretGrantsForWorkflow(workflow, workspaceRoot),
      get runnerHostIdentity() {
        return orchestrator.runnerHostIdentity;
      },
      get panelClientId() {
        return orchestrator.PANEL_CLIENT_ID;
      },
      getStoredPanelSend: () => this.storedPanelSend,
      replayWorkflowStateTo: (workflowId, send, clientId) =>
        this.replayWorkflowStateTo(workflowId, send, clientId),
      approvePendingWorkflowExternalRootsForClient: (
        clientId,
        send,
        port,
        promptUser
      ) =>
        this.approvePendingWorkflowExternalRootsForClient(
          clientId,
          send,
          port,
          promptUser
        ),
      emitWorkflowExternalRootsApprovalState: (
        clientId,
        workflowId,
        pendingRoots,
        send
      ) =>
        this.emitWorkflowExternalRootsApprovalState(
          clientId,
          workflowId,
          pendingRoots,
          send
        ),
      saveState: () => this.saveState(),
      ensureCoordinationWatchSession: (executionRoot) =>
        this.ensureCoordinationWatchSession(executionRoot),
      getActiveWorkflowId: () => this.getActiveWorkflowId(),
      fireActiveQueueStateChanged: (state) =>
        this.getActiveQueueStateChangedEmitter().fire(state),
      getActiveQueueState: () => this.getActiveQueueState(),
      getActiveTerminalWorkflowRefs: () => this.getActiveTerminalWorkflowRefs(),
      syncExecutingRunViews: (instance) => this.syncExecutingRunViews(instance),
    });
  }

  private createRunViewPublisher(): RunViewPublisher {
    return new RunViewPublisher({
      workspaceRoot: this.currentWorkspaceFolderPath,
      lineageRepository: this.lineageRepository,
      registry: this.workflowInstanceRegistry,
      externalRunWatch: this.externalRunWatchCoordinator ?? {
        hasSession: () => false,
        getEntry: () => undefined,
      },
      loadFreshInstanceAndReplay: (filePath, clientId, send, options) =>
        this.loadFreshInstanceAndReplay(filePath, clientId, send, options),
      findExecutionRunRef: (workflowKey) =>
        this.findExecutionRunRef(workflowKey),
      getActiveTerminalWorkflowRefs: () => this.getActiveTerminalWorkflowRefs(),
      replayTerminalSessionsTo: (workflowId, send, clientId) =>
        this.replayTerminalSessionsTo(workflowId, send, clientId),
    });
  }

  private runLifecycleServiceInstance?: RunLifecycleService;
  private get runLifecycleService(): RunLifecycleService {
    return (this.runLifecycleServiceInstance ??=
      this.createRunLifecycleService());
  }

  private createRunLifecycleService(): RunLifecycleService {
    const views: RunLifecycleViewPort = {
      getViewAddress: (clientId) => this.getViewAddress(clientId),
      loadRunViewForClient: (address, send, clientId) =>
        this.loadRunViewForClient(address, send, clientId),
      publishRunRevisionsToViewers: (workflowKey, runRef) =>
        this.publishRunRevisionsToViewers(workflowKey, runRef),
      invalidateRunViews: (workflowKey, runRef, definitionRollback) =>
        this.invalidateRunViews(workflowKey, runRef, definitionRollback),
      pushRunSummariesRefreshIfNotAlreadyViewing: (
        workflowKey,
        send,
        refreshedClientIds,
        clientId
      ) =>
        this.pushRunSummariesRefreshIfNotAlreadyViewing(
          workflowKey,
          send,
          refreshedClientIds,
          clientId
        ),
    };
    return new RunLifecycleService({
      registry: this.workflowInstanceRegistry,
      views,
      panelClientId: this.PANEL_CLIENT_ID,
      getWorkspaceRoot: () => this.currentWorkspaceFolderPath,
      getLineageRepository: () => this.lineageRepository,
      getRunnerHostIdentity: () => this.runnerHostIdentity,
      getUserFeedbackSink: () => this.userFeedbackSink,
      getInstanceForClient: (clientId) => this.getInstanceForClient(clientId),
      getStoredPanelSend: () => this.storedPanelSend,
      assertNoPendingWorkflowExternalRoots: (clientId) =>
        this.assertNoPendingWorkflowExternalRoots(clientId),
      buildWorkflowInstance: () => this.buildWorkflowInstance(),
      replayWorkflowStateTo: (workflowId, send, clientId) =>
        this.replayWorkflowStateTo(workflowId, send, clientId),
      getExternalExecutionRunRef: (workflowKey) => {
        const external = this.externalRunWatchCoordinator.getEntry(workflowKey);
        return external
          ? WorkflowPaths.parseWorkingFileAddressFromPath(
              external.summary.workingFilePath ?? ""
            )?.runRef
          : undefined;
      },
    });
  }

  // These accessors keep prototype-based legacy unit fixtures wired to the
  // real registry while the remaining façade tests are migrated.
  private get instances(): Map<string, WorkflowInstance> {
    return this.workflowInstanceRegistry.getInstances();
  }
  private set instances(value: Map<string, WorkflowInstance>) {
    const target = this.workflowInstanceRegistry.getInstances();
    target.clear();
    for (const [id, instance] of value) target.set(id, instance);
  }
  private get retiredInstances(): Map<string, WorkflowInstance> {
    return this.workflowInstanceRegistry.getRetiredInstances();
  }
  private set retiredInstances(value: Map<string, WorkflowInstance>) {
    const target = this.workflowInstanceRegistry.getRetiredInstances();
    target.clear();
    for (const [id, instance] of value) target.set(id, instance);
  }
  private get viewerRegistry(): Map<string, string | null> {
    return this.workflowInstanceRegistry.getViewerRegistry();
  }
  private set viewerRegistry(value: Map<string, string | null>) {
    const target = this.workflowInstanceRegistry.getViewerRegistry();
    target.clear();
    for (const [id, instanceId] of value) target.set(id, instanceId);
  }
  public get viewAddressRegistry(): Map<string, WorkflowViewAddress | null> {
    return this.workflowInstanceRegistry.getViewAddressRegistry();
  }
  public set viewAddressRegistry(
    value: Map<string, WorkflowViewAddress | null>
  ) {
    const target = this.workflowInstanceRegistry.getViewAddressRegistry();
    target.clear();
    for (const [id, address] of value) target.set(id, address);
  }
  public get viewMessageSinks(): Map<string, (message: unknown) => void> {
    return this.workflowInstanceRegistry.getViewMessageSinks();
  }
  public set viewMessageSinks(value: Map<string, (message: unknown) => void>) {
    const target = this.workflowInstanceRegistry.getViewMessageSinks();
    target.clear();
    for (const [id, send] of value) target.set(id, send);
  }
  public get lineageBindingClients(): Set<string> {
    return this.workflowInstanceRegistry.getLineageBindingClients();
  }
  public set lineageBindingClients(value: Set<string>) {
    const target = this.workflowInstanceRegistry.getLineageBindingClients();
    target.clear();
    for (const clientId of value) target.add(clientId);
  }
  public get lineageExecutionOwners(): Map<WorkflowKey, LineageExecutionClaim> {
    return this.workflowInstanceRegistry.getLineageExecutionOwners();
  }
  public set lineageExecutionOwners(
    value: Map<WorkflowKey, LineageExecutionClaim>
  ) {
    const target = this.workflowInstanceRegistry.getLineageExecutionOwners();
    target.clear();
    for (const [key, claim] of value) target.set(key, claim);
  }
  public get externallyCreatedInstanceIds(): Set<string> {
    return this.workflowInstanceRegistry.getExternallyCreatedInstanceIds();
  }
  public set externallyCreatedInstanceIds(value: Set<string>) {
    const target =
      this.workflowInstanceRegistry.getExternallyCreatedInstanceIds();
    target.clear();
    for (const id of value) target.add(id);
  }
  public get announcedExternalWorkflowIds(): Set<string> {
    return this.workflowInstanceRegistry.getAnnouncedExternalWorkflowIds();
  }
  public set announcedExternalWorkflowIds(value: Set<string>) {
    const target =
      this.workflowInstanceRegistry.getAnnouncedExternalWorkflowIds();
    target.clear();
    for (const id of value) target.add(id);
  }
  private readonly lineageRepository = new WorkflowLineageRepository();
  private definitionAuthorLedgerInstance?: DefinitionAuthorLedger;
  private get definitionAuthorLedger(): DefinitionAuthorLedger {
    return (this.definitionAuthorLedgerInstance ??=
      new DefinitionAuthorLedger());
  }

  private readonly externalRunWatchCoordinator: ExternalRunWatchCoordinator;
  private readonly coordinationWatchSessions = new Map<
    string,
    ExecutionRootCoordinationWatchSession
  >();

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

  /** Emits the queue state of the instance currently viewed by the panel. */
  private activeQueueStateChangedEmitter?: TypedEmitter<QueueState | undefined>;

  // ─────────────────────────────────────────────────────────────────────────
  // Cross-cutting concerns
  // ─────────────────────────────────────────────────────────────────────────
  private readonly dashboardBroadcastHub = new DashboardBroadcastHub();
  private readonly harnessUsageService?: HarnessUsageService;
  private readonly workspaceStatsService?: WorkspaceStatsService;
  private readonly integrationFactory: IntegrationFactory;
  private readonly compatibilityRegistry: HarnessCapabilityRegistry;
  private readonly platform: PlatformAdapter;
  private readonly statusBarSink?: StatusBarSink;
  private readonly disposableRegistry: DisposableRegistry;
  private readonly fileWatcherFactory: FileWatcherFactory;
  private readonly workspaceState: KeyValueStore;
  private readonly userFeedbackSink: UserFeedbackSink;
  private readonly runnerHostIdentity: RunnerHostIdentity;
  private readonly userInteractionPort: UserInteractionPort;
  private readonly workspaceTrustPredicate?: () => boolean;
  private readonly currentWorkspaceFolderPath: string | undefined;

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

  constructor(dependencies: WorkflowOrchestratorDependencies) {
    this.platform = dependencies.platform;
    this.statusBarSink = dependencies.statusBarSink;
    this.disposableRegistry = dependencies.disposableRegistry;
    this.fileWatcherFactory = dependencies.fileWatcherFactory;
    this.workspaceState = dependencies.workspaceState;
    this.userFeedbackSink = dependencies.userFeedbackSink;
    this.runnerHostIdentity = dependencies.runnerHostIdentity;
    this.workspaceTrustPredicate =
      dependencies.isWorkspaceTrusted ?? (() => true);
    this.userInteractionPort =
      dependencies.userInteractionPort ?? new NullUserInteractionPort();

    // Create the startup auto-load promise — browser clients await this instead
    // of registering pending callbacks, eliminating the startup race condition.
    this.startupAutoLoadSettled = new Promise((resolve) => {
      this.resolveStartupAutoLoad = resolve;
    });

    if (dependencies.dashboardProvider) {
      this.dashboardBroadcastHub.addClient(dependencies.dashboardProvider);
    }
    // Workspace — the folder matching the resolved `.ctrlyoke` root
    // (honors the `.code-workspace` dir and `ctrlyoke.workspaceDirectory`).
    this.currentWorkspaceFolderPath =
      dependencies.workspaceFolderPathResolver();
    this.externalRunWatchCoordinator = new ExternalRunWatchCoordinator({
      broadcast: this.dashboardBroadcastHub,
      lineageRepository: this.lineageRepository,
      findInstanceForWorkingFile: (workingFilePath) =>
        this.findInstancesForExternalRunWatch(workingFilePath),
      retireWorkflow: (workflowId) => this.retireWorkflow(workflowId),
      workspaceRoot: this.currentWorkspaceFolderPath,
      saveState: () => this.saveState(),
      getOutputHistoryManager: () => this.getOutputHistoryManager(),
      runnerHostIdentity: this.runnerHostIdentity,
      fileWatcherFactory: this.fileWatcherFactory,
    });
    if (this.currentWorkspaceFolderPath) {
      this.ensureCoordinationWatchSession(this.currentWorkspaceFolderPath);
      this.harnessUsageService = new HarnessUsageService(
        this.currentWorkspaceFolderPath,
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
        this.currentWorkspaceFolderPath
      );
    }

    this.integrationFactory = new IntegrationFactory(
      this.platform,
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

    // Status updates are delegated to the optional host-owned status sink.
    // Shared parsers / orchestration helpers
    this.promptFileParser = new PromptFileParser(
      this.platform,
      this.userFeedbackSink
    );
    this.workspaceSessionManager = new WorkspaceSessionManager(
      this.promptFileParser,
      this.platform
    );
    this.endConditionEvaluator = new EndConditionEvaluator(this.platform);
    this.workflowCommandHandler = new WorkflowCommandHandler(
      this.userFeedbackSink
    );

    this.workflowInstanceRegistry = this.createWorkflowInstanceRegistry();

    this.runViewPublisher = this.createRunViewPublisher();

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
      this.disposableRegistry.add(
        integration.onDidChangeStatus((status) => {
          if (integration === defaultIntegration) {
            Log.trace(
              `[WorkflowOrchestrator] Copilot status changed to: ${status}`
            );
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
    Log.debug("[WorkflowOrchestrator] WorkflowOrchestrator initialized");
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
   * Create a workflow instance for an orchestrated one-shot background caller
   * (e.g. commit-message generation) that must run without hijacking any
   * client's currently displayed workflow.
   *
   * Unlike the normal dashboard workflow path, the caller loads its prompt after
   * construction so it can allocate the persisted lineage first. Registration
   * here is what wires the instance's dashboard sink and lifecycle listener into
   * the normal live-run pipeline. The instance is deliberately never adopted as
   * any client's viewed workflow — `externallyCreatedInstanceIds` marks it so
   * `buildWorkflowInstance`'s state-change listener announces it
   * (`notifyWorkflowAdded`, for the Running-workflows dropdown) once it starts
   * executing instead of skipping the announcement as "already registered", and
   * so it's excluded from the blank-panel auto-adopt behavior meant for normal
   * runs. Because nothing ever views it, there's also no currently-viewed
   * idle instance to dispose here the way the normal "make active" path does.
   */
  public createExternalWorkflowInstance(): WorkflowInstance {
    return this.workflowInstanceRegistry.createExternalWorkflowInstance();
  }

  /**
   * Creates a fresh WorkflowInstance and makes it the active workflow.
   * Phase 2: adds it alongside existing instances without clearing the registry.
   */
  private async createWorkflow(
    _filePath?: string
  ): Promise<WorkflowInstance | undefined> {
    return this.workflowInstanceRegistry.createWorkflow(_filePath);
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
  public promoteInstanceToLive(instance: WorkflowInstance): boolean {
    return this.workflowInstanceRegistry.promoteInstanceToLive(instance);
  }

  private retireWorkflow(workflowId: string): void {
    this.workflowInstanceRegistry.retireWorkflow(workflowId);
  }

  getWorkflow(workflowId: string): WorkflowInstance | undefined {
    return this.workflowInstanceRegistry.getWorkflow(workflowId);
  }

  /** @keep Standalone server API; see dev/backlog/STANDALONE_SERVER_PLAN.md. */
  getAllWorkflows(): WorkflowInstance[] {
    return this.workflowInstanceRegistry.getAllWorkflows();
  }

  getRunningWorkflows(): WorkflowInstance[] {
    return this.workflowInstanceRegistry.getRunningWorkflows();
  }

  getUserFeedbackSink(): UserFeedbackSink {
    return this.userFeedbackSink;
  }

  /** @keep Standalone server API; see dev/backlog/STANDALONE_SERVER_PLAN.md. */
  getActiveWorkflow(): WorkflowInstance | undefined {
    return this.workflowInstanceRegistry.getActiveWorkflow();
  }

  /** @keep Standalone server API; see dev/backlog/STANDALONE_SERVER_PLAN.md. */
  getActiveWorkflowId(): string | null {
    return this.workflowInstanceRegistry.getActiveWorkflowId();
  }

  /**
   * Subscribe to queue-state changes for the panel's active workflow.
   *
   * The event emits both state changes from the active instance and the
   * current state when the panel switches to another instance. Browser views
   * do not affect this event because context-menu commands are scoped to the
   * VS Code panel's active workflow.
   */
  onDidChangeActiveQueueState(
    listener: (state: QueueState | undefined) => void
  ): { dispose(): void } {
    const emitter = this.getActiveQueueStateChangedEmitter();
    const subscription = emitter.event(listener);
    return { dispose: () => subscription.dispose() };
  }

  /** Return the current queue state for the panel's active workflow, if any. */
  getActiveQueueState(): QueueState | undefined {
    return this.getActiveWorkflow()?.getQueueState();
  }

  /**
   * Register the VS Code context key used by Queue/Queue Next menu entries.
   * The initial value is set immediately because a newly-created queue may not
   * emit a state change before the first context menu is opened.
   */
  registerActiveQueueContextKey(): { dispose(): void } {
    const subscription = this.onDidChangeActiveQueueState((state) => {
      this.setHasQueuedStepsContext(state);
    });
    this.setHasQueuedStepsContext(this.getActiveQueueState());
    return { dispose: () => subscription.dispose() };
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
                kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
                runRef: queueState.runRef,
              }
            : {
                workflowKey: queueState.workflowKey,
                kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
              },
          send,
          clientId
        );
      }

      // A brand-new workflow (New / Ctrl+N) has no lineage yet, so the
      // addressed RUN_VIEW_LOADED above did not run and nothing has published
      // an address for it. Its SESSION_RESTORED therefore *replaces* whatever
      // the client was displaying, and must omit `definitionRevision` — with
      // one, the webview reads it as a replay of the workflow already on
      // screen and keeps that workflow's view address, so the rename and every
      // prompt that follows is written to the workflow the user just left.
      instance.replayFullStateTo(sink, {
        asReplacement: !queueState.workflowKey,
      });
      await instance.replayOutputHistoryTo(send);
      // The addressed RUN_VIEW_LOADED above set the client's displayed view
      // address (and, for a system-generated lineage, its read-only
      // lockdown), but replayFullStateTo's SESSION_RESTORED then ran
      // applyWorkflowChange() on the client, which clears that address,
      // revisions, and the system-generated flag as part of resetting
      // cross-workflow state — and unlike the output store it re-populates
      // via replayOutputHistoryTo, nothing re-publishes them. Left cleared,
      // the header loses its run identity, the Run/Re-run control collapses
      // to the disabled "Load a workflow to run" state, and a running
      // commit-message-generation lineage briefly shows its lockdown banner
      // before silently becoming editable. Re-publish the authoritative
      // identity now — WORKFLOW_VIEW_IDENTITY carries isSystemGenerated
      // alongside address/revisions for exactly this restore.
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

    // External-run session
    const externalEntry = this.externalRunWatchCoordinator.getEntry(workflowId);
    if (externalEntry) {
      send({
        type: MESSAGE_TYPES.ACTIVE_WORKFLOW_CHANGED,
        workflowId,
        workingFilePath: externalEntry.summary.workingFilePath ?? null,
      });
      // Update viewerRegistry before the await for the same reason as above.
      this.setViewedWorkflowId(clientId, workflowId);
      await this.externalRunWatchCoordinator.sendExternalRunFullStateToDashboard(
        workflowId,
        externalEntry,
        sink
      );
    } else {
      Log.warn(
        `[replayWorkflowStateTo] workflowId "${workflowId.slice(0, 8)}" not found`
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
      const terminalStartedMessage: TerminalStartedMessage = {
        type: MESSAGE_TYPES.TERMINAL_STARTED,
        workflowId: session.workflowId,
        sessionId: session.id,
        stepName: session.stepName,
        stepIndex: session.stepIndex,
        kind: session.kind,
        promptNumber: session.promptNumber,
        harnessId: session.harnessId,
        parallelGroupId: session.parallelGroupId,
        controllerClientId: session.controllerClientId,
      };
      send(terminalStartedMessage);
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
   * retired, and external-run sessions for path lookup.
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
          instance?.getSummary() ??
          this.externalRunWatchCoordinator.getEntry(workflowId)?.summary;
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
    const externalRunSummaries =
      this.externalRunWatchCoordinator.getSummaries();
    const summaries = [...vsSummaries, ...externalRunSummaries];
    Log.trace(
      `[getWorkflowSummaries] registry has ${this.instances.size} instances + ${externalRunSummaries.length} external sessions, viewed=${this.getViewedWorkflowId(this.PANEL_CLIENT_ID)?.slice(0, 8) ?? "null"}: ${summaries.map((s) => `inst:${s.id.slice(0, 8)}(${s.executionState},fp=${s.filePath ? path.basename(s.filePath) : "?"})`).join(", ") || "(none)"}`
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
      interactionPort?: UserInteractionPort;
    }
  ): Promise<void> {
    // Parse working file path to get workflowId (used for external session lookup)
    const workflowId =
      WorkflowPaths.parseWorkingFileAddressFromPath(filePath)?.workflowKey ??
      "";

    // Check for an external-run session first
    const externalEntry = this.externalRunWatchCoordinator.getEntry(workflowId);
    if (externalEntry) {
      // setViewedWorkflowId is normally called inside replayWorkflowStateTo; call
      // it explicitly here so the viewer registry stays consistent when skipping.
      this.setViewedWorkflowId(clientId, workflowId);
      const pendingRoots =
        await this.approvePendingWorkflowExternalRootsForClient(
          clientId,
          undefined,
          options?.interactionPort,
          false
        );
      if (!options?.skipReplay) {
        await this.replayWorkflowStateTo(workflowId, send, clientId);
      }
      this.emitWorkflowExternalRootsApprovalState(
        clientId,
        workflowId,
        pendingRoots,
        send
      );
      return;
    }

    // If startup has not finished wiring external watch sessions yet, a preferred
    // working-file load can arrive before setupExternalRunWatching() sees an active external
    // lock. Register the external session first so a dashboard view load never
    // converts an actively external RUNNING file to a VS Code instance.
    if (await this.ensureExternalRunWatchSession(filePath)) {
      this.setViewedWorkflowId(clientId, workflowId);
      const pendingRoots =
        await this.approvePendingWorkflowExternalRootsForClient(
          clientId,
          undefined,
          options?.interactionPort,
          false
        );
      if (!options?.skipReplay) {
        await this.replayWorkflowStateTo(workflowId, send, clientId);
      }
      this.emitWorkflowExternalRootsApprovalState(
        clientId,
        workflowId,
        pendingRoots,
        send
      );
      return;
    }

    const ownershipResolution = await this.resolveExternalExecutionForPath(
      filePath,
      this.currentWorkspaceFolderPath ?? ""
    );
    if (
      this.currentWorkspaceFolderPath &&
      this.shouldDeclineUntrackedOwnership(filePath, ownershipResolution)
    ) {
      return;
    }

    // Check if already in instances registry by working file path
    const existing = [...this.instances.values()].find((w) =>
      sameWorkingFilePath(w.getSummary().workingFilePath, filePath)
    );
    if (existing) {
      this.setViewedWorkflowId(clientId, existing.id);
      const pendingRoots =
        await this.approvePendingWorkflowExternalRootsForClient(
          clientId,
          undefined,
          options?.interactionPort,
          false
        );
      if (!options?.skipReplay) {
        await this.replayWorkflowStateTo(existing.id, send, clientId);
      }
      this.emitWorkflowExternalRootsApprovalState(
        clientId,
        existing.id,
        pendingRoots,
        send
      );
      return;
    }

    // Check retired instances (completed/stopped workflows) by working file path.
    // Reuse the existing retired instance so its PTY sessions remain accessible.
    const existingRetired = [...this.retiredInstances.values()].find((w) =>
      sameWorkingFilePath(w.getSummary().workingFilePath, filePath)
    );
    if (existingRetired) {
      this.setViewedWorkflowId(clientId, existingRetired.id);
      const pendingRoots =
        await this.approvePendingWorkflowExternalRootsForClient(
          clientId,
          undefined,
          options?.interactionPort,
          false
        );
      if (!options?.skipReplay) {
        await this.replayWorkflowStateTo(existingRetired.id, send, clientId);
      }
      this.emitWorkflowExternalRootsApprovalState(
        clientId,
        existingRetired.id,
        pendingRoots,
        send
      );
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
    options?: { skipReplay?: boolean; interactionPort?: UserInteractionPort }
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
    const pendingRoots =
      await this.approvePendingWorkflowExternalRootsForClient(
        clientId,
        undefined,
        options?.interactionPort,
        false
      );
    if (!options?.skipReplay) {
      await this.replayWorkflowStateTo(instance.id, send, clientId);
    }
    this.emitWorkflowExternalRootsApprovalState(
      clientId,
      instance.id,
      pendingRoots,
      send
    );
  }

  /**
   * Ensure an external-run watch session exists for the given working file if its lock
   * belongs to a live CLI or sibling VS Code instance.
   *
   * Called by WorkflowSerializer.handleGetRecentWorkflows to bridge the timing gap between
   * CLI lock file creation and the runnerJsonCreateWatcher firing (VS Code file-watcher
   * latency on Windows can be several hundred milliseconds).
   *
   * Also implements Entry Point 2 from the CLI Watch Mode plan: the user opens a recently-run
   * workflow from the dropdown while the CLI is still actively running it.
   *
   * @returns true if the working file is (or was just registered as) externally managed;
   *          false if no live external lock exists or the session could not be started.
   */
  async ensureExternalRunWatchSession(
    workingFilePath: string
  ): Promise<boolean> {
    return this.externalRunWatchCoordinator.ensureExternalRunWatchSession(
      workingFilePath
    );
  }

  private async resolveExternalExecutionForPath(
    workingFilePath: string,
    workspaceFolderPath: string
  ): Promise<ExternalExecutionResolution> {
    return this.externalRunWatchCoordinator.resolveExternalExecutionForPath(
      workingFilePath,
      workspaceFolderPath
    );
  }

  /**
   * Keep an active self-owned or indeterminate run on a non-mutating path when
   * no resident execution accounts for it. A host restart can leave the lock
   * briefly visible before its in-memory owner is reconciled; treating that
   * shape as an orphan would create a second editable/adopted execution.
   */
  private shouldDeclineUntrackedOwnership(
    workingFilePath: string,
    resolution: ExternalExecutionResolution
  ): boolean {
    return this.externalRunWatchCoordinator.shouldDeclineUntrackedOwnership(
      workingFilePath,
      resolution
    );
  }

  /**
   * Clears persisted workflow state from the previous architecture.
   * Running/paused workflows live only in the in-memory Map and cannot be
   * meaningfully restored after the extension host terminates, so we write
   * an empty array to clear any stale data left by earlier versions.
   */
  async saveState(): Promise<void> {
    await this.workspaceState.update("ctrlyoke.loadedWorkflows", []);
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
      Log.debug("[WorkflowOrchestrator] WorkflowOrchestrator: Initializing...");

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
      Log.info(`[WorkflowOrchestrator] Default integration: ${modeLabel}`);

      await Promise.all([
        this.copilotCliIntegration.initialize(),
        this.claudeCliIntegration.initialize(),
        this.codexCliIntegration.initialize(),
        this.openCodeCliIntegration.initialize(),
        this.qwenCliIntegration.initialize(),
        this.antigravityCliIntegration.initialize(),
      ]);

      if (this.currentWorkspaceFolderPath) {
        await this.workspaceSessionManager.discoverPromptFiles(
          this.currentWorkspaceFolderPath
        );
        // Must run after harness init and before auto-load so stale RUNNING files
        // are normalized and external-run workflows are registered.
        await this.setupExternalRunWatching();
        await this.discoverWorktreesOnActivation();
      }

      this.orchestratorInitialized = true;
      Log.debug(
        "[WorkflowOrchestrator] WorkflowOrchestrator: Initialization complete"
      );

      await this.restoreState(); // no-op

      if (this.dashboardReady) {
        Log.debug(
          "[WorkflowOrchestrator] Dashboard was ready before init — triggering deferred auto-load"
        );
        await this.triggerStartupAutoLoadIfReady();
      }
    } catch (error) {
      this.orchestratorInitialized = true;
      Log.error(
        "[WorkflowOrchestrator] Failed to initialize WorkflowOrchestrator:",
        error
      );
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
      `[WorkflowOrchestrator] ctrlyoke: Workspace initialization pending for "${workspaceRoot}"`
    );
  }

  /**
   * Called when the user approves ctrlyoke initialization from the dashboard.
   * Creates the .ctrlyoke/ directory scaffold, then resumes the normal
   * startup sequence (triggers auto-load and broadcasts STARTUP_COMPLETE).
   */
  async handleInitializeWorkspace(): Promise<void> {
    const workspaceRoot =
      this.pendingInitWorkspaceRoot ?? this.currentWorkspaceFolderPath;

    if (!workspaceRoot) {
      Log.warn(
        "[WorkflowOrchestrator] ctrlyoke: handleInitializeWorkspace called with no workspace root"
      );
      return;
    }

    let isNew = false;
    try {
      isNew = await WorkspaceInitializer.initializeIfNeeded(workspaceRoot);
      // .ctrlyoke/ now exists — start file logging for this session.
      Log.enableWorkspaceFileLogging();
    } catch (err) {
      Log.warn(
        "[WorkflowOrchestrator] ctrlyoke: Workspace initialization failed:",
        err
      );
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
    Log.info("[WorkflowOrchestrator] Dashboard is ready");
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
        "[startup] Orchestrator not yet initialized — deferring auto-load until init completes"
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
        this.currentWorkspaceFolderPath
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
            `[startup] triggerAutoLoad: skipping auto-load — panel view moved during startup ` +
              `(inst:${this.startupPanelViewedId?.slice(0, 8) ?? "null"} inst:${panelViewedId.slice(0, 8)}); ` +
              `keeping the user's workflow`
          );
          loadedWorkflowId = panelViewedId;
          return;
        }

        if (panelViewedId && panelWorkingFilePath) {
          Log.debug(
            `[startup] triggerAutoLoad: keeping panel's persisted workflow "${path.basename(panelWorkingFilePath)}" instead of loading most recent`
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
              `[startup] triggerAutoLoad: skipping panel replay — already replayed during startup for inst:${panelViewedId.slice(0, 8)}`
            );
          }
          return;
        }
        Log.debug("[startup] Triggering auto-load of recent session");

        await this.workspaceSessionManager.autoLoadRecentSession(
          this.currentWorkspaceFolderPath,
          async (workingFilePath: string) => {
            // Skip auto-loading only when the resolver proves this working file is
            // actively managed externally. A self-owned or indeterminate lock must
            // stay on this host's local execution path.
            const resolution = await this.resolveExternalExecutionForPath(
              workingFilePath,
              this.currentWorkspaceFolderPath!
            );
            if (
              resolution.kind ===
              EXTERNAL_EXECUTION_RESOLUTION_KINDS.EXTERNAL_ACTIVE_RUN
            ) {
              Log.debug(
                `[startup] triggerAutoLoad: skipping externally managed workflow "${path.basename(workingFilePath)}"`
              );
              return;
            }
            if (
              this.shouldDeclineUntrackedOwnership(workingFilePath, resolution)
            ) {
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
        `[startup] Broadcasting STARTUP_COMPLETE — session: ${loadedWorkflowId ?? "none"}, READYCOMPLETE: ${readyToCompleteMs}ms`
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
      Log.warn(
        `[WorkflowOrchestrator] executeWorkflow: workflow ${workflowId ?? "viewed"} not found`
      );
      return;
    }

    try {
      await this.assertNoPendingWorkflowExternalRoots(this.PANEL_CLIENT_ID);
    } catch (error) {
      notifyUserFeedback(
        this.userFeedbackSink,
        "warning",
        getErrorMessage(error)
      );
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
      `[WorkflowOrchestrator] executePromptFile: loading "${path.basename(filePath)}" into new instance ` +
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
    if (!mutation || mutation.address.kind !== WORKFLOW_VIEW_ADDRESS_KIND.RUN) {
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
        `[WorkflowOrchestrator] pauseWorkflow: inst:${workflowId.slice(0, 8)} not found in registry`
      );
      return;
    }
    Log.info(
      `[WorkflowOrchestrator] pauseWorkflow: inst:${workflowId.slice(0, 8)}`
    );
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
        `[WorkflowOrchestrator] cancelPauseWorkflow: inst:${workflowId.slice(0, 8)} not found in registry`
      );
      return;
    }
    Log.info(
      `[WorkflowOrchestrator] cancelPauseWorkflow: inst:${workflowId.slice(0, 8)}`
    );
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
          `[WorkflowOrchestrator] resumeWorkflow: inst:${workflowId.slice(0, 8)} not found — reloading from ${path.basename(workingFilePath)}`
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
            `[WorkflowOrchestrator] resumeWorkflow: inst:${workflowId.slice(0, 8)} reload from working file produced no instance`
          );
          return;
        }
      } else {
        Log.warn(
          `[WorkflowOrchestrator] resumeWorkflow: inst:${workflowId.slice(0, 8)} not found in registry`
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
    Log.info(
      `[WorkflowOrchestrator] resumeWorkflow: inst:${workflowId.slice(0, 8)}`
    );
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
        `[WorkflowOrchestrator] stopWorkflow: inst:${workflowId.slice(0, 8)} not found in registry`
      );
      return;
    }
    return instance.stop();
  }

  /**
   * Kill the CLI process for a CLI-managed workflow by sending SIGTERM to its PID.
   * The CLI handles SIGTERM by releasing the lock and exiting cleanly, which triggers
   * ExternalRunWatchSession.onFinished() → workflow transitions to STOPPED automatically.
   */
  async stopExternalRunSession(workflowId: string): Promise<void> {
    return this.externalRunWatchCoordinator.stopExternalRunSession(workflowId);
  }

  /** Ask a live sibling VS Code instance to stop through its owner-token sentinel. */
  async requestVscodeStop(
    workflowId: string
  ): Promise<"picked-up" | "timed-out" | "unavailable"> {
    const entry = this.externalRunWatchCoordinator.getEntry(workflowId);
    if (!entry) return "unavailable";

    const workspaceFolderPath = this.currentWorkspaceFolderPath;
    const workflowKey = entry.summary.workflowKey;
    if (!workspaceFolderPath || !workflowKey) return "unavailable";

    // Re-resolve the exact addressed run immediately before writing. This
    // rejects self-owned, indeterminate, terminal, and replaced owners and
    // supplies the owner token for the request filename.
    const resolution = await this.resolveExternalExecutionForPath(
      entry.summary.workingFilePath ?? "",
      workspaceFolderPath
    );
    if (
      resolution.kind !==
      EXTERNAL_EXECUTION_RESOLUTION_KINDS.EXTERNAL_ACTIVE_RUN
    ) {
      return "unavailable";
    }
    const lock = resolution.inspection.lock;
    // Intentional runner-type policy after resolver proof: sibling VS Code
    // owners use the owner-token stop-request protocol below.
    if (
      lock.runner !== RUNNER_IDS.VSCODE ||
      lock.workflowKey !== workflowKey ||
      lock.runRef !== entry.summary.runRef ||
      lock.ownerToken !== entry.session.getOwnerToken()
    ) {
      Log.info(
        `[WorkflowOrchestrator] sibling VS Code stop request rejected because the external lock acquisition changed for "${workflowKey}"`
      );
      return "unavailable";
    }

    const requestId = `${this.PANEL_CLIENT_ID}-${Date.now()}`;
    const requestPath = await writeWorkflowStopRequest(
      workspaceFolderPath,
      workflowKey,
      lock.ownerToken,
      requestId
    );
    const pickedUp = await waitForWorkflowStopRequestPickup(
      requestPath,
      10_000
    );
    if (!pickedUp) {
      await deleteWorkflowStopRequest(
        workspaceFolderPath,
        workflowKey,
        lock.ownerToken
      );
      Log.warn(
        `[WorkflowOrchestrator] sibling VS Code stop request timed out for "${workflowKey}"`
      );
      return "timed-out";
    }
    return "picked-up";
  }

  /** Ownership discovered for the workspace root during activation, if any. */
  getActivationWorktreeOwnership(): WorkspaceWorktreeOwnership | undefined {
    return this.externalRunWatchCoordinator.getActivationWorktreeOwnership();
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
    clientId: string,
    interactionPort?: UserInteractionPort
  ): Promise<WorkflowInstance> {
    const instance = this.registerNewInstance(clientId);
    await instance.loadPromptFile(filePath);
    const pendingRoots =
      await this.approvePendingWorkflowExternalRootsForClient(
        clientId,
        undefined,
        interactionPort,
        false
      );
    await this.replayWorkflowStateTo(instance.id, send, clientId);
    this.emitWorkflowExternalRootsApprovalState(
      clientId,
      instance.id,
      pendingRoots,
      send
    );
    return instance;
  }

  /** Build a fresh workflow instance, register it, and make it the client's viewed workflow. */
  private registerNewInstance(clientId: string): WorkflowInstance {
    return this.workflowInstanceRegistry.registerNewInstance(clientId);
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
      interactionPort?: UserInteractionPort;
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
          `[WorkflowOrchestrator] handleClientReady: preferred view is not available, falling back: ${JSON.stringify(options.preferredViewAddress)}`,
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
      const workspaceFolderPath = this.currentWorkspaceFolderPath;
      if (workspaceFolderPath) {
        const mostRecentWorkingFilePath =
          await this.workspaceSessionManager.getMostRecentWorkingFilePath(
            workspaceFolderPath
          );
        if (mostRecentWorkingFilePath) {
          await this.loadWorkflowForClient(
            mostRecentWorkingFilePath,
            send,
            clientId,
            { interactionPort: options?.interactionPort }
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
          `[WorkflowOrchestrator] handleClientReady: skipping duplicate panel startup replay for inst:${viewedId.slice(0, 8)}`
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
    const previewSourcePath = sourcePath ?? state?.workingFilePath;
    const outputHistoryManager = this.getOutputHistoryManager();
    const historyFilePath =
      address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN
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
      workspaceRoots: this.platform.getWorkspaceRoots(),
      approvedExternalRoots:
        this.platform.getApprovedExternalFileRoots?.(workspaceRoot),
      namedWorkspaceRoots: this.platform.getNamedWorkspaceRoots(),
      extensionPath: this.platform.getExtensionPath(),
      hostCanProvidePty: true,
      supportsConcurrentInteractiveSessions: true,
      cwd: workspaceRoot,
      platform: process.platform,
      dynamicQueueConfig: ConfigurationUtils.getDynamicQueueConfig(),
      secretStore: this.platform.getSecretStore?.(),
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
    return this.runViewPublisher.getViewAddress(clientId);
  }

  /**
   * Return the authored source definition for a client's addressed lineage.
   * This deliberately reads the lineage descriptor rather than deriving a
   * semantic base from the draft/run working-copy path in run storage.
   */
  async getViewSourceDefinitionPath(clientId: string): Promise<string | null> {
    const address = this.getViewAddress(clientId);
    const workspaceRoot = this.currentWorkspaceFolderPath;
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

  async approvePendingWorkflowExternalRootsForClient(
    clientId: string,
    send?: (message: unknown) => void,
    port: UserInteractionPort = this.userInteractionPort,
    notify = true
  ): Promise<string[]> {
    const workspaceRoot = this.currentWorkspaceFolderPath;
    // Panel resolution goes through getInstanceForClient (equivalent to
    // getActiveInstance() for the panel — see its fallback order) rather than
    // getActiveInstance() directly, so this stays on the one seam every other
    // panel-scoped instance resolution in this class already uses. Non-panel
    // clients stay on the strict getBoundInstance: unlike getInstanceForClient,
    // it never falls back to the panel's instance for a client with no binding
    // of its own (see getBoundInstance's doc comment) — this state is
    // per-client, so an unbound browser client must resolve to no instance,
    // not silently inherit the panel's pending-roots state.
    const instance =
      clientId === this.PANEL_CLIENT_ID
        ? this.getInstanceForClient(clientId)
        : this.getBoundInstance(clientId);
    const workflow = instance?.promptQueue?.getWorkflowFile();
    const workflowSourcePath = instance?.getCurrentPromptFilePath();
    const requestedRoots = workflow?.trustedExternalRoots;
    let pendingRoots: string[] = [];

    if (workspaceRoot && workflowSourcePath && Array.isArray(requestedRoots)) {
      const workflowIdentity =
        ExternalRootsTrustStore.canonicalizeWorkflowIdentity(
          workspaceRoot,
          workflowSourcePath
        );
      pendingRoots = ConfigurationUtils.getPendingWorkflowExternalFileRoots(
        ExternalRootsTrustStore.canonicalizeRoot(workspaceRoot),
        workflowIdentity,
        requestedRoots
      );
      if (this.workspaceTrustPredicate?.() ?? true) {
        await promptBatchApprovalForPendingWorkflowExternalRoots(
          workspaceRoot,
          workflowSourcePath,
          requestedRoots,
          port
        );
        pendingRoots = ConfigurationUtils.getPendingWorkflowExternalFileRoots(
          ExternalRootsTrustStore.canonicalizeRoot(workspaceRoot),
          workflowIdentity,
          requestedRoots
        );
      }
    }

    if (notify) {
      this.emitWorkflowExternalRootsApprovalState(
        clientId,
        instance?.id ?? "",
        pendingRoots,
        send
      );
    }
    return pendingRoots;
  }

  private emitWorkflowExternalRootsApprovalState(
    clientId: string,
    workflowId: string,
    pendingRoots: readonly string[],
    send?: (message: unknown) => void
  ): void {
    const target =
      send ??
      (clientId === this.PANEL_CLIENT_ID
        ? this.storedPanelSend
        : this.workflowInstanceRegistry.getViewMessageSinks().get(clientId));
    target?.({
      type: MESSAGE_TYPES.WORKFLOW_EXTERNAL_ROOTS_APPROVAL_REQUIRED,
      workflowId,
      pendingRoots: [...pendingRoots],
    });
  }

  async updateWorkflowTrustedExternalRootsForClient(
    clientId: string,
    roots: readonly string[]
  ): Promise<void> {
    const instance =
      clientId === this.PANEL_CLIENT_ID
        ? this.getActiveInstance()
        : this.getBoundInstance(clientId);
    if (!instance) {
      throw new Error("The active workflow is unavailable.");
    }
    await instance.updateWorkingFileProperties({
      trustedExternalRoots: [...roots],
    });
  }

  private getPendingWorkflowExternalRootsForClient(clientId: string): string[] {
    const workspaceRoot = this.currentWorkspaceFolderPath;
    // See approvePendingWorkflowExternalRootsForClient for why the panel
    // branch goes through getInstanceForClient rather than getActiveInstance().
    const instance =
      clientId === this.PANEL_CLIENT_ID
        ? this.getInstanceForClient(clientId)
        : this.getBoundInstance(clientId);
    const requestedRoots =
      instance?.promptQueue?.getWorkflowFile().trustedExternalRoots;
    const workflowSourcePath = instance?.getCurrentPromptFilePath();
    if (
      !workspaceRoot ||
      !workflowSourcePath ||
      !Array.isArray(requestedRoots)
    ) {
      return [];
    }
    return ConfigurationUtils.getPendingWorkflowExternalFileRoots(
      ExternalRootsTrustStore.canonicalizeRoot(workspaceRoot),
      ExternalRootsTrustStore.canonicalizeWorkflowIdentity(
        workspaceRoot,
        workflowSourcePath
      ),
      requestedRoots
    );
  }

  private async assertNoPendingWorkflowExternalRoots(
    clientId: string
  ): Promise<void> {
    const pendingRoots =
      this.getPendingWorkflowExternalRootsForClient(clientId);
    if (pendingRoots.length > 0) {
      throw new Error(
        `Workflow external roots require approval before running: ${pendingRoots.join(", ")}. ` +
          `Run "ctrlyoke trust-workflow-external-roots <file>" or approve them in the dashboard.`
      );
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
    return this.runViewPublisher.getViewFilePath(clientId);
  }

  async getViewIdentity(
    clientId: string
  ): Promise<WorkflowViewIdentityMessage | null> {
    return this.runViewPublisher.getViewIdentity(clientId);
  }

  private async publishRunRevisionsToViewers(
    workflowKey: WorkflowKey,
    runRef: RunRef
  ): Promise<void> {
    await this.runViewPublisher.publishRunRevisionsToViewers(
      workflowKey,
      runRef
    );
  }

  async publishViewIdentityToViewers(
    clientId: string
  ): Promise<WorkflowViewIdentityMessage | null> {
    return this.runViewPublisher.publishViewIdentityToViewers(clientId);
  }

  private reconcileExpectedRevisions(
    address: WorkflowViewAddress,
    clientId: string,
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number
  ): {
    expectedDefinitionRevision: number;
    expectedDescriptorRevision: number;
  } {
    return {
      expectedDefinitionRevision:
        this.definitionAuthorLedger.reconcileDefinition(
          address,
          clientId,
          expectedDefinitionRevision
        ),
      expectedDescriptorRevision:
        this.definitionAuthorLedger.reconcileDescriptor(
          address.workflowKey,
          clientId,
          expectedDescriptorRevision
        ),
    };
  }

  private reconcileRunRevisions(
    address: WorkflowRunAddress,
    clientId: string,
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number
  ): {
    expectedDefinitionRevision: number;
    expectedDescriptorRevision: number;
  } {
    return this.reconcileExpectedRevisions(
      WorkflowOrchestrator.runViewAddress(address),
      clientId,
      expectedDefinitionRevision,
      expectedDescriptorRevision
    );
  }

  private static runViewAddress(
    address: WorkflowRunAddress
  ): Extract<WorkflowViewAddress, { kind: "run" }> {
    return {
      workflowKey: address.workflowKey,
      kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
      runRef: address.runRef,
    };
  }

  private async recordDefinitionWrite(
    address: WorkflowViewAddress | undefined,
    clientId: string,
    newRevision?: number,
    expectedRevision?: number
  ): Promise<void> {
    if (
      newRevision !== undefined &&
      expectedRevision !== undefined &&
      newRevision === expectedRevision
    ) {
      return;
    }
    const identity =
      newRevision === undefined || address === undefined
        ? await this.getViewIdentity(clientId)
        : null;
    const effectiveAddress = address ?? identity?.address;
    const effectiveRevision = newRevision ?? identity?.definitionRevision;
    if (!effectiveAddress || effectiveRevision === undefined) {
      return;
    }
    this.definitionAuthorLedger.recordDefinition(
      effectiveAddress,
      clientId,
      effectiveRevision
    );
  }

  private async recordSuccessfulRevisions(
    fallbackAddress: WorkflowViewAddress,
    clientId: string,
    options: {
      definitionRevision?: number;
      descriptorRevision?: number;
      recordDefinition: boolean;
      recordDescriptor: boolean;
    }
  ): Promise<void> {
    const needsIdentity =
      (options.recordDefinition && options.definitionRevision === undefined) ||
      (options.recordDescriptor && options.descriptorRevision === undefined);
    const identity = needsIdentity
      ? await this.getViewIdentity(clientId)
      : null;
    const address = identity?.address ?? fallbackAddress;
    if (options.recordDefinition) {
      const revision =
        options.definitionRevision ?? identity?.definitionRevision;
      if (revision !== undefined) {
        this.definitionAuthorLedger.recordDefinition(
          address,
          clientId,
          revision
        );
      }
    }
    if (options.recordDescriptor) {
      const revision =
        options.descriptorRevision ?? identity?.descriptorRevision;
      if (revision !== undefined) {
        this.definitionAuthorLedger.recordDescriptor(
          address.workflowKey,
          clientId,
          revision
        );
      }
    }
  }

  public async bindClientToAddressedLineage(
    address: WorkflowViewAddress,
    send: (message: unknown) => void,
    clientId: string
  ): Promise<string | null> {
    return this.runViewPublisher.bindClientToAddressedLineage(
      address,
      send,
      clientId
    );
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

  async loadRunViewForClient(
    address: WorkflowViewAddress,
    send: (message: unknown) => void,
    clientId: string,
    requestId?: string,
    definitionRollback?: DefinitionRollbackInvalidation,
    announceReplayBoundary = false
  ): Promise<void> {
    await this.runViewPublisher.loadRunViewForClient(
      address,
      send,
      clientId,
      requestId,
      definitionRollback,
      announceReplayBoundary
    );
  }

  private async publishRunViewToClients(
    address: WorkflowViewAddress,
    targets: ReadonlyArray<{
      clientId: string;
      send: (message: unknown) => void;
    }>,
    definitionRollback?: DefinitionRollbackInvalidation
  ): Promise<void> {
    await this.runViewPublisher.publishRunViewToClients(
      address,
      targets,
      definitionRollback
    );
  }

  async loadRunSummariesForClient(
    workflowKey: WorkflowKey,
    send: (message: unknown) => void,
    requestId: string
  ): Promise<void> {
    await this.runViewPublisher.loadRunSummariesForClient(
      workflowKey,
      send,
      requestId
    );
  }

  async prepareDefinitionMutation(
    mutation: WorkflowDefinitionMutation | undefined,
    clientId: string
  ): Promise<void> {
    const viewed = this.getViewAddress(clientId);
    // A brand-new, as-yet-unaddressed editor still uses the ephemeral workflow
    // path. Once a client is viewing a persisted draft/run, revision context is
    // mandatory so a stale UI cannot silently alter a promoted definition.
    if (!mutation) {
      if (
        viewed?.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN ||
        viewed?.kind === WORKFLOW_VIEW_ADDRESS_KIND.DRAFT
      ) {
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
      (viewed.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN &&
        mutation.address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN &&
        viewed.runRef !== mutation.address.runRef)
    ) {
      throw new Error(
        "Definition mutation no longer targets this client's viewed run " +
          `(targeted: ${WorkflowOrchestrator.describeViewAddress(mutation.address)}, ` +
          `viewing: ${WorkflowOrchestrator.describeViewAddress(viewed)})`
      );
    }
    const reconciled = this.reconcileExpectedRevisions(
      mutation.address,
      clientId,
      mutation.expectedDefinitionRevision,
      mutation.expectedDescriptorRevision
    );
    mutation.expectedDefinitionRevision = reconciled.expectedDefinitionRevision;
    mutation.expectedDescriptorRevision = reconciled.expectedDescriptorRevision;
    const workspaceRoot = this.currentWorkspaceFolderPath;
    if (!workspaceRoot) {
      throw new Error("No workspace folder is open");
    }

    if (mutation.address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN) {
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
        assertDefinitionRevision(
          mutation.expectedDefinitionRevision,
          liveRevision
        );
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
      assertDefinitionRevision(
        mutation.expectedDefinitionRevision,
        target.definitionRevision
      );
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
    assertDescriptorRevision(
      mutation.expectedDescriptorRevision,
      descriptor.revision
    );
    assertDefinitionRevision(
      mutation.expectedDefinitionRevision,
      draftRevision
    );
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
    return this.runLifecycleService.findResidentInstanceForRun(
      workflowKey,
      runRef
    ) as WorkflowInstance | undefined;
  }

  private requireWorkspaceRoot(): string {
    const workspaceRoot = this.currentWorkspaceFolderPath;
    if (!workspaceRoot) {
      throw new Error("No workspace folder is open");
    }
    return workspaceRoot;
  }

  public findInstanceForLineage(
    workflowKey: WorkflowKey
  ): WorkflowInstance | undefined {
    return this.workflowInstanceRegistry.findInstanceForLineage(workflowKey);
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
    clientId: string,
    expectedDefinitionRevision: number,
    liveEdit: (instance: WorkflowInstance) => Promise<void>,
    staticEdit: (workspaceRoot: string) => Promise<number | undefined>,
    invalidation: "snapshot" | "properties" | StepColorInvalidation = "snapshot"
  ): Promise<void> {
    const live = this.findResidentInstanceForRun(
      runAddress.workflowKey,
      runAddress.runRef
    );
    let newDefinitionRevision: number | undefined;
    if (live) {
      await liveEdit(live);
    } else {
      newDefinitionRevision = await staticEdit(this.requireWorkspaceRoot());
    }
    await this.recordDefinitionWrite(
      {
        workflowKey: runAddress.workflowKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: runAddress.runRef,
      },
      clientId,
      newDefinitionRevision,
      expectedDefinitionRevision
    );
    // Before the invalidation, never after: the write is already durable, and
    // the client cannot safely act on this address again until it holds the
    // revisions the write produced. See `publishRunRevisionsToViewers`.
    await this.publishRunRevisionsToViewers(
      runAddress.workflowKey,
      runAddress.runRef
    );
    if (invalidation === "properties") {
      await this.invalidateRunViewProperties(
        runAddress.workflowKey,
        runAddress.runRef
      );
    } else if (typeof invalidation === "object") {
      // A resident instance broadcasts the narrow update through its tagged
      // dashboard sink. Static historical-run edits have no instance sink,
      // so target their viewers directly without a full run snapshot. Keep
      // the existing properties push for workflow-level identity fields.
      await this.invalidateRunViewProperties(
        runAddress.workflowKey,
        runAddress.runRef
      );
      if (!live) {
        await this.invalidateRunViewStepColor(
          runAddress.workflowKey,
          runAddress.runRef,
          invalidation.index
        );
      }
    } else {
      await this.invalidateRunViews(runAddress.workflowKey, runAddress.runRef);
    }
  }

  private findExecutionRunRef(workflowKey: WorkflowKey): RunRef | undefined {
    return this.runLifecycleService.findExecutionRunRef(workflowKey);
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
    if (!mutation || mutation.address.kind !== WORKFLOW_VIEW_ADDRESS_KIND.RUN) {
      await this.getInstanceForClient(clientId).updateWorkflowName(
        workflowName
      );
      await this.recordDefinitionWrite(undefined, clientId);
      return undefined;
    }
    const runAddress = mutation.address;
    let latest:
      | { definitionRevision: number; descriptorRevision: number }
      | undefined;
    await this.applyRunAddressedMutation(
      runAddress,
      clientId,
      mutation.expectedDefinitionRevision,
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
        return written.definitionRevision;
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

    // Check for a proven external execution before creating a VS Code instance
    // (Entry Point 2). A live lock owned by this host, an indeterminate lock,
    // or a stale watch entry must remain on the local execution path.
    const workspaceFolderPath = this.currentWorkspaceFolderPath;
    if (workflowId && workspaceFolderPath) {
      const resolution = await this.resolveExternalExecutionForPath(
        filePath,
        workspaceFolderPath
      );
      if (
        resolution.kind ===
        EXTERNAL_EXECUTION_RESOLUTION_KINDS.EXTERNAL_ACTIVE_RUN
      ) {
        const existingExternalEntry =
          this.externalRunWatchCoordinator.getEntry(workflowId);
        if (existingExternalEntry) {
          Log.debug(
            `[WorkflowOrchestrator] loadWorkingFile: "${workflowId}" is externally managed (session exists) — switching view`
          );
          this.storedPanelSend?.({
            type: MESSAGE_TYPES.ACTIVE_WORKFLOW_CHANGED,
            workflowId,
            workingFilePath:
              existingExternalEntry.summary.workingFilePath ?? null,
          });
          this.dashboardBroadcastHub.notifyWorkflowSummaryUpdated(
            existingExternalEntry.summary
          );
          return;
        }

        Log.debug(
          `[WorkflowOrchestrator] loadWorkingFile: "${workflowId}" has a proven external lock — starting external run watch session`
        );
        await this.externalRunWatchCoordinator.startExternalRunWatchSession(
          filePath,
          workspaceFolderPath,
          resolution.inspection
        );
        return;
      }
      if (this.shouldDeclineUntrackedOwnership(filePath, resolution)) {
        return;
      }
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
      const pendingRoots =
        await this.approvePendingWorkflowExternalRootsForClient(
          this.PANEL_CLIENT_ID,
          undefined,
          undefined,
          false
        );
      await this.replayWorkflowStateTo(
        existingRetiredForPanel.id,
        panelSend,
        this.PANEL_CLIENT_ID
      );
      this.emitWorkflowExternalRootsApprovalState(
        this.PANEL_CLIENT_ID,
        existingRetiredForPanel.id,
        pendingRoots,
        panelSend
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
    if (!runtime || runtime.mode !== WORKTREE_MODES.MANAGED) {
      throw new Error("Merge is available only for managed worktree runs.");
    }
    if (runtime.branchState !== WORKTREE_BRANCH_STATES.PRESENT) {
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
    if (!mutation || mutation.address.kind !== WORKFLOW_VIEW_ADDRESS_KIND.RUN) {
      const result = await this.getInstanceForClient(
        clientId
      ).updateWorkingFileProperties(properties, options);
      if (result && result.appliedKeys.length > 0) {
        await this.recordDefinitionWrite(
          undefined,
          clientId,
          result.workingFile.definitionRevision
        );
      }
      return result;
    }
    const runAddress = mutation.address;
    let result: { workingFile: WorkingFile; appliedKeys: string[] } | null =
      null;
    await this.applyRunAddressedMutation(
      runAddress,
      clientId,
      mutation.expectedDefinitionRevision,
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
        return written.appliedKeys.length > 0
          ? written.definitionRevision
          : undefined;
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
    if (!mutation || mutation.address.kind !== WORKFLOW_VIEW_ADDRESS_KIND.RUN) {
      await this.getInstanceForClient(clientId).updatePromptInQueue(
        index,
        text,
        properties,
        promptName,
        clearProperties
      );
      await this.recordDefinitionWrite(undefined, clientId);
      return;
    }
    const runAddress = mutation.address;
    await this.applyRunAddressedMutation(
      runAddress,
      clientId,
      mutation.expectedDefinitionRevision,
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
        ).then((written) => written.definitionRevision)
    );
  }

  async updateStepColorInQueue(
    mutation: WorkflowDefinitionMutation | undefined,
    index: number,
    color: string | null,
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<void> {
    if (!mutation || mutation.address.kind !== WORKFLOW_VIEW_ADDRESS_KIND.RUN) {
      await this.getInstanceForClient(clientId).updateStepColorInQueue(
        index,
        color
      );
      await this.recordDefinitionWrite(undefined, clientId);
      return;
    }

    const runAddress = mutation.address;
    await this.applyRunAddressedMutation(
      runAddress,
      clientId,
      mutation.expectedDefinitionRevision,
      (instance) => instance.updateStepColorInQueue(index, color),
      (workspaceRoot) =>
        WorkingFileManager.updateStepAtRun(
          workspaceRoot,
          runAddress.workflowKey,
          runAddress.runRef,
          index,
          { updates: { color: color ?? undefined } },
          mutation.expectedDefinitionRevision,
          this.lineageRepository
        ).then((written) => written.definitionRevision),
      { kind: "stepColor", index }
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
    if (
      mutation.address.kind !== WORKFLOW_VIEW_ADDRESS_KIND.RUN ||
      index <= 0
    ) {
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
    if (rewind.kind !== WORKTREE_EDIT_KINDS.REWIND) {
      throw new Error("Completed-step edit did not create a pending rewind");
    }

    let newDefinitionRevision: number | undefined;
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
        const written = await WorkingFileManager.updateStepAtRun(
          this.requireWorkspaceRoot(),
          runAddress.workflowKey,
          runAddress.runRef,
          index,
          buildPromptStepChange(text, properties, promptName, clearProperties),
          rewind.definitionRevision,
          this.lineageRepository
        );
        newDefinitionRevision = written.definitionRevision;
      }
      await this.recordDefinitionWrite(
        runAddress,
        clientId,
        newDefinitionRevision,
        rewind.definitionRevision
      );
    } catch (error) {
      // The rewind is already durable even if the content edit fails. Publish
      // it so clients see the continuation state they can discard or retry.
      await this.publishRunRevisionsToViewers(
        runAddress.workflowKey,
        runAddress.runRef
      );
      await this.invalidateRunViews(runAddress.workflowKey, runAddress.runRef);
      throw error;
    }

    await this.publishRunRevisionsToViewers(
      runAddress.workflowKey,
      runAddress.runRef
    );
    await this.invalidateRunViews(runAddress.workflowKey, runAddress.runRef);
  }

  async insertWorkflowStepAfterIndex(
    mutation: WorkflowDefinitionMutation | undefined,
    afterIndex: number,
    step: WorkflowStep,
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<void> {
    if (!mutation || mutation.address.kind !== WORKFLOW_VIEW_ADDRESS_KIND.RUN) {
      await this.getInstanceForClient(clientId).insertWorkflowStepAfterIndex(
        afterIndex,
        step
      );
      await this.recordDefinitionWrite(undefined, clientId);
      return;
    }
    const runAddress = mutation.address;
    await this.applyRunAddressedMutation(
      runAddress,
      clientId,
      mutation.expectedDefinitionRevision,
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
        ).then((written) => written.definitionRevision)
    );
  }

  async updateFinalStepInQueue(
    mutation: WorkflowDefinitionMutation | undefined,
    finalStep: WorkflowStep | null,
    clearProperties?: string[],
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<void> {
    if (!mutation || mutation.address.kind !== WORKFLOW_VIEW_ADDRESS_KIND.RUN) {
      await this.getInstanceForClient(clientId).updateFinalStepInQueue(
        finalStep,
        clearProperties
      );
      await this.recordDefinitionWrite(undefined, clientId);
      return;
    }
    const runAddress = mutation.address;
    await this.applyRunAddressedMutation(
      runAddress,
      clientId,
      mutation.expectedDefinitionRevision,
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
        ).then((written) => written.definitionRevision)
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
    if (!mutation || mutation.address.kind !== WORKFLOW_VIEW_ADDRESS_KIND.RUN) {
      await this.getInstanceForClient(clientId).deletePromptFromQueue(index);
      await this.recordDefinitionWrite(undefined, clientId);
      return;
    }
    const runAddress = mutation.address;
    await this.applyRunAddressedMutation(
      runAddress,
      clientId,
      mutation.expectedDefinitionRevision,
      (instance) => instance.deletePromptFromQueue(index),
      (workspaceRoot) =>
        WorkingFileManager.deleteStepAtRun(
          workspaceRoot,
          runAddress.workflowKey,
          runAddress.runRef,
          index,
          mutation.expectedDefinitionRevision,
          this.lineageRepository
        ).then((written) => written.definitionRevision)
    );
  }

  async reorderPendingPrompts(
    mutation: WorkflowDefinitionMutation | undefined,
    newPendingOrder: number[],
    clientId: string = this.PANEL_CLIENT_ID,
    pendingGroups?: PendingParallelGroupRange[]
  ): Promise<void> {
    if (!mutation || mutation.address.kind !== WORKFLOW_VIEW_ADDRESS_KIND.RUN) {
      await this.getInstanceForClient(clientId).reorderPendingPrompts(
        newPendingOrder,
        pendingGroups
      );
      await this.recordDefinitionWrite(undefined, clientId);
      return;
    }
    const runAddress = mutation.address;
    await this.applyRunAddressedMutation(
      runAddress,
      clientId,
      mutation.expectedDefinitionRevision,
      (instance) =>
        instance.reorderPendingPrompts(newPendingOrder, pendingGroups),
      (workspaceRoot) =>
        WorkingFileManager.reorderStepsAtRun(
          workspaceRoot,
          runAddress.workflowKey,
          runAddress.runRef,
          newPendingOrder,
          mutation.expectedDefinitionRevision,
          this.lineageRepository,
          pendingGroups
        ).then((written) => written.definitionRevision)
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
    clientId: string = this.PANEL_CLIENT_ID,
    parallelGroups?: import("../types/CtrlYokeTypes").ParallelGroupDefinition[]
  ): Promise<
    { definitionRevision: number; descriptorRevision: number } | undefined
  > {
    if (!mutation || mutation.address.kind !== WORKFLOW_VIEW_ADDRESS_KIND.RUN) {
      await this.getInstanceForClient(clientId).syncStepsForUndoRedo(
        steps,
        finalStep,
        parallelGroups
      );
      await this.recordDefinitionWrite(undefined, clientId);
      return undefined;
    }
    const runAddress = mutation.address;
    let latest:
      | { definitionRevision: number; descriptorRevision: number }
      | undefined;
    await this.applyRunAddressedMutation(
      runAddress,
      clientId,
      mutation.expectedDefinitionRevision,
      (instance) =>
        instance.syncStepsForUndoRedo(steps, finalStep, parallelGroups),
      async (workspaceRoot) => {
        const stepsResult = await WorkingFileManager.syncStepsForUndoRedoAtRun(
          workspaceRoot,
          runAddress.workflowKey,
          runAddress.runRef,
          steps,
          mutation.expectedDefinitionRevision,
          this.lineageRepository,
          parallelGroups
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
          return finalStepResult.definitionRevision;
        }
        return stepsResult.definitionRevision;
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
        kind: typeof WORKTREE_EDIT_KINDS.REWIND;
        definitionRevision: number;
        descriptorRevision: number;
      }
  > {
    const reconciled = this.reconcileRunRevisions(
      address,
      clientId,
      expectedDefinitionRevision,
      expectedDescriptorRevision
    );
    const result = await this.runLifecycleService.setStartPositionAtRun(
      address,
      toIndex,
      reconciled.expectedDefinitionRevision,
      reconciled.expectedDescriptorRevision,
      clientId,
      options
    );
    const resultAddress =
      "runRef" in result
        ? {
            workflowKey: address.workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: result.runRef,
          }
        : {
            workflowKey: address.workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: address.runRef,
          };
    await this.recordSuccessfulRevisions(resultAddress, clientId, {
      definitionRevision: result.definitionRevision,
      descriptorRevision: result.descriptorRevision,
      recordDefinition: true,
      recordDescriptor: true,
    });
    return result;
  }

  /** Seed a fresh RunRef from an addressed run and execute that new run. */
  async seedAndExecuteAtRun(
    address: WorkflowRunAddress,
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number,
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<{ runRef: RunRef }> {
    const reconciled = this.reconcileRunRevisions(
      address,
      clientId,
      expectedDefinitionRevision,
      expectedDescriptorRevision
    );
    const result = await this.runLifecycleService.seedAndExecuteAtRun(
      address,
      reconciled.expectedDefinitionRevision,
      reconciled.expectedDescriptorRevision,
      clientId
    );
    await this.recordSuccessfulRevisions(
      {
        workflowKey: address.workflowKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: result.runRef,
      },
      clientId,
      {
        recordDefinition: true,
        recordDescriptor: true,
      }
    );
    return result;
  }

  /** Execute the exact viewed draft; promoted runs must use seedAndExecuteAtRun. */
  async executeDraftAtAddress(
    address: Extract<WorkflowViewAddress, { kind: "draft" }>,
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number,
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<void> {
    const reconciled = this.reconcileExpectedRevisions(
      address,
      clientId,
      expectedDefinitionRevision,
      expectedDescriptorRevision
    );
    await this.runLifecycleService.executeDraftAtAddress(
      address,
      reconciled.expectedDefinitionRevision,
      reconciled.expectedDescriptorRevision,
      clientId
    );
    await this.recordSuccessfulRevisions(address, clientId, {
      recordDefinition: true,
      recordDescriptor: true,
    });
  }

  /** One client action: restore the committed run, then seed and execute a new RunRef. */
  async startNewRunInsteadAtRun(
    address: WorkflowRunAddress,
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number,
    confirmEditedSuffix: boolean,
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<{ runRef: RunRef } | { hasSuffixEdits: true }> {
    const reconciled = this.reconcileRunRevisions(
      address,
      clientId,
      expectedDefinitionRevision,
      expectedDescriptorRevision
    );
    const result = await this.runLifecycleService.startNewRunInsteadAtRun(
      address,
      reconciled.expectedDefinitionRevision,
      reconciled.expectedDescriptorRevision,
      confirmEditedSuffix,
      clientId
    );
    if ("runRef" in result) {
      await this.recordSuccessfulRevisions(
        {
          workflowKey: address.workflowKey,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
          runRef: result.runRef,
        },
        clientId,
        {
          recordDefinition: true,
          recordDescriptor: true,
        }
      );
    }
    return result;
  }

  /** Human-readable view address for mismatch diagnostics in thrown errors. */
  private static describeViewAddress(
    address: WorkflowViewAddress | null | undefined
  ): string {
    return RunLifecycleService.describeViewAddress(address);
  }

  public async switchClientToPreparedExecution(
    instance: WorkflowInstance,
    clientId: string
  ): Promise<void> {
    return this.runLifecycleService.switchClientToPreparedExecution(
      instance,
      clientId
    );
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
    const reconciled = this.reconcileRunRevisions(
      address,
      clientId,
      expectedDefinitionRevision,
      expectedDescriptorRevision
    );
    const result = await this.runLifecycleService.appendAndContinueAtRun(
      address,
      tail,
      reconciled.expectedDefinitionRevision,
      reconciled.expectedDescriptorRevision,
      clientId
    );
    await this.recordSuccessfulRevisions(
      {
        workflowKey: address.workflowKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: address.runRef,
      },
      clientId,
      {
        definitionRevision: result.definitionRevision,
        descriptorRevision:
          result.descriptorRevision !== reconciled.expectedDescriptorRevision
            ? result.descriptorRevision
            : undefined,
        recordDefinition: true,
        recordDescriptor:
          result.descriptorRevision !== reconciled.expectedDescriptorRevision,
      }
    );
    return result;
  }

  /** Continue an unchanged addressed run; no target is inferred from recency. */
  async continueAtRun(
    address: { workflowKey: WorkflowKey; runRef: RunRef },
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number,
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<void> {
    const reconciled = this.reconcileRunRevisions(
      address,
      clientId,
      expectedDefinitionRevision,
      expectedDescriptorRevision
    );
    await this.runLifecycleService.continueAtRun(
      address,
      reconciled.expectedDefinitionRevision,
      reconciled.expectedDescriptorRevision,
      clientId
    );
    const identity = await this.getViewIdentity(clientId);
    if (
      identity &&
      identity.descriptorRevision !== reconciled.expectedDescriptorRevision
    ) {
      this.definitionAuthorLedger.recordDescriptor(
        address.workflowKey,
        clientId,
        identity.descriptorRevision
      );
    }
  }

  public async validateExplicitContinuationTarget(
    address: { workflowKey: WorkflowKey; runRef: RunRef },
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number,
    clientId: string
  ): Promise<ExplicitContinuationValidation> {
    return this.runLifecycleService.validateExplicitContinuationTarget(
      address,
      expectedDefinitionRevision,
      expectedDescriptorRevision,
      clientId
    );
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
    const reconciled = this.reconcileRunRevisions(
      address,
      clientId,
      expectedDefinitionRevision,
      expectedDescriptorRevision
    );
    const result = await this.runLifecycleService.discardContinuationAtRun(
      address,
      reconciled.expectedDefinitionRevision,
      reconciled.expectedDescriptorRevision,
      confirmEditedSuffix,
      clientId,
      invalidate
    );
    if (result.discarded) {
      await this.recordSuccessfulRevisions(
        {
          workflowKey: address.workflowKey,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
          runRef: address.runRef,
        },
        clientId,
        {
          definitionRevision: result.definitionRevision,
          descriptorRevision: result.descriptorRevision,
          recordDefinition: true,
          recordDescriptor: true,
        }
      );
    }
    return result;
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
    await this.runViewPublisher.invalidateRunViewProperties(
      workflowKey,
      runRef
    );
  }

  private async invalidateRunViewStepColor(
    workflowKey: WorkflowKey,
    runRef: RunRef,
    index: number
  ): Promise<void> {
    await this.runViewPublisher.invalidateRunViewStepColor(
      workflowKey,
      runRef,
      index
    );
  }

  private async invalidateRunViews(
    workflowKey: WorkflowKey,
    runRef: RunRef,
    definitionRollback?: DefinitionRollbackInvalidation
  ): Promise<void> {
    await this.runViewPublisher.invalidateRunViews(
      workflowKey,
      runRef,
      definitionRollback
    );
  }

  async deleteRunAtAddress(
    address: { workflowKey: WorkflowKey; runRef: RunRef },
    send: (message: unknown) => void,
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<void> {
    return this.runLifecycleService.deleteRunAtAddress(address, send, clientId);
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
    return this.runLifecycleService.deleteAllRunsForLineage(
      workflowKey,
      send,
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
    await this.runViewPublisher.pushRunSummariesRefreshIfNotAlreadyViewing(
      workflowKey,
      send,
      refreshedClientIds,
      clientId
    );
  }

  async runInNewWorkflowForClient(
    text: string,
    properties: unknown,
    promptName: string | undefined,
    send: (message: unknown) => void,
    clientId: string
  ): Promise<void> {
    const instance = this.registerNewInstance(clientId);
    getPtyProcessManager()?.setPendingController(instance.id, clientId);
    const stepHarness = await instance.initializeEphemeralPrompt(
      text,
      properties,
      promptName
    );
    await this.replayWorkflowStateTo(instance.id, send, clientId);
    await instance.executeLoadedPromptFile(stepHarness);
  }

  async sendSteerMessage(
    workflowId: string,
    sessionId: string,
    text: string
  ): Promise<void> {
    const instance = this.findInstance(workflowId);
    if (!instance) {
      throw new Error(`Workflow "${workflowId}" was not found.`);
    }
    await instance.sendSteerMessage(sessionId, text);
  }

  async executeEphemeralPrompt(
    text: string,
    properties: unknown,
    action: ActionType,
    promptName?: string,
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
    if (mutation && mutation.address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN) {
      const runAddress = mutation.address;
      const queueState = instance.getQueueState();
      const instanceOwnsAddressedRun =
        queueState.workflowKey === runAddress.workflowKey &&
        queueState.runRef === runAddress.runRef;
      if (!instanceOwnsAddressedRun) {
        if (action === ACTION_TYPES.RUN_PARALLEL) {
          throw new Error(
            "Run in Parallel must target the executing workflow run."
          );
        }
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
    if (isRunAction) {
      const summary = instance.getSummary();
      const wouldStart =
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
      promptName
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
      clientId,
      mutation.expectedDefinitionRevision,
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
        ).then((written) => written.definitionRevision)
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Orchestrator-level workflow operations
  // ─────────────────────────────────────────────────────────────────────────

  async listResumableSessions(): Promise<ResumableSession[]> {
    if (!this.currentWorkspaceFolderPath) {
      notifyUserFeedback(
        this.userFeedbackSink,
        USER_FEEDBACK_SEVERITY.ERROR,
        "No workspace folder open"
      );
      return [];
    }

    try {
      const sessions = await this.workspaceSessionManager.discoverSessions(
        this.currentWorkspaceFolderPath
      );

      if (sessions.length === 0) {
        notifyUserFeedback(
          this.userFeedbackSink,
          USER_FEEDBACK_SEVERITY.INFO,
          "No previous sessions found. Run a workflow first to create a session."
        );
        return [];
      }

      return sessions;
    } catch (error) {
      Log.error(
        "[WorkflowOrchestrator] Failed to discover resumable sessions:",
        error as Error
      );
      notifyUserFeedback(
        this.userFeedbackSink,
        USER_FEEDBACK_SEVERITY.ERROR,
        `Failed to resume session: ${getErrorMessage(error)}`
      );
      return [];
    }
  }

  async resumeSessionFromWorkingFile(filePath: string): Promise<void> {
    try {
      // Create a fresh instance so the resumed workflow is parallel to any running ones
      const panelSend = this.storedPanelSend ?? ((_: unknown) => {});
      await this.createWorkflowForClient(panelSend, this.PANEL_CLIENT_ID);
      await this.getActiveInstance().restoreWorkflowFromWorkingFile(filePath);
      this.platform.focusDashboard?.();
      Log.info(
        `[WorkflowOrchestrator] Resumed session from working file: ${filePath}`
      );
    } catch (loadError) {
      Log.error(
        "[WorkflowOrchestrator] Failed to load session:",
        loadError as Error
      );
      notifyUserFeedback(
        this.userFeedbackSink,
        USER_FEEDBACK_SEVERITY.ERROR,
        `Failed to load session: ${getErrorMessage(loadError)}`
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
        Log.warn(
          "[WorkflowOrchestrator] Workflow shutdown did not settle cleanly:",
          result.reason
        );
      }
    }
  }

  dispose(): void {
    this.activeQueueStateChangedEmitter?.dispose();
    this.activeQueueStateChangedEmitter = undefined;

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

    this.externalRunWatchCoordinator.dispose();

    for (const session of this.coordinationWatchSessions?.values() ?? []) {
      session.dispose();
    }
    this.coordinationWatchSessions?.clear();

    // The extension owns the injected status sink. Its StatusBarManager is
    // registered with context.subscriptions at construction time.
    this.endConditionEvaluator.dispose();
    this.compatibilityRegistry.dispose();
    // Cancels any in-flight provider quota probe so its subprocess cannot
    // outlive the host (workspace close, extension deactivate).
    this.harnessUsageService?.dispose();
    // The run-summary cache is module-level, so nothing else drops it when the
    // host tears down (workspace close, extension deactivate).
    clearRunSummaryCache();
    Log.debug("[WorkflowOrchestrator] WorkflowOrchestrator disposed");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private findInstancesForExternalRunWatch(
    workingFilePath: string,
    includeRetired = false
  ): ReadonlyArray<ExternalRunWatchInstance> {
    const instances = includeRetired
      ? [...this.instances.values(), ...this.retiredInstances.values()]
      : [...this.instances.values()];
    return instances.filter((instance) =>
      sameWorkingFilePath(
        instance.getSummary().workingFilePath,
        workingFilePath
      )
    );
  }

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
    return this.workflowInstanceRegistry.findInstance(workflowId);
  }

  /**
   * Get the active WorkflowInstance, creating one if none exists yet.
   * Always scoped to the panel client. Use getInstanceForClient() when a
   * specific clientId is available (e.g. from a browser message handler).
   */
  private getActiveInstance(): WorkflowInstance {
    return this.workflowInstanceRegistry.getActiveInstance();
  }

  /**
   * Get the WorkflowInstance currently viewed by the given client.
   * All callers must supply a valid clientId — "panel" for the VS Code panel,
   * "browser:N" for WebSocket clients. Falls back to the active instance as a
   * last resort but logs a warning so bugs are surfaced immediately.
   */
  private getInstanceForClient(clientId: string): WorkflowInstance {
    return this.workflowInstanceRegistry.getInstanceForClient(clientId);
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
    return this.workflowInstanceRegistry.getBoundInstance(clientId);
  }

  /** Return the execution-root coordination projection for one dashboard view. */
  async getCoordinationScopeSnapshot(
    clientId: string = this.PANEL_CLIENT_ID
  ): Promise<CoordinationScopeSnapshot> {
    const instance =
      clientId === this.PANEL_CLIENT_ID
        ? this.getActiveInstance()
        : this.getBoundInstance(clientId);
    const executionRoot =
      instance?.getExecutionRoot() ?? this.currentWorkspaceFolderPath;
    if (!executionRoot) {
      throw new Error("No workspace execution root is available");
    }
    this.ensureCoordinationWatchSession(executionRoot);
    return readCoordinationScopeSnapshot(executionRoot);
  }

  private ensureCoordinationWatchSession(executionRoot: string): void {
    const key = path.normalize(executionRoot).toLowerCase();
    const sessions = this.coordinationWatchSessions;
    // Some focused tests construct the orchestrator prototype without running
    // the constructor. Those instances do not own long-lived filesystem
    // watchers and should retain their lightweight behavior.
    if (!sessions || sessions.has(key)) return;
    const session = new ExecutionRootCoordinationWatchSession(
      executionRoot,
      (snapshot) =>
        this.dashboardBroadcastHub.notifyCoordinationScopeUpdated(snapshot)
    );
    sessions.set(key, session);
    void session.start().catch((error) => {
      Log.warn(
        `[WorkflowOrchestrator] coordination watcher failed for ${executionRoot}`,
        error
      );
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Per-client viewer registry helpers
  // ─────────────────────────────────────────────────────────────────────────

  private getViewedWorkflowId(clientId: string): string | null {
    return this.workflowInstanceRegistry.getViewedWorkflowId(clientId);
  }

  private setViewedWorkflowId(
    clientId: string,
    workflowId: string | null
  ): void {
    this.workflowInstanceRegistry.setViewedWorkflowId(clientId, workflowId);
  }

  private getActiveQueueStateChangedEmitter(): TypedEmitter<
    QueueState | undefined
  > {
    return (this.activeQueueStateChangedEmitter ??= new TypedEmitter<
      QueueState | undefined
    >());
  }

  private setHasQueuedStepsContext(state: QueueState | undefined): void {
    this.statusBarSink?.setHasQueuedStepsContext(
      (state?.steps.length ?? 0) > 0
    );
  }

  public isWorkflowViewedByAnyClient(workflowId: string): boolean {
    return this.workflowInstanceRegistry.isWorkflowViewedByAnyClient(
      workflowId
    );
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
    this.workflowInstanceRegistry.registerClient(clientId, send);
  }

  unregisterClient(clientId: string): void {
    this.workflowInstanceRegistry.unregisterClient(clientId);
  }

  /**
   * Gate secret-grant approval on VS Code's own workspace-trust concept
   * before delegating to the (vscode-free) shared prompt helper — an
   * untrusted workspace never gets asked, same as before this was made
   * interaction-port-based.
   */
  private async approveSecretGrantsForWorkflow(
    workflow: PromptFile,
    workspaceRoot: string
  ): Promise<void> {
    if (!(this.workspaceTrustPredicate?.() ?? true)) {
      return;
    }
    await promptBatchApprovalForPendingWorkspaceSecretGrants(
      workflow,
      workspaceRoot,
      this.userInteractionPort
    );
  }

  /**
   * Construct a new WorkflowInstance wired to this orchestrator's integrations.
   */
  private buildWorkflowInstance(): WorkflowInstance {
    return this.workflowInstanceRegistry.buildWorkflowInstanceForHost();
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
  public adoptInstanceLineageAddress(
    instance: WorkflowInstance,
    state: QueueState
  ): void {
    this.workflowInstanceRegistry.adoptInstanceLineageAddress(instance, state);
    const address = lineageAddressOf(state);

    for (const [clientId, viewedInstanceId] of this.viewerRegistry) {
      if (viewedInstanceId !== instance.id) {
        continue;
      }
      if (
        address?.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN &&
        this.getViewAddress(clientId)?.workflowKey === address.workflowKey
      ) {
        continue;
      }
      this.workflowInstanceRegistry
        .getViewAddressRegistry()
        .set(clientId, address);
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
      kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
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
        viewedAddress?.kind !== WORKFLOW_VIEW_ADDRESS_KIND.DRAFT ||
        viewedAddress.workflowKey !== state.workflowKey
      ) {
        continue;
      }
      // Move the address before publishing, not after: the publish is
      // asynchronous, the draft this client is addressing is already gone, and
      // RUNNING is emitted repeatedly — an unmoved address would send a fresh
      // snapshot on every one of them.
      this.workflowInstanceRegistry
        .getViewAddressRegistry()
        .set(clientId, address);
      const send =
        this.workflowInstanceRegistry.getViewMessageSinks().get(clientId) ??
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
    this.statusBarSink?.updateStatusBar(state, harnessStatus);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────────
  // CLI Watch Mode
  // ─────────────────────────────────────────────────────────────────────────

  private async setupExternalRunWatching(): Promise<void> {
    return this.externalRunWatchCoordinator.setupExternalRunWatching();
  }

  private async discoverWorktreesOnActivation(): Promise<void> {
    return this.externalRunWatchCoordinator.discoverWorktreesOnActivation();
  }
}
