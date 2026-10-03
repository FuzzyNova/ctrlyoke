import * as path from "path";
import { PromptFileParser } from "./PromptFileParser";
import { PromptQueue } from "./PromptQueue";
import { isActiveQueueWorkRunning } from "./ParallelGroupRuntime";
import { WorkingFileManager } from "./WorkingFileManager";
import { assertDefinitionRevision } from "./orchestration/RevisionPrecondition";
import {
  buildClearUpdates,
  buildDefinitionSnapshot,
  buildEphemeralWorkflowStep,
  buildFinalStepUpdate,
  buildPromptStepProperties,
  buildScriptStepFromProperties,
  mergeWorkflowStepUpdate,
  sanitizeClipboardWorkflowStep,
  stripViewOnlyWorkflowStepFields,
} from "./WorkflowStepSanitizer";
import { HarnessIntegration, HarnessStatus } from "./HarnessIntegration";
import {
  EndConditionEvaluator,
  type EvaluationResult,
} from "./EndConditionEvaluator";
import { EndConditionHandler } from "./EndConditionHandler";
import { WorkflowExecutor, WorkflowExecutionContext } from "./WorkflowExecutor";
import {
  PromptFile,
  PromptStep,
  WorkflowStep,
  isScriptStep,
  QueueState,
  HarnessId,
  EXECUTION_STATES,
  WorkingFile,
  WorkflowAttemptTarget,
  WorkflowAttemptTransition,
  WorkflowRuntimeTransition,
  WorkflowSummary,
  type WorktreeRunProjection,
  DynamicQueueConfig,
  deriveWorkflowFinalStepSummary,
  type RunRef,
  type WorkflowKey,
  type WorkflowLineageCreationOptions,
  type RunnerHostIdentity,
  type ParallelGroupDefinition,
} from "../types/CtrlYokeTypes";
import * as WorkflowPaths from "../utils/WorkflowPaths";
import { WorkflowLineageRepository } from "./orchestration/WorkflowLineageRepository";
import { resolveReportedScriptProperties } from "../utils/ScriptComparison";
import { pathsEqual } from "../utils/PathCasing";
import { generateWorkflowNameFromPrompt } from "../utils/workflowNaming";
import {
  ACTION_TYPES,
  COMPARE_SOURCES,
  CONDITION_ACTIONS,
  DEFAULT_WORKFLOW_NAME,
  FINAL_STEP_PHASES,
  MESSAGE_TYPES,
  PARALLEL_GROUP_ADMISSION,
  getEffectiveParallelGroupWidth,
  QUEUE_POSITION,
  RUNNER_IDS,
  SESSION_KINDS,
  TERMINAL_END_REASONS,
  TERMINAL_SESSION_STATUS,
  STATUS_MESSAGE_SEVERITY,
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  CAPABILITY_FIDELITIES,
  CAPABILITY_MECHANISMS,
  CAPABILITY_VERIFICATION_STATUSES,
  PROMPT_DIAGNOSTIC_CODES,
  PROMPT_INPUT_CAPABILITY_KEYS,
  EXECUTION_PHASES,
  SCRIPT_OUTPUT_SOURCES,
  SCRIPT_SOURCE_LABELS,
  STEP_STATUS,
  STEP_TYPES,
  WORKFLOW_ATTEMPT_COMMANDS,
  WORKFLOW_RUNTIME_COMMANDS,
  WORKFLOW_TELEMETRY_OUTCOMES,
  WORKTREE_MODES,
  DEFAULT_ERROR_BEHAVIOR_RETRIES,
  type ActionType,
  type QueuePosition,
  type WorkflowTelemetryOutcome,
} from "../types/DashboardConstants";
import type { IDashboardSink } from "../types/IDashboardSink";
import { WorkflowTaggedSink } from "./WorkflowTaggedSink";
import type {
  CliEvent,
  CliOutput,
  TerminalStartedMessage,
} from "../types/WebviewMessageTypes";
import { Log } from "../utils/Log";
import {
  reportWorkflowStarted,
  reportWorkflowCompleted,
} from "../utils/TelemetryEvents";
import { getErrorMessage } from "../utils/ErrorUtils";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { exceedsLimit } from "../utils/LimitUtils";
import {
  buildStepLimitError,
  getEffectiveMaxStepsSource,
  resolveEffectiveMaxSteps,
} from "../utils/QueueLimitUtils";
import { PropertyResolver } from "../utils/PropertyResolver";
import {
  resolveWorktreeForWorkspace,
  type WorkspaceWorktreeResolution,
} from "../utils/WorktreeResolution";
import { isCli } from "../utils/RuntimeMode";
import {
  createNoWorktreeExecutionWorkspace,
  PlatformAdapter,
} from "../platform/PlatformAdapter";
import {
  getExecutionWorkspaceIdentity,
  type ExecutionWorkspace,
  type McpToolSkillRunContext,
} from "../types/WorkflowContextTypes";
import { TypedEmitter } from "../utils/TypedEmitter";
import type { HarnessUsageSnapshot } from "../types/UsageTypes";
import {
  ExecutionRootLeaseManager,
  ExecutionLeaseConflictError,
  type ExecutionLeaseHandle,
} from "./orchestration/ExecutionRootLeaseManager";
import { CoordinationParticipantRegistry } from "./orchestration/ExecutionRootCoordination";
import {
  WorktreeManager,
  type WorktreeInfo,
  type WorktreeSetupRunner,
} from "./orchestration/WorktreeManager";
import {
  ScriptExecutionReporter,
  type ScriptExecutionReporterContext,
} from "./orchestration/ScriptExecutionReporter";
import {
  ScriptProcessRunner,
  resolveScriptInvocation,
  type ScriptProcessResult,
} from "./orchestration/ScriptProcessRunner";

// Import orchestration classes
import { PromptFileLoader } from "./orchestration/PromptFileLoader";
import { PromptFileWatcher } from "./orchestration/PromptFileWatcher";
import { createPriorContextResolver } from "./orchestration/AddressedPriorContextResolver";
import {
  OutputHistoryManager,
  type DefinitionRevisionContext,
} from "./orchestration/OutputHistoryManager";
import { StatusMessageReporter } from "./orchestration/StatusMessageReporter";
import { SessionActivityRecorder } from "./orchestration/SessionActivityRecorder";
import { RunnerLockCoordinator } from "./orchestration/RunnerLockCoordinator";
import {
  WorkflowStartupPipeline,
  type WorkflowStartupContextPort,
  type WorkflowStartupLifecyclePort,
  type WorkflowStartupPipelinePort,
} from "./orchestration/WorkflowStartupPipeline";
import type { PendingParallelGroupRange } from "./ParallelGroupTopology";
import { IntegrationFactory } from "./IntegrationFactory";
import { HarnessCapabilityRegistry } from "./HarnessCapabilityRegistry";
import { notifyUserFeedback, type UserFeedbackSink } from "./UserFeedbackSink";
import {
  RunSecretRedactor,
  secretRedactionService,
} from "../utils/SecretRedactionService";
import {
  analyzeCompatibility,
  enumerateCompatibilityTargets,
} from "../types/CompatibilityAnalyzer";
import type { CompatibilityDiagnostic } from "../types/CompatibilityTypes";
import type { ResolvedProperties } from "../types/ExecutionPropertyTypes";
import { spawnIdentityHash } from "../types/ExecutionSpawnIdentity";
import { WorkspaceSnapshotService } from "../utils/WorkspaceSnapshotService";
import type {
  OutputExecutionTarget,
  UndoExecutionTarget,
} from "../types/OutputHistoryTypes";
import {
  OutputCaptureBuffer,
  type OutputCaptureCallbacks,
  type PromptStartData,
  type PromptCompleteData,
} from "./OutputCaptureBuffer";
import { WorkflowStateMachine } from "./WorkflowStateMachine";
import type { ExternalRunWatchInstance } from "./orchestration/ExternalRunWatchCoordinator";
import type { RunLifecycleInstancePort } from "./orchestration/RunLifecycleService";
import type { RunViewPublisherInstance } from "./orchestration/RunViewPublisher";
import {
  buildTerminalEndedMessage,
  getPtyProcessManager,
  ptyPostMessage,
  resolveShellInvocation,
  toPtySpawnArgs,
} from "./harness/PtyProcessManager";
import { getShellInvocationError } from "../utils/ShellCatalog";
export type {
  PromptStartData,
  PromptCompleteData,
} from "./OutputCaptureBuffer";

/**
 * WorkflowInstance
 *
 * RESPONSIBILITY: Single Workflow Execution Lifecycle
 *
 * Encapsulates all per-workflow state that was previously scattered across
 * the original monolithic manager:
 *   - PromptQueue (state machine)
 *   - WorkflowExecutor (execution loop)
 *   - EndConditionHandler / EndConditionEvaluator
 *   - PromptFileLoader / PromptFileWatcher
 *   - OutputHistoryManager
 *   - active target resources, currentPromptFile, startPending, lastKnownStepCount
 *
 * Dependencies that span multiple workflows (integrations, status bar, template
 * importing) remain in WorkflowOrchestrator and are injected as callbacks:
 *   - integrationFactory                → creates per-run execution integrations
 *   - getDetectorIntegration(harness?)  → returns detector singleton for pre-flight checks
 *   - onWorkflowNameChange(name)        → propagate name to CLI tabs
 *   - onStatusBarUpdate()               → trigger orchestrator status bar refresh
 *
 * Phase 1: WorkflowOrchestrator holds exactly one instance.
 * Phase 2: Multiple instances run in parallel (one per open workflow).
 */

interface ActiveTargetResources {
  target: WorkflowAttemptTarget;
  attemptIndex?: number;
  integration?: HarnessIntegration;
  processRunner?: ScriptProcessRunner;
  ptySessionId?: string;
}

export class WorkflowInstance
  implements
    RunLifecycleInstancePort,
    RunViewPublisherInstance,
    ExternalRunWatchInstance
{
  private readonly lineageRepository = new WorkflowLineageRepository();
  /** Unique identifier — stable for this instance's lifetime */
  readonly id: string;
  /** Editable display name (kept in sync with queue's workflowName) */
  workflowName: string = "";
  /** Path to the source prompt/workflow file (or generated name for ephemerals) */
  filePath: string = "";
  /** Authored source used as the semantic base for standalone prompt-file refs. */
  private sourceDefinitionPath?: string;
  /** Creation timestamp (ms since epoch) */
  readonly createdAt: number;
  /** Timestamp when execution last started (ms since epoch), 0 if never started */
  startedAt: number = 0;

  // ─────────────────────────────────────────────────────────────────────────
  // Per-workflow execution state
  // ─────────────────────────────────────────────────────────────────────────
  readonly promptFileParser: PromptFileParser;
  readonly promptQueue: PromptQueue;
  workflowExecutor: WorkflowExecutor;
  private readonly workflowRuntime: WorkflowStateMachine;
  /** Immutable state/execution roots captured when this instance is created. */
  private executionWorkspace: ExecutionWorkspace;
  private readonly defaultExecutionWorkspace: ExecutionWorkspace;
  private executionWorkspaceIdentity: string;
  /** Worktree selection resolved for the current run, including its origin. */
  private worktreeResolution: WorkspaceWorktreeResolution = {
    origin: "default",
  };

  private canReuseExecutionIntegration(
    integration: HarnessIntegration
  ): boolean {
    const identity = integration.getExecutionWorkspaceIdentity();
    return (
      identity === undefined || identity === this.executionWorkspaceIdentity
    );
  }
  private endConditionEvaluator: EndConditionEvaluator;
  private endConditionHandler: EndConditionHandler;
  private readonly worktreeManager: WorktreeManager;
  private activeWorktree: WorktreeInfo | undefined;
  /**
   * Merge/keep intent captured alongside `activeWorktree` at the moment it
   * was resolved. `worktreeResolution` gets overwritten by the next resolve
   * (e.g. resuming after the workflow's worktree config changed), so by the
   * time a stale `activeWorktree` needs settling, `worktreeResolution.config`
   * no longer describes it — this does.
   */
  private activeWorktreeSettlement:
    { merge: boolean; keep: boolean } | undefined;

  /** Reference to the loaded source prompt file */
  private currentPromptFile?: { filePath: string; promptFile: PromptFile };
  /** Race-condition guard: prevents duplicate workflow starts */
  startPending: boolean = false;
  /** Deduplicates overlapping eager working-file creation requests */
  private ensureWorkingFilePromise: Promise<void> | undefined;
  /** Tracks prompt count to detect MCP-triggered merges */
  private lastKnownStepCount: number = 0;
  /** Tracks workflow name to detect changes and push them to the dashboard */
  private lastKnownWorkflowName: string = "";
  /** One-shot marker for the automatic topology echo caused by promotion. */
  private runtimePromotionUndoSuppressed = false;
  /**
   * When a prompt is sent with Run intent while the workflow is still cancelling,
   * we can't execute immediately. This stores the harness override so that once
   * confirmStopped fires (cancelling → stopped) we auto-continue rather than
   * leaving the user with a pending step they have to manually resume.
   * null = no deferred run pending.
   */
  private pendingRunAfterCancel: { harness: HarnessId | undefined } | null =
    null;
  private readonly runnerLockCoordinator: RunnerLockCoordinator;
  /** Shared lease for the execution root used by this run. */
  private executionLease: ExecutionLeaseHandle | undefined;
  /** The RunRef this instance is currently executing, if any. Distinct from any client's viewed run. */
  private executionRunRef: RunRef | undefined;
  private executionSettledPromise: Promise<void> = Promise.resolve();
  private resolveExecutionSettled: (() => void) | undefined;
  /**
   * How long `shutdown()` lets an already-cancelled run settle after durable
   * state is flushed. Deliberately short: VS Code's exit path should not stall
   * on a harness that is slow to acknowledge cancellation, and startup recovery
   * already repairs a run that never settled.
   */
  private static readonly SHUTDOWN_SETTLE_TIMEOUT_MS = 1_500;

  /** Per-workflow dashboard sink (wrapped with WorkflowTaggedSink to inject workflowId) */
  private readonly dashboardSink: IDashboardSink | undefined;
  private readonly sessionActivityRecorder: SessionActivityRecorder;
  private readonly statusMessageReporter: StatusMessageReporter;

  /** Manages all output capture Maps and replay logic for background workflows. */
  private readonly outputCaptureBuffer: OutputCaptureBuffer;

  // ─────────────────────────────────────────────────────────────────────────
  // Orchestration helpers
  // ─────────────────────────────────────────────────────────────────────────
  private readonly promptFileLoader: PromptFileLoader;
  private readonly promptFileWatcher: PromptFileWatcher;
  readonly outputHistoryManager: OutputHistoryManager;
  private activeHistoryFilePath: string = "";
  /** Optional per-run override used by commit-message skill capture. */
  private mcpToolSkillContext?: Partial<McpToolSkillRunContext>;
  private activeRunRedactor?: RunSecretRedactor;
  private releaseActiveRunRedactor?: () => void;
  private pendingRuntimeTransitionHistoryWrite: Promise<void> =
    Promise.resolve();

  /**
   * Execution integrations created for the current/most-recent run — disposed in finally block.
   * Keyed by harness ID and spawn identity so compatible prompts reuse the same integration
   * instance rather than allocating a new one per prompt (important for long-running /
   * infinite-queue workflows).
   */
  private readonly executionIntegrations = new Map<
    string,
    HarnessIntegration
  >();
  /**
   * Execution integrations this run owns that no spawn-identity key points at:
   * provisional ones created before the executor resolved a prompt, and ones
   * superseded by a newer conversation for the same spawn identity. Their
   * terminals stay open for the rest of the run — retention is the point — but
   * no prompt can select them again, so they are never parked for inject.
   */
  private readonly unkeyedExecutionIntegrations = new Set<HarnessIntegration>();
  /** Target-keyed integrations used by a future parallel group fan-out. */
  private readonly targetExecutionIntegrations = new Map<
    string,
    HarnessIntegration
  >();
  /** All resources currently owned by active target attempts. */
  private readonly activeTargetResources = new Map<
    string,
    ActiveTargetResources
  >();
  /** One headless process transport per active target. */
  private readonly targetScriptProcessRunners = new Map<
    string,
    ScriptProcessRunner
  >();

  /**
   * Integrations from the previous run whose terminals were intentionally left open
   * (closeTerminalWhenPromptCompletes = false). Closed at the start of the next run
   * so old terminals don't accumulate when a workflow is restarted or extended.
   */
  private lastRunIntegrations: HarnessIntegration[] = [];

  /**
   * Live integrations retained between `startWorkflowExecution` passes when
   * inject mode is active, keyed by the same harness/spawn-identity key used in
   * executionIntegrations. Each entry represents a compatible process that
   * completed a prompt with an active PTY session.
   *
   * **This retention never crosses a RunRef.** "Pass" here means another
   * `startWorkflowExecution` call on the *same* run — appending a prompt to a
   * completed workflow and continuing it, which is what keeps the TUI alive so
   * the appended prompt injects instead of restarting. A new RunRef (Re-run,
   * restart-from-beginning) disposes every entry first via
   * `closeRetainedTerminalsForFreshRun`, so a fresh run never inherits a
   * terminal or a conversation from the previous one.
   *
   * Instead of disposing these integrations at the end of a pass (which would
   * sever the PTY connection), WorkflowInstance holds them here. On the next
   * pass they are re-inserted into executionIntegrations so
   * createIntegrationForMode returns the correct live instance — the PTY and
   * lastInteractiveContext are fully intact. Each entry is removed and disposed
   * when its PTY process exits.
   */
  private readonly liveInjectIntegrations = new Map<
    string,
    HarnessIntegration
  >();

  /**
   * Cleanup context for retained integrations whose provider explicitly needs
   * workflow artifacts to survive between executions. Most providers clean up
   * at execution completion even when their PTY/session watcher remains live.
   */
  private readonly retainedIntegrationArtifactContexts = new Map<
    string,
    {
      integration: HarnessIntegration;
      workingFilePath: string | undefined;
      workspaceRoot: string;
    }
  >();

  // ─────────────────────────────────────────────────────────────────────────
  // Streaming event forwarding — aggregates events from all execution integrations
  // so callers (e.g. the standalone CLI) can subscribe once on the instance.
  // ─────────────────────────────────────────────────────────────────────────
  private readonly _streamingEventsEmitter = new TypedEmitter<CliEvent[]>();
  /** Fires structured CLI events (Claude/Codex) from the active execution integration. */
  public readonly onStreamingEvents = this._streamingEventsEmitter.event;

  private readonly _streamingChunkEmitter = new TypedEmitter<string>();
  /** Fires plain-text chunks (Copilot) from the active execution integration. */
  public readonly onStreamingChunk = this._streamingChunkEmitter.event;

  private readonly _targetedStreamingEventsEmitter = new TypedEmitter<{
    target: WorkflowAttemptTarget;
    stepName: string;
    events: CliEvent[];
  }>();
  /** Fires structured output with the execution target that produced it. */
  public readonly onTargetStreamingEvents =
    this._targetedStreamingEventsEmitter.event;

  private readonly _targetedStreamingChunkEmitter = new TypedEmitter<{
    target: WorkflowAttemptTarget;
    stepName: string;
    chunk: string;
  }>();
  /** Fires plain-text output with the execution target that produced it. */
  public readonly onTargetStreamingChunk =
    this._targetedStreamingChunkEmitter.event;

  private readonly _targetedScriptOutputEmitter = new TypedEmitter<{
    target: OutputExecutionTarget;
    output: CliOutput;
  }>();
  /** Fires script command/output updates with the execution target that produced them. */
  public readonly onTargetScriptOutput =
    this._targetedScriptOutputEmitter.event;

  private readonly _responseCompleteEmitter = new TypedEmitter<string>();
  /** Fires the final plain-text response from the active execution integration. */
  public readonly onResponseComplete = this._responseCompleteEmitter.event;

  private readonly _promptCompleteEmitter =
    new TypedEmitter<PromptCompleteData>();
  /**
   * Fires after each prompt fully completes (after session ID extraction),
   * carrying token stats, session ID, harness, and elapsed time.
   * Designed for the standalone CLI to display per-prompt statistics.
   */
  public readonly onPromptComplete = this._promptCompleteEmitter.event;

  private readonly _promptStartEmitter = new TypedEmitter<PromptStartData>();
  /**
   * Fires when a prompt step begins (or retries).
   * Fires once immediately with the prompt text (cliCommand undefined), then again
   * when the harness CLI command is known (cliCommand populated).
   * Designed for the standalone CLI to display step headers and CLI commands.
   */
  public readonly onPromptStart = this._promptStartEmitter.event;

  private readonly _workflowStatusMessageEmitter = new TypedEmitter<{
    stepIndex: number;
    message: string;
    severity: string;
  }>();
  /**
   * Fires for each status message produced during workflow execution
   * (end condition results, retry notifications, etc.).
   * Designed for the standalone CLI to display status updates.
   */
  public readonly onWorkflowStatusMessage =
    this._workflowStatusMessageEmitter.event;

  constructor(
    private readonly platform: PlatformAdapter,
    dashboardSink: IDashboardSink | undefined,
    /**
     * Factory for creating per-run execution integrations.
     * Each call to createIntegrationForMode() produces a fresh, isolated integration.
     */
    private readonly integrationFactory: IntegrationFactory,
    /**
     * Resolve a DETECTOR integration (singleton) by optional harness override.
     * Used only for pre-flight status checks (Initializing / Waiting / Unavailable).
     * Never used for execution — execution always goes through integrationFactory.createForExecution().
     */
    private readonly getDetectorIntegration: (
      harnessOverride?: HarnessId
    ) => HarnessIntegration,
    /**
     * Callback to propagate workflow name to CLI detector singleton terminal tabs.
     * Called whenever workflowName changes or is cleared.
     */
    private readonly onWorkflowNameChange: (name: string | undefined) => void,
    /** Callback so status bar in orchestrator stays in sync with queue state */
    private readonly onStatusBarUpdate: () => void,
    private readonly workspaceFolderPath: string | undefined,
    private readonly hostCanProvidePty: boolean = true,
    private readonly supportsConcurrentInteractiveSessions: boolean = true,
    private readonly compatibilityRegistry?: HarnessCapabilityRegistry,
    /** Destination for future operational feedback migrations. */
    private readonly userFeedbackSink?: UserFeedbackSink,
    /** Synchronous cache reader; must never refresh providers during launch. */
    private readonly getHarnessUsageSnapshots?: () => readonly HarnessUsageSnapshot[],
    /** Fire-and-forget provider refresh after a terminal Copilot attempt. */
    private readonly refreshHarnessUsage?: (
      harnessId: HarnessId
    ) => Promise<unknown> | void,
    private readonly approveSecretGrants?: (
      workflow: PromptFile,
      workspaceRoot: string
    ) => Promise<void>,
    runnerHostIdentity?: RunnerHostIdentity
  ) {
    const resolvedRunnerHostIdentity = runnerHostIdentity ?? {
      runner: isCli() ? RUNNER_IDS.CLI : RUNNER_IDS.VSCODE,
      hostInstanceId: crypto.randomUUID(),
      pid: process.pid,
    };
    this.id = crypto.randomUUID();
    this.createdAt = Date.now();
    this.dashboardSink = dashboardSink
      ? new WorkflowTaggedSink(dashboardSink, this.id)
      : undefined;

    // Per-workflow dependencies
    this.promptFileParser = new PromptFileParser(
      this.platform,
      this.userFeedbackSink
    );
    this.workflowRuntime = new WorkflowStateMachine();
    this.promptQueue = new PromptQueue(this.workflowRuntime);
    this.runnerLockCoordinator = new RunnerLockCoordinator({
      id: this.id,
      runnerHostIdentity: resolvedRunnerHostIdentity,
      getQueueState: () => this.promptQueue.getState(),
      getWorkspaceRoot: () =>
        this.workspaceFolderPath ?? this.platform.getWorkspaceRoot(),
      stop: () => this.stop(),
      getExecutionLease: () => this.executionLease,
    });
    this.worktreeManager = new WorktreeManager({
      updateWorktreeRuntime: (patch) =>
        this.promptQueue.updateWorktreeRuntime(patch),
    });

    const resolvedWorkspacePath =
      workspaceFolderPath ?? this.platform.getWorkspaceRoot();
    const executionWorkspace: ExecutionWorkspace =
      createNoWorktreeExecutionWorkspace(this.platform, resolvedWorkspacePath);
    this.executionWorkspace = executionWorkspace;
    this.defaultExecutionWorkspace = executionWorkspace;
    this.executionWorkspaceIdentity =
      getExecutionWorkspaceIdentity(executionWorkspace);
    this.outputHistoryManager = new OutputHistoryManager(resolvedWorkspacePath);
    this.sessionActivityRecorder = new SessionActivityRecorder({
      id: this.id,
      dashboardSink: this.dashboardSink,
      promptQueue: this.promptQueue,
      outputHistoryManager: this.outputHistoryManager,
      resolveHistoryFilePath: () => this.resolveHistoryFilePath(),
      getDefinitionRevisionContext: () => this.getDefinitionRevisionContext(),
    });
    this.outputHistoryManager.setOutputActivityHandler((entry) =>
      this.publishOutputActivity(entry)
    );
    this.statusMessageReporter = new StatusMessageReporter(
      () => this.dashboardSink,
      () => {
        const filePath = this.resolveHistoryFilePath();
        return filePath
          ? { filePath, manager: this.outputHistoryManager }
          : undefined;
      },
      (target, message, severity) => {
        if (target.kind === FINAL_STEP_PHASES.QUEUE) {
          if (target.stepIndex === undefined) {
            throw new Error("Queue status message target requires stepIndex");
          }
          this._workflowStatusMessageEmitter.fire({
            stepIndex: target.stepIndex,
            message,
            severity,
          });
        } else {
          if (target.loopIndex === undefined) {
            throw new Error(
              "Final-step status message target requires loopIndex"
            );
          }
          this.outputCaptureBuffer.onFinalStepStatusMessage(
            target.loopIndex,
            message,
            severity
          );
        }
      },
      () => this.id
    );
    this.outputHistoryManager.setTokenTotalsChangedHandler(
      async (_historyFilePath, tokenTotals) => {
        this.promptQueue.setTokenTotals(tokenTotals);
        await this.promptQueue.updateWorkingFile(true);
      }
    );
    if (this.refreshHarnessUsage) {
      this.outputHistoryManager.setHarnessUsageRefreshHandler(
        this.refreshHarnessUsage
      );
    }

    this.endConditionEvaluator = new EndConditionEvaluator(
      this.platform,
      executionWorkspace
    );
    this.endConditionHandler = new EndConditionHandler(
      this.endConditionEvaluator,
      this.promptQueue,
      this.statusMessageReporter,
      this.userFeedbackSink
    );
    this.workflowExecutor = new WorkflowExecutor(
      this.promptQueue,
      this.endConditionHandler,
      this.endConditionEvaluator,
      this.platform,
      this.userFeedbackSink
    );
    this.promptFileLoader = new PromptFileLoader(
      this.promptFileParser,
      this.promptQueue,
      () => this.dashboardSink,
      (workflow) => this.analyzeWorkflowCompatibility(workflow),
      (diagnostics) => this.reportCompatibilityDiagnostics(diagnostics),
      this.userFeedbackSink,
      this.statusMessageReporter
    );
    this.promptFileWatcher = new PromptFileWatcher(
      this.promptQueue,
      () => this.dashboardSink
    );

    const bufferCallbacks: OutputCaptureCallbacks = {
      onPromptStart: (data) => this._promptStartEmitter.fire(data),
      onPromptComplete: (data) =>
        this._promptCompleteEmitter.fire({
          ...data,
          showCostEstimates: ConfigurationUtils.shouldShowCostEstimates(),
        }),
      onStatusMessage: (stepIndex, message, severity) =>
        this._workflowStatusMessageEmitter.fire({
          stepIndex,
          message,
          severity,
        }),
      getWorkflowStep: (stepIndex) =>
        this.promptQueue.getState().steps[stepIndex],
      getParallelGroupId: (stepIndex) =>
        this.promptQueue
          .getState()
          .parallelGroups.find(
            (group) =>
              stepIndex >= group.startIndex && stepIndex <= group.endIndex
          )?.id,
      getTotalSteps: () => this.promptQueue.getProgress().total,
    };
    this.outputCaptureBuffer = new OutputCaptureBuffer(
      `[inst:${this.id.slice(0, 8)}]`,
      bufferCallbacks
    );

    // Subscribe to queue state changes
    this.promptQueue.onDidChangeState(this.onQueueStateChanged.bind(this));
    this.workflowRuntime.onDidTransition(this.onRuntimeTransition.bind(this));
    this.workflowRuntime.onDidAttemptTransition(
      this.onAttemptTransition.bind(this)
    );
  }

  private async analyzeWorkflowCompatibility(
    workflow: PromptFile
  ): Promise<CompatibilityDiagnostic[]> {
    if (!this.compatibilityRegistry) {
      return [];
    }

    const workflowForAnalysis: PromptFile = {
      ...workflow,
      steps: workflow.steps ?? [],
    };
    const targets = enumerateCompatibilityTargets(
      workflowForAnalysis,
      (prompt, resolvedWorkflow) =>
        PropertyResolver.resolveTarget(prompt, resolvedWorkflow, {
          hostCanProvidePty: this.hostCanProvidePty,
        })
    );
    return analyzeCompatibility({
      workflow: workflowForAnalysis,
      executionTargets: targets,
      capabilities: await this.compatibilityRegistry.getSnapshot(),
      workspace: {
        workspaceRoot: this.workspaceFolderPath,
      },
    });
  }

  private async analyzePromptCompatibility(
    promptIndex: number,
    prompt: PromptStep,
    resolvedProperties: ResolvedProperties,
    imageFileRefs: readonly string[]
  ): Promise<readonly CompatibilityDiagnostic[]> {
    if (!this.compatibilityRegistry || imageFileRefs.length === 0) {
      return [];
    }

    const workflow = {
      ...this.promptQueue.getWorkflowFile(),
      steps: this.promptQueue.getWorkflowFile().steps ?? [],
    };
    const resolvedTarget = PropertyResolver.resolveTarget(prompt, workflow, {
      hostCanProvidePty: this.hostCanProvidePty,
    });
    const diagnostics = analyzeCompatibility({
      workflow,
      executionTargets: [
        {
          consumer:
            promptIndex < workflow.steps.length
              ? { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: promptIndex }
              : { kind: FINAL_STEP_PHASES.FINAL_STEP },
          resolved: { ...resolvedTarget, properties: resolvedProperties },
          imageFileRefs,
        },
      ],
      capabilities: await this.compatibilityRegistry.getSnapshot(),
      workspace: { workspaceRoot: this.workspaceFolderPath },
    });
    return diagnostics.filter(
      (diagnostic) =>
        diagnostic.capability === PROMPT_INPUT_CAPABILITY_KEYS.IMAGES
    );
  }

  private reportCompatibilityDiagnostics(
    diagnostics: readonly CompatibilityDiagnostic[],
    timestampMs?: number
  ): void {
    for (const diagnostic of diagnostics) {
      const key = JSON.stringify([
        diagnostic.code,
        diagnostic.harnessId,
        diagnostic.capability,
        diagnostic.message,
      ]);
      const stepIndex =
        diagnostic.consumer?.kind === FINAL_STEP_PHASES.QUEUE
          ? diagnostic.consumer.stepIndex
          : 0;
      const diagnosticTimestampMs = timestampMs ?? Date.now();
      this.statusMessageReporter.report(
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex },
        diagnostic.message,
        diagnostic.severity,
        {
          timestampMs: diagnosticTimestampMs,
          liveDedupeKey: key,
          persistDedupeKey: key,
        }
      );
    }
  }

  private async releaseTargetResources(
    target: WorkflowAttemptTarget
  ): Promise<void> {
    const targetKey = this.getExecutionTargetRunKey(target);
    const resource = this.activeTargetResources.get(targetKey);
    const processRunner =
      resource?.processRunner ?? this.targetScriptProcessRunners.get(targetKey);
    processRunner?.dispose();
    if (resource?.ptySessionId) {
      getPtyProcessManager()?.killSession(
        resource.ptySessionId,
        TERMINAL_END_REASONS.STEP_COMPLETE
      );
    }
    const integration = this.targetExecutionIntegrations.get(targetKey);
    if (integration) {
      integration.closeTerminalGracefully(TERMINAL_END_REASONS.STEP_COMPLETE);
      integration.dispose();
      this.targetExecutionIntegrations.delete(targetKey);
    }
    this.targetScriptProcessRunners.delete(targetKey);
    this.activeTargetResources.delete(targetKey);
  }

  private getCoordinationAddress(
    target: WorkflowAttemptTarget,
    parallelGroupId?: string
  ):
    | {
        workflowKey: WorkflowKey;
        runRef: RunRef;
        stepIndex?: number;
        parallelGroupId?: string;
      }
    | undefined {
    const state = this.promptQueue.getState();
    if (!state.workflowKey || !state.runRef) return undefined;
    const targetGroupId =
      target.kind === FINAL_STEP_PHASES.QUEUE
        ? state.parallelGroups.find(
            (candidate) =>
              target.stepIndex >= candidate.startIndex &&
              target.stepIndex <= candidate.endIndex
          )?.id
        : undefined;
    const resolvedParallelGroupId = parallelGroupId ?? targetGroupId;
    return {
      workflowKey: state.workflowKey,
      runRef: state.runRef,
      ...(target.kind === FINAL_STEP_PHASES.QUEUE
        ? { stepIndex: target.stepIndex }
        : {}),
      ...(resolvedParallelGroupId
        ? { parallelGroupId: resolvedParallelGroupId }
        : {}),
    };
  }

  private async closeCoordinationParticipant(
    target: WorkflowAttemptTarget
  ): Promise<void> {
    const address = this.getCoordinationAddress(target);
    if (!address) return;
    await new CoordinationParticipantRegistry(
      this.executionWorkspace.executionRoot
    ).closeRunParticipants(address);
  }

  private async releaseCoordinationGroupClaims(
    group: ParallelGroupDefinition
  ): Promise<void> {
    const address = this.getCoordinationAddress(
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: group.startIndex },
      group.id
    );
    if (!address) return;
    const registry = new CoordinationParticipantRegistry(
      this.executionWorkspace.executionRoot
    );
    await registry.releaseClaimsForGroup(address);
    // A sanitising MCP client may omit the member step index. At the join all
    // members are settled, so closing the whole group is then unambiguous.
    await registry.closeGroupParticipants(address);
  }

  private async cancelTarget(target: WorkflowAttemptTarget): Promise<void> {
    const targetKey = this.getExecutionTargetRunKey(target);
    const resource = this.activeTargetResources.get(targetKey);
    const processRunner =
      resource?.processRunner ?? this.targetScriptProcessRunners.get(targetKey);
    await processRunner?.cancel();
    if (resource?.ptySessionId) {
      getPtyProcessManager()?.killSession(
        resource.ptySessionId,
        TERMINAL_END_REASONS.STOPPED
      );
    }
    const integration =
      resource?.integration ?? this.targetExecutionIntegrations.get(targetKey);
    if (integration) {
      await integration.cancel();
    }
  }

  private reportMissingAssetWarning(
    missingDirectories: readonly string[]
  ): void {
    if (missingDirectories.length === 0) {
      return;
    }

    const message = `Workflow references missing exported assets: ${missingDirectories.join(
      ", "
    )}. Restore the sibling *.assets/ directory or use Save As to create a portable copy.`;
    const dedupeKey = this.getMissingAssetDedupeKey(missingDirectories);
    this.statusMessageReporter.report(
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      message,
      STATUS_MESSAGE_SEVERITY.WARNING,
      {
        liveDedupeKey: dedupeKey,
        persistDedupeKey: dedupeKey,
      }
    );
  }

  private getMissingAssetDedupeKey(
    missingDirectories: readonly string[]
  ): string {
    return JSON.stringify(missingDirectories);
  }

  private reportUnresolvedWorktreeVariables(
    placeholders: readonly string[],
    harnessId: HarnessId
  ): void {
    if (placeholders.length === 0) {
      return;
    }
    this.reportCompatibilityDiagnostics([
      {
        code: PROMPT_DIAGNOSTIC_CODES.VARIABLE_SUBSTITUTION_IGNORED,
        severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING,
        harnessId,
        capability: "variableSubstitution",
        state: {
          fidelity: CAPABILITY_FIDELITIES.PARTIAL,
          mechanism: CAPABILITY_MECHANISMS.NONE,
          verification: CAPABILITY_VERIFICATION_STATUSES.VERIFIED,
        },
        message:
          `Unresolved variable placeholders were left literal in worktree setup: ${placeholders.join(
            ", "
          )}. ` +
          "Define the variable in vars or remove the placeholder if it was intended as text.",
        remediation:
          "Define the variable in the workflow vars section or remove the placeholder if it was intended as text.",
      },
    ]);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  private getWorkflowPropertiesForDashboard(): Record<string, unknown> {
    const { prompt, steps, finalStep, ...workflowProperties } =
      this.promptQueue.getWorkflowFile();
    void prompt;
    void steps;
    void finalStep;
    return workflowProperties;
  }

  /**
   * Replay the full current state of this workflow to an explicit sink.
   * This bypasses the broadcast hub so only the provided sink receives the
   * messages — used for per-client
   * workflow switches in the hosted server.
   *
   * `asReplacement` marks a replay that *replaces* the client's displayed
   * workflow rather than re-sending the one it already shows. The webview
   * classifies an untagged SESSION_RESTORED by whether it carries a
   * `definitionRevision` (see core.instructions.md), so a replacement must
   * send none: it has no preceding address publish, and a revision there
   * would keep the outgoing workflow's view address alive on the client and
   * compare two unrelated lineages' revisions.
   */
  replayFullStateTo(
    sink: IDashboardSink,
    options?: { asReplacement?: boolean }
  ): void {
    const state = this.promptQueue.getState();
    const executionState = this.getAuthoritativeExecutionState();
    const fileName = this.currentPromptFile
      ? path.basename(this.currentPromptFile.filePath)
      : state.workflowName || DEFAULT_WORKFLOW_NAME;
    sink.updateSessionRestored(
      fileName,
      state.steps,
      state.results,
      executionState,
      state.currentIndex,
      state.workflowName || undefined,
      this.promptQueue.getWorkflowFile().finalStep ?? null,
      this.promptQueue.getFinalStepRuntime(),
      undefined,
      this.getWorkflowPropertiesForDashboard(),
      state.parallelGroups,
      this.getActiveStepIndices(),
      options?.asReplacement ? undefined : state.definitionRevision,
      this.promptFileLoader.getLastSchemaWarnings()
    );
    this.outputCaptureBuffer.replayTo(
      sink,
      { status: executionState, currentIndex: state.currentIndex },
      this.promptQueue.getFinalStepRuntime(),
      `[inst:${this.id.slice(0, 8)}]`,
      this.getActiveTargetKeys()
    );
  }

  /**
   * Replay only in-memory output that may be newer than the persisted timeline.
   * Addressed run switches already carry definition, runtime, and history in one
   * RUN_VIEW_LOADED snapshot, so emitting SESSION_RESTORED here would reset that
   * snapshot before the client could display it.
   */
  replayBufferedOutputTo(sink: IDashboardSink): void {
    const state = this.promptQueue.getState();
    this.outputCaptureBuffer.replayTo(
      sink,
      {
        status: this.getAuthoritativeExecutionState(),
        currentIndex: state.currentIndex,
      },
      this.promptQueue.getFinalStepRuntime(),
      `[inst:${this.id.slice(0, 8)}]`,
      this.getActiveTargetKeys()
    );
  }

  /** Release file-system watchers and child processes owned by this instance */
  dispose(): void {
    // Clear heartbeat interval (the finally block in startWorkflowExecution handles
    // releaseLock for normal termination; crash path is covered by staleness detection).
    this.runnerLockCoordinator.stopHeartbeat();
    this.stopStopRequestPolling();
    this.promptFileWatcher.dispose();
    this.endConditionEvaluator.dispose();
    // Close any lingering terminals from the last run and release references.
    for (const prev of this.lastRunIntegrations) {
      prev.closeTerminal(TERMINAL_END_REASONS.CLOSED);
    }
    this.lastRunIntegrations = [];
    // Dispose all live inject integrations held across runs (PTY still alive).
    for (const [harnessKey, integration] of this.liveInjectIntegrations) {
      void this.cleanupRetainedIntegrationArtifacts(harnessKey, integration);
      integration.dispose();
    }
    this.liveInjectIntegrations.clear();
    for (const integration of this.unkeyedExecutionIntegrations) {
      integration.closeTerminal(TERMINAL_END_REASONS.CLOSED);
      integration.dispose();
    }
    this.unkeyedExecutionIntegrations.clear();
    for (const integration of this.targetExecutionIntegrations.values()) {
      integration.closeTerminal(TERMINAL_END_REASONS.CLOSED);
      integration.dispose();
    }
    this.targetExecutionIntegrations.clear();
    for (const runner of this.targetScriptProcessRunners.values()) {
      runner.dispose();
    }
    this.targetScriptProcessRunners.clear();
    this.activeTargetResources.clear();
    if (this.activeWorktree) {
      this.worktreeManager.releaseRuntimeTrust(this.activeWorktree);
      this.activeWorktree = undefined;
    }
  }

  /**
   * End every terminal/integration retained from the previous run before a
   * different RunRef starts. Same-run append/continue deliberately does not
   * call this because its resumable session is part of that run's state.
   *
   * The retained-reservation release is awaited here rather than left to the
   * `onPtySessionEnded` callback. That callback is the *asynchronous* trigger —
   * it fires only once the graceful kill actually reaps the PTY, several
   * hundred ms later — while the caller (`seedAndExecuteAtRun`) goes straight
   * on to acquire this lineage's runner lock for the new run. Releasing here
   * makes the hand-off ordered instead of a race the incoming run can only win
   * by out-waiting the previous owner.
   */
  async closeRetainedTerminalsForFreshRun(): Promise<void> {
    for (const previous of this.lastRunIntegrations) {
      previous.closeTerminal(TERMINAL_END_REASONS.SUPERSEDED);
    }
    this.lastRunIntegrations = [];

    for (const [harnessKey, liveIntegration] of this.liveInjectIntegrations) {
      await this.cleanupRetainedIntegrationArtifacts(
        harnessKey,
        liveIntegration
      );
      liveIntegration.closeTerminalGracefully(TERMINAL_END_REASONS.SUPERSEDED);
      liveIntegration.dispose();
    }
    this.liveInjectIntegrations.clear();
    await this.releaseNamedWorktreeRetentionAfterPtyExit();
  }

  /**
   * Stop an active run and get its durable state onto disk.
   *
   * Ordering matters on the VS Code exit path: cancel the harness, flush
   * immediately, and only then allow a brief settle window. Flushing first is
   * what makes exit fast — the streamed output and working-file metadata are
   * the parts that must survive, and they are already written by the time we
   * wait on anything.
   *
   * The settle window is a small bonus, not a guarantee: if the run finishes
   * cancelling in time we persist its final aggregate and terminal status here.
   * Anything that misses it is repaired on the next startup by
   * `WorkflowLockManager.normalizeStaleLocks` plus
   * `OutputHistoryManager.recoverInterruptedRun`.
   *
   * A PAUSED run is never stopped here: nothing is in flight, and the user's
   * deliberate pause must survive the restart. Its runner lock is left for
   * startup normalization, which removes it without touching the paused state.
   *
   * Ordinary view disposal remains synchronous.
   */
  async shutdown(): Promise<void> {
    const status = this.workflowRuntime.status;
    const preservePausingWorktree =
      Boolean(this.executionWorkspace.worktree) &&
      status === EXECUTION_STATES.PAUSING;
    if (
      (status === EXECUTION_STATES.RUNNING ||
        status === EXECUTION_STATES.PAUSING) &&
      !preservePausingWorktree
    ) {
      await this.stop().catch((error) =>
        Log.warn(
          `[inst:${this.id.slice(0, 8)}] Failed to request stop during shutdown:`,
          error
        )
      );
    }

    await this.flushDurableState();

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.executionSettledPromise,
      new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(
          resolve,
          WorkflowInstance.SHUTDOWN_SETTLE_TIMEOUT_MS
        );
      }),
    ]);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    // Persist whatever the settle window produced (final aggregate, terminal status).
    await this.flushDurableState();
  }

  /**
   * The manifest this instance's history/timeline writes belong to.
   *
   * `activeHistoryFilePath` is only assigned by `startWorkflowExecution`, so it
   * is empty on an instance that was restored from a working file rather than
   * started here — exactly the shape a host restart leaves behind for a run that
   * was paused when the previous host died. Every history writer early-returns on
   * an empty path, so without this fallback a resumed run executes to completion
   * while `manifest.json` stays frozen at whatever the dead process last wrote,
   * and the run panel (which lists from manifests) disagrees with the header
   * (which reads the run's `workflow.ctrlyoke.json`) forever after.
   *
   * The queue's own `workflowKey`/`runRef` are restored with the working file and
   * identify the run's manifest exactly, so derive from them. A draft has no
   * `runRef` yet and correctly resolves to "" — it has no manifest to write to.
   */
  private resolveHistoryFilePath(): string {
    if (this.activeHistoryFilePath) {
      return this.activeHistoryFilePath;
    }
    const { workflowKey, runRef } = this.promptQueue.getState();
    if (!workflowKey || !runRef) {
      return "";
    }
    return this.outputHistoryManager.getHistoryFilePath(workflowKey, runRef);
  }

  /** Write pending history/working-file state for this instance. */
  private async flushDurableState(): Promise<void> {
    await this.pendingRuntimeTransitionHistoryWrite;
    await this.outputHistoryManager.flushPendingWrites(
      this.resolveHistoryFilePath() || undefined
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Status / summary
  // ─────────────────────────────────────────────────────────────────────────

  getQueueState(): QueueState {
    return this.promptQueue.getState();
  }

  /** Runtime-only state that can be newer than the addressed working file. */
  getRunViewLiveState() {
    const state = this.promptQueue.getState();
    return {
      executionState: this.getAuthoritativeExecutionState(),
      currentIndex: state.currentIndex,
      steps: state.steps,
      results: state.results,
      parallelGroups: state.parallelGroups,
      finalStep: this.promptQueue.getWorkflowFile().finalStep ?? null,
      finalStepRuntime: this.promptQueue.getFinalStepRuntime(),
      workflowProperties: this.getWorkflowPropertiesForDashboard(),
      schemaWarnings: this.promptFileLoader.getLastSchemaWarnings(),
    };
  }

  /** Filesystem root whose coordination board belongs to this instance. */
  getExecutionRoot(): string {
    return this.executionWorkspace.executionRoot;
  }

  getSummary(): WorkflowSummary {
    const state = this.promptQueue.getState();
    const executionTimeUpdatedAt = Date.now();
    const finalStepSummary = deriveWorkflowFinalStepSummary(
      this.promptQueue.getWorkflowFile().finalStep,
      this.promptQueue.getFinalStepRuntime()
    );
    const workflowHarness =
      this.currentPromptFile?.promptFile?.harness ??
      this.promptQueue.getWorkflowFile().harness;
    const harness = PropertyResolver.resolveHarnessValue(
      undefined,
      workflowHarness
    );
    return {
      id: this.id,
      workflowKey: state.workflowKey,
      runRef: state.runRef,
      workflowName: this.workflowName || state.workflowName || "",
      filePath: this.filePath,
      workingFilePath: state.workingFilePath || undefined,
      executionState: this.getAuthoritativeExecutionState(),
      currentStep: state.currentIndex,
      totalSteps: state.steps.length,
      startedAt: this.startedAt || undefined,
      executionTimeMs: this.workflowRuntime.getActiveExecutionTime(),
      executionTimeUpdatedAt,
      harness,
      ...finalStepSummary,
      worktree: this.activeWorktree
        ? ({
            branchName: this.activeWorktree.branchName,
            worktreePath: this.activeWorktree.worktreePath,
          } satisfies Pick<
            WorktreeRunProjection,
            "branchName" | "worktreePath"
          >)
        : undefined,
      tokenTotals: state.tokenTotals,
    };
  }

  getCurrentPromptFile(): { fileName: string; steps: unknown[] } | null {
    if (!this.currentPromptFile?.promptFile.steps) {
      return null;
    }
    return {
      fileName: path.basename(this.currentPromptFile.filePath),
      steps: this.currentPromptFile.promptFile.steps.map((p) => ({
        prompt: isScriptStep(p) ? p.script : p.prompt,
      })),
    };
  }

  /** Internal accessor used by WorkflowOrchestrator for openCurrentPromptFile */
  getCurrentPromptFilePath(): string | undefined {
    return this.currentPromptFile?.filePath;
  }

  /**
   * Keep the in-memory prompt file aligned with the queue after dashboard/appends.
   * This avoids relying on the working-file watcher for local writes, which is
   * intentionally muted in idle/completed states to preserve the dashboard view.
   */
  private syncCurrentPromptFileFromQueue(filePathOverride?: string): void {
    const nextFilePath =
      filePathOverride ??
      this.currentPromptFile?.filePath ??
      this.promptQueue.getState().workingFilePath;

    if (!nextFilePath) {
      return;
    }

    const workflowFile = this.promptQueue.getWorkflowFile();
    this.currentPromptFile = {
      filePath: nextFilePath,
      promptFile: {
        ...workflowFile,
        steps: this.promptQueue.getState().steps.map((prompt) => ({
          ...prompt,
        })),
      },
    };
  }

  async readWorkingFile(workingFilePath: string): Promise<WorkingFile> {
    return this.promptQueue.readWorkingFile(workingFilePath);
  }

  getOutputHistoryManager(): OutputHistoryManager {
    return this.outputHistoryManager;
  }

  /** The RunRef this instance is currently executing, if any (undefined while idle). */
  getExecutionRunRef(): RunRef | undefined {
    return this.executionRunRef;
  }

  /** Whether this resident instance still owns its lineage runner lock. */
  ownsRunnerLock(): boolean {
    return this.runnerLockCoordinator.ownsLock();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // File loading
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Load a prompt file into the dashboard without executing.
   */
  async loadPromptFile(filePath: string): Promise<boolean> {
    // Clear queue to reset cached workflow name — ensures fresh name from filename
    this.promptQueue.clearQueue();
    // Track the source file path for summaries and state sync
    this.filePath = filePath;
    this.sourceDefinitionPath = filePath;

    const workingFilePath = await this.promptFileLoader.loadPromptFile(
      filePath,
      this.workspaceFolderPath
    );

    if (!workingFilePath) {
      this.propagateWorkflowNameToIntegrations();
      return false;
    }

    const promptFile = await this.promptFileParser.parsePromptFile(filePath);
    if (!promptFile) {
      this.propagateWorkflowNameToIntegrations();
      return false;
    }

    this.currentPromptFile = { filePath, promptFile };
    this.setupPromptFileWatcher(workingFilePath);
    this.propagateWorkflowNameToIntegrations();
    return true;
  }

  /**
   * Load an already-substituted template workflow into the dashboard without
   * executing. There is no source file on disk — the working file created
   * here is the only artifact, with `originalFile` left undefined so Save As
   * is the only way to export a durable copy.
   */
  async loadFromTemplate(
    promptFile: PromptFile,
    displayName: string
  ): Promise<void> {
    this.promptQueue.clearQueue();
    this.filePath = displayName;
    this.sourceDefinitionPath = undefined;

    const workingFilePath = await this.promptFileLoader.loadFromMemory(
      promptFile,
      displayName,
      this.workspaceFolderPath
    );

    if (workingFilePath) {
      this.currentPromptFile = { filePath: displayName, promptFile };
      this.setupPromptFileWatcher(workingFilePath);
    }

    this.propagateWorkflowNameToIntegrations();
  }

  /**
   * Load an inline prompt string into the queue without a file.
   * Behaves like loading a single-prompt .prompt.md file.
   */
  loadPromptString(
    promptText: string,
    workflowOverrides?: Partial<PromptFile>
  ): void {
    this.promptQueue.clearQueue();
    this.filePath = "";
    this.sourceDefinitionPath = undefined;
    const promptFile: PromptFile = {
      steps: [{ prompt: promptText }],
      ...workflowOverrides,
    };
    this.currentPromptFile = { filePath: "<inline>", promptFile };
    this.promptQueue.loadPrompts(promptFile);
    this.propagateWorkflowNameToIntegrations();
  }

  /**
   * Load an inline prompt into a persisted, single-step workflow run.
   * An existing lineage key may be supplied when the caller owns a durable
   * pointer to the lineage; otherwise the normal creation path mints one.
   * Workflow overrides are intentionally in-memory only; the working file
   * stores the prompt step and lineage/runtime metadata.
   */
  async loadPromptStringAsRun(
    promptText: string,
    nameHint: string,
    workflowOverrides?: Partial<PromptFile>,
    lineageOptions?: WorkflowLineageCreationOptions
  ): Promise<void> {
    this.promptQueue.clearQueue();
    this.filePath = "";
    this.sourceDefinitionPath = undefined;
    const promptFile: PromptFile = {
      steps: [{ prompt: promptText }],
      ...workflowOverrides,
    };

    const workspaceFolderPath =
      this.workspaceFolderPath ?? this.platform.getWorkspaceRoot();
    const workingFilePath = workspaceFolderPath
      ? await this.promptQueue.createWorkingFile(
          nameHint,
          promptFile.steps ?? [],
          workspaceFolderPath,
          undefined,
          lineageOptions,
          promptFile.parallelGroups
        )
      : undefined;

    this.currentPromptFile = { filePath: "<inline>", promptFile };
    this.promptQueue.loadPrompts(promptFile, workingFilePath);
    this.propagateWorkflowNameToIntegrations();
  }

  /** Set ephemeral addresses used while expanding a built-in MCP skill. */
  setMcpToolSkillContext(context?: Partial<McpToolSkillRunContext>): void {
    this.mcpToolSkillContext = context;
  }

  /**
   * Restore a workflow from a working file.
   * Shared helper used by resumeWorkflow and loadWorkingFile.
   */
  async restoreWorkflowFromWorkingFile(workingFilePath: string): Promise<void> {
    // Read working file FIRST so this.filePath is correct when queue state fires
    // (onDidChangeState → getSummary() → filePath must already be set)
    const workingFile = await this.promptQueue.readWorkingFile(workingFilePath);
    const originalFile = await this.readLineageOriginalFile(workingFilePath);
    if (workingFile?.steps) {
      const filePath = originalFile || workingFilePath;
      this.filePath = filePath;
      this.sourceDefinitionPath = originalFile;
      this.currentPromptFile = {
        filePath,
        promptFile: {
          steps: workingFile.steps,
          parallelGroups: workingFile.parallelGroups,
        },
      };
    }

    await this.promptFileLoader.reloadFromWorkingFile(
      workingFilePath,
      "replace",
      true,
      this.workspaceFolderPath
    );
    const restoredState = this.promptQueue.getState();
    if (restoredState.workflowKey && restoredState.runRef) {
      await this.outputHistoryManager.hydrateTokenTotals(
        this.outputHistoryManager.getHistoryFilePath(
          restoredState.workflowKey,
          restoredState.runRef
        )
      );
    }
    await this.hydrateActiveExecutionOutputCaches();

    this.setupPromptFileWatcher(workingFilePath);
    this.propagateWorkflowNameToIntegrations();
  }

  /**
   * Load a working file by path (used by WorkflowOrchestrator.loadWorkingFile).
   */
  async loadWorkingFile(filePath: string): Promise<void> {
    try {
      await this.restoreWorkflowFromWorkingFile(filePath);
      Log.info(`[WorkflowInstance] Loaded workflow: ${filePath}`);
    } catch (loadError) {
      Log.error(
        "[WorkflowInstance] Failed to load workflow:",
        loadError as Error
      );
      notifyUserFeedback(
        this.userFeedbackSink,
        "error",
        `Failed to load workflow: ${getErrorMessage(loadError)}`
      );
      throw loadError;
    }
  }

  /**
   * Auto-load from working file without triggering auto-start
   * (called by triggerAutoLoad in orchestrator).
   */
  async autoLoadFromWorkingFile(workingFilePath: string): Promise<void> {
    // Read working file FIRST so this.filePath is correct when queue state fires
    const workingFile = await this.promptQueue.readWorkingFile(workingFilePath);
    const originalFile = await this.readLineageOriginalFile(workingFilePath);
    if (workingFile?.steps) {
      const filePath = originalFile || workingFilePath;
      this.filePath = filePath;
      this.sourceDefinitionPath = originalFile;
      this.currentPromptFile = {
        filePath,
        promptFile: {
          steps: workingFile.steps,
          parallelGroups: workingFile.parallelGroups,
        },
      };
    }

    await this.promptFileLoader.reloadFromWorkingFile(
      workingFilePath,
      "replace",
      true,
      this.workspaceFolderPath
    );
    const autoLoadedState = this.promptQueue.getState();
    if (autoLoadedState.workflowKey && autoLoadedState.runRef) {
      await this.outputHistoryManager.hydrateTokenTotals(
        this.outputHistoryManager.getHistoryFilePath(
          autoLoadedState.workflowKey,
          autoLoadedState.runRef
        )
      );
    }
    await this.hydrateActiveExecutionOutputCaches();

    this.setupPromptFileWatcher(workingFilePath);
    this.propagateWorkflowNameToIntegrations();
  }

  /**
   * Rebuild the small in-memory response cache required by a resumed active
   * executor. Historical/inactive views never hydrate this cache; they read
   * timeline data through their own resolver consumers instead.
   */
  private async hydrateActiveExecutionOutputCaches(): Promise<void> {
    const state = this.promptQueue.getState();
    const activeExecutionStates: QueueState["status"][] = [
      EXECUTION_STATES.RUNNING,
      EXECUTION_STATES.PAUSED,
      EXECUTION_STATES.PAUSING,
      EXECUTION_STATES.CANCELLING,
    ];
    if (
      !state.workflowKey ||
      !state.runRef ||
      !activeExecutionStates.includes(state.status)
    ) {
      return;
    }

    const manifestPath = this.outputHistoryManager.getHistoryFilePath(
      state.workflowKey,
      state.runRef
    );
    const resolver = this.outputHistoryManager.getRunOutputResolver();
    const queueTargets: OutputExecutionTarget[] = Array.from(
      { length: Math.min(state.currentIndex, state.steps.length) },
      (_, stepIndex) => ({ kind: FINAL_STEP_PHASES.QUEUE, stepIndex })
    );
    try {
      const [queueAttempts, finalStepAttempts] = await Promise.all([
        resolver.resolveLatestAttempts(manifestPath, queueTargets),
        resolver.resolveLatestFinalStepAttempts(manifestPath),
      ]);
      const queueEntries = [...queueAttempts.values()].flatMap((attempt) =>
        attempt.target.kind === FINAL_STEP_PHASES.QUEUE
          ? [
              {
                stepIndex: attempt.target.stepIndex,
                responseText: attempt.responseText,
                scriptOutput: attempt.scriptOutput,
              },
            ]
          : []
      );
      const finalStepResponseTexts = new Map<number, string>();
      for (const attempt of finalStepAttempts.values()) {
        if (
          attempt.target.kind === FINAL_STEP_PHASES.FINAL_STEP &&
          attempt.responseText !== undefined
        ) {
          finalStepResponseTexts.set(
            attempt.target.loopIndex,
            attempt.responseText
          );
        }
      }
      this.promptQueue.hydrateActiveRuntimeOutputCache(
        queueEntries,
        finalStepResponseTexts
      );
    } catch (error) {
      Log.warn(
        `[inst:${this.id.slice(0, 8)}] Failed to hydrate active output cache from timeline:`,
        error
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Execution
  // ─────────────────────────────────────────────────────────────────────────

  private createWorkflowStartupPipelinePort(): WorkflowStartupPipelinePort {
    return {
      id: this.id,
      platform: this.platform,
      workspaceFolderPath: this.workspaceFolderPath,
      dashboardSink: this.dashboardSink,
      userFeedbackSink: this.userFeedbackSink,
      queue: this.promptQueue,
      history: this.outputHistoryManager,
      status: this.statusMessageReporter,
      failRuntime: () => {
        this.workflowRuntime.fail();
      },
      getDetectorIntegration: (harnessOverride) =>
        this.getDetectorIntegration(harnessOverride),
      analyzeWorkflowCompatibility: (workflow) =>
        this.analyzeWorkflowCompatibility(workflow),
      approveSecretGrants: this.approveSecretGrants,
      getHarnessUsageSnapshots: this.getHarnessUsageSnapshots,
      hostCanProvidePty: this.hostCanProvidePty,
      execution: {
        currentPromptFile: () => this.currentPromptFile,
        getAuthoritativeExecutionState: () =>
          this.getAuthoritativeExecutionState(),
        closeRetainedTerminalsForFreshRun: () =>
          this.closeRetainedTerminalsForFreshRun(),
        syncCurrentPromptFileFromQueue: (filePath) =>
          this.syncCurrentPromptFileFromQueue(filePath),
        setExecutionRunRef: (runRef) => {
          this.executionRunRef = runRef;
        },
        clearOutputBuffers: () => this.clearOutputBuffers(),
        prepareExecutionWorktree: (historyFilePath) =>
          this.prepareExecutionWorktree(historyFilePath),
        createIntegrationForMode: (modeOverride) =>
          this.createIntegrationForMode(modeOverride),
        startWorkflowExecution: (
          integration,
          historyFilePath,
          workingFilePath,
          targetRunIndices
        ) =>
          this.startWorkflowExecution(
            integration,
            historyFilePath,
            workingFilePath,
            targetRunIndices
          ),
        reportMissingAssetWarning: (missingDirectories) =>
          this.reportMissingAssetWarning(missingDirectories),
        getMissingAssetDirectories: () =>
          this.promptFileLoader.getLastMissingAssetDirectories(),
        getMissingAssetDedupeKey: (missingDirectories) =>
          this.getMissingAssetDedupeKey(missingDirectories),
        getDefinitionRevisionContext: () => this.getDefinitionRevisionContext(),
        getResolvedHistoryFilePath: () => this.resolveHistoryFilePath(),
        getActiveHistoryFilePath: () => this.activeHistoryFilePath,
        setActiveHistoryFilePath: (filePath) => {
          this.activeHistoryFilePath = filePath;
        },
        startPending: () => this.startPending,
        reportCompatibilityDiagnostics: (diagnostics) =>
          this.reportCompatibilityDiagnostics(diagnostics),
        cacheHistoricalStepOutput: (stepIndex, outputs, retry) =>
          this.outputCaptureBuffer.cacheHistoricalStepOutput(
            stepIndex,
            [...outputs],
            retry
          ),
        getStepBufferSize: () => this.outputCaptureBuffer.stepBufferSize,
        computeTargetRunIndices: (historyFilePath, isContinuation) =>
          this.computeTargetRunIndices(historyFilePath, isContinuation),
        warnBeforeWorkflowStart: (
          queueState,
          workflow,
          modeOverride,
          restartFromBeginning
        ) =>
          this.warnBeforeWorkflowStart(
            queueState,
            workflow,
            modeOverride,
            restartFromBeginning
          ),
        describeExecutionFailure: (error) =>
          this.describeExecutionFailure(error),
        context: this.createWorkflowStartupContextPort(),
        lifecycle: this.createWorkflowStartupLifecyclePort(),
      },
      worktree: {
        getResolution: () => this.worktreeResolution,
        setResolution: (resolution) => {
          this.worktreeResolution = resolution;
        },
        getActiveWorktree: () => this.activeWorktree,
        clearActiveWorktree: () => {
          this.activeWorktree = undefined;
        },
        getExecutionLease: () => this.executionLease,
        clearExecutionLease: () => {
          this.executionLease = undefined;
        },
        manager: this.worktreeManager,
        ensureRunnerLock: (workingFilePath) =>
          this.ensureRunnerLock(workingFilePath),
        releaseRunnerLock: () => this.releaseRunnerLock(),
      },
    };
  }

  private createWorkflowStartupOutputContext(): Pick<
    WorkflowStartupContextPort,
    | "captureOutputInit"
    | "captureChunk"
    | "captureEvents"
    | "captureContextWindow"
    | "getBufferedOutput"
    | "captureCompletedOutput"
    | "captureFinalStepOutputInit"
    | "beginSessionActivityTargetCapture"
    | "captureFinalStepChunk"
    | "captureFinalStepEvents"
    | "getFinalStepBufferedOutput"
    | "captureFinalStepCompletedOutput"
    | "onFinalStepStatusMessage"
    | "onStatusMessage"
    | "onTargetStreamingEvents"
    | "onTargetStreamingChunk"
    | "onScriptOutput"
    | "onScriptCompletedOutput"
    | "snapshotService"
    | "onSnapshotCaptured"
  > {
    return {
      captureOutputInit: (
        stepIndex,
        prompt,
        cliCommand,
        cliCommandWasInjected,
        workingDirectory,
        timestampMs,
        attemptIndex,
        rawTextOutput,
        runIndex
      ) => {
        this.outputCaptureBuffer.captureOutputInit(
          stepIndex,
          prompt,
          cliCommand,
          cliCommandWasInjected,
          workingDirectory,
          timestampMs,
          attemptIndex,
          rawTextOutput,
          runIndex
        );
      },
      captureChunk: (stepIndex, chunk) => {
        this.outputCaptureBuffer.captureChunk(stepIndex, chunk);
      },
      captureEvents: (stepIndex, events) => {
        this.outputCaptureBuffer.captureEvents(stepIndex, events);
      },
      captureContextWindow: (stepIndex, used, size) => {
        this.outputCaptureBuffer.captureContextWindow(stepIndex, used, size);
      },
      getBufferedOutput: (stepIndex) => {
        return this.outputCaptureBuffer.getBufferedOutput(stepIndex);
      },
      captureCompletedOutput: (stepIndex, output, integration) => {
        this.outputCaptureBuffer.captureCompletedOutput(stepIndex, output);
        if (integration) {
          this.recordCompletedActivityTarget(
            { kind: FINAL_STEP_PHASES.QUEUE, stepIndex },
            output.runIndex ?? 0,
            output.attemptIndex ?? 0,
            integration
          );
        }
      },
      captureFinalStepOutputInit: (
        loopIndex,
        prompt,
        cliCommand,
        cliCommandWasInjected,
        workingDirectory,
        timestampMs,
        attemptIndex,
        rawTextOutput,
        runIndex
      ) => {
        this.outputCaptureBuffer.captureFinalStepOutputInit(
          loopIndex,
          prompt,
          cliCommand,
          cliCommandWasInjected,
          workingDirectory,
          timestampMs,
          attemptIndex,
          rawTextOutput,
          runIndex
        );
      },
      beginSessionActivityTargetCapture: (integration, target) =>
        this.beginActivityTargetCapture(integration, target),
      captureFinalStepChunk: (loopIndex, chunk) => {
        this.outputCaptureBuffer.captureFinalStepChunk(loopIndex, chunk);
      },
      captureFinalStepEvents: (loopIndex, events) => {
        this.outputCaptureBuffer.captureFinalStepEvents(loopIndex, events);
      },
      getFinalStepBufferedOutput: (loopIndex) => {
        return this.outputCaptureBuffer.getFinalStepBufferedOutput(loopIndex);
      },
      captureFinalStepCompletedOutput: (loopIndex, output, integration) => {
        this.outputCaptureBuffer.captureFinalStepCompletedOutput(
          loopIndex,
          output
        );
        if (integration) {
          this.recordCompletedActivityTarget(
            { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex },
            output.runIndex ?? 0,
            output.attemptIndex ?? 0,
            integration
          );
        }
      },
      onFinalStepStatusMessage: (loopIndex, message, severity) => {
        this.outputCaptureBuffer.onFinalStepStatusMessage(
          loopIndex,
          message,
          severity
        );
      },
      onStatusMessage: (stepIndex, message, severity) => {
        this._workflowStatusMessageEmitter.fire({
          stepIndex,
          message,
          severity,
        });
      },
      onTargetStreamingEvents: (data) =>
        this._targetedStreamingEventsEmitter.fire(data),
      onTargetStreamingChunk: (data) =>
        this._targetedStreamingChunkEmitter.fire(data),
      onScriptOutput: (target, output) =>
        this._targetedScriptOutputEmitter.fire({ target, output }),
      onScriptCompletedOutput: (target, output) =>
        this._targetedScriptOutputEmitter.fire({ target, output }),
      snapshotService: new WorkspaceSnapshotService(),
      onSnapshotCaptured: (target, snapshot) => {
        this.dashboardSink?.sendStepUndoDataUpdated(
          target as UndoExecutionTarget,
          snapshot
        );
      },
    };
  }

  private createWorkflowStartupContextPort(): WorkflowStartupContextPort {
    const instance = this;
    return {
      get executionWorkspace() {
        return instance.executionWorkspace;
      },
      workspaceFolderPath: this.workspaceFolderPath,
      hostCanProvidePty: this.hostCanProvidePty,
      supportsConcurrentInteractiveSessions:
        this.supportsConcurrentInteractiveSessions,
      get namedWorkspaceRoots() {
        return instance.executionWorkspace.namedWorkspaceRoots;
      },
      get currentPromptFilePath() {
        return instance.currentPromptFile?.filePath;
      },
      get sourceDefinitionPath() {
        return instance.sourceDefinitionPath;
      },
      statusReporter: this.statusMessageReporter,
      reportCompatibilityDiagnostics: (diagnostics, timestampMs) =>
        this.reportCompatibilityDiagnostics(diagnostics, timestampMs),
      analyzeCompatibilityForPrompt: (
        promptIndex,
        prompt,
        resolvedProperties,
        imageFileRefs
      ) =>
        this.analyzePromptCompatibility(
          promptIndex,
          prompt,
          resolvedProperties,
          imageFileRefs
        ),
      get shouldShowCliCommand() {
        return instance.shouldShowCliCommand();
      },
      get dynamicQueueConfig() {
        return instance.getDynamicQueueConfig();
      },
      getScriptProcessRunner: (target) => this.getScriptProcessRunner(target),
      ensureHarnessReady: (harnessId) =>
        this.getHarnessReadinessError(harnessId),
      registerActiveTarget: (target, attemptIndex) =>
        this.registerActiveTarget(target, attemptIndex),
      registerTargetPtySession: (target, sessionId) =>
        this.registerTargetPtySession(target, sessionId),
      clearTargetPtySession: (target) => this.clearTargetPtySession(target),
      unregisterActiveTarget: (target) => this.unregisterActiveTarget(target),
      cancelTarget: (target) => this.cancelTarget(target),
      releaseTargetResources: (target) => this.releaseTargetResources(target),
      closeCoordinationParticipant: (target) =>
        this.closeCoordinationParticipant(target),
      releaseCoordinationGroupClaims: (group) =>
        this.releaseCoordinationGroupClaims(group),
      releaseConflictingAiSession: (aiSessionId, requester) =>
        this.releaseConflictingAiSession(aiSessionId, requester),
      outputHistoryManager: this.outputHistoryManager,
      ...this.createWorkflowStartupOutputContext(),
      getDefinitionRevisionContext: () => this.getDefinitionRevisionContext(),
      getSecretRedactor: () => this.activeRunRedactor,
      getMcpToolSkillContext: () => this.mcpToolSkillContext,
      createPriorContextResolver: (historyFilePath) =>
        createPriorContextResolver({
          workspaceRoot:
            this.workspaceFolderPath ?? this.platform.getWorkspaceRoot(),
          historyFilePath,
          outputResolver: this.outputHistoryManager.getRunOutputResolver(),
        }),
      getDashboardProvider: () => this.dashboardSink,
      createIntegrationForMode: (harnessOverride, target, properties) =>
        this.createIntegrationForMode(harnessOverride, target, properties),
      getSequentialIntegrationKey: (properties) =>
        this.getSequentialIntegrationKey(properties),
      registerTargetIntegration: (target, integration) =>
        this.registerTargetIntegration(target, integration),
      isTargetInParallelGroup: (target) =>
        target.kind === FINAL_STEP_PHASES.QUEUE &&
        this.promptQueue
          .getState()
          .parallelGroups.some(
            (group) =>
              target.stepIndex >= group.startIndex &&
              target.stepIndex <= group.endIndex
          ),
      getHarnessReadinessError: (harnessId) =>
        this.getHarnessReadinessError(harnessId),
      platform: this.platform,
      isCli: isCli(),
      instanceTag: `[inst:${this.id.slice(0, 8)}]`,
      instanceId: this.id,
      spawnScriptPty: isCli()
        ? undefined
        : (options) => this.spawnScriptPty(options),
    };
  }
  private createWorkflowStartupLifecyclePort(): WorkflowStartupLifecyclePort {
    return {
      isStartPending: () => this.startPending,
      beginExecution: (historyFilePath) => {
        this.startPending = true;
        // An executing run cannot have a pending continuation.
        this.promptQueue.clearPendingRewind();
        this.executionSettledPromise = new Promise<void>((resolve) => {
          this.resolveExecutionSettled = resolve;
        });
        this.startedAt = Date.now();
        this.activeHistoryFilePath = historyFilePath;
        this.activeRunRedactor = new RunSecretRedactor();
        this.releaseActiveRunRedactor?.();
        this.releaseActiveRunRedactor = secretRedactionService.register(
          this.activeRunRedactor
        );
        for (const previous of this.lastRunIntegrations) {
          previous.closeTerminal(TERMINAL_END_REASONS.SUPERSEDED);
        }
        this.lastRunIntegrations = [];
      },
      getRunIdentity: () => {
        const state = this.promptQueue.getState();
        this.executionRunRef = state.runRef;
        return {
          workflowKey: state.workflowKey,
          runRef: state.runRef,
          lockWorkspaceRoot:
            this.workspaceFolderPath ?? this.platform.getWorkspaceRoot(),
        };
      },
      acquireExecutionLease: async (
        workflowKey,
        runRef,
        _lockWorkspaceRoot,
        workingFilePath
      ) => {
        if (workingFilePath && !this.executionLease) {
          this.executionLease = await ExecutionRootLeaseManager.acquireLease({
            mode: "shared-native",
            pid: process.pid,
            runner: isCli() ? RUNNER_IDS.CLI : RUNNER_IDS.VSCODE,
            instanceId: this.id,
            stateRoot: this.executionWorkspace.stateRoot,
            executionRoot: this.executionWorkspace.executionRoot,
            workflowKey,
            runRef,
          });
        }
      },
      ownsExecutionReservation: () =>
        this.runnerLockCoordinator.ownsLock() ||
        this.executionLease !== undefined,
      startRunnerLockHeartbeat: (workspaceRoot, workflowKey) =>
        this.startRunnerLockHeartbeat(workspaceRoot, workflowKey),
      restoreRetainedIntegrations: () =>
        this.restoreRetainedExecutionIntegrations(),
      executeWorkflow: (integration, context) =>
        this.workflowExecutor.execute(integration, context),
      settleExecution: (options) => this.settleWorkflowExecution(options),
    };
  }

  /**
   * Executes a run already allocated and written by `WorkingFileManager.seedNewRun`
   * (Re-run / CLI `rerun`) — a brand-new `RunRef` whose definition was seeded from an
   * older run that is not necessarily the one this instance currently has loaded.
   *
   * This is deliberately NOT `loadWorkingFile(...)` followed by a plain
   * `executeLoadedPromptFile(harnessOverride)` call: that method's fresh-execution-start
   * branch has no way to tell "this run was already promoted" from "this is a draft/older
   * run that still needs promoting" — it would call `promptQueue.promoteToNewRun()` again
   * (minting a second, unwanted run) and would skip initializing the seeded run's
   * manifest/events (violating the invariant that every promoted run has all three run
   * artifacts). Instead: load the seeded file, initialize ITS timeline directly, then
   * execute with `continueFromCurrent=true` so `executeLoadedPromptFile` treats it purely
   * as "run exactly what's loaded" — no restart, no re-promotion.
   */
  async executeSeededRun(
    seeded: {
      workingFilePath: string;
      sourceRunRef: RunRef;
      runRef: RunRef;
      runId: number;
      runDir: string;
      stagingRunDir: string;
      stagingWorkingFilePath: string;
      allocation: import("./orchestration/WorkflowLineageRepository").AllocatedRun;
      startedAt: number;
    },
    workflowKey: WorkflowKey,
    harnessOverride?: HarnessId,
    onPrepared?: () => Promise<void>
  ): Promise<void> {
    await this.closeRetainedTerminalsForFreshRun();
    await this.loadWorkingFile(seeded.workingFilePath);
    const historyInit = await this.outputHistoryManager.initializeRunAt(
      workflowKey,
      seeded.runRef,
      seeded.runDir,
      seeded.runId,
      seeded.startedAt,
      [seeded.sourceRunRef],
      this.getDefinitionRevisionContext().definition
    );
    if (!historyInit.filePath) {
      throw new Error(
        `Failed to initialize timeline for seeded run ${workflowKey}/${seeded.runRef}`
      );
    }
    await onPrepared?.();
    await this.executeLoadedPromptFile(
      harnessOverride,
      false,
      historyInit.filePath,
      true
    );
  }

  /**
   * Bind and execute one already-promoted run as an explicit continuation.
   * Callers must have already validated that this is the lineage's permitted
   * execution target; this method never discovers a "latest" run.
   */
  async executeContinuationAtRun(
    workflowKey: WorkflowKey,
    runRef: RunRef,
    expectedDefinitionRevision: number,
    onPrepared?: () => Promise<void>
  ): Promise<void> {
    const workspaceRoot =
      this.workspaceFolderPath ?? this.platform.getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error("No workspace folder is open");
    }
    const workingFilePath = WorkflowPaths.runFilePath(
      workspaceRoot,
      workflowKey,
      runRef
    );

    // Binding is intentionally done only here, as part of an explicit action.
    await this.loadWorkingFile(workingFilePath);
    const state = this.promptQueue.getState();
    if (state.workflowKey !== workflowKey || state.runRef !== runRef) {
      throw new Error("Continuation target did not bind to the requested run");
    }
    assertDefinitionRevision(
      expectedDefinitionRevision,
      state.definitionRevision
    );
    await onPrepared?.();

    const historyFilePath = this.outputHistoryManager.getHistoryFilePath(
      workflowKey,
      runRef
    );
    await this.prepareFinalStepContinuation(historyFilePath);
    // Commit before reopening: a newer definition must have its immutable
    // snapshot in events.jsonl before any continuation output can be written.
    await this.outputHistoryManager.commitDefinitionRevision(
      historyFilePath,
      this.getDefinitionRevisionContext()
    );
    await this.outputHistoryManager.reopenRun(
      historyFilePath,
      EXECUTION_STATES.RUNNING,
      state.definitionRevision,
      state.steps.length
    );

    if (this.getAuthoritativeExecutionState() === EXECUTION_STATES.PAUSED) {
      const targetRunIndices = await this.computeTargetRunIndices(
        historyFilePath,
        true
      );
      await this.resume(historyFilePath, targetRunIndices);
      return;
    }

    await this.executeLoadedPromptFile(undefined, true, historyFilePath);
  }

  /**
   * Execute the currently loaded prompt file.
   *
   * `onPrepared`, when given, fires once the run's identity is settled — a
   * fresh start has promoted its draft (or a continuation has bound its
   * existing run) and `getQueueState().runRef` names the run this call is
   * about to execute — but before the step loop and worktree/lock
   * acquisition begin. Mirrors `executeSeededRun`'s `onPrepared`: callers that
   * promote a draft while a client is still addressed at it (e.g.
   * `executeDraftAtAddress`) use this to move that client onto the new run's
   * address without waiting for the whole run to finish.
   */
  async executeLoadedPromptFile(
    modeOverride?: HarnessId,
    continueFromCurrent: boolean = false,
    preinitializedHistoryFilePath: string = "",
    prePromotedFreshStart: boolean = false,
    onPrepared?: () => Promise<void>
  ): Promise<void> {
    const pipeline = new WorkflowStartupPipeline({
      ...this.createWorkflowStartupPipelinePort(),
      onPrepared,
    });
    await pipeline.execute(
      modeOverride,
      continueFromCurrent,
      preinitializedHistoryFilePath,
      prePromotedFreshStart
    );
  }
  /**
   * Pause current execution.
   */
  async pause(): Promise<void> {
    if (!this.workflowRuntime.pause()) {
      return;
    }

    await this.promptQueue.commitRuntimeTransition();
  }

  /**
   * Cancel a pending pause request, resuming execution immediately.
   */
  async cancelPause(): Promise<void> {
    if (!this.workflowRuntime.cancelPause()) {
      return;
    }

    await this.promptQueue.commitRuntimeTransition();
  }

  /**
   * Resume execution from paused state.
   */
  async resume(
    historyFilePath?: string,
    targetRunIndices?: Map<string, number>
  ): Promise<void> {
    // IDLE with currentIndex > 0 = user stopped, then used "set start position" to reposition.
    // Treat as a continuation from the set position so existing outputs are preserved.
    if (
      this.workflowRuntime.status === EXECUTION_STATES.IDLE &&
      this.promptQueue.getState().currentIndex > 0
    ) {
      await this.executeLoadedPromptFile(undefined, true);
      return;
    }

    // STOPPED = a step was appended to a completed workflow via reopenForContinuation().
    // ERROR = the current step failed; retry it from the current (failed) position.
    // Both use executeLoadedPromptFile so EXECUTION_STARTED is sent to the webview and
    // the history file is properly initialised for the new step's output.
    if (
      this.workflowRuntime.status === EXECUTION_STATES.STOPPED ||
      this.workflowRuntime.status === EXECUTION_STATES.ERROR
    ) {
      await this.executeLoadedPromptFile(undefined, true);
      return;
    }

    if (!this.workflowRuntime.resume()) {
      return;
    }

    this.promptQueue.clearPendingRewind();
    await this.promptQueue.commitRuntimeTransition();

    if (this.workflowExecutor.isAwaitingResponse()) {
      Log.info(
        "[WorkflowInstance] Resuming while Copilot is still responding - will continue when response completes"
      );
      return;
    }

    if (this.startPending) {
      Log.info(
        "[WorkflowInstance] Waiting for the paused execution cycle to settle"
      );
      await this.executionSettledPromise;
      if (this.workflowRuntime.status !== EXECUTION_STATES.RUNNING) {
        return;
      }
    }

    // A workflow paused mid-worktree-execution can reach this branch on a
    // freshly constructed instance (e.g. after an extension/host restart)
    // that never went through executeLoadedPromptFile for this run, so
    // worktreeResolution/executionWorkspace are still the constructor's
    // no-worktree defaults. Re-resolve and re-apply here — cheap and a
    // no-op when this.activeWorktree/this.executionLease are already set
    // from an in-process pause — or the resumed run silently executes
    // against the main checkout instead of its configured worktree.
    const resolvedHistoryFilePath =
      historyFilePath ?? this.resolveHistoryFilePath();
    const workingFilePath = this.promptQueue.getState().workingFilePath;
    await this.ensureRunnerLock(workingFilePath);
    this.worktreeResolution = await resolveWorktreeForWorkspace(
      this.promptQueue.getWorkflowFile().worktree,
      ConfigurationUtils.getDefaultWorktree(),
      this.platform.getNamedWorkspaceRoots()
    );
    await this.prepareExecutionWorktree(resolvedHistoryFilePath);

    Log.info("[WorkflowInstance] Resuming workflow from paused position");
    await this.startWorkflowExecution(
      undefined,
      resolvedHistoryFilePath,
      workingFilePath,
      targetRunIndices
    );
  }

  /**
   * Stop current execution.
   */
  async stop(): Promise<void> {
    const stopReason = "Workflow stopped by user";

    Log.info(`[WorkflowInstance] stop() - stopping active target resources`);

    this.promptQueue.markInFlightPromptCancelled();
    const activeAttempts = this.workflowRuntime.getActiveAttempts();
    if (activeAttempts.length > 0) {
      this.workflowRuntime.cancelActiveAttempts(stopReason);
    } else {
      const currentTarget = this.getCurrentCancellationTarget();
      if (currentTarget) {
        const pendingAttempt = this.workflowRuntime.getAttempt(currentTarget);
        this.workflowRuntime.cancelAttempt(
          currentTarget,
          pendingAttempt?.attemptIndex ?? 0,
          stopReason
        );
      }
    }

    if (this.workflowRuntime.requestStop()) {
      await this.promptQueue.commitRuntimeTransition({ persist: false });
    }

    let confirmedStoppedCalled = false;

    const confirmStopped = async (): Promise<void> => {
      if (confirmedStoppedCalled) {
        return;
      }

      confirmedStoppedCalled = true;
      if (this.promptQueue.getCurrentParallelGroup()) {
        Log.info(
          "[WorkflowInstance] Parallel group cancellation requested; coordinator will commit member cancellations before STOPPED"
        );
        return;
      }
      if (!this.workflowRuntime.confirmStopped()) {
        return;
      }

      const stoppedIndex = this.promptQueue.getState().currentIndex;
      const advancedPastQueuePrompt =
        this.promptQueue.finalizeCancelledPromptAfterStop();

      await this.promptQueue.commitRuntimeTransition();
      if (advancedPastQueuePrompt) {
        Log.info(
          `[WorkflowInstance] Queue execution fully stopped - advanced past cancelled step ${stoppedIndex}`
        );
      } else {
        Log.info("[WorkflowInstance] Queue execution fully stopped");
      }
    };

    const integrations = new Set<HarnessIntegration>();
    for (const resource of this.activeTargetResources.values()) {
      if (resource.integration) {
        integrations.add(resource.integration);
      }
      void resource.processRunner?.cancel();
      if (resource.ptySessionId) {
        getPtyProcessManager()?.killSession(
          resource.ptySessionId,
          TERMINAL_END_REASONS.STOPPED
        );
      }
    }
    if (integrations.size === 0) {
      integrations.add(this.getDetectorIntegration());
    }

    const responseDisposables: Array<{ dispose(): void }> = [];
    const responseSettled = [...integrations].map(
      (integration) =>
        new Promise<void>((resolve) => {
          const disposable = integration.onResponseComplete(() => {
            disposable.dispose();
            resolve();
          });
          responseDisposables.push(disposable);
        })
    );
    const cancelPromises = [...integrations].map((integration) =>
      integration.cancel()
    );
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([
        Promise.allSettled(cancelPromises),
        ...responseSettled,
      ]).then(() => confirmStopped()),
      new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(() => {
          if (!confirmedStoppedCalled) {
            Log.warn(
              "[WorkflowInstance] Stop timeout: cancellation did not settle within 10s, forcing confirmedStopped()"
            );
            confirmStopped()
              .catch((err) => {
                Log.error(
                  "[WorkflowInstance] Failed to update working file after stop:",
                  err
                );
              })
              .finally(resolve);
          } else {
            resolve();
          }
        }, 10000);
      }),
    ]);
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
    for (const disposable of responseDisposables) {
      disposable.dispose();
    }

    this.workflowExecutor.clearResponseWaitState();
    this.startPending = false;
  }

  /**
   * Clear only the stale working file path without wiping prompts or currentPromptFile.
   * Used when the working file is deleted externally (removed from history) so that
   * ensureEphemeralWorkingFile() will create a fresh one on the next property write or run.
   */
  clearWorkingFilePath(): void {
    this.promptQueue.clearWorkingFilePath();
    Log.debug(
      `[inst:${this.id.slice(0, 8)}] clearWorkingFilePath: stale working file path cleared`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Queue operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Append prompts from a file to the current queue.
   */
  async appendFromFile(
    filePath: string,
    position: QueuePosition = QUEUE_POSITION.END
  ): Promise<void> {
    try {
      const parsed = await this.promptFileParser.parsePromptFile(filePath);

      if (!parsed?.steps?.length) {
        notifyUserFeedback(
          this.userFeedbackSink,
          "error",
          "No steps found in file"
        );
        return;
      }

      const queueState = this.promptQueue.getState();
      const currentSize = queueState.steps.length;

      if (currentSize === 0) {
        Log.debug(
          "[WorkflowInstance] Empty workflow, creating new workflow in IDLE state"
        );
        const workflowType = queueState.workflowName
          ? `workflow "${queueState.workflowName}"`
          : DEFAULT_WORKFLOW_NAME;

        await this.initializeNewWorkflow(
          parsed.steps,
          path.basename(filePath),
          filePath,
          true,
          `Queued ${parsed.steps.length} prompt(s) to ${workflowType}`,
          parsed.parallelGroups
        );
        return;
      }

      if (!this.promptQueue.canAppend()) {
        notifyUserFeedback(
          this.userFeedbackSink,
          "error",
          "Cannot queue prompts: Workflow must be cleared first"
        );
        return;
      }

      const newSize = currentSize + parsed.steps.length;
      const workflowMaxSteps = this.promptQueue.getWorkflowFile().maxSteps;
      const maxSteps = resolveEffectiveMaxSteps(
        workflowMaxSteps,
        ConfigurationUtils.getGlobalMaxSteps()
      );

      if (exceedsLimit(newSize, maxSteps)) {
        notifyUserFeedback(
          this.userFeedbackSink,
          "warning",
          buildStepLimitError(
            currentSize,
            maxSteps,
            getEffectiveMaxStepsSource(workflowMaxSteps)
          )
        );
        return;
      }

      const source = `User append (${position}): ${path.basename(filePath)}`;
      this.reopenRuntimeForContinuationIfNeeded(false);
      await this.promptQueue.appendSteps(
        parsed.steps,
        source,
        position,
        parsed.parallelGroups
      );
      this.syncCurrentPromptFileFromQueue();

      if (this.dashboardSink) {
        const updatedState = this.promptQueue.getState();
        this.dashboardSink.updateStepsExtended(
          updatedState.steps,
          this.promptQueue.getWorkflowFile().finalStep ?? null,
          undefined,
          updatedState.definitionRevision,
          this.id,
          updatedState.parallelGroups
        );
        this.dashboardSink.updateProgress(
          updatedState.currentIndex,
          updatedState.steps.length,
          this.id
        );
      }

      if (!this.currentPromptFile) {
        Log.debug(
          "[WorkflowInstance] No prompt file loaded, updating context (append mode)"
        );
        this.currentPromptFile = { filePath, promptFile: parsed };
        const appendWorkingFilePath =
          this.promptQueue.getState().workingFilePath;
        if (appendWorkingFilePath) {
          this.setupPromptFileWatcher(appendWorkingFilePath);
        }
      }

      const positionText =
        position === QUEUE_POSITION.NEXT
          ? "after current prompt"
          : "at end of queue";
      notifyUserFeedback(
        this.userFeedbackSink,
        "info",
        `Queued ${parsed.steps.length} prompt(s) ${positionText}`
      );
    } catch (error) {
      Log.error("[WorkflowInstance] Failed to queue prompts:", error);
      notifyUserFeedback(
        this.userFeedbackSink,
        "error",
        `Failed to queue prompts: ${getErrorMessage(error)}`
      );
    }
  }

  /** Forget a pending rewind this instance still holds in memory. */
  clearPendingRewind(): void {
    this.promptQueue.clearPendingRewind();
  }

  async updateWorkflowName(workflowName: string): Promise<void> {
    if (!this.promptQueue) {
      throw new Error("No active queue");
    }
    // Update instance field first so ensureEphemeralWorkingFile uses the new
    // name when creating the working file for brand-new workflows.
    this.workflowName = workflowName;
    // Eagerly create a working file if one doesn't exist yet, so that renaming
    // a new workflow before adding prompts isn't lost when switching away.
    await this.ensureEphemeralWorkingFile();
    await this.promptQueue.updateWorkflowName(workflowName);
    this.propagateWorkflowNameToIntegrations();
  }

  /** Guard the next user definition mutation with its client-observed revision. */
  expectDefinitionRevision(revision: number): void {
    this.promptQueue.expectDefinitionRevision(revision);
  }

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
   * Eagerly create a working file for a new ephemeral workflow the moment the
   * user first changes any workflow-level property (harness, model, finalStep,
   * etc.) before adding any prompts. This eliminates the need for a
   * pendingWorkflowProperties cache — every property write goes straight to disk.
   *
   * Idempotent: returns immediately if a working file already exists.
   */
  public async ensureEphemeralWorkingFile(options?: {
    /**
     * Properties the caller is about to write explicitly.
     * Passed to populateSettingsDefaults so they influence dependent lookups
     * (e.g. harness change → correct model default) without being overwritten
     * by the defaults computation.
     */
    initialProperties?: Record<string, unknown>;
  }): Promise<void> {
    if (this.promptQueue.getState().workingFilePath) {
      return;
    }

    if (!this.ensureWorkingFilePromise) {
      this.ensureWorkingFilePromise = this.doEnsureEphemeralWorkingFile(
        options
      ).finally(() => {
        this.ensureWorkingFilePromise = undefined;
      });
    }

    await this.ensureWorkingFilePromise;
  }

  private async doEnsureEphemeralWorkingFile(options?: {
    initialProperties?: Record<string, unknown>;
  }): Promise<void> {
    if (this.promptQueue.getState().workingFilePath) {
      return;
    }

    const workspaceFolderPath =
      this.workspaceFolderPath ?? this.platform.getWorkspaceRoot();
    if (!workspaceFolderPath) {
      return;
    }

    const displayName =
      this.workflowName ||
      this.promptQueue.getState().workflowName ||
      DEFAULT_WORKFLOW_NAME;

    try {
      const workingFilePath = await this.promptQueue.createWorkingFile(
        displayName,
        [],
        workspaceFolderPath
      );
      Log.info(
        `[WorkflowInstance] Eagerly created working file: ${workingFilePath}`
      );

      // Keep currentPromptFile in sync so executeLoadedPromptFile doesn't
      // fail with "No prompt file loaded" when the user runs an ephemeral
      // prompt after changing a workflow property (harness, model, etc.)
      // before adding any prompts.
      if (!this.currentPromptFile) {
        this.currentPromptFile = {
          filePath: workingFilePath,
          promptFile: { steps: [] },
        };
        Log.debug(
          `[inst:${this.id.slice(0, 8)}] ensureEphemeralWorkingFile: set currentPromptFile ${path.basename(workingFilePath)}`
        );
      }

      // Populate VS Code defaults and write them (along with any explicit
      // initialProperties) to the file BEFORE notifying the webview.
      // This ensures sendWorkflowPropertiesToSettings() — called inside
      // updateFileSelected — reads a file that already contains the correct
      // values (e.g. additionalArgs harness default, resumeSession from an
      // in-progress user selection), preventing a brief reversion in the UI.
      // onlyIfUndefined ensures concurrent calls don't stomp each other.
      const explicitValues = options?.initialProperties ?? {};
      const defaults =
        PromptFileLoader.populateSettingsDefaults(explicitValues);
      const allInitialValues = { ...defaults, ...explicitValues };
      // defaults.toolPermissions is always the complete merged object
      // (explicit sub-fields on top of VS Code defaults). Use it over
      // the potentially partial explicitValues.toolPermissions.
      if (defaults.toolPermissions !== undefined) {
        allInitialValues.toolPermissions = defaults.toolPermissions;
      }
      if (Object.keys(allInitialValues).length > 0) {
        await this.promptQueue.updateWorkingFileProperties(allInitialValues, {
          onlyIfUndefined: true,
        });
      }

      // Notify the webview so the WorkflowStatus header transitions from
      // "No workflow loaded" to showing the new workflow name.
      if (this.dashboardSink) {
        const workflowName =
          this.promptQueue.getState().workflowName || displayName;
        await this.dashboardSink.updateFileSelected(
          workingFilePath,
          [],
          workflowName
        );
      }
    } catch (error) {
      Log.error(
        "[WorkflowInstance] Failed to eagerly create working file:",
        error
      );
    }
  }

  /**
   * Sync steps (and optionally finalStep) to match the state restored by a webview undo/redo.
   * Updates the in-memory queue and persists to the working file without broadcasting to the webview.
   */
  async syncStepsForUndoRedo(
    steps: WorkflowStep[],
    finalStep: WorkflowStep | null,
    parallelGroups?: ParallelGroupDefinition[]
  ): Promise<void> {
    await this.promptQueue.syncStepsForUndoRedo(
      steps,
      parallelGroups ?? this.promptQueue.getState().parallelGroups
    );

    // Sync finalStep if it changed
    if (finalStep !== null) {
      const persistableFinalStep = stripViewOnlyWorkflowStepFields(finalStep);
      this.promptQueue.updateWorkflowProperty(
        "finalStep",
        persistableFinalStep
      );
      await this.promptQueue.updateWorkingFileProperties({
        finalStep: persistableFinalStep,
      });
    } else {
      this.promptQueue.updateWorkflowProperty("finalStep", undefined);
      await this.promptQueue.updateWorkingFileProperties(
        { finalStep: undefined },
        { allowDeletes: true }
      );
    }

    this.dashboardSink?.notifyUndoRedoSynced();
    await this.reconcileExecutionStateAfterStepChange();
    Log.debug(
      `[WorkflowInstance] syncStepsForUndoRedo: ${steps.length} steps, finalStep=${finalStep ? "set" : "null"}`
    );
  }

  async insertWorkflowStepAfterIndex(
    afterIndex: number,
    step: unknown
  ): Promise<void> {
    const sanitizedStep = sanitizeClipboardWorkflowStep(step);

    if (!this.promptQueue.getState().workingFilePath) {
      await this.ensureEphemeralWorkingFile();
    }

    this.reopenRuntimeForContinuationIfNeeded(false);
    await this.promptQueue.insertStepAfterIndex(
      afterIndex,
      sanitizedStep,
      "Clipboard paste"
    );
    this.syncCurrentPromptFileFromQueue();

    if (this.dashboardSink) {
      const currentState = this.promptQueue.getState();
      this.dashboardSink.updateStepsExtended(
        currentState.steps,
        this.promptQueue.getWorkflowFile().finalStep ?? null,
        this.getAuthoritativeExecutionState(),
        currentState.definitionRevision,
        undefined,
        currentState.parallelGroups
      );
      this.dashboardSink.updateProgress(
        currentState.currentIndex,
        currentState.steps.length
      );
    }

    Log.debug(
      `[WorkflowInstance] Inserted workflow step after index ${afterIndex}: ${isScriptStep(sanitizedStep) ? sanitizedStep.script.substring(0, 50) : sanitizedStep.prompt.substring(0, 50)}...`
    );
  }

  async updatePromptInQueue(
    index: number,
    text: string,
    properties: unknown,
    promptName?: string,
    clearProperties?: string[]
  ): Promise<void> {
    const props = properties as Record<string, unknown>;
    const incomingStep: WorkflowStep =
      props?.type === STEP_TYPES.SCRIPT
        ? buildScriptStepFromProperties(text, props, promptName)
        : {
            prompt: text,
            ...(promptName !== undefined && { name: promptName || undefined }),
            ...buildPromptStepProperties(properties),
          };
    const existingStep = this.promptQueue.getState().steps[index];
    await this.promptQueue.replaceStep(
      index,
      existingStep
        ? mergeWorkflowStepUpdate(existingStep, incomingStep, clearProperties)
        : incomingStep
    );
    if (this.dashboardSink) {
      const currentState = this.promptQueue.getState();
      this.dashboardSink.updateStepsExtended(
        currentState.steps,
        this.promptQueue.getWorkflowFile().finalStep ?? null,
        undefined,
        currentState.definitionRevision
      );
    }
    Log.debug(
      `[WorkflowInstance] Updated prompt ${index}: ${text.substring(0, 50)}...`
    );
  }

  async updateStepColorInQueue(
    indices: number[],
    color: string | null
  ): Promise<void> {
    await this.promptQueue.updatePromptColors(indices, color);
    const currentState = this.promptQueue.getState();
    this.dashboardSink?.updateStepColor(
      indices,
      color,
      currentState.definitionRevision
    );
  }

  async updateFinalStepInQueue(
    finalStep: WorkflowStep | null,
    clearProperties?: string[]
  ): Promise<void> {
    await this.ensureEphemeralWorkingFile();

    if (finalStep) {
      const incomingStep = buildFinalStepUpdate(finalStep);
      const existingFinalStep = this.promptQueue.getWorkflowFile().finalStep;
      const normalized = existingFinalStep
        ? mergeWorkflowStepUpdate(
            existingFinalStep,
            incomingStep,
            clearProperties
          )
        : ({
            ...incomingStep,
            ...buildClearUpdates(clearProperties),
          } as WorkflowStep);
      this.promptQueue.updateWorkflowProperty("finalStep", normalized);
      await this.promptQueue.updateWorkingFileProperties({
        finalStep: normalized,
      });
      if (this.currentPromptFile) {
        this.currentPromptFile.promptFile.finalStep = normalized;
      }
    } else {
      this.promptQueue.updateWorkflowProperty("finalStep", undefined);
      await this.promptQueue.updateWorkingFileProperties(
        { finalStep: undefined },
        { allowDeletes: true }
      );
      await this.promptQueue.setFinalStepRuntime(undefined);
      if (this.currentPromptFile) {
        delete this.currentPromptFile.promptFile.finalStep;
      }
    }

    this.dashboardSink?.updateFinalStep(
      finalStep,
      undefined,
      this.promptQueue.getState().definitionRevision
    );
    if (!finalStep) {
      this.dashboardSink?.updateFinalStepStatus(null, 0, null);
    }

    Log.debug(
      `[WorkflowInstance] Updated finalStep (${finalStep ? "enabled" : "disabled"})`
    );
  }

  async deletePromptFromQueue(indices: number[]): Promise<void> {
    await this.promptQueue.deletePrompts(indices);
    if (this.dashboardSink) {
      const currentState = this.promptQueue.getState();
      const fileName = this.currentPromptFile
        ? path.basename(this.currentPromptFile.filePath)
        : DEFAULT_WORKFLOW_NAME;
      this.dashboardSink.updatePromptDeleted(
        fileName,
        currentState.steps,
        this.promptQueue.getWorkflowFile().finalStep ?? null,
        currentState.parallelGroups,
        currentState.definitionRevision
      );
    }
    await this.reconcileExecutionStateAfterStepChange();
    Log.debug(`[WorkflowInstance] Deleted prompts ${indices.join(", ")}`);
  }

  /**
   * Move the start position of this instance's never-executed draft. The queue
   * owns the resulting state (prefix skip marks plus `currentIndex`) and
   * persists it to the draft file; the refreshed view is published by the
   * caller through the addressed draft-view invalidation, so nothing is pushed
   * to the dashboard sink from here.
   */
  async setDraftStartPosition(toIndex: number): Promise<void> {
    await this.promptQueue.setStartPosition(toIndex);
    Log.debug(`[WorkflowInstance] Draft start position set to step ${toIndex}`);
  }

  /**
   * Auto-transition execution state after a step list change triggered by a
   * user edit (delete or undo/redo):
   *
   * - STOPPED + all steps completed → COMPLETED
   *   Handles the case where a user deletes (or undoes the append of) the last
   *   pending step from a workflow that was re-opened for continuation after
   *   reaching COMPLETED. The state machine was set to STOPPED by
   *   `reopenForContinuation`; now that there is no pending work, it should
   *   revert to COMPLETED.
   *
   * - COMPLETED + non-terminal steps present → STOPPED (continuation)
   *   Handles the symmetric redo case: after undoing a delete (via Ctrl+Z/Y)
   *   the user may have restored a pending step. The state machine should go
   *   back to STOPPED so the "Resume" affordance is available.
   *
   * Calling `workflowRuntime.complete()` or `reopenForContinuation()` emits a
   * transition which is picked up by `onRuntimeTransition` → broadcasts
   * EXECUTION_STATE_CHANGED (and EXECUTION_COMPLETED for the COMPLETED case) to
   * the webview.  We then re-persist the working file so the on-disk state
   * matches the new status.
   */
  private async reconcileExecutionStateAfterStepChange(): Promise<void> {
    const status = this.workflowRuntime.status;
    const queueState = this.promptQueue.getState();
    const stepCount = queueState.steps.length;
    const terminalCount = this.promptQueue.getTerminalCount();
    const completedOrSkippedCount =
      this.promptQueue.getCompletedOrSkippedCount();

    if (
      status === EXECUTION_STATES.STOPPED &&
      stepCount > 0 &&
      completedOrSkippedCount === stepCount
    ) {
      Log.info(
        `[WorkflowInstance] reconcileExecutionState: all ${stepCount} step(s) completed while STOPPED — transitioning to COMPLETED`
      );
      this.workflowRuntime.complete();
      await this.promptQueue.updateWorkingFile();
    } else if (
      status === EXECUTION_STATES.COMPLETED &&
      stepCount > 0 &&
      terminalCount < stepCount
    ) {
      Log.info(
        `[WorkflowInstance] reconcileExecutionState: ${stepCount - terminalCount} non-terminal step(s) present while COMPLETED — reopening for continuation`
      );
      this.workflowRuntime.reopenForContinuation();
      await this.promptQueue.updateWorkingFile();
    }
  }

  async reorderPendingPrompts(
    newPendingOrder: number[],
    pendingGroups?: PendingParallelGroupRange[]
  ): Promise<void> {
    await this.promptQueue.reorderPendingPrompts(
      newPendingOrder,
      pendingGroups
    );
    if (this.dashboardSink) {
      const state = this.promptQueue.getState();
      this.dashboardSink.notifyPromptsReordered(
        state.steps,
        undefined,
        state.parallelGroups,
        state.definitionRevision
      );
    }
  }

  /**
   * Begins an addressed same-run rewind for the run already loaded by this
   * instance. Callers that address another historical run use the static
   * WorkingFileManager transaction and never rebind this executor.
   */
  async beginPendingRewind(
    workflowKey: WorkflowKey,
    runRef: RunRef,
    fromStepIndex: number,
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number
  ): Promise<{ definitionRevision: number; descriptorRevision: number }> {
    const state = this.promptQueue.getState();
    if (state.workflowKey !== workflowKey || state.runRef !== runRef) {
      throw new Error(
        "Pending rewind target is not loaded by this workflow instance"
      );
    }
    const executionState = this.getAuthoritativeExecutionState();
    if (
      executionState === EXECUTION_STATES.RUNNING ||
      executionState === EXECUTION_STATES.PAUSING ||
      executionState === EXECUTION_STATES.CANCELLING
    ) {
      throw new Error(
        `Cannot set start position while in state ${executionState}`
      );
    }
    const workspaceRoot =
      this.workspaceFolderPath ?? this.platform.getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error("No workspace folder is open");
    }
    const result = await WorkingFileManager.beginPendingRewind(
      workspaceRoot,
      workflowKey,
      runRef,
      fromStepIndex,
      expectedDefinitionRevision,
      expectedDescriptorRevision
    );
    this.promptQueue.applyPendingRewind(
      result.workingFile._runtime?.pendingRewind?.fromStepIndex ??
        fromStepIndex,
      expectedDefinitionRevision,
      result.definitionRevision,
      executionState === EXECUTION_STATES.PAUSED
    );
    this.syncCurrentPromptFileFromQueue();
    return {
      definitionRevision: result.definitionRevision,
      descriptorRevision: result.descriptorRevision,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Ephemeral / dashboard prompts
  // ─────────────────────────────────────────────────────────────────────────

  /** Seed a fresh workflow with one dashboard prompt without starting it yet. */
  async initializeEphemeralPrompt(
    text: string,
    properties: unknown,
    promptName?: string
  ): Promise<HarnessId | undefined> {
    const { workflowName, step, stepHarness } = this.buildEphemeralPromptSeed(
      text,
      properties,
      promptName
    );

    await this.initializeNewWorkflow([step], workflowName);
    return stepHarness;
  }

  async executeEphemeralPrompt(
    text: string,
    properties: unknown,
    action: ActionType,
    promptName?: string
  ): Promise<void> {
    const {
      workflowName: generatedWorkflowName,
      step,
      stepHarness,
    } = this.buildEphemeralPromptSeed(text, properties, promptName);

    const currentState = this.promptQueue.getState();
    const hasWorkflow =
      currentState.steps.length > 0 || !!currentState.workingFilePath;
    const isCompleted =
      this.getAuthoritativeExecutionState() === EXECUTION_STATES.COMPLETED;

    if (action === ACTION_TYPES.RUN_PARALLEL) {
      await this.executeEphemeralParallelPrompt(step);
      return;
    }

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
      const workflowName = currentState.workflowName || generatedWorkflowName;
      Log.debug(
        `[inst:${this.id.slice(0, 8)}] executeEphemeralPrompt: no existing workflow — initializing new with name="${workflowName}", shouldRun=${shouldRun}, action=${action}`
      );
      await this.initializeNewWorkflow([step], workflowName);

      if (shouldRun) {
        await this.executeLoadedPromptFile(stepHarness);
      }
    } else {
      // If the workflow was eagerly created before any prompts were added (e.g., a
      // setting was changed first), the name is a generic placeholder like "new workflow".
      // Update it from the first prompt text so the session has a meaningful name.
      // Only do this if the user hasn't explicitly set a custom name — a non-empty
      // workflowName that differs from the default placeholder means the user named it.
      const hasUserDefinedName =
        this.workflowName && this.workflowName !== DEFAULT_WORKFLOW_NAME;
      if (currentState.steps.length === 0 && !hasUserDefinedName) {
        this.workflowName = generatedWorkflowName;
        this.promptQueue.setWorkflowName(generatedWorkflowName);
        await this.promptQueue.updateWorkingFile(true);
        Log.debug(
          `[inst:${this.id.slice(0, 8)}] executeEphemeralPrompt: updated workflow name from first prompt "${generatedWorkflowName}"`
        );
      }

      Log.debug(
        `[inst:${this.id.slice(0, 8)}] executeEphemeralPrompt: appending to existing workflow ` +
          `(status=${this.getAuthoritativeExecutionState()}, prompts=${currentState.steps.length}, shouldRun=${shouldRun}, action=${action})`
      );
      const stepLimitError = this.getStepLimitError(1);
      if (stepLimitError) {
        notifyUserFeedback(this.userFeedbackSink, "warning", stepLimitError);
        return;
      }
      this.reopenRuntimeForContinuationIfNeeded(shouldRun);
      await this.promptQueue.appendSteps([step], "Dashboard editor", position);
      this.syncCurrentPromptFileFromQueue();

      if (this.dashboardSink) {
        const updatedState = this.promptQueue.getState();
        this.dashboardSink.updateStepsExtended(
          updatedState.steps,
          this.promptQueue.getWorkflowFile().finalStep ?? null,
          undefined,
          updatedState.definitionRevision,
          this.id,
          updatedState.parallelGroups
        );
      }

      if (shouldRun) {
        const statusNow = this.getAuthoritativeExecutionState();
        const isStopped = statusNow === EXECUTION_STATES.STOPPED;
        const isIdleNow = statusNow === EXECUTION_STATES.IDLE;
        const isError = statusNow === EXECUTION_STATES.ERROR;
        const isCancelling = statusNow === EXECUTION_STATES.CANCELLING;
        Log.debug(
          `[inst:${this.id.slice(0, 8)}] executeEphemeralPrompt: post-append shouldRun=true, ` +
            `isIdle=${isIdleNow}, isCompleted=${isCompleted}, isStopped=${isStopped}, isError=${isError}, isCancelling=${isCancelling}, ` +
            `queueStatusNow=${statusNow}`
        );
        if (isCancelling) {
          this.pendingRunAfterCancel = { harness: stepHarness };
          Log.info(
            `[inst:${this.id.slice(0, 8)}] executeEphemeralPrompt: cancelling in progress — deferring run until confirmStopped`
          );
        } else if (isIdleNow || isCompleted || isStopped || isError) {
          await this.executeLoadedPromptFile(stepHarness, isStopped || isError);
        }
      }
    }
  }

  /**
   * Dispatch a new editor step beside the queue target that is executing now.
   * The topology mutation and the executor admission deliberately use the
   * shared PromptQueue/WorkflowExecutor paths used by other late joiners.
   */
  private async executeEphemeralParallelPrompt(
    step: WorkflowStep
  ): Promise<void> {
    const state = this.promptQueue.getState();
    const stepLimitError = this.getStepLimitError(1);
    if (stepLimitError) {
      throw new Error(stepLimitError);
    }
    const executionState = this.getAuthoritativeExecutionState();
    if (executionState !== EXECUTION_STATES.RUNNING) {
      throw new Error(
        executionState === EXECUTION_STATES.PAUSING
          ? "Workflow is pausing. Run in Parallel was rejected."
          : "No step is running. Run in Parallel was rejected."
      );
    }

    const finalStepRuntime = this.promptQueue.getFinalStepRuntime();
    if (finalStepRuntime?.phase === FINAL_STEP_PHASES.FINAL_STEP) {
      throw new Error(
        "The final step cannot run in parallel. Run in Parallel was rejected."
      );
    }

    const currentGroup = this.promptQueue.getCurrentParallelGroup();
    if (
      !isActiveQueueWorkRunning(state.steps, state.currentIndex, currentGroup)
    ) {
      throw new Error("No step is running. Run in Parallel was rejected.");
    }

    const effectiveWidth = getEffectiveParallelGroupWidth(
      ConfigurationUtils.getDynamicQueueConfig().maxParallelSteps
    );
    if (effectiveWidth <= 1) {
      throw new Error(
        "Parallel width is 1. Raise queue.maxParallelSteps to run in parallel."
      );
    }

    const activeRuntime = this.promptQueue.getActiveParallelGroupRuntime();
    const previousParallelGroups = state.parallelGroups.map((group) => ({
      ...group,
    }));
    const previousActiveRuntime = activeRuntime
      ? { ...activeRuntime }
      : undefined;
    let insertion: { stepIndex: number; stepId?: string };
    let runtimePromotionUndoSuppressed = false;
    // The queue emits its topology echo before executor admission completes.
    // Suppress that provisional echo; the explicit success echo below is the
    // only history decision for this mutation.
    this.runtimePromotionUndoSuppressed = true;

    if (currentGroup) {
      if (
        !activeRuntime ||
        activeRuntime.groupId !== currentGroup.id ||
        activeRuntime.admission !== PARALLEL_GROUP_ADMISSION.ACCEPTING
      ) {
        throw new Error(
          "The running parallel group is no longer accepting members."
        );
      }
      try {
        insertion = await this.promptQueue.appendParallelGroupMember(
          currentGroup.id,
          step
        );
      } catch (error) {
        this.runtimePromotionUndoSuppressed = false;
        throw error;
      }
    } else {
      runtimePromotionUndoSuppressed = true;
      try {
        insertion = await this.promptQueue.promoteStepToParallelGroup(
          state.currentIndex,
          step,
          { failFast: false }
        );
      } catch (error) {
        this.runtimePromotionUndoSuppressed = false;
        throw error;
      }
    }

    const join = await this.workflowExecutor.joinRunningParallelGroup(
      insertion.stepIndex
    );
    if (!join.accepted) {
      await this.promptQueue.rollbackParallelGroupMemberInsertion(
        insertion,
        previousParallelGroups,
        previousActiveRuntime
      );
      this.runtimePromotionUndoSuppressed = false;
      throw new Error(join.diagnostic);
    }

    this.syncCurrentPromptFileFromQueue();
    this.syncParallelGroupTerminalSessions(insertion.stepIndex);
    if (this.dashboardSink) {
      const updatedState = this.promptQueue.getState();
      this.dashboardSink.updateStepsExtended(
        updatedState.steps,
        this.promptQueue.getWorkflowFile().finalStep ?? null,
        updatedState.status,
        updatedState.definitionRevision,
        this.id,
        updatedState.parallelGroups,
        runtimePromotionUndoSuppressed
      );
    }
  }

  private getStepLimitError(additionalSteps: number): string | undefined {
    const workflowMaxSteps = this.promptQueue.getWorkflowFile().maxSteps;
    const maxSteps = resolveEffectiveMaxSteps(
      workflowMaxSteps,
      ConfigurationUtils.getGlobalMaxSteps()
    );
    const currentCount = this.promptQueue.getState().steps.length;
    const resultingCount = currentCount + additionalSteps;
    return exceedsLimit(resultingCount, maxSteps)
      ? buildStepLimitError(
          currentCount,
          maxSteps,
          getEffectiveMaxStepsSource(workflowMaxSteps)
        )
      : undefined;
  }

  /**
   * Back-fill `parallelGroupId` onto PTY sessions whose step joined a group
   * *after* their terminal was already live.
   *
   * An ad-hoc promotion (Run in Parallel against a sequentially running step)
   * groups a step whose TUI already announced itself with
   * `parallelGroupId: undefined`. The webview keeps same-harness terminals
   * apart by that field alone (`hooks/terminalMessageHandlers.ts`
   * TERMINAL_STARTED reconciliation), so without this back-fill the joining
   * member's session evicts the promoted step's still-running terminal — the
   * user watches the step they were already invested in disappear.
   *
   * Mutating the `PtySession` matters as much as the broadcast: reconnect
   * replay (`TerminalMessageHandlers.reconnectPanel`,
   * `replayTerminalSessionsTo`) re-derives the payload from the session, so a
   * broadcast-only fix would come undone on the next webview reload.
   */
  private syncParallelGroupTerminalSessions(stepIndex: number): void {
    const ptyManager = getPtyProcessManager();
    if (!ptyManager) {
      return;
    }
    const group = this.promptQueue
      .getState()
      .parallelGroups.find(
        (candidate) =>
          stepIndex >= candidate.startIndex && stepIndex <= candidate.endIndex
      );
    if (!group) {
      return;
    }

    for (const session of ptyManager.getSessionsForWorkflow(this.id)) {
      if (
        session.status !== TERMINAL_SESSION_STATUS.RUNNING ||
        session.parallelGroupId === group.id ||
        session.stepIndex < group.startIndex ||
        session.stepIndex > group.endIndex
      ) {
        continue;
      }
      session.parallelGroupId = group.id;
      const terminalStartedMessage: TerminalStartedMessage = {
        type: MESSAGE_TYPES.TERMINAL_STARTED,
        workflowId: session.workflowId,
        sessionId: session.id,
        stepName: session.stepName,
        stepIndex: session.stepIndex,
        kind: session.kind,
        promptNumber: session.promptNumber,
        harnessId: session.harnessId,
        parallelGroupId: group.id,
        shellKind: session.shellKind,
        controllerClientId: session.controllerClientId,
      };
      ptyPostMessage(terminalStartedMessage);
      Log.debug(
        `[inst:${this.id.slice(0, 8)}] Adopted PTY session ${session.id.slice(0, 8)} ` +
          `(step ${session.stepIndex}) into parallel group ${group.id}`
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private buildEphemeralPromptSeed(
    text: string,
    properties: unknown,
    promptName?: string
  ): {
    workflowName: string;
    step: WorkflowStep;
    stepHarness: HarnessId | undefined;
  } {
    const workflowName = generateWorkflowNameFromPrompt(text, promptName);
    const step = buildEphemeralWorkflowStep(text, properties, promptName);
    return {
      workflowName,
      step,
      stepHarness: isScriptStep(step) ? undefined : step.harness,
    };
  }

  /** Clear all output capture buffers — called at the start of a fresh (non-continuation) run. */
  private clearOutputBuffers(): void {
    this.outputCaptureBuffer.clear();
    this.sessionActivityRecorder.clear();
  }

  private recordCompletedActivityTarget(
    target: OutputExecutionTarget,
    runIndex: number,
    attemptIndex: number,
    integration?: HarnessIntegration
  ): void {
    this.sessionActivityRecorder.recordCompletedActivityTarget(
      target,
      runIndex,
      attemptIndex,
      integration
    );
  }

  private beginActivityTargetCapture(
    integration?: HarnessIntegration,
    target?: WorkflowAttemptTarget
  ): void {
    this.sessionActivityRecorder.beginActivityTargetCapture(
      integration,
      target
    );
  }

  private getExecutionTargetRunKey(
    target: OutputExecutionTarget | WorkflowAttemptTarget
  ): ReturnType<SessionActivityRecorder["getExecutionTargetRunKey"]> {
    return this.sessionActivityRecorder.getExecutionTargetRunKey(target);
  }

  private async handleSessionActivityResumed(
    events: CliEvent[],
    integration?: HarnessIntegration,
    sessionId?: string
  ): Promise<void> {
    return this.sessionActivityRecorder.handleSessionActivityResumed(
      events,
      integration,
      sessionId
    );
  }

  private publishOutputActivity(
    entry: import("../types/OutputHistoryTypes").OutputActivityEntry
  ): void {
    this.sessionActivityRecorder.publishOutputActivity(entry);
  }

  private async computeTargetRunIndices(
    historyFilePath: string,
    isContinuation: boolean
  ): Promise<Map<string, number>> {
    return new WorkflowStartupPipeline(
      this.createWorkflowStartupPipelinePort()
    ).computeTargetRunIndices(historyFilePath, isContinuation);
  }
  /** Advance a completed final-step loop before it is reached again in this run. */
  private async prepareFinalStepContinuation(
    historyFilePath: string
  ): Promise<void> {
    await new WorkflowStartupPipeline(
      this.createWorkflowStartupPipelinePort()
    ).prepareFinalStepContinuation(historyFilePath);
  }

  private warnBeforeWorkflowStart(
    queueState: QueueState,
    workflow: PromptFile,
    modeOverride: HarnessId | undefined,
    restartFromBeginning: boolean
  ): void {
    new WorkflowStartupPipeline(
      this.createWorkflowStartupPipelinePort()
    ).warnBeforeWorkflowStart(
      queueState,
      workflow,
      modeOverride,
      restartFromBeginning
    );
  }

  private async spawnScriptPty(
    options: Parameters<
      NonNullable<WorkflowExecutionContext["spawnScriptPty"]>
    >[0]
  ): Promise<number> {
    return new Promise<number>((resolve) => {
      const ptyManager = getPtyProcessManager();
      if (!ptyManager) {
        Log.warn("[spawnScriptPty] PtyProcessManager not available");
        resolve(1);
        return;
      }

      const preSessionId = `script-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const {
        executable: shell,
        args: shellArgs,
        shellKind,
        windowsVerbatimArguments,
      } = resolveShellInvocation(options.script, options.shell);
      Log.debug(
        `[spawnScriptPty] resolved shell (${shellKind}): ${shell} ${shellArgs
          .map((a) => JSON.stringify(a))
          .join(" ")}`
      );
      const shellError = getShellInvocationError(options.script, shellKind);
      if (shellError) {
        Log.warn(`[spawnScriptPty] ${shellError}`);
        options.onOutput(shellError);
        resolve(1);
        return;
      }

      options.onSessionCreated?.(preSessionId);
      ptyPostMessage({
        type: MESSAGE_TYPES.TERMINAL_STARTED,
        workflowId: this.id,
        sessionId: preSessionId,
        stepName: options.stepName,
        stepIndex: options.stepIndex,
        kind: SESSION_KINDS.AI_CLI,
        parallelGroupId: options.parallelGroupId,
        controllerClientId: ptyManager.getExpectedController(this.id),
      });

      try {
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const session = ptyManager.spawnPty({
          workflowId: this.id,
          stepName: options.stepName,
          stepIndex: options.stepIndex,
          kind: SESSION_KINDS.AI_CLI,
          sessionId: preSessionId,
          parallelGroupId: options.parallelGroupId,
          command: shell,
          args: toPtySpawnArgs(shellArgs, windowsVerbatimArguments),
          cwd: options.cwd,
          env: { ...process.env, ...(options.env ?? {}) },
          streamingSecretRedaction: true,
          onData: (session, chunk) => {
            ptyPostMessage({
              type: MESSAGE_TYPES.TERMINAL_OUTPUT,
              workflowId: session.workflowId,
              sessionId: session.id,
              data: chunk,
            });
            options.onOutput(chunk);
          },
          onExit: (session, exitCode) => {
            if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
            options.onSessionEnded?.();
            ptyPostMessage(buildTerminalEndedMessage(session, exitCode));
            resolve(exitCode);
          },
        });
        if (options.timeout > 0) {
          timeoutHandle = setTimeout(() => {
            Log.warn(
              `[spawnScriptPty] timed out after ${options.timeout}ms: ${options.stepName}`
            );
            options.onTimeout?.();
            ptyManager.killSession(session.id, TERMINAL_END_REASONS.TIMED_OUT);
          }, options.timeout);
        }
      } catch (error) {
        const message = getErrorMessage(error);
        Log.warn(`[spawnScriptPty] ${message}`);
        options.onSessionEnded?.();
        ptyPostMessage({
          type: MESSAGE_TYPES.TERMINAL_OUTPUT,
          workflowId: this.id,
          sessionId: preSessionId,
          data: `${message}\r\n`,
        });
        ptyPostMessage(
          buildTerminalEndedMessage(
            {
              workflowId: this.id,
              id: preSessionId,
              kind: SESSION_KINDS.AI_CLI,
              status: TERMINAL_SESSION_STATUS.FAILED,
            },
            1
          )
        );
        options.onOutput(message);
        resolve(1);
      }
    });
  }

  private shouldShowCliCommand(): boolean {
    return ConfigurationUtils.shouldShowCliCommand();
  }

  private getDynamicQueueConfig(): DynamicQueueConfig {
    return ConfigurationUtils.getDynamicQueueConfig();
  }

  private getScriptProcessRunner(
    target: WorkflowAttemptTarget
  ): ScriptProcessRunner {
    const targetKey = this.getExecutionTargetRunKey(target);
    const existing = this.targetScriptProcessRunners.get(targetKey);
    if (existing) {
      this.registerTargetProcessRunner(target, existing);
      return existing;
    }
    const runner = new ScriptProcessRunner(
      this.executionWorkspace.executionRoot
    );
    this.targetScriptProcessRunners.set(targetKey, runner);
    this.registerTargetProcessRunner(target, runner);
    return runner;
  }

  private registerTargetIntegration(
    target: WorkflowAttemptTarget,
    integration: HarnessIntegration
  ): void {
    const targetKey = this.getExecutionTargetRunKey(target);
    const resource = this.activeTargetResources.get(targetKey) ?? { target };
    resource.integration = integration;
    this.activeTargetResources.set(targetKey, resource);
  }

  private unregisterActiveTarget(target: WorkflowAttemptTarget): void {
    this.activeTargetResources.delete(this.getExecutionTargetRunKey(target));
  }

  private registerTargetPtySession(
    target: WorkflowAttemptTarget,
    sessionId: string
  ): void {
    const targetKey = this.getExecutionTargetRunKey(target);
    const resource = this.activeTargetResources.get(targetKey) ?? { target };
    resource.ptySessionId = sessionId;
    this.activeTargetResources.set(targetKey, resource);
  }

  private clearTargetPtySession(target: WorkflowAttemptTarget): void {
    const targetKey = this.getExecutionTargetRunKey(target);
    const resource = this.activeTargetResources.get(targetKey);
    if (resource) {
      resource.ptySessionId = undefined;
    }
  }

  private registerActiveTarget(
    target: WorkflowAttemptTarget,
    attemptIndex: number
  ): void {
    const targetKey = this.getExecutionTargetRunKey(target);
    const resource = this.activeTargetResources.get(targetKey) ?? { target };
    resource.attemptIndex = attemptIndex;
    this.activeTargetResources.set(targetKey, resource);
  }

  private registerTargetProcessRunner(
    target: WorkflowAttemptTarget,
    processRunner: ScriptProcessRunner
  ): void {
    const targetKey = this.getExecutionTargetRunKey(target);
    const resource = this.activeTargetResources.get(targetKey) ?? { target };
    resource.processRunner = processRunner;
    this.activeTargetResources.set(targetKey, resource);
  }

  private getActiveTargetKeys(): ReadonlySet<string> {
    return new Set(this.activeTargetResources.keys());
  }

  /**
   * Queue-step attempts report their zero-based `stepIndex`; final-step attempts
   * report the signed index `-(loopIndex + 1)` used by terminal metadata and the
   * dashboard execution system. The signed convention is the single terminal
   * step-identity notation, so emit one value per active attempt.
   *
   * Public because `WorkflowOrchestrator.deliverRunView` also needs it: the
   * addressed run-view snapshot it sends on a workflow switch is otherwise
   * built entirely from a disk read (`readAddressedRunView`), and this value
   * has no persisted `_runtime` counterpart — it only ever exists in memory.
   */
  getActiveStepIndices(): number[] {
    return this.workflowRuntime
      .getActiveAttempts()
      .flatMap((attempt) =>
        attempt.target.kind === FINAL_STEP_PHASES.QUEUE
          ? [attempt.target.stepIndex]
          : [-(attempt.target.loopIndex + 1)]
      )
      .sort((left, right) => left - right);
  }

  /**
   * Every integration this instance could still own a live PTY for, in
   * most-specific-first order: the per-target ones registered by the running
   * attempt, the target- and harness-keyed execution caches, the inject-mode
   * integrations retained between runs, and the unkeyed ones whose terminals
   * are retained for the rest of the run.
   */
  private *getLivePtyIntegrationCandidates(): Generator<HarnessIntegration> {
    for (const resource of this.activeTargetResources.values()) {
      if (resource.integration) {
        yield resource.integration;
      }
    }
    yield* this.targetExecutionIntegrations.values();
    yield* this.executionIntegrations.values();
    yield* this.liveInjectIntegrations.values();
    yield* this.unkeyedExecutionIntegrations;
  }

  /**
   * Find the integration that owns an interactive PTY session.
   *
   * Match on the integration's own activity session id rather than
   * `ActiveTargetResources.ptySessionId`: that field is only ever populated by
   * `registerTargetPtySession`, which the executor calls for interactive
   * *script* PTYs. An AI-CLI TUI is spawned by `CliTransportCoordinator`, which
   * reports its session through `getActivitySessionId()` — so a mid-run steer
   * resolves here and nowhere else.
   */
  private findIntegrationForPtySession(
    sessionId: string
  ): HarnessIntegration | undefined {
    for (const integration of this.getLivePtyIntegrationCandidates()) {
      if (integration.getActivitySessionId() === sessionId) {
        return integration;
      }
    }

    return undefined;
  }

  /**
   * Retire every *other* live harness process in this workflow that still owns
   * `aiSessionId`, then drop its terminal tab.
   *
   * Sibling terminals are the point of the spawn-identity integration caches —
   * a model or MCP change spawns beside the previous step's TUI instead of
   * replacing it. That is only safe while the siblings own different
   * conversations: a step that changes a spawn-time property while still
   * resuming the previous step's session would otherwise `--resume` a session
   * the retained TUI still has open, which every harness rejects or corrupts.
   * The dispatching integration asks for this immediately before it spawns
   * (`CliIntegration.retireConflictingSiblingPty`), so the kill is ordered
   * before the takeover rather than racing it.
   *
   * The tab goes with the process: the incoming terminal continues that very
   * conversation, so leaving the dead one behind shows the same session twice.
   */
  private async releaseConflictingAiSession(
    aiSessionId: string,
    requester: HarnessIntegration
  ): Promise<void> {
    const visited = new Set<HarnessIntegration>();
    for (const integration of this.getLivePtyIntegrationCandidates()) {
      if (integration === requester || visited.has(integration)) {
        continue;
      }
      visited.add(integration);
      if (!integration.ownsLiveAiSession(aiSessionId)) {
        continue;
      }

      const ptySessionId = await integration.releaseLiveAiSession(aiSessionId);
      Log.info(
        `[inst:${this.id.slice(0, 8)}] Retired terminal ${ptySessionId?.slice(0, 8) ?? "(none)"} — its AI session ${aiSessionId} is being resumed by a new process`
      );
      if (ptySessionId) {
        ptyPostMessage({
          type: MESSAGE_TYPES.TERMINAL_REMOVED,
          workflowId: this.id,
          sessionId: ptySessionId,
        });
      }
    }
  }

  /** Send a steer message directly to a live AI-CLI PTY session. */
  async sendSteerMessage(sessionId: string, text: string): Promise<void> {
    const session = getPtyProcessManager()?.getSession(sessionId);
    if (
      !session ||
      session.workflowId !== this.id ||
      session.kind !== SESSION_KINDS.AI_CLI ||
      session.status !== TERMINAL_SESSION_STATUS.RUNNING
    ) {
      throw new Error(
        "That harness session has ended. The steer message was not sent."
      );
    }

    const integration = this.findIntegrationForPtySession(sessionId);
    if (!integration) {
      throw new Error("No live harness session for this workflow.");
    }

    const sent = await integration.sendSteerMessage(text);
    if (!sent) {
      throw new Error(
        "That harness session has ended. The steer message was not sent."
      );
    }
  }

  private createIntegrationForMode(
    harnessOverride?: HarnessId,
    target?: WorkflowAttemptTarget,
    resolvedProperties?: ResolvedProperties
  ): HarnessIntegration {
    const harness =
      resolvedProperties?.harness ??
      harnessOverride ??
      ConfigurationUtils.getIntegrationMode();
    const targetKey = target
      ? this.getExecutionTargetRunKey(target)
      : undefined;

    if (targetKey) {
      const targetCached = this.targetExecutionIntegrations.get(targetKey);
      if (targetCached) {
        return targetCached;
      }

      if (harnessOverride) {
        Log.info(
          `[WorkflowInstance] Using harness override: ${harnessOverride}`
        );
      }
      const targetIntegration = this.createExecutionIntegration(harness);
      this.targetExecutionIntegrations.set(targetKey, targetIntegration);
      return targetIntegration;
    }

    // Calls made before the executor has resolved a prompt (notably the initial
    // setup integration) cannot identify a compatible cache entry safely. Keep
    // that integration provisional; prompt selection below resolves the exact
    // spawn-identity key before it is used for a prompt.
    if (!resolvedProperties) {
      return this.createUnkeyedExecutionIntegration(harness);
    }

    const integrationKey = this.getSequentialIntegrationKey(resolvedProperties);

    // A fresh-session prompt must never reuse an existing integration, even
    // when its other spawn-time properties happen to match a previous prompt.
    // It does, however, become the conversation that spawn identity now names:
    // the next compatible prompt auto-resumes the session this one is about to
    // create, so it has to select this integration rather than the superseded
    // one still holding the older session.
    if (!resolvedProperties.resumeSession) {
      const fresh = this.createExecutionIntegration(harness);
      this.claimSpawnIdentityKey(integrationKey, fresh);
      return fresh;
    }

    // If a live integration from the previous run is waiting in liveInjectIntegrations,
    // promote it into executionIntegrations immediately — before checking the cache or
    // creating a new instance. This ensures the live one wins even when
    // executeLoadedPromptFile calls createIntegrationForMode() before startWorkflowExecution
    // has a chance to run its own restore loop.
    const live = this.liveInjectIntegrations.get(integrationKey);
    if (live) {
      this.liveInjectIntegrations.delete(integrationKey);
      if (!this.canReuseExecutionIntegration(live)) {
        void this.cleanupRetainedIntegrationArtifacts(integrationKey, live);
        live.closeTerminalGracefully(TERMINAL_END_REASONS.SUPERSEDED);
        live.dispose();
      } else {
        live.resetForNewRun();
        live.setSourceDefinitionPath(this.sourceDefinitionPath);
        this.executionIntegrations.set(integrationKey, live);
        Log.info(
          `[inst:${this.id.slice(0, 8)}] Reusing live inject integration (key=${integrationKey}) from previous run`
        );
        return live;
      }
    }

    const cached = this.executionIntegrations.get(integrationKey);
    if (cached) {
      cached.setSourceDefinitionPath(this.sourceDefinitionPath);
      Log.debug(
        `[WorkflowInstance] Reusing cached integration for key: ${integrationKey}`
      );
      return cached;
    }
    if (harnessOverride) {
      Log.info(`[WorkflowInstance] Using harness override: ${harnessOverride}`);
    }
    const integration = this.createExecutionIntegration(harness);
    this.executionIntegrations.set(integrationKey, integration);
    return integration;
  }

  /**
   * Make `integration` the conversation `integrationKey` names, demoting
   * whatever held that key. The superseded integration keeps its terminal —
   * nothing about it conflicts with the new process — but no later prompt can
   * resolve to it, so ownership moves to the unkeyed set that disposes with the
   * run.
   */
  private claimSpawnIdentityKey(
    integrationKey: string,
    integration: HarnessIntegration
  ): void {
    const superseded =
      this.executionIntegrations.get(integrationKey) ??
      this.liveInjectIntegrations.get(integrationKey);
    if (superseded && superseded !== integration) {
      this.executionIntegrations.delete(integrationKey);
      this.liveInjectIntegrations.delete(integrationKey);
      if (
        this.retainedIntegrationArtifactContexts.get(integrationKey)
          ?.integration === superseded
      ) {
        this.retainedIntegrationArtifactContexts.delete(integrationKey);
      }
      this.unkeyedExecutionIntegrations.add(superseded);
      Log.info(
        `[inst:${this.id.slice(0, 8)}] Superseded integration for key ${integrationKey}; its terminal stays open but no longer receives prompts`
      );
    }
    this.executionIntegrations.set(integrationKey, integration);
  }

  private getSequentialIntegrationKey(
    resolvedProperties: ResolvedProperties
  ): string {
    return `${resolvedProperties.harness}::${spawnIdentityHash(
      resolvedProperties
    )}`;
  }

  private createUnkeyedExecutionIntegration(
    harness: HarnessId
  ): HarnessIntegration {
    const integration = this.createExecutionIntegration(harness);
    this.unkeyedExecutionIntegrations.add(integration);
    return integration;
  }

  /** Build a configured execution integration without registering it anywhere. */
  private createExecutionIntegration(harness: HarnessId): HarnessIntegration {
    const integration = this.integrationFactory.createForExecution(
      harness,
      this.executionWorkspace
    );
    this.configureExecutionIntegration(integration);
    return integration;
  }

  private async getHarnessReadinessError(
    harnessId: HarnessId
  ): Promise<string | undefined> {
    const integration = this.getDetectorIntegration(harnessId);
    let status = integration.getDetailedStatus();
    if (status.initializationStatus === HarnessStatus.Initializing) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          subscription.dispose();
          clearTimeout(timer);
          resolve();
        };
        const subscription = integration.onDidChangeStatus(settle);
        const timer = setTimeout(settle, 35_000);
      });
      status = integration.getDetailedStatus();
    }
    return status.initializationStatus === HarnessStatus.Ready
      ? undefined
      : status.message || "Harness is unavailable";
  }

  private configureExecutionIntegration(integration: HarnessIntegration): void {
    integration.setWorkflowName(this.workflowName || undefined);
    integration.setSourceDefinitionPath(this.sourceDefinitionPath);
    integration.onStreamingEvents((events) =>
      this._streamingEventsEmitter.fire(events)
    );
    integration.onStreamingChunk((chunk) =>
      this._streamingChunkEmitter.fire(chunk)
    );
    integration.onResponseComplete((response) =>
      this._responseCompleteEmitter.fire(response)
    );
    integration.onNotificationEvent((event) =>
      this.dashboardSink?.notifyNotificationEvent?.(event)
    );
    // Wired once at creation (not per-run) so `SessionActivityWatcher` activity
    // captured between step completions — not just after the whole workflow
    // finishes — reaches the dashboard/history. The integration instance
    // persists across runs when parked in `liveInjectIntegrations`, so this
    // subscription persists with it.
    integration.onSessionActivityResumed((payload) => {
      void this.handleSessionActivityResumed(
        payload.events,
        integration,
        integration.getActivitySessionId()
      );
    });
  }

  private async configureExecutionWorkspace(
    executionWorkspace: ExecutionWorkspace
  ): Promise<void> {
    const identity = getExecutionWorkspaceIdentity(executionWorkspace);
    if (identity === this.executionWorkspaceIdentity) return;

    this.endConditionEvaluator.dispose();
    this.executionWorkspace = executionWorkspace;
    this.executionWorkspaceIdentity = identity;
    this.endConditionEvaluator = new EndConditionEvaluator(
      this.platform,
      executionWorkspace
    );
    this.endConditionHandler = new EndConditionHandler(
      this.endConditionEvaluator,
      this.promptQueue,
      this.statusMessageReporter,
      this.userFeedbackSink
    );
    this.workflowExecutor = new WorkflowExecutor(
      this.promptQueue,
      this.endConditionHandler,
      this.endConditionEvaluator,
      this.platform,
      this.userFeedbackSink
    );
  }

  private createWorktreeSetupRunner(
    historyFilePath: string
  ): WorktreeSetupRunner {
    return {
      run: async (args) => {
        const processRunner = new ScriptProcessRunner(args.executionRoot);
        const reporter = new ScriptExecutionReporter(
          this.endConditionEvaluator
        );
        let processResult: ScriptProcessResult | undefined;
        try {
          await reporter.report({
            context: {
              executionWorkspace: {
                ...this.executionWorkspace,
                executionRoot: args.executionRoot,
              },
              workspaceFolderPath: args.executionRoot,
              historyFilePath,
              statusReporter: this.statusMessageReporter,
              dashboardProvider: this.dashboardSink,
              outputHistoryManager: this.outputHistoryManager,
              getDefinitionRevisionContext: () =>
                this.getDefinitionRevisionContext(),
              onScriptOutput: (target, output) =>
                this._targetedScriptOutputEmitter.fire({ target, output }),
              onScriptCompletedOutput: (target, output) =>
                this._targetedScriptOutputEmitter.fire({ target, output }),
            } satisfies ScriptExecutionReporterContext,
            source: SCRIPT_OUTPUT_SOURCES.WORKTREE_SETUP,
            properties: resolveReportedScriptProperties({
              script: args.command,
              compareSource: COMPARE_SOURCES.EXIT_CODE,
            }),
            phase: EXECUTION_PHASES.WORKTREE_SETUP,
            target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
            signedStepIndex: 0,
            runIndex: 0,
            attemptIndex: args.attemptIndex,
            timestampMs: Date.now(),
            onPass: CONDITION_ACTIONS.CONTINUE,
            onFail: CONDITION_ACTIONS.STOP_WORKFLOW,
            actionForErrored: CONDITION_ACTIONS.STOP_WORKFLOW,
            statusLabel:
              SCRIPT_SOURCE_LABELS[SCRIPT_OUTPUT_SOURCES.WORKTREE_SETUP],
            emitStatus: false,
            vars: args.vars,
            evaluate: async (onOutput): Promise<EvaluationResult> => {
              const startedAt = Date.now();
              const invocation = resolveScriptInvocation(args.command);
              processResult = await processRunner.run({
                cwd: args.executionRoot,
                timeout: args.timeoutMs,
                argv: invocation.argv,
                vars: args.vars,
                onOutput,
                windowsVerbatimArguments: invocation.windowsVerbatimArguments,
              });
              const comparison = this.endConditionEvaluator.evaluateResult(
                {
                  result: processResult.result,
                  stdout: processResult.stdout,
                  stderr: processResult.stderr,
                  exitCode: processResult.exitCode,
                  success: processResult.success,
                },
                { compareSource: COMPARE_SOURCES.EXIT_CODE }
              );
              return {
                ...comparison,
                errored: processResult.errored ?? false,
                stdout: comparison.stdout,
                stderr: comparison.stderr,
                result: comparison.result,
                error: processResult.error,
                timeout: processResult.timeout,
                duration: Date.now() - startedAt,
                exitCode: processResult.exitCode,
              };
            },
          });
          if (!processResult) {
            throw new Error("Worktree setup did not produce a process result");
          }
          return processResult;
        } finally {
          processRunner.dispose();
        }
      },
    };
  }

  private async getNextWorktreeSetupAttemptIndex(
    historyFilePath: string
  ): Promise<number> {
    if (!historyFilePath) {
      return 0;
    }
    try {
      return await this.outputHistoryManager.findNextAttemptIndexForPhase(
        historyFilePath,
        EXECUTION_PHASES.WORKTREE_SETUP
      );
    } catch (error) {
      Log.warn(
        `[inst:${this.id.slice(0, 8)}] Failed to read prior worktree setup attempts:`,
        error
      );
      return 0;
    }
  }

  /**
   * Turns a caught execution-start error into the text shown to the user via
   * notifyUserFeedback/updateStatusMessage. Only ExecutionLeaseConflictError
   * gets special handling — everything else keeps its plain message.
   */
  private async describeExecutionFailure(error: unknown): Promise<string> {
    if (error instanceof ExecutionLeaseConflictError) {
      return this.describeLeaseConflict(error);
    }
    return new WorkflowStartupPipeline(
      this.createWorkflowStartupPipelinePort()
    ).describeExecutionFailure(error);
  }

  /**
   * A lease conflict is common and actionable — unlike most execution
   * errors, the fix is simply "wait for or stop the other run" — so it gets
   * a message naming the worktree and the owning workflow instead of
   * ExecutionRootLeaseManager's technical detail (workflowKey/runRef/PID).
   * ExecutionRootLeaseManager itself stays generic (shared-native leases
   * have no worktree at all), so this enrichment happens here rather than
   * there.
   */
  private async describeLeaseConflict(
    error: ExecutionLeaseConflictError
  ): Promise<string> {
    return new WorkflowStartupPipeline(
      this.createWorkflowStartupPipelinePort()
    ).describeLeaseConflict(error);
  }

  private async prepareExecutionWorktree(
    historyFilePath: string
  ): Promise<void> {
    const config = this.worktreeResolution.config;
    if (!config) {
      await this.abandonActiveWorktree();
      await this.configureExecutionWorkspace(this.defaultExecutionWorkspace);
      return;
    }
    if (this.activeWorktree && this.executionLease) {
      await this.configureExecutionWorkspace(
        this.activeWorktree.executionWorkspace
      );
      return;
    }

    const state = this.promptQueue.getState();
    const sourceCheckoutRoot =
      this.workspaceFolderPath ?? this.platform.getWorkspaceRoot();
    if (!sourceCheckoutRoot || !state.workflowKey || !state.runRef) {
      throw new Error(
        "Named worktree execution requires a promoted workflow run and Git workspace."
      );
    }

    const setupAttemptIndex = config.setup?.trim()
      ? await this.getNextWorktreeSetupAttemptIndex(historyFilePath)
      : 0;
    const sharedOptions = {
      sourceCheckoutRoot,
      base: config.base,
      stateRoot: this.executionWorkspace.stateRoot,
      workspaceRoots: this.platform.getWorkspaceRoots(),
      namedWorkspaceRoots: this.platform.getNamedWorkspaceRoots(),
      approvedExternalRoots: this.executionWorkspace.approvedExternalRoots,
      workflowKey: state.workflowKey,
      runRef: state.runRef,
      runner: isCli() ? RUNNER_IDS.CLI : RUNNER_IDS.VSCODE,
      instanceId: this.id,
      worktree: this.worktreeResolution,
      setup: config.setup,
      vars: this.promptQueue.getWorkflowFile().vars,
      setupAttemptIndex,
      worktreeSetupRunner: this.createWorktreeSetupRunner(historyFilePath),
      reportUnresolvedVariables: (placeholders: readonly string[]) =>
        this.reportUnresolvedWorktreeVariables(
          placeholders,
          PropertyResolver.resolveHarnessValue(
            undefined,
            this.promptQueue.getWorkflowFile().harness
          )
        ),
    } as const;
    const info =
      config.mode === WORKTREE_MODES.MANAGED
        ? await this.worktreeManager.ensureManagedWorktree({
            ...sharedOptions,
            workflowName:
              this.promptQueue.getState().workflowName || this.workflowName,
            targetBranch: undefined,
          })
        : config.branch
          ? await this.worktreeManager.resolveNamedWorktree({
              ...sharedOptions,
              branchName: config.branch,
            })
          : (() => {
              throw new Error("Named worktree execution requires a branch.");
            })();
    if (this.activeWorktree) {
      this.worktreeManager.releaseRuntimeTrust(this.activeWorktree);
    }
    this.activeWorktree = info;
    this.activeWorktreeSettlement = {
      merge: config.mode === WORKTREE_MODES.MANAGED && config.merge === true,
      keep: config.mode === WORKTREE_MODES.MANAGED && config.keep === true,
    };
    this.executionLease = info.lease;
    await this.configureExecutionWorkspace(info.executionWorkspace);
  }

  /**
   * Settle and release a worktree this run was using before it was resumed
   * onto no worktree — e.g. paused mid-run, then the workflow's worktree
   * config was edited to "none" before resuming. The normal
   * terminal-completion cleanup in `startWorkflowExecution`'s `finally`
   * never runs for this transition (the run isn't ending), so this is the
   * only place that settles it; without it, `activeWorktree` would linger
   * stale for the rest of the run, still reporting a worktree this run no
   * longer executes in.
   */
  private async abandonActiveWorktree(): Promise<void> {
    const worktree = this.activeWorktree;
    if (!worktree) return;
    const settlement = this.activeWorktreeSettlement;
    this.activeWorktree = undefined;
    this.activeWorktreeSettlement = undefined;

    // Any PTY retained across the pause for reuse belongs to the worktree
    // being abandoned and cannot follow execution to the new workspace —
    // settlement below must not race a still-live process in that directory.
    for (const [harnessKey, liveIntegration] of this.liveInjectIntegrations) {
      await this.cleanupRetainedIntegrationArtifacts(
        harnessKey,
        liveIntegration
      );
      liveIntegration.closeTerminalGracefully(
        TERMINAL_END_REASONS.WORKTREE_RELEASED
      );
      liveIntegration.dispose();
    }
    this.liveInjectIntegrations.clear();

    this.worktreeManager.releaseRuntimeTrust(worktree);

    if (worktree.mode === WORKTREE_MODES.MANAGED) {
      try {
        await this.worktreeManager.completeManagedRun(worktree, {
          merge: settlement?.merge === true,
          keep: settlement?.keep === true,
          artifactsClean: true,
        });
      } catch (error) {
        Log.error(
          `[inst:${this.id.slice(0, 8)}] Failed to settle abandoned managed worktree:`,
          error
        );
        await worktree.lease?.release().catch(() => undefined);
      }
      this.executionLease = undefined;
    } else if (this.executionLease) {
      const lease = this.executionLease;
      this.executionLease = undefined;
      await lease
        .release()
        .catch((err) =>
          Log.warn(
            `[inst:${this.id.slice(0, 8)}] Failed to release abandoned worktree lease:`,
            err
          )
        );
    }
  }

  private async ensureRunnerLock(workingFilePath?: string): Promise<void> {
    return this.runnerLockCoordinator.ensureRunnerLock(workingFilePath);
  }

  private stopStopRequestPolling(): void {
    this.runnerLockCoordinator.stopStopRequestPolling();
  }

  private async releaseRunnerLock(): Promise<void> {
    return this.runnerLockCoordinator.releaseRunnerLock();
  }

  private startRunnerLockHeartbeat(
    workspaceRoot: string,
    workflowKey: WorkflowKey
  ): void {
    this.runnerLockCoordinator.startHeartbeat(workspaceRoot, workflowKey);
  }

  private stopRunnerLockHeartbeat(): void {
    this.runnerLockCoordinator.stopHeartbeat();
  }

  private async startWorkflowExecution(
    integration?: HarnessIntegration,
    historyFilePath = this.resolveHistoryFilePath(),
    workingFilePath?: string,
    targetRunIndices?: Map<string, number>
  ): Promise<void> {
    await new WorkflowStartupPipeline(
      this.createWorkflowStartupPipelinePort()
    ).startWorkflowExecution(
      integration,
      historyFilePath,
      workingFilePath,
      targetRunIndices
    );
  }

  private async restoreRetainedExecutionIntegrations(): Promise<void> {
    Log.debug(
      `[inst:${this.id.slice(0, 8)}] startWorkflowExecution: retained same-run integrations available=${this.liveInjectIntegrations.size}`
    );
    for (const [integrationKey, liveIntegration] of this
      .liveInjectIntegrations) {
      if (!this.canReuseExecutionIntegration(liveIntegration)) {
        this.liveInjectIntegrations.delete(integrationKey);
        await this.cleanupRetainedIntegrationArtifacts(
          integrationKey,
          liveIntegration
        );
        liveIntegration.closeTerminalGracefully(
          TERMINAL_END_REASONS.SUPERSEDED
        );
        liveIntegration.dispose();
        continue;
      }
      liveIntegration.resetForNewRun();
      this.executionIntegrations.set(integrationKey, liveIntegration);
      Log.info(
        `[inst:${this.id.slice(0, 8)}] Restored live inject integration (key=${integrationKey}) at workflow start`
      );
    }
    this.liveInjectIntegrations.clear();
  }

  private async settleWorkflowExecution(options: {
    historyFilePath: string;
    workingFilePath: string | undefined;
  }): Promise<void> {
    const paused =
      this.workflowRuntime.status === EXECUTION_STATES.PAUSED ||
      this.workflowRuntime.status === EXECUTION_STATES.PAUSING;
    const pausedWorktreeReservation =
      paused && Boolean(this.executionWorkspace.worktree);
    const namedWorktreeInjectRetention =
      !paused &&
      this.activeWorktree?.mode === "named" &&
      ConfigurationUtils.isInjectModeEnabled() &&
      Array.from(this.executionIntegrations.values()).some((integration) =>
        integration.canReuseForInject()
      );
    const preserveWorktreeReservation =
      pausedWorktreeReservation || namedWorktreeInjectRetention;
    const terminalWorktreeRun =
      !preserveWorktreeReservation && Boolean(this.activeWorktree);
    const managedTerminalRun =
      terminalWorktreeRun &&
      this.activeWorktree?.mode === WORKTREE_MODES.MANAGED;
    const workspaceRoot =
      this.workspaceFolderPath ?? this.platform.getWorkspaceRoot();
    const integrationCleanup = await this.settleExecutionIntegrations(
      options,
      preserveWorktreeReservation,
      terminalWorktreeRun,
      workspaceRoot
    );
    const retainedCleanup = await this.settleRetainedIntegrations(
      options,
      terminalWorktreeRun,
      workspaceRoot,
      integrationCleanup.strictArtifactCleanupSucceeded,
      integrationCleanup.strictArtifactCleanupMessage
    );
    await this.settleActiveExecutionWorktree(
      terminalWorktreeRun,
      managedTerminalRun,
      retainedCleanup.strictArtifactCleanupSucceeded,
      retainedCleanup.strictArtifactCleanupMessage
    );
    await this.releaseExecutionReservations(
      preserveWorktreeReservation,
      managedTerminalRun
    );
    await this.finishExecutionHistory(options.historyFilePath);
  }

  private async settleExecutionIntegrations(
    options: { historyFilePath: string; workingFilePath: string | undefined },
    preserveWorktreeReservation: boolean,
    terminalWorktreeRun: boolean,
    workspaceRoot: string
  ): Promise<{
    strictArtifactCleanupSucceeded: boolean;
    strictArtifactCleanupMessage: string | undefined;
  }> {
    let strictArtifactCleanupSucceeded = true;
    let strictArtifactCleanupMessage: string | undefined;
    this.lastRunIntegrations = [];
    Log.debug(
      `[inst:${this.id.slice(0, 8)}] startWorkflowExecution finally: executionIntegrations.size=${this.executionIntegrations.size}`
    );
    const executionIntegrationEntries = [
      ...this.executionIntegrations.entries(),
      ...Array.from(
        this.unkeyedExecutionIntegrations,
        (execIntegration, index) =>
          [`unkeyed:${index}`, execIntegration] as const
      ),
    ];
    for (const [harnessKey, execIntegration] of executionIntegrationEntries) {
      const isUnkeyedIntegration =
        this.unkeyedExecutionIntegrations.has(execIntegration);
      const retainIntegration =
        !isUnkeyedIntegration &&
        ((preserveWorktreeReservation && execIntegration.canReuseForInject()) ||
          (!this.executionWorkspace.worktree &&
            (execIntegration.canReuseForInject() ||
              execIntegration.shouldPersistForSessionActivity())));
      if (retainIntegration) {
        // Either the PTY is still alive with inject context set (CLI), or the
        // integration wants to stay alive for its own post-completion session
        // watcher (non-PTY harness). Keep it alive for the next run rather
        // than destroying it. Store under the same map key so the restore code
        // can insert it where createIntegrationForMode looks. Register a
        // one-shot exit callback so we dispose it if the terminal is killed
        // between runs (no-op for non-PTY harnesses).
        this.liveInjectIntegrations.set(harnessKey, execIntegration);
        if (
          workspaceRoot &&
          execIntegration.shouldRetainWorkflowArtifactsForReuse()
        ) {
          this.retainedIntegrationArtifactContexts.set(harnessKey, {
            integration: execIntegration,
            workingFilePath: options.workingFilePath,
            workspaceRoot: execIntegration.getExecutionRoot() ?? workspaceRoot,
          });
        } else {
          await this.cleanupRetainedIntegrationArtifacts(
            harnessKey,
            execIntegration,
            options.workingFilePath,
            workspaceRoot
          );
        }
        execIntegration.onPtySessionEnded(() => {
          if (this.liveInjectIntegrations.get(harnessKey) === execIntegration) {
            this.liveInjectIntegrations.delete(harnessKey);
          }
          void this.cleanupRetainedIntegrationArtifacts(
            harnessKey,
            execIntegration
          ).finally(() => {
            execIntegration.dispose();
            void this.releaseNamedWorktreeRetentionAfterPtyExit();
          });
        });
      } else {
        // A worktree-targeted terminal run cannot park a PTY or watcher:
        // cleanup is the barrier that makes the lease safe to release.
        // Dispose first so no background reader can recreate an artifact
        // while provider cleanup is proving the directory clean.
        if (terminalWorktreeRun) {
          execIntegration.closeTerminalGracefully(
            TERMINAL_END_REASONS.WORKTREE_RELEASED
          );
          execIntegration.dispose();
        }
        const cleanup = await this.cleanupIntegrationArtifactsForSettlement(
          harnessKey,
          execIntegration,
          options.workingFilePath,
          execIntegration.getExecutionRoot() ?? workspaceRoot,
          terminalWorktreeRun
        );
        if (!cleanup.cleaned) {
          strictArtifactCleanupSucceeded = false;
          strictArtifactCleanupMessage = [
            strictArtifactCleanupMessage,
            cleanup.message,
          ]
            .filter(Boolean)
            .join("; ");
        }
        // Normal path: terminal closed or inject mode not active — dispose now
        // and save so the next run can close any VS Code terminal tab left open.
        if (!terminalWorktreeRun) {
          this.lastRunIntegrations.push(execIntegration);
          execIntegration.dispose();
        }
      }
    }
    this.executionIntegrations.clear();
    this.unkeyedExecutionIntegrations.clear();

    for (const targetIntegration of this.targetExecutionIntegrations.values()) {
      targetIntegration.closeTerminalGracefully(
        terminalWorktreeRun
          ? TERMINAL_END_REASONS.WORKTREE_RELEASED
          : TERMINAL_END_REASONS.STEP_COMPLETE
      );
      targetIntegration.dispose();
    }
    this.targetExecutionIntegrations.clear();
    for (const runner of this.targetScriptProcessRunners.values()) {
      runner.dispose();
    }
    this.targetScriptProcessRunners.clear();
    this.activeTargetResources.clear();

    return { strictArtifactCleanupSucceeded, strictArtifactCleanupMessage };
  }

  private async settleRetainedIntegrations(
    options: { historyFilePath: string; workingFilePath: string | undefined },
    terminalWorktreeRun: boolean,
    workspaceRoot: string,
    strictArtifactCleanupSucceeded: boolean,
    strictArtifactCleanupMessage: string | undefined
  ): Promise<{
    strictArtifactCleanupSucceeded: boolean;
    strictArtifactCleanupMessage: string | undefined;
  }> {
    // A retained entry can survive an unusual handoff path even when it was
    // not reinserted into executionIntegrations. It is still part of the
    // worktree cleanup barrier and must never outlive the lease.
    if (terminalWorktreeRun) {
      for (const [harnessKey, retained] of this.liveInjectIntegrations) {
        retained.closeTerminalGracefully(
          TERMINAL_END_REASONS.WORKTREE_RELEASED
        );
        retained.dispose();
        const cleanup = await this.cleanupIntegrationArtifactsForSettlement(
          harnessKey,
          retained,
          options.workingFilePath,
          retained.getExecutionRoot() ?? workspaceRoot,
          true
        );
        if (!cleanup.cleaned) {
          strictArtifactCleanupSucceeded = false;
          strictArtifactCleanupMessage = [
            strictArtifactCleanupMessage,
            cleanup.message,
          ]
            .filter(Boolean)
            .join("; ");
        }
      }
      this.liveInjectIntegrations.clear();
    }

    return { strictArtifactCleanupSucceeded, strictArtifactCleanupMessage };
  }

  private async settleActiveExecutionWorktree(
    terminalWorktreeRun: boolean,
    managedTerminalRun: boolean,
    strictArtifactCleanupSucceeded: boolean,
    strictArtifactCleanupMessage: string | undefined
  ): Promise<void> {
    if (terminalWorktreeRun && this.activeWorktree) {
      const worktree = this.activeWorktree;
      // Runtime trust is only needed while integrations are live. Remove it
      // before the Git landing guard/commit, as required by finalization order.
      this.worktreeManager.releaseRuntimeTrust(worktree);
      if (managedTerminalRun) {
        try {
          await this.worktreeManager.completeManagedRun(worktree, {
            merge:
              this.worktreeResolution.config?.mode === WORKTREE_MODES.MANAGED &&
              this.worktreeResolution.config.merge === true,
            keep:
              this.worktreeResolution.config?.mode === WORKTREE_MODES.MANAGED &&
              this.worktreeResolution.config.keep === true,
            artifactsClean: strictArtifactCleanupSucceeded,
            cleanupMessage: strictArtifactCleanupMessage,
          });
        } catch (error) {
          Log.error(
            `[inst:${this.id.slice(0, 8)}] Managed worktree settlement failed:`,
            error
          );
          await worktree.lease?.release().catch(() => undefined);
        }
      }
      if (managedTerminalRun) {
        this.executionLease = undefined;
      }
      this.activeWorktree = undefined;
    }
  }

  private async releaseExecutionReservations(
    preserveWorktreeReservation: boolean,
    managedTerminalRun: boolean
  ): Promise<void> {
    // A worktree lease is released only after every process, watcher,
    // sidecar, and workspace artifact owned by the run is gone. Otherwise a
    // retained integration could still mutate a directory after its lease
    // was handed to another run.
    if (!preserveWorktreeReservation) {
      this.stopRunnerLockHeartbeat();
      this.stopStopRequestPolling();
    }
    if (
      !preserveWorktreeReservation &&
      !managedTerminalRun &&
      this.executionLease
    ) {
      const lease = this.executionLease;
      this.executionLease = undefined;
      await lease
        .release()
        .catch((err) =>
          Log.warn(
            `[inst:${this.id.slice(0, 8)}] startWorkflowExecution: failed to release execution lease:`,
            err
          )
        );
    }
    if (!preserveWorktreeReservation) {
      await this.releaseRunnerLock().catch((err) =>
        Log.warn(
          `[inst:${this.id.slice(0, 8)}] startWorkflowExecution: failed to release lock:`,
          err
        )
      );
    }
  }

  private async finishExecutionHistory(historyFilePath: string): Promise<void> {
    await this.pendingRuntimeTransitionHistoryWrite;

    if (historyFilePath) {
      const runStepCount = this.promptQueue.getProgress().total;
      await this.outputHistoryManager
        .finalizeRun(
          historyFilePath,
          this.getAuthoritativeExecutionState() as Parameters<
            OutputHistoryManager["finalizeRun"]
          >[1],
          runStepCount,
          this.promptQueue.getState().totalExecutionTime
        )
        .catch((err) =>
          Log.warn(
            `[inst:${this.id.slice(0, 8)}] Failed to finalize history run:`,
            err
          )
        );
    }
    this.releaseActiveRunRedactor?.();
    this.releaseActiveRunRedactor = undefined;
    this.activeRunRedactor = undefined;
    this.startPending = false;
    this.resolveExecutionSettled?.();
    this.resolveExecutionSettled = undefined;
  }
  private async releaseNamedWorktreeRetentionAfterPtyExit(): Promise<void> {
    const status = this.workflowRuntime.status;
    const executionStillOwnsReservation =
      status === EXECUTION_STATES.RUNNING ||
      status === EXECUTION_STATES.PAUSING ||
      status === EXECUTION_STATES.PAUSED ||
      status === EXECUTION_STATES.CANCELLING;
    const worktree = this.activeWorktree;
    const hasReusableInjectIntegration = Array.from(
      this.liveInjectIntegrations.values()
    ).some((integration) => integration.canReuseForInject());
    if (
      executionStillOwnsReservation ||
      hasReusableInjectIntegration ||
      worktree?.mode !== WORKTREE_MODES.NAMED
    ) {
      return;
    }

    this.worktreeManager.releaseRuntimeTrust(worktree);
    this.activeWorktree = undefined;
    if (this.runnerLockCoordinator.ownsLock() || this.executionLease) {
      this.stopRunnerLockHeartbeat();
      this.stopStopRequestPolling();
    }

    const lease = this.executionLease;
    this.executionLease = undefined;
    await lease
      ?.release()
      .catch((error) =>
        Log.warn(
          `[inst:${this.id.slice(0, 8)}] Failed to release retained named-worktree execution lease:`,
          error
        )
      );
    await this.releaseRunnerLock().catch((error) =>
      Log.warn(
        `[inst:${this.id.slice(0, 8)}] Failed to release retained named-worktree runner lock:`,
        error
      )
    );
  }

  private async cleanupRetainedIntegrationArtifacts(
    harnessKey: string,
    integration: HarnessIntegration,
    fallbackWorkingFilePath?: string,
    fallbackWorkspaceRoot?: string
  ): Promise<void> {
    const retainedContext =
      this.retainedIntegrationArtifactContexts.get(harnessKey);
    if (retainedContext?.integration === integration) {
      this.retainedIntegrationArtifactContexts.delete(harnessKey);
    }
    const workingFilePath =
      retainedContext?.integration === integration
        ? retainedContext.workingFilePath
        : fallbackWorkingFilePath;
    const workspaceRoot =
      retainedContext?.integration === integration
        ? retainedContext.workspaceRoot
        : fallbackWorkspaceRoot;
    if (!workspaceRoot) return;

    await integration
      .cleanupWorkflowArtifacts(workingFilePath, workspaceRoot)
      .catch((err) =>
        Log.warn(
          "[WorkflowInstance] Failed to clean up workflow artifacts:",
          err
        )
      );
  }

  private async cleanupIntegrationArtifactsForSettlement(
    harnessKey: string,
    integration: HarnessIntegration,
    workingFilePath: string | undefined,
    workspaceRoot: string,
    strict: boolean
  ): Promise<{ cleaned: boolean; message?: string }> {
    const retainedContext =
      this.retainedIntegrationArtifactContexts.get(harnessKey);
    if (retainedContext?.integration === integration) {
      this.retainedIntegrationArtifactContexts.delete(harnessKey);
    }
    const effectiveWorkingFilePath =
      retainedContext?.integration === integration
        ? retainedContext.workingFilePath
        : workingFilePath;
    const effectiveWorkspaceRoot =
      retainedContext?.integration === integration
        ? retainedContext.workspaceRoot
        : workspaceRoot;
    if (!strict) {
      await this.cleanupRetainedIntegrationArtifacts(
        harnessKey,
        integration,
        effectiveWorkingFilePath,
        effectiveWorkspaceRoot
      );
      return { cleaned: true };
    }
    const result = await integration.cleanupWorkflowArtifactsStrict(
      effectiveWorkingFilePath,
      effectiveWorkspaceRoot
    );
    return result.cleaned
      ? { cleaned: true }
      : { cleaned: false, message: result.failures.join("; ") };
  }

  private propagateWorkflowNameToIntegrations(): void {
    const state = this.promptQueue.getState();
    const name =
      state.workflowName ||
      (this.currentPromptFile
        ? PromptQueue.extractWorkflowName(this.currentPromptFile.filePath)
        : undefined);
    // Keep instance field in sync so createIntegrationForMode reads the right value.
    this.workflowName = name ?? "";
    // Push to all cached execution integrations created for this run.
    for (const integration of this.executionIntegrations.values()) {
      integration.setWorkflowName(name);
    }
    // Push to the detector singletons (terminal tab labeling for the idle harness).
    this.onWorkflowNameChange(name);
  }

  private setupPromptFileWatcher(filePath: string): void {
    this.promptFileWatcher.setupFileWatcher(
      filePath,
      async (changedFilePath: string) => {
        await this.promptFileLoader.reloadFromWorkingFile(
          changedFilePath,
          undefined,
          false,
          this.workspaceFolderPath ?? this.platform.getWorkspaceRoot()
        );

        const workingFile =
          await this.promptQueue.readWorkingFile(changedFilePath);
        if (workingFile?.steps) {
          const fp =
            (await this.readLineageOriginalFile(changedFilePath)) ??
            changedFilePath;
          this.currentPromptFile = {
            filePath: fp,
            promptFile: {
              steps: workingFile.steps,
              parallelGroups: workingFile.parallelGroups,
            },
          };
        }
      },
      (deletedFilePath: string) => {
        // A promoted draft is moved, not lost. `WorkingFileManager.finalizeRun`
        // removes `draft/workflow.ctrlyoke.json` once its content lives on in
        // `run-<ts>/workflow.ctrlyoke.json`, and the watcher is never
        // re-pointed off the draft — so that delete lands here, asynchronously,
        // often only after the user has already pressed Run again. The queue
        // has switched to the run's file by then, so a delete for anything
        // other than the queue's *current* working file means the definition
        // moved rather than disappeared. Clearing `currentPromptFile` on it
        // made the next Run bail at the "No prompt file loaded" guard and
        // silently do nothing — a real re-run-after-completion failure that
        // reproduced about half the time, purely on watcher delivery timing.
        const activeWorkingFile = this.promptQueue.getState().workingFilePath;
        if (
          activeWorkingFile &&
          !pathsEqual(activeWorkingFile, deletedFilePath)
        ) {
          return;
        }
        this.currentPromptFile = undefined;
      }
    );
  }

  private async readLineageOriginalFile(
    workingFilePath: string
  ): Promise<string | undefined> {
    const address =
      WorkflowPaths.parseWorkingFileAddressFromPath(workingFilePath);
    const workspaceRoot =
      this.workspaceFolderPath ?? this.platform.getWorkspaceRoot();
    if (!address || !workspaceRoot) return undefined;
    return (
      (
        await this.lineageRepository.tryReadDescriptor(
          workspaceRoot,
          address.workflowKey
        )
      )?.originalFile ?? undefined
    );
  }

  private getAuthoritativeExecutionState(): QueueState["status"] {
    return this.workflowRuntime.status;
  }

  /** Current definitionRevision + snapshot to commit before this revision's first output. */
  private getDefinitionRevisionContext(): DefinitionRevisionContext {
    const state = this.promptQueue.getState();
    return {
      definitionRevision: state.definitionRevision,
      definition: buildDefinitionSnapshot(
        state.workflowName ?? "",
        state.steps,
        undefined,
        this.promptQueue.getWorkflowFile().finalStep,
        this.promptQueue.getWorkflowFile().worktree,
        state.parallelGroups
      ),
    };
  }

  private reopenRuntimeForContinuationIfNeeded(
    willRunImmediately: boolean
  ): void {
    if (willRunImmediately) {
      return;
    }

    const status = this.workflowRuntime.status;
    if (
      status !== EXECUTION_STATES.COMPLETED &&
      status !== EXECUTION_STATES.ERROR
    ) {
      return;
    }

    Log.info(
      `[WorkflowInstance] appendSteps: Setting to STOPPED (appended to ${status} queue, ${this.promptQueue.getCompletedCount()} steps previously completed, user can Resume)`
    );
    this.workflowRuntime.reopenForContinuation();
  }

  private onRuntimeTransition(transition: WorkflowRuntimeTransition): void {
    if (
      transition.command === WORKFLOW_RUNTIME_COMMANDS.REOPEN_FOR_CONTINUATION
    ) {
      return;
    }

    // Resolved rather than read straight off the field: the transition that
    // starts a resume (paused -> running) fires *before* startWorkflowExecution
    // assigns the field, so a restored instance would otherwise drop the very
    // transition that reopens the run.
    const historyFilePath = this.resolveHistoryFilePath();
    if (historyFilePath) {
      this.pendingRuntimeTransitionHistoryWrite =
        this.pendingRuntimeTransitionHistoryWrite
          .then(() =>
            this.outputHistoryManager.appendRuntimeTransition(
              historyFilePath,
              transition
            )
          )
          .catch((error) => {
            Log.warn(
              `[inst:${this.id.slice(0, 8)}] Failed to persist runtime transition history:`,
              error
            );
          });
    }

    const state = this.promptQueue.getState();
    const runtimeTransitionDetails =
      `Runtime transition ${transition.command}: ${transition.previous.status} -> ${transition.current.status} ` +
      `(step ${state.currentIndex}/${state.steps.length})`;
    switch (transition.command) {
      case WORKFLOW_RUNTIME_COMMANDS.START_EXECUTION: {
        Log.info(`[inst:${this.id.slice(0, 8)}] Workflow started`);
        const workflowFile = this.promptQueue.getWorkflowFile();
        const hasEndCondition =
          workflowFile.endCondition != null ||
          state.steps.some(
            (step) => !isScriptStep(step) && step.endCondition != null
          );
        reportWorkflowStarted({
          harness: PropertyResolver.resolveHarnessValue(
            undefined,
            workflowFile.harness
          ),
          executionMode: PropertyResolver.resolveExecutionMode(
            { executionMode: undefined },
            workflowFile
          ),
          stepCount: state.steps.length,
          hasFinalStep:
            workflowFile.finalStep != null &&
            workflowFile.finalStep.enabled !== false,
          hasEndCondition,
          resumeSession: Boolean(workflowFile.resumeSession),
          dynamicQueueEnabled: state.parallelGroups.length > 0,
          mcpEnabled: Boolean(workflowFile.mcpServers?.length),
        });
        break;
      }
      case WORKFLOW_RUNTIME_COMMANDS.COMPLETE:
      case WORKFLOW_RUNTIME_COMMANDS.FAIL:
      case WORKFLOW_RUNTIME_COMMANDS.CONFIRM_STOPPED: {
        let outcome: WorkflowTelemetryOutcome;
        switch (transition.command) {
          case WORKFLOW_RUNTIME_COMMANDS.COMPLETE:
            Log.info(`[inst:${this.id.slice(0, 8)}] Workflow completed`);
            outcome = WORKFLOW_TELEMETRY_OUTCOMES.SUCCESS;
            break;
          case WORKFLOW_RUNTIME_COMMANDS.FAIL:
            Log.info(`[inst:${this.id.slice(0, 8)}] Workflow failed`);
            outcome = WORKFLOW_TELEMETRY_OUTCOMES.ERROR;
            break;
          default:
            Log.info(`[inst:${this.id.slice(0, 8)}] Workflow stopped`);
            outcome = WORKFLOW_TELEMETRY_OUTCOMES.CANCELLED;
            break;
        }
        const workflowFile = this.promptQueue.getWorkflowFile();
        reportWorkflowCompleted({
          harness: PropertyResolver.resolveHarnessValue(
            undefined,
            workflowFile.harness
          ),
          executionMode: PropertyResolver.resolveExecutionMode(
            { executionMode: undefined },
            workflowFile
          ),
          outcome,
          stepCount: state.steps.length,
          totalDurationMs: this.workflowRuntime.getActiveExecutionTime(),
        });
        break;
      }
      case WORKFLOW_RUNTIME_COMMANDS.REQUEST_STOP:
        Log.info(`[inst:${this.id.slice(0, 8)}] Workflow stopped`);
        break;
      default:
        Log.debug(`[inst:${this.id.slice(0, 8)}] ${runtimeTransitionDetails}`);
        break;
    }

    const executionState = this.getAuthoritativeExecutionState();

    if (this.dashboardSink) {
      this.dashboardSink.updateExecutionState(
        executionState,
        undefined,
        this.getActiveStepIndices()
      );
      if (transition.command === WORKFLOW_RUNTIME_COMMANDS.COMPLETE) {
        this.dashboardSink.updateExecutionCompleted?.();
      }
    }

    if (
      transition.command === WORKFLOW_RUNTIME_COMMANDS.CONFIRM_STOPPED &&
      this.pendingRunAfterCancel !== null
    ) {
      const { harness } = this.pendingRunAfterCancel;
      this.pendingRunAfterCancel = null;
      Log.info(
        `[inst:${this.id.slice(0, 8)}] onRuntimeTransition: firing deferred run after cancel completed`
      );
      this.executeLoadedPromptFile(harness, true).catch((err) =>
        Log.error(
          `[inst:${this.id.slice(0, 8)}] Failed to execute deferred run after cancel:`,
          err
        )
      );
    }
  }

  private onAttemptTransition(transition: WorkflowAttemptTransition): void {
    const target = transition.current.target;
    if (target.kind === FINAL_STEP_PHASES.QUEUE) {
      this.reportQueueAttemptTransition(transition, target.stepIndex);
    }

    // Every attempt transition, final-step ones included, changes the active
    // set. A final step begins without a workflow runtime transition (the run
    // stays `running`), so this is the only push that tells the dashboard its
    // signed index is live — skipping it leaves the final step's terminal
    // closeable while it runs.
    this.dashboardSink?.updateActiveStepIndices?.(this.getActiveStepIndices());
  }

  private reportQueueAttemptTransition(
    transition: WorkflowAttemptTransition,
    stepIndex: number
  ): void {
    const state = this.promptQueue.getState();
    const step = state.steps[stepIndex];

    switch (transition.command) {
      case WORKFLOW_ATTEMPT_COMMANDS.BEGIN:
        if (step) {
          const command = isScriptStep(step) ? step.script : step.prompt;
          const harness = isScriptStep(step)
            ? undefined
            : (step._runtime?.harness ??
              PropertyResolver.resolve(
                step,
                this.promptQueue.getWorkflowFile(),
                { hostCanProvidePty: this.hostCanProvidePty }
              ).harness);
          Log.info(
            `[inst:${this.id.slice(0, 8)}] Step ${stepIndex + 1}/${state.steps.length} started ` +
              `(attempt ${transition.current.attemptIndex + 1}, command="${command}"` +
              (harness ? `, harness=${harness}` : "") +
              ")"
          );
        } else {
          Log.info(
            `[inst:${this.id.slice(0, 8)}] Step ${stepIndex + 1} started ` +
              `(attempt ${transition.current.attemptIndex + 1})`
          );
        }
        if (transition.current.attemptIndex > 0) {
          this.dashboardSink?.updateStepStatus(stepIndex, {
            state: STEP_STATUS.RUNNING,
          });
        }
        break;
      case WORKFLOW_ATTEMPT_COMMANDS.SCHEDULE_RETRY:
        Log.debug(
          `[inst:${this.id.slice(0, 8)}] Step ${stepIndex + 1} retry scheduled ` +
            `(attempt ${transition.current.attemptIndex + 1})`
        );
        this.outputCaptureBuffer.captureRetryState(
          stepIndex,
          transition.current.retryCount ?? transition.current.attemptIndex,
          transition.current.maxRetries ?? DEFAULT_ERROR_BEHAVIOR_RETRIES
        );
        this.dashboardSink?.updateRetryAttempt(
          stepIndex,
          transition.current.retryCount ?? transition.current.attemptIndex,
          transition.current.maxRetries ?? DEFAULT_ERROR_BEHAVIOR_RETRIES
        );
        break;
      case WORKFLOW_ATTEMPT_COMMANDS.CANCEL:
        Log.debug(
          `[inst:${this.id.slice(0, 8)}] Step ${stepIndex + 1} cancelled ` +
            `(attempt ${transition.current.attemptIndex + 1})`
        );
        this.dashboardSink?.updateStepStatus(stepIndex, {
          state: STEP_STATUS.CANCELLED,
        });
        break;
      case WORKFLOW_ATTEMPT_COMMANDS.COMPLETE:
        Log.info(
          `[inst:${this.id.slice(0, 8)}] Step ${stepIndex + 1} completed ` +
            `(attempt ${transition.current.attemptIndex + 1})`
        );
        if (transition.current.attemptIndex > 0) {
          this.dashboardSink?.updateRetryAttempt(stepIndex, 0, 0);
        }
        break;
      case WORKFLOW_ATTEMPT_COMMANDS.FAIL:
        Log.info(
          `[inst:${this.id.slice(0, 8)}] Step ${stepIndex + 1} failed ` +
            `(attempt ${transition.current.attemptIndex + 1}, failureReason="${transition.current.failureReason ?? "unknown"}")`
        );
        break;
      default:
        break;
    }
  }

  private getCurrentCancellationTarget(): WorkflowAttemptTarget | undefined {
    const finalStepRuntime = this.promptQueue.getFinalStepRuntime();
    if (finalStepRuntime?.phase === FINAL_STEP_PHASES.FINAL_STEP) {
      return {
        kind: FINAL_STEP_PHASES.FINAL_STEP,
        loopIndex: finalStepRuntime.loopCount,
      };
    }

    const state = this.promptQueue.getState();
    if (state.currentIndex >= state.steps.length) {
      return undefined;
    }

    return {
      kind: FINAL_STEP_PHASES.QUEUE,
      stepIndex: state.currentIndex,
    };
  }

  private onQueueStateChanged(state: QueueState): void {
    const executionState = this.getAuthoritativeExecutionState();
    Log.debug(
      `[inst:${this.id.slice(0, 8)}] Queue state ${executionState} (step ${state.currentIndex}/${state.steps.length})`
    );
    this.onStatusBarUpdate();

    const suppressRuntimePromotionUndo = this.runtimePromotionUndoSuppressed;
    this.runtimePromotionUndoSuppressed = false;

    if (this.dashboardSink) {
      // Detect workflow name changes and push them to the dashboard immediately.
      const newWorkflowName = state.workflowName ?? "";
      if (newWorkflowName && newWorkflowName !== this.lastKnownWorkflowName) {
        this.dashboardSink.updateWorkflowName(
          newWorkflowName,
          undefined,
          state.definitionRevision
        );
      }

      // Active workflow: forward state changes directly to the dashboard.
      // Runtime transitions now flow through WorkflowStateMachine.onDidTransition.
      // Queue state changes stay responsible for queue topology updates only.
      // When prompts increase, piggyback the current execution state onto the
      // STEPS_EXTENDED message so prompt-growth + lifecycle updates still land
      // in one render and avoid the React 19 detached-fiber issue.
      const hasNewPrompts = state.steps.length > this.lastKnownStepCount;

      if (hasNewPrompts) {
        Log.info(
          `[inst:${this.id.slice(0, 8)}] Detected prompt count increase: ${this.lastKnownStepCount} ${state.steps.length}. Notifying dashboard.`
        );
        // Include executionState so both updates reach the webview in one message.
        this.dashboardSink.updateStepsExtended(
          state.steps,
          this.promptQueue.getWorkflowFile().finalStep ?? null,
          executionState,
          state.definitionRevision,
          undefined,
          state.parallelGroups,
          suppressRuntimePromotionUndo
        );
        this.dashboardSink.updateProgress(
          state.currentIndex,
          state.steps.length
        );
      }
    }

    this.lastKnownStepCount = state.steps.length;
    this.lastKnownWorkflowName = state.workflowName ?? "";
  }

  private async initializeNewWorkflow(
    steps: WorkflowStep[],
    displayName: string,
    originalFilePath?: string,
    reuseExistingWorkingFile: boolean = false,
    notificationMessage?: string,
    parallelGroups: ParallelGroupDefinition[] = []
  ): Promise<string | undefined> {
    // Set instance-level name so getSummary() returns it immediately
    this.workflowName = displayName;
    this.sourceDefinitionPath = originalFilePath;

    Log.debug(
      `[inst:${this.id.slice(0, 8)}] initializeNewWorkflow: displayName="${displayName}" ` +
        `originalFile=${originalFilePath ? path.basename(originalFilePath) : "(none)"} ` +
        `reuseExisting=${reuseExistingWorkingFile} ` +
        `instance.workflowName="${this.workflowName}" instance.filePath="${this.filePath}" ` +
        `queue.workflowName="${this.promptQueue.getState().workflowName || "(unset)"}"`
    );
    let workingFilePath: string | undefined;
    if (reuseExistingWorkingFile) {
      const queueState = this.promptQueue.getState();
      workingFilePath = queueState.workingFilePath;
      if (workingFilePath) {
        Log.debug(
          `[WorkflowInstance] Reusing existing working file: ${workingFilePath}`
        );
      }
    }

    const workspaceFolderPath =
      this.workspaceFolderPath ?? this.platform.getWorkspaceRoot();
    if (!workingFilePath && workspaceFolderPath) {
      try {
        workingFilePath = await this.promptQueue.createWorkingFile(
          displayName,
          steps,
          workspaceFolderPath,
          originalFilePath,
          undefined,
          parallelGroups
        );
        Log.info(`[WorkflowInstance] Created working file: ${workingFilePath}`);

        // Populate all execution properties from VS Code settings so the
        // working file always has explicit values for every workflow-level
        // setting, making it the sole source of truth regardless of the
        // user's VS Code defaults on any machine. onlyIfUndefined ensures
        // any properties already written (e.g. from ensureEphemeralWorkingFile)
        // are not overwritten.
        const defaults = PromptFileLoader.populateSettingsDefaults({});
        if (Object.keys(defaults).length > 0) {
          await this.promptQueue.updateWorkingFileProperties(defaults, {
            onlyIfUndefined: true,
          });
        }
      } catch (error) {
        Log.error("[WorkflowInstance] Failed to create working file:", error);
      }
    } else if (!workingFilePath) {
      Log.warn(
        "[WorkflowInstance] No workspace folder, skipping working file creation (MCP won't work)"
      );
    }

    let promptFile: PromptFile;
    if (workingFilePath) {
      promptFile = await this.promptQueue.readWorkingFile(workingFilePath);
      if (!promptFile.steps || promptFile.steps.length === 0) {
        promptFile = {
          ...promptFile,
          steps: steps,
          parallelGroups,
        };
      }
    } else {
      promptFile = { steps, parallelGroups };
    }
    this.promptQueue.loadPrompts(promptFile, workingFilePath);

    // Log the final state of name resolution after loadPrompts
    const postLoadState = this.promptQueue.getState();
    Log.debug(
      `[inst:${this.id.slice(0, 8)}] initializeNewWorkflow: post-load state — ` +
        `queue.workflowName="${postLoadState.workflowName || '(unset)"'}` +
        `, instance.workflowName="${this.workflowName}", instance.filePath="${this.filePath}"` +
        `, getSummary().workflowName="${this.getSummary().workflowName || "(empty)"}"`
    );

    if (this.dashboardSink) {
      const queueState = this.promptQueue.getState();
      this.dashboardSink.updateFileSelected(
        displayName,
        steps,
        queueState.workflowName || undefined,
        promptFile.finalStep ?? null,
        this.promptQueue.getFinalStepRuntime(),
        undefined,
        undefined,
        promptFile.parallelGroups
      );
    }

    if (originalFilePath) {
      this.currentPromptFile = {
        filePath: originalFilePath,
        promptFile,
      };
    } else {
      this.currentPromptFile = {
        filePath: displayName,
        promptFile,
      };
    }

    if (workingFilePath) {
      this.setupPromptFileWatcher(workingFilePath);
    }

    if (notificationMessage) {
      notifyUserFeedback(this.userFeedbackSink, "info", notificationMessage);
    }

    return workingFilePath;
  }
}
