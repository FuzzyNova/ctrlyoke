import * as path from "path";
import { HarnessIntegration, HarnessStatus } from "../HarnessIntegration";
import type { WorkflowExecutionContext } from "../WorkflowExecutor";
import { isScriptStep } from "../../types/CtrlYokeTypes";
import type { PromptQueue } from "../PromptQueue";
import type { OutputHistoryManager } from "./OutputHistoryManager";
import type { StatusMessageReporter } from "./StatusMessageReporter";
import type { WorktreeManager, WorktreeInfo } from "./WorktreeManager";
import type { ExecutionLeaseHandle } from "./ExecutionRootLeaseManager";
import type {
  HarnessId,
  PromptFile,
  PromptStep,
  QueueState,
  RunRef,
  WorkflowKey,
} from "../../types/CtrlYokeTypes";
import type { IDashboardSink } from "../../types/IDashboardSink";
import {
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  CONTEXT_RESOLUTION_FAILURE_MODES,
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  OUTPUT_HISTORY_KINDS,
  STATUS_MESSAGE_SEVERITY,
  STEP_STATUS,
  WORKTREE_MODES,
  type ExecutionMode,
} from "../../types/DashboardConstants";
import type { CompatibilityDiagnostic } from "../../types/CompatibilityTypes";
import type { CliOutput } from "../../types/WebviewMessageTypes";
import type { OutputExecutionTarget } from "../../types/OutputHistoryTypes";
import type { DefinitionRevisionContext } from "./OutputHistoryManager";
import type { WorkspaceWorktreeResolution } from "../../utils/WorktreeResolution";
import { resolveWorktreeForWorkspace } from "../../utils/WorktreeResolution";
import { preflightWorkflowSecrets } from "../../utils/SecretResolver";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { PropertyResolver } from "../../utils/PropertyResolver";
import { Log } from "../../utils/Log";
import { getErrorMessage } from "../../utils/ErrorUtils";
import { notifyUserFeedback, type UserFeedbackSink } from "../UserFeedbackSink";
import { ExecutionLeaseConflictError } from "./ExecutionRootLeaseManager";
import { WorkflowLineageRepository } from "./WorkflowLineageRepository";
import { buildUsageSelectionWarning } from "../harness/shared/usage/UsageSelectionAssist";
import type { HarnessUsageSnapshot } from "../../types/UsageTypes";
import type { PlatformAdapter } from "../../platform/PlatformAdapter";
import type { ResolvedProperties } from "../../types/ExecutionPropertyTypes";
import type { McpToolSkillRunContext } from "../../types/WorkflowContextTypes";
import type { WorkflowAttemptTarget } from "../../types/CtrlYokeTypes";

export type WorkflowStartupContextPort = Omit<
  WorkflowExecutionContext,
  | "dashboardProvider"
  | "getIntegrationForPrompt"
  | "historyFilePath"
  | "workingFilePath"
  | "targetRunIndices"
> & {
  readonly getDashboardProvider: () => IDashboardSink | undefined;
  readonly createIntegrationForMode: (
    harnessOverride?: HarnessId,
    target?: WorkflowAttemptTarget,
    resolvedProperties?: ResolvedProperties
  ) => HarnessIntegration;
  readonly getSequentialIntegrationKey: (
    properties: ResolvedProperties
  ) => string;
  readonly registerTargetIntegration: (
    target: WorkflowAttemptTarget,
    integration: HarnessIntegration
  ) => void;
  readonly isTargetInParallelGroup: (target: WorkflowAttemptTarget) => boolean;
  readonly getHarnessReadinessError: (
    harnessId: HarnessId
  ) => Promise<string | undefined>;
  readonly getSecretRedactor: () => WorkflowExecutionContext["secretRedactor"];
  readonly getMcpToolSkillContext: () =>
    Partial<McpToolSkillRunContext> | undefined;
  readonly createPriorContextResolver: (
    historyFilePath: string
  ) => WorkflowExecutionContext["resolvePriorContextItems"];
  readonly platform: PlatformAdapter;
  readonly isCli: boolean;
};

export type WorkflowStartupQueuePort = Pick<
  PromptQueue,
  | "getState"
  | "getWorkflowFile"
  | "getCompletedCount"
  | "restart"
  | "restoreCompletedSteps"
  | "promoteToNewRun"
  | "updateWorktreeNotice"
  | "finalizeFailedInFlightPrompt"
  | "commitRuntimeTransition"
  | "getProgress"
  | "getFinalStepRuntime"
  | "hasNext"
  | "prepareFinalStepContinuation"
>;

export type WorkflowStartupHistoryPort = Pick<
  OutputHistoryManager,
  | "initializeRunAt"
  | "getHistoryFilePath"
  | "loadHistory"
  | "finalizeRun"
  | "findNextRunIndexByTarget"
>;

export type WorkflowStartupWorktreeManagerPort = Pick<
  WorktreeManager,
  "releaseRuntimeTrust" | "completeManagedRun"
>;

export type WorkflowStartupStatusPort = Pick<
  StatusMessageReporter,
  "resetDedupeState" | "report"
>;

export interface WorkflowStartupExecutionPort {
  readonly currentPromptFile: () =>
    { filePath: string; promptFile: PromptFile } | undefined;
  readonly getAuthoritativeExecutionState: () => QueueState["status"];
  readonly closeRetainedTerminalsForFreshRun: () => Promise<void>;
  readonly syncCurrentPromptFileFromQueue: (filePath?: string) => void;
  readonly setExecutionRunRef: (runRef: RunRef | undefined) => void;
  readonly clearOutputBuffers: () => void;
  readonly prepareExecutionWorktree: (historyFilePath: string) => Promise<void>;
  readonly createIntegrationForMode: (
    modeOverride?: HarnessId
  ) => HarnessIntegration;
  readonly startWorkflowExecution: (
    integration: HarnessIntegration,
    historyFilePath: string,
    workingFilePath: string | undefined,
    targetRunIndices: Map<string, number>
  ) => Promise<void>;
  readonly reportMissingAssetWarning: (
    missingDirectories: readonly string[]
  ) => void;
  readonly getMissingAssetDirectories: () => readonly string[];
  readonly getMissingAssetDedupeKey: (
    missingDirectories: readonly string[]
  ) => string;
  readonly getDefinitionRevisionContext: () => DefinitionRevisionContext;
  readonly getResolvedHistoryFilePath: () => string;
  readonly getActiveHistoryFilePath: () => string;
  readonly setActiveHistoryFilePath: (filePath: string) => void;
  readonly startPending: () => boolean;
  readonly reportCompatibilityDiagnostics?: (
    diagnostics: readonly CompatibilityDiagnostic[]
  ) => void;
  readonly cacheHistoricalStepOutput?: (
    stepIndex: number,
    outputs: readonly CliOutput[],
    retry?: { currentRetry: number; maxRetries: number }
  ) => void;
  readonly getStepBufferSize?: () => number;
  readonly computeTargetRunIndices?: (
    historyFilePath: string,
    isContinuation: boolean
  ) => Promise<Map<string, number>>;
  readonly warnBeforeWorkflowStart?: (
    queueState: QueueState,
    workflow: PromptFile,
    modeOverride: HarnessId | undefined,
    restartFromBeginning: boolean
  ) => void;
  readonly describeExecutionFailure?: (error: unknown) => Promise<string>;
  readonly context?: WorkflowStartupContextPort;
  readonly lifecycle?: WorkflowStartupLifecyclePort;
}

export interface WorkflowStartupLifecyclePort {
  readonly isStartPending: () => boolean;
  readonly beginExecution: (historyFilePath: string) => void;
  readonly getRunIdentity: () => {
    readonly workflowKey: WorkflowKey | undefined;
    readonly runRef: RunRef | undefined;
    readonly lockWorkspaceRoot: string | undefined;
  };
  readonly acquireExecutionLease: (
    workflowKey: WorkflowKey,
    runRef: RunRef,
    lockWorkspaceRoot: string,
    workingFilePath: string | undefined
  ) => Promise<void>;
  readonly ownsExecutionReservation: () => boolean;
  readonly startRunnerLockHeartbeat: (
    lockWorkspaceRoot: string,
    workflowKey: WorkflowKey
  ) => void;
  readonly restoreRetainedIntegrations: () => Promise<void>;
  readonly executeWorkflow: (
    integration: HarnessIntegration,
    context: WorkflowExecutionContext
  ) => Promise<void>;
  readonly settleExecution: (options: {
    readonly historyFilePath: string;
    readonly workingFilePath: string | undefined;
  }) => Promise<void>;
}

export interface WorkflowStartupWorktreePort {
  readonly getResolution: () => WorkspaceWorktreeResolution;
  readonly setResolution: (resolution: WorkspaceWorktreeResolution) => void;
  readonly getActiveWorktree: () => WorktreeInfo | undefined;
  readonly clearActiveWorktree: () => void;
  readonly getExecutionLease: () => ExecutionLeaseHandle | undefined;
  readonly clearExecutionLease: () => void;
  readonly manager: WorkflowStartupWorktreeManagerPort;
  readonly ensureRunnerLock: (
    workingFilePath: string | undefined
  ) => Promise<void>;
  readonly releaseRunnerLock: () => Promise<void>;
}

export interface WorkflowStartupPipelinePort {
  readonly id: string;
  readonly platform: PlatformAdapter;
  readonly workspaceFolderPath: string | undefined;
  readonly dashboardSink: IDashboardSink | undefined;
  readonly userFeedbackSink: UserFeedbackSink | undefined;
  readonly queue: WorkflowStartupQueuePort;
  readonly history: WorkflowStartupHistoryPort;
  readonly execution: WorkflowStartupExecutionPort;
  readonly worktree: WorkflowStartupWorktreePort;
  readonly status: WorkflowStartupStatusPort;
  readonly failRuntime: () => void;
  readonly getDetectorIntegration: (
    harnessOverride?: HarnessId
  ) => HarnessIntegration;
  readonly analyzeWorkflowCompatibility: (
    workflow: PromptFile
  ) => Promise<CompatibilityDiagnostic[]>;
  readonly approveSecretGrants?: (
    workflow: PromptFile,
    workspaceRoot: string
  ) => Promise<void>;
  readonly getHarnessUsageSnapshots?: () => readonly HarnessUsageSnapshot[];
  readonly onPrepared?: () => Promise<void>;
  readonly hostCanProvidePty: boolean;
}

export interface WorkflowContinuationClassification {
  readonly prevQueueState: QueueState;
  readonly prevExecutionState: QueueState["status"];
  readonly prevCompletedCount: number;
  readonly isAppendContinuation: boolean;
  readonly isIdleContinuation: boolean;
}

/** Owns the ordered preflight and startup phases for one execution call. */
export class WorkflowStartupPipeline {
  private historyFilePath: string;
  private promotedRunRef: RunRef | undefined;
  private worktreeNotice: string | undefined;
  private missingSecretNames: string[] = [];
  private compatibilityDiagnostics: CompatibilityDiagnostic[] = [];
  private readonly lineageRepository = new WorkflowLineageRepository();

  constructor(private readonly port: WorkflowStartupPipelinePort) {
    this.historyFilePath = "";
  }

  async execute(
    modeOverride?: HarnessId,
    continueFromCurrent: boolean = false,
    preinitializedHistoryFilePath: string = "",
    prePromotedFreshStart: boolean = false
  ): Promise<void> {
    const currentPromptFile = this.port.execution.currentPromptFile();
    if (!currentPromptFile) {
      const queueState = this.port.queue.getState();
      Log.debug(
        `[inst:${this.port.id.slice(0, 8)}] executeLoadedPromptFile: currentPromptFile is null — ` +
          `workingFilePath=${queueState.workingFilePath ?? "(none)"}, ` +
          `prompts=${queueState.steps.length}, status=${this.port.execution.getAuthoritativeExecutionState()}`
      );
      notifyUserFeedback(
        this.port.userFeedbackSink,
        "warning",
        "No prompt file loaded. Use 'Change' button to select a file first."
      );
      return;
    }

    this.historyFilePath = preinitializedHistoryFilePath;
    this.promotedRunRef = undefined;
    this.worktreeNotice = undefined;
    this.missingSecretNames = [];
    this.compatibilityDiagnostics = [];

    const classification = this.classifyContinuation(
      continueFromCurrent,
      currentPromptFile.promptFile
    );
    const { filePath } = currentPromptFile;
    const fileName = path.basename(filePath);

    if (
      !continueFromCurrent &&
      !classification.isAppendContinuation &&
      !classification.isIdleContinuation
    ) {
      const missingAssetDirectories =
        this.port.execution.getMissingAssetDirectories();
      const missingAssetDedupeKey =
        missingAssetDirectories.length > 0
          ? this.port.execution.getMissingAssetDedupeKey(
              missingAssetDirectories
            )
          : undefined;
      this.port.status.resetDedupeState(
        missingAssetDedupeKey ? [missingAssetDedupeKey] : []
      );
    }

    try {
      Log.info(
        `[executeLoadedPromptFile] ctrlyoke: Executing loaded prompt file: ${filePath}`
      );

      await this.preflightSecrets();
      await this.resolveWorktree();
      if (!(await this.preflightCompatibility())) {
        return;
      }
      if (!(await this.ensureHarnessReadiness(modeOverride, fileName))) {
        return;
      }

      const startup = await this.promoteRunAndInitializeHistory(
        modeOverride,
        continueFromCurrent,
        prePromotedFreshStart,
        classification
      );
      await this.prepareWorktreeAndDispatch(
        modeOverride,
        continueFromCurrent,
        fileName,
        startup
      );
    } catch (error) {
      await this.finalizeFailure(error);
    }
  }

  async startWorkflowExecution(
    integration?: HarnessIntegration,
    historyFilePath: string = this.port.execution.getResolvedHistoryFilePath(),
    workingFilePath?: string,
    targetRunIndices?: Map<string, number>
  ): Promise<void> {
    const lifecycle = this.port.execution.lifecycle;
    const contextPort = this.port.execution.context;
    if (!lifecycle || !contextPort) {
      throw new Error("Workflow startup lifecycle is not configured");
    }
    if (lifecycle.isStartPending()) {
      Log.debug(
        `[inst:${this.port.id.slice(0, 8)}] Workflow start already pending, skipping duplicate start request`
      );
      return;
    }

    lifecycle.beginExecution(historyFilePath);
    const { workflowKey, runRef, lockWorkspaceRoot } =
      lifecycle.getRunIdentity();
    let activeIntegration: HarnessIntegration | undefined;

    try {
      await this.port.worktree.ensureRunnerLock(workingFilePath);
      if (workflowKey && runRef && lockWorkspaceRoot) {
        await lifecycle.acquireExecutionLease(
          workflowKey,
          runRef,
          lockWorkspaceRoot,
          workingFilePath
        );
      }
      if (
        lifecycle.ownsExecutionReservation() &&
        lockWorkspaceRoot &&
        workflowKey
      ) {
        lifecycle.startRunnerLockHeartbeat(lockWorkspaceRoot, workflowKey);
      }

      await lifecycle.restoreRetainedIntegrations();
      activeIntegration =
        integration ?? contextPort.createIntegrationForMode(undefined);
      contextPort.registerTargetIntegration(
        {
          kind: FINAL_STEP_PHASES.QUEUE,
          stepIndex: this.port.queue.getState().currentIndex,
        },
        activeIntegration
      );

      Log.debug(
        `[inst:${this.port.id.slice(0, 8)}] startWorkflowExecution: historyFilePath="${historyFilePath}"`
      );
      if (!historyFilePath && workflowKey && runRef) {
        Log.error(
          `[inst:${this.port.id.slice(0, 8)}] startWorkflowExecution: no history file for promoted run ` +
            `${workflowKey}/${runRef} — timeline and manifest writes will be skipped for this execution`
        );
      }

      await lifecycle.executeWorkflow(
        activeIntegration,
        this.buildWorkflowExecutionContext(
          activeIntegration,
          historyFilePath,
          workingFilePath,
          targetRunIndices
        )
      );
    } finally {
      await lifecycle.settleExecution({ historyFilePath, workingFilePath });
    }
  }

  buildWorkflowExecutionContext(
    activeIntegration: HarnessIntegration,
    historyFilePath: string,
    workingFilePath: string | undefined,
    targetRunIndices?: Map<string, number>,
    targetKeyedExecution: boolean = false
  ): WorkflowExecutionContext {
    const contextPort = this.port.execution.context;
    if (!contextPort) {
      throw new Error("Workflow execution context is not configured");
    }
    let currentIntegration = activeIntegration;
    let activeIntegrationKey: string | undefined;
    const {
      getDashboardProvider,
      createIntegrationForMode,
      getSequentialIntegrationKey,
      registerTargetIntegration,
      isTargetInParallelGroup,
      platform,
      isCli,
      ...baseContext
    } = contextPort;
    const self = this;

    return {
      ...baseContext,
      get dashboardProvider() {
        return getDashboardProvider();
      },
      historyFilePath,
      workingFilePath: workingFilePath || undefined,
      mcpToolSkillContext: {
        mcpServerPath: path.join(
          platform.getExtensionPath(),
          "out",
          "mcp-server.js"
        ),
        workspaceRoot: contextPort.executionWorkspace.stateRoot,
        executionRoot: contextPort.executionWorkspace.executionRoot,
        workingFilePath: workingFilePath || undefined,
        ...contextPort.getMcpToolSkillContext(),
      },
      secretRedactor: contextPort.getSecretRedactor(),
      resolvePriorContextItems:
        contextPort.createPriorContextResolver(historyFilePath),
      shouldShowCliCommand: isCli || contextPort.shouldShowCliCommand,
      targetRunIndices,
      targetKeyedExecution,
      getIntegrationForPrompt: (
        prompt: PromptStep,
        resolvedProperties: ResolvedProperties,
        target?: WorkflowAttemptTarget
      ) => {
        const targetIsGrouped = target
          ? isTargetInParallelGroup(target)
          : false;
        if (target && (targetKeyedExecution || targetIsGrouped)) {
          const targetIntegration = createIntegrationForMode(
            resolvedProperties.harness,
            target,
            resolvedProperties
          );
          registerTargetIntegration(target, targetIntegration);
          return targetIntegration;
        }

        const integrationKey = getSequentialIntegrationKey(resolvedProperties);
        const requiresFreshIntegration = !resolvedProperties.resumeSession;
        if (
          requiresFreshIntegration ||
          activeIntegrationKey !== integrationKey
        ) {
          Log.info(
            `[inst:${self.port.id.slice(0, 8)}] Prompt ${prompt.name || "unnamed"} selecting spawn identity ${resolvedProperties.harness}::${integrationKey.slice(-16)}; retaining incompatible terminals`
          );
          currentIntegration = createIntegrationForMode(
            resolvedProperties.harness,
            undefined,
            resolvedProperties
          );
          activeIntegrationKey = integrationKey;
        }
        if (target) {
          registerTargetIntegration(target, currentIntegration);
        }
        return currentIntegration;
      },
    };
  }

  classifyContinuation(
    continueFromCurrent: boolean,
    promptFile: PromptFile
  ): WorkflowContinuationClassification {
    const prevQueueState = this.port.queue.getState();
    const prevExecutionState =
      this.port.execution.getAuthoritativeExecutionState();
    const prevCompletedCount =
      prevExecutionState === EXECUTION_STATES.COMPLETED
        ? this.port.queue.getCompletedCount()
        : 0;
    const filePromptCount = promptFile.steps?.length ?? 0;
    const pendingCount = prevQueueState.results.filter(
      (result) => result.status === STEP_STATUS.PENDING
    ).length;
    const isAppendContinuation =
      !continueFromCurrent && prevCompletedCount > 0 && pendingCount > 0;
    // An idle continuation resumes an existing run that was stopped and then
    // repositioned, so it requires a promoted RunRef to continue into: the
    // branch it selects below reuses that run's history file and explicitly
    // rejects a queue without one. A *draft* also sits IDLE at a nonzero index
    // once its start position has been set, and without this guard it took that
    // branch and threw "Idle continuation requires an explicit promoted run" —
    // the draft must promote first, carrying its start position into run 1.
    const isIdleContinuation =
      !continueFromCurrent &&
      !isAppendContinuation &&
      prevExecutionState === EXECUTION_STATES.IDLE &&
      prevQueueState.currentIndex > 0 &&
      prevQueueState.runRef !== undefined;

    Log.debug(
      `[executeLoadedPromptFile] continueFromCurrent=${continueFromCurrent}, ` +
        `prevQueueStatus=${prevExecutionState}, prevCompletedCount=${prevCompletedCount}, ` +
        `pendingCount=${pendingCount}, filePromptCount=${filePromptCount}, ` +
        `isAppendContinuation=${isAppendContinuation}, isIdleContinuation=${isIdleContinuation}`
    );

    return {
      prevQueueState,
      prevExecutionState,
      prevCompletedCount,
      isAppendContinuation,
      isIdleContinuation,
    };
  }

  async preflightSecrets(): Promise<void> {
    const workflow = this.port.queue.getWorkflowFile();
    const workspaceRoot = this.port.platform.getWorkspaceRoot();
    await this.port.approveSecretGrants?.(workflow, workspaceRoot);
    this.missingSecretNames = await preflightWorkflowSecrets(
      workflow,
      this.port.platform,
      workspaceRoot,
      process.env,
      {
        failOnMissing:
          ConfigurationUtils.getContextResolutionFailureMode() ===
          CONTEXT_RESOLUTION_FAILURE_MODES.FAIL,
      }
    );
  }

  async resolveWorktree(): Promise<void> {
    const resolution = await resolveWorktreeForWorkspace(
      this.port.queue.getWorkflowFile().worktree,
      ConfigurationUtils.getDefaultWorktree(),
      this.port.platform.getNamedWorkspaceRoots()
    );
    this.port.worktree.setResolution(resolution);
    this.worktreeNotice = resolution.notice;
  }

  async preflightCompatibility(): Promise<boolean> {
    this.compatibilityDiagnostics =
      await this.port.analyzeWorkflowCompatibility({
        ...this.port.queue.getWorkflowFile(),
        steps: this.port.queue.getState().steps,
      });
    const compatibilityErrors = this.compatibilityDiagnostics.filter(
      (diagnostic) =>
        diagnostic.severity === COMPATIBILITY_DIAGNOSTIC_SEVERITIES.ERROR
    );
    if (compatibilityErrors.length === 0) {
      return true;
    }

    this.port.execution.reportCompatibilityDiagnostics?.(
      this.compatibilityDiagnostics
    );
    Log.error(
      "[executeLoadedPromptFile] ctrlyoke: Compatibility preflight failed:",
      compatibilityErrors.map((diagnostic) => diagnostic.message).join(" ")
    );
    this.port.failRuntime();
    await this.port.queue.commitRuntimeTransition();
    return false;
  }

  async ensureHarnessReadiness(
    modeOverride: HarnessId | undefined,
    fileName: string
  ): Promise<boolean> {
    const currentPromptFile = this.port.execution.currentPromptFile();
    const preflightHarness = PropertyResolver.resolveHarnessValue(
      modeOverride,
      currentPromptFile?.promptFile?.harness
    );
    const detectedIntegration =
      this.port.getDetectorIntegration(preflightHarness);
    let detailedStatus = detectedIntegration.getDetailedStatus();

    if (
      detailedStatus.initializationStatus === HarnessStatus.Initializing ||
      detailedStatus.initializationStatus === HarnessStatus.Waiting
    ) {
      Log.info(
        `[executeLoadedPromptFile] ctrlyoke: Harness not ready (${detailedStatus.initializationStatus}), waiting for status change…`
      );
      await new Promise<void>((resolve) => {
        let settled = false;
        const settle = () => {
          if (!settled) {
            settled = true;
            subscription.dispose();
            clearTimeout(timer);
            resolve();
          }
        };
        const subscription = detectedIntegration.onDidChangeStatus(settle);
        const timer = setTimeout(settle, 35_000);
      });
      detailedStatus = detectedIntegration.getDetailedStatus();
    }

    if (detailedStatus.initializationStatus === HarnessStatus.Ready) {
      return true;
    }

    const errorMessage = detailedStatus.message || "Harness is unavailable";
    Log.error(
      `[executeLoadedPromptFile] ctrlyoke: Harness not ready: ${errorMessage}`
    );
    const preflightStepCount = this.port.queue.getState().steps.length;
    if (this.port.dashboardSink && preflightStepCount > 0) {
      this.port.dashboardSink.updateExecutionStarted(
        this.port.id,
        fileName,
        preflightStepCount
      );
      this.port.dashboardSink.updateCliOutput(0, {
        prompt: "",
        response: "",
        elapsed: 0,
        errorMessage,
      });
    }
    this.port.failRuntime();
    await this.port.queue.commitRuntimeTransition();
    if (this.historyFilePath) {
      await this.port.history.finalizeRun(
        this.historyFilePath,
        EXECUTION_STATES.ERROR,
        preflightStepCount,
        this.port.queue.getState().totalExecutionTime
      );
    }
    return false;
  }

  async promoteRunAndInitializeHistory(
    modeOverride: HarnessId | undefined,
    continueFromCurrent: boolean,
    prePromotedFreshStart: boolean,
    classification: WorkflowContinuationClassification
  ): Promise<{
    readonly currentQueueState: QueueState;
    readonly totalSteps: number;
    readonly currentStep: QueueState["steps"][number] | undefined;
    readonly executionMode: ExecutionMode | undefined;
    readonly workingFilePath: string;
    readonly isAppendContinuation: boolean;
    readonly isIdleContinuation: boolean;
    readonly prevCompletedCount: number;
  }> {
    const executionState = this.port.execution.getAuthoritativeExecutionState();
    const isRestartFromBeginning =
      !continueFromCurrent &&
      !classification.isAppendContinuation &&
      (executionState === EXECUTION_STATES.COMPLETED ||
        executionState === EXECUTION_STATES.PAUSED ||
        executionState === EXECUTION_STATES.STOPPED ||
        executionState === EXECUTION_STATES.ERROR);

    this.port.execution.warnBeforeWorkflowStart?.(
      classification.prevQueueState,
      this.port.queue.getWorkflowFile(),
      modeOverride,
      isRestartFromBeginning
    );
    if (isRestartFromBeginning) {
      await this.port.execution.closeRetainedTerminalsForFreshRun();
    }

    if (!continueFromCurrent && !classification.isAppendContinuation) {
      if (isRestartFromBeginning) {
        Log.info(
          `[executeLoadedPromptFile] ctrlyoke: Queue in ${executionState} state, restarting from beginning`
        );
        await this.port.queue.restart();
      }
    } else if (classification.isAppendContinuation) {
      Log.info(
        `[executeLoadedPromptFile] ctrlyoke: Append continuation — skipping restart, continuing from step ${classification.prevCompletedCount}`
      );
      if (executionState === EXECUTION_STATES.IDLE) {
        await this.port.queue.restoreCompletedSteps(
          classification.prevCompletedCount
        );
      }
    } else {
      Log.info(
        "[executeLoadedPromptFile] ctrlyoke: Continuing from current position (append mode), preserving history"
      );
    }

    const currentQueueState = this.port.queue.getState();
    const totalSteps = currentQueueState.steps.length;
    const currentStep = currentQueueState.steps[currentQueueState.currentIndex];
    const executionMode = currentStep
      ? PropertyResolver.resolveExecutionMode(
          currentStep,
          this.port.queue.getWorkflowFile(),
          { hostCanProvidePty: this.port.hostCanProvidePty }
        )
      : undefined;
    let workingFilePath = currentQueueState.workingFilePath ?? "";
    const workflowKey = currentQueueState.workflowKey;

    if (
      !continueFromCurrent &&
      !classification.isAppendContinuation &&
      !classification.isIdleContinuation &&
      !prePromotedFreshStart &&
      workflowKey
    ) {
      workingFilePath = await this.promoteFreshRun(
        workflowKey,
        workingFilePath
      );
    } else if (classification.isAppendContinuation && workflowKey) {
      const runRef = currentQueueState.runRef;
      if (!runRef) {
        throw new Error(
          "Append continuation requires an explicit promoted run"
        );
      }
      this.historyFilePath = this.port.history.getHistoryFilePath(
        workflowKey,
        runRef
      );
      Log.debug(
        `[WorkflowInstance] [APPEND-DEBUG] Reusing explicit history file for append continuation: ${this.historyFilePath}`
      );
      await this.cacheHistoricalStepOutputs(classification.prevCompletedCount);
    } else if (continueFromCurrent && workflowKey) {
      const runRef = currentQueueState.runRef;
      if (!runRef) {
        throw new Error("Continuation requires an explicit promoted run");
      }
      this.historyFilePath =
        this.historyFilePath ||
        this.port.history.getHistoryFilePath(workflowKey, runRef);
      Log.debug(
        `[WorkflowInstance] [APPEND-DEBUG] Manual resume: Reusing existing history file: ${this.historyFilePath}`
      );
    } else if (classification.isIdleContinuation && workflowKey) {
      const runRef = currentQueueState.runRef;
      if (!runRef) {
        throw new Error("Idle continuation requires an explicit promoted run");
      }
      this.historyFilePath = this.port.history.getHistoryFilePath(
        workflowKey,
        runRef
      );
      Log.debug(
        `[WorkflowInstance] [APPEND-DEBUG] Idle continuation (stop+skip): Reusing existing history file: ${this.historyFilePath}`
      );
    }

    await this.port.onPrepared?.();
    await this.port.worktree.ensureRunnerLock(workingFilePath);

    return {
      currentQueueState,
      totalSteps,
      currentStep,
      executionMode,
      workingFilePath,
      isAppendContinuation: classification.isAppendContinuation,
      isIdleContinuation: classification.isIdleContinuation,
      prevCompletedCount: classification.prevCompletedCount,
    };
  }

  async prepareWorktreeAndDispatch(
    modeOverride: HarnessId | undefined,
    continueFromCurrent: boolean,
    fileName: string,
    startup: {
      readonly currentQueueState: QueueState;
      readonly totalSteps: number;
      readonly currentStep: QueueState["steps"][number] | undefined;
      readonly executionMode: ExecutionMode | undefined;
      readonly workingFilePath: string;
      readonly isAppendContinuation: boolean;
      readonly isIdleContinuation: boolean;
      readonly prevCompletedCount: number;
    }
  ): Promise<void> {
    if (
      this.port.dashboardSink &&
      startup.totalSteps > 0 &&
      !continueFromCurrent &&
      !startup.isAppendContinuation &&
      !startup.isIdleContinuation
    ) {
      // A fresh start normally begins at step 0, and the client resets every
      // step to pending on that message. A draft whose start position was moved
      // before its first run is the exception: it promotes with its prefix
      // already marked skipped, so the reset has to stop at the start index or
      // the dashboard silently repaints those steps as pending for the whole
      // run — `preserveStepCount` is exactly that boundary.
      const skippedPrefix = startup.currentQueueState.currentIndex;
      Log.debug(
        `[executeLoadedPromptFile] Sending EXECUTION_STARTED fresh start, totalSteps=${startup.totalSteps}, skippedPrefix=${skippedPrefix}`
      );
      this.port.execution.clearOutputBuffers();
      this.port.dashboardSink.updateExecutionStarted(
        this.port.id,
        fileName,
        startup.totalSteps,
        skippedPrefix > 0 ? true : undefined,
        skippedPrefix > 0 ? skippedPrefix : undefined,
        undefined,
        startup.executionMode
      );
    }

    await this.port.execution.prepareExecutionWorktree(this.historyFilePath);
    const integration =
      this.port.execution.createIntegrationForMode(modeOverride);

    if (this.port.dashboardSink && startup.totalSteps > 0) {
      if (continueFromCurrent || startup.isIdleContinuation) {
        const currentIndex = startup.currentQueueState.currentIndex;
        const willInject = integration.canReuseForInject();
        Log.debug(
          `[executeLoadedPromptFile] Sending EXECUTION_STARTED isContinuation=true, preserveStepCount=${currentIndex}, totalSteps=${startup.totalSteps}, isInjectMode=${willInject}`
        );
        this.port.dashboardSink.updateExecutionStarted(
          this.port.id,
          fileName,
          startup.totalSteps,
          true,
          currentIndex,
          willInject ? true : undefined,
          startup.executionMode
        );
      } else if (startup.isAppendContinuation) {
        const willInject = integration.canReuseForInject();
        Log.debug(
          `[executeLoadedPromptFile] Sending EXECUTION_STARTED isContinuation=true (append-to-completed), preserveStepCount=${startup.prevCompletedCount}, totalSteps=${startup.totalSteps}, isInjectMode=${willInject}`
        );
        this.port.dashboardSink.updateExecutionStarted(
          this.port.id,
          fileName,
          startup.totalSteps,
          true,
          startup.prevCompletedCount,
          willInject ? true : undefined,
          startup.executionMode
        );
      }
    }

    this.port.execution.reportCompatibilityDiagnostics?.(
      this.compatibilityDiagnostics
    );
    this.port.execution.reportMissingAssetWarning(
      this.port.execution.getMissingAssetDirectories()
    );

    if (this.missingSecretNames.length > 0) {
      const missingSecretNotice = `Context resolution warning: declared secrets are not available: ${this.missingSecretNames.join(
        ", "
      )}.`;
      this.port.status.report(
        {
          kind: FINAL_STEP_PHASES.QUEUE,
          stepIndex: startup.currentQueueState.currentIndex,
        },
        missingSecretNotice,
        STATUS_MESSAGE_SEVERITY.WARNING,
        { timestampMs: Date.now() }
      );
    }

    if (this.worktreeNotice && this.historyFilePath) {
      await this.port.queue.updateWorktreeNotice(this.worktreeNotice);
      this.port.status.report(
        {
          kind: FINAL_STEP_PHASES.QUEUE,
          stepIndex: startup.currentQueueState.currentIndex,
        },
        this.worktreeNotice,
        STATUS_MESSAGE_SEVERITY.WARNING,
        { timestampMs: Date.now() }
      );
    }

    if (startup.totalSteps > 0) {
      integration.setWorkflowProgress(
        startup.currentQueueState.currentIndex + 1,
        startup.totalSteps
      );
    }
    const targetRunIndices = this.port.execution.computeTargetRunIndices
      ? await this.port.execution.computeTargetRunIndices(
          this.historyFilePath,
          continueFromCurrent ||
            startup.isAppendContinuation ||
            startup.isIdleContinuation
        )
      : await this.computeTargetRunIndices(
          this.historyFilePath,
          continueFromCurrent ||
            startup.isAppendContinuation ||
            startup.isIdleContinuation
        );
    Log.debug(
      `[WorkflowInstance] [APPEND-DEBUG] Starting workflow execution with historyFilePath: "${this.historyFilePath}" (empty=${!this.historyFilePath})`
    );
    await this.port.execution.startWorkflowExecution(
      integration,
      this.historyFilePath,
      startup.workingFilePath || undefined,
      targetRunIndices
    );
  }

  async computeTargetRunIndices(
    historyFilePath: string,
    isContinuation: boolean
  ): Promise<Map<string, number>> {
    if (!historyFilePath || !isContinuation) {
      return new Map();
    }
    const rerunTargets: OutputExecutionTarget[] = [];
    const state = this.port.queue.getState();
    for (
      let stepIndex = state.currentIndex;
      stepIndex < state.steps.length;
      stepIndex++
    ) {
      rerunTargets.push({ kind: FINAL_STEP_PHASES.QUEUE, stepIndex });
    }
    const finalStepRuntime = this.port.queue.getFinalStepRuntime();
    if (
      finalStepRuntime?.phase === FINAL_STEP_PHASES.FINAL_STEP &&
      !this.port.queue.hasNext()
    ) {
      rerunTargets.push({
        kind: FINAL_STEP_PHASES.FINAL_STEP,
        loopIndex: finalStepRuntime.loopCount,
      });
    }
    if (rerunTargets.length === 0) {
      return new Map();
    }
    return this.port.history.findNextRunIndexByTarget(
      historyFilePath,
      new Set(
        rerunTargets.map((target) => this.getExecutionTargetRunKey(target))
      )
    );
  }

  async prepareFinalStepContinuation(historyFilePath: string): Promise<void> {
    const runtime = this.port.queue.getFinalStepRuntime();
    if (
      !runtime ||
      runtime.phase !== FINAL_STEP_PHASES.FINAL_STEP ||
      (runtime.status !== STEP_STATUS.COMPLETED &&
        runtime.status !== STEP_STATUS.SKIPPED)
    ) {
      return;
    }
    const history = await this.port.history.loadHistory(historyFilePath);
    let maxLoopIndex = runtime.loopCount;
    for (const entry of history.orderedEntries) {
      if (
        entry.kind === OUTPUT_HISTORY_KINDS.CLI &&
        entry.target.kind === FINAL_STEP_PHASES.FINAL_STEP
      ) {
        maxLoopIndex = Math.max(maxLoopIndex, entry.target.loopIndex);
      }
    }
    await this.port.queue.prepareFinalStepContinuation(maxLoopIndex + 1);
    this.port.execution.syncCurrentPromptFileFromQueue();
  }

  warnBeforeWorkflowStart(
    queueState: QueueState,
    workflow: PromptFile,
    modeOverride: HarnessId | undefined,
    restartFromBeginning: boolean
  ): void {
    if (
      !ConfigurationUtils.shouldTrackHarnessUsage() ||
      !this.port.getHarnessUsageSnapshots
    ) {
      return;
    }
    const startIndex = restartFromBeginning ? 0 : queueState.currentIndex;
    const queuedAttempts = queueState.steps
      .slice(startIndex)
      .filter((step, offset): step is PromptStep => {
        if (step.enabled === false || isScriptStep(step)) return false;
        const absoluteIndex = startIndex + offset;
        if (restartFromBeginning) return true;
        const status = queueState.results[absoluteIndex]?.status;
        return (
          status !== STEP_STATUS.COMPLETED &&
          status !== STEP_STATUS.CANCELLED &&
          status !== STEP_STATUS.FAILED &&
          status !== STEP_STATUS.SKIPPED
        );
      })
      .map((step) => ({
        harnessId: PropertyResolver.resolveHarnessValue(
          step.harness,
          modeOverride ?? workflow.harness
        ),
      }));
    const finalStepRuntime = this.port.queue.getFinalStepRuntime();
    const finalStep = workflow.finalStep;
    const finalStepStillQueued =
      finalStep !== undefined &&
      finalStep.enabled !== false &&
      !isScriptStep(finalStep) &&
      (restartFromBeginning ||
        !finalStepRuntime ||
        finalStepRuntime.phase === FINAL_STEP_PHASES.QUEUE ||
        (finalStepRuntime.status !== STEP_STATUS.COMPLETED &&
          finalStepRuntime.status !== STEP_STATUS.SKIPPED));
    if (finalStepStillQueued && finalStep) {
      queuedAttempts.push({
        harnessId: PropertyResolver.resolveHarnessValue(
          finalStep.harness,
          modeOverride ?? workflow.harness
        ),
      });
    }
    const settings = ConfigurationUtils.getHarnessUsageSettings();
    const warning = buildUsageSelectionWarning({
      queuedAttempts,
      snapshots: this.port.getHarnessUsageSnapshots(),
      warningPercentUsed: settings.warningPercentUsed,
    });
    if (warning) {
      notifyUserFeedback(
        this.port.userFeedbackSink,
        "warning",
        warning.message
      );
    }
  }

  async describeExecutionFailure(error: unknown): Promise<string> {
    if (error instanceof ExecutionLeaseConflictError) {
      return this.describeLeaseConflict(error);
    }
    return getErrorMessage(error);
  }

  async describeLeaseConflict(
    error: ExecutionLeaseConflictError
  ): Promise<string> {
    const owner = error.conflict.lease;
    const ageSeconds = Math.max(0, Math.floor(error.conflict.ageMs / 1000));
    const ageLabel =
      ageSeconds < 60 ? `${ageSeconds}s` : `${Math.floor(ageSeconds / 60)}m`;
    const ownerDescriptor = await this.lineageRepository
      .tryReadDescriptor(owner.stateRoot, owner.workflowKey as WorkflowKey)
      .catch(() => undefined);
    const ownerName =
      ownerDescriptor?.workflowName?.trim() || owner.workflowKey;
    const config = this.port.worktree.getResolution().config;
    const target =
      config?.mode === WORKTREE_MODES.NAMED
        ? `named worktree "${config.branch}"`
        : owner.mode === "exclusive-worktree"
          ? "this worktree"
          : "this execution directory";
    return (
      `Can't start — "${ownerName}" is still holding the lease on ${target} ` +
      `(started ${ageLabel} ago). Close its live harness session or wait ` +
      `for it to finish, then run this workflow again.`
    );
  }

  private async promoteFreshRun(
    workflowKey: WorkflowKey,
    workingFilePath: string
  ): Promise<string> {
    const runWorkspaceRoot =
      this.port.workspaceFolderPath ??
      this.port.platform.getWorkspaceRoot() ??
      "";
    const startedAt = Date.now();
    const promoted = await this.port.queue.promoteToNewRun(
      runWorkspaceRoot,
      startedAt
    );
    if (!promoted) return workingFilePath;

    this.promotedRunRef = promoted.runRef;
    this.port.execution.syncCurrentPromptFileFromQueue(
      promoted.workingFilePath
    );
    this.port.execution.setExecutionRunRef(promoted.runRef);
    const historyInit = await this.port.history.initializeRunAt(
      workflowKey,
      promoted.runRef,
      promoted.runDir,
      promoted.runId,
      startedAt,
      [],
      this.port.execution.getDefinitionRevisionContext().definition
    );
    if (!historyInit.filePath) {
      throw new Error(
        `Failed to initialize timeline for promoted run ${workflowKey}/${promoted.runRef}`
      );
    }
    this.historyFilePath = this.port.history.getHistoryFilePath(
      workflowKey,
      promoted.runRef
    );
    return promoted.workingFilePath;
  }

  private getExecutionTargetRunKey(
    target: OutputExecutionTarget
  ): `queue:${number}` | `final:${number}` {
    return target.kind === FINAL_STEP_PHASES.QUEUE
      ? `queue:${target.stepIndex}`
      : `final:${target.loopIndex}`;
  }

  private async cacheHistoricalStepOutputs(
    prevCompletedCount: number
  ): Promise<void> {
    if (!this.historyFilePath) return;
    try {
      const history = await this.port.history.loadHistory(this.historyFilePath);
      const cliEntriesByStep = new Map<
        number,
        Array<{ cliOutput: CliOutput; attemptIndex: number }>
      >();
      for (const entry of history.orderedEntries) {
        if (
          entry.kind === OUTPUT_HISTORY_KINDS.CLI &&
          entry.target.kind === FINAL_STEP_PHASES.QUEUE
        ) {
          const stepIndex = entry.target.stepIndex;
          const entries = cliEntriesByStep.get(stepIndex) ?? [];
          entries.push({
            cliOutput: entry.cliOutput,
            attemptIndex: entry.attemptIndex,
          });
          cliEntriesByStep.set(stepIndex, entries);
        }
      }
      for (let i = 0; i < prevCompletedCount; i++) {
        const entries = cliEntriesByStep.get(i);
        if (!entries || entries.length === 0) continue;
        const maxAttemptIndex = Math.max(
          ...entries.map((entry) => entry.attemptIndex)
        );
        this.port.execution.cacheHistoricalStepOutput?.(
          i,
          entries.map((entry) => entry.cliOutput),
          maxAttemptIndex > 0
            ? { currentRetry: maxAttemptIndex, maxRetries: maxAttemptIndex }
            : undefined
        );
      }
      Log.debug(
        `[inst:${this.port.id.slice(0, 8)}] Cached ${this.port.execution.getStepBufferSize?.() ?? 0} historical step(s) for replay on workflow switch`
      );
    } catch (error) {
      Log.warn(
        `[inst:${this.port.id.slice(0, 8)}] Failed to cache historical step outputs for replay: ${error}`
      );
    }
  }

  public finalizeFailedStepBeforeStatusFlip(
    failureMessage: string
  ): number | undefined {
    const failedStepIndex =
      this.port.queue.finalizeFailedInFlightPrompt(failureMessage);
    if (failedStepIndex !== undefined) {
      this.port.dashboardSink?.updateStepStatus(failedStepIndex, {
        state: STEP_STATUS.FAILED,
        message: failureMessage,
      });
    }
    return failedStepIndex;
  }

  public async settleProvisionedWorktreeAfterEarlyFailure(): Promise<void> {
    if (
      this.port.execution.startPending?.() ||
      this.port.worktree.getActiveWorktree()?.mode !== WORKTREE_MODES.MANAGED
    ) {
      return;
    }
    const worktree = this.port.worktree.getActiveWorktree();
    if (!worktree) return;
    this.port.worktree.manager.releaseRuntimeTrust(worktree);
    await this.port.worktree.manager
      .completeManagedRun(worktree, {
        merge: this.port.worktree.getResolution().config?.merge === true,
        keep: this.port.worktree.getResolution().config?.keep === true,
        artifactsClean: true,
      })
      .catch((settlementError) =>
        Log.error(
          `[inst:${this.port.id.slice(0, 8)}] Failed to settle managed worktree after early execution error:`,
          settlementError
        )
      );
    this.port.worktree.clearExecutionLease();
    this.port.worktree.clearActiveWorktree();
  }

  public async releaseLineageLockAfterEarlyFailure(): Promise<void> {
    if (this.port.execution.startPending?.()) return;
    await this.port.worktree
      .releaseRunnerLock()
      .catch((lockError) =>
        Log.warn(
          "[executeLoadedPromptFile] Failed to release runner lock after setup failure:",
          lockError
        )
      );
  }

  public async finalizePromotedRunAfterEarlyFailure(): Promise<string> {
    const failedRunKey = this.port.queue.getState().workflowKey;
    const runToFinalize =
      this.historyFilePath ||
      (this.promotedRunRef && failedRunKey
        ? this.port.history.getHistoryFilePath(
            failedRunKey,
            this.promotedRunRef
          )
        : "");
    if (!runToFinalize) return "";
    await this.port.history
      .finalizeRun(
        runToFinalize,
        EXECUTION_STATES.ERROR,
        this.port.queue.getProgress().total,
        this.port.queue.getState().totalExecutionTime
      )
      .catch((err) =>
        Log.warn(
          "[executeLoadedPromptFile] Failed to finalize history run on early error:",
          err
        )
      );
    return runToFinalize;
  }

  private async finalizeFailure(error: unknown): Promise<void> {
    Log.error(
      "[executeLoadedPromptFile] Failed to execute prompt file:",
      error
    );
    const failureMessage = getErrorMessage(error);
    this.finalizeFailedStepBeforeStatusFlip(failureMessage);
    this.port.failRuntime();
    await this.port.queue.commitRuntimeTransition();
    await this.settleProvisionedWorktreeAfterEarlyFailure();
    await this.releaseLineageLockAfterEarlyFailure();
    const runToFinalize = await this.finalizePromotedRunAfterEarlyFailure();
    const executionFailureMessage = this.port.execution.describeExecutionFailure
      ? await this.port.execution.describeExecutionFailure(error)
      : await this.describeExecutionFailure(error);
    notifyUserFeedback(
      this.port.userFeedbackSink,
      "error",
      `ctrlyoke: Execution failed: ${executionFailureMessage}`
    );
    const executionFailureStatusMessage = `Execution failed: ${executionFailureMessage}`;
    const executionFailureTimestampMs = Date.now();
    const executionFailureStepIndex = this.port.queue.getState().currentIndex;
    const resolvedHistoryFilePath =
      this.port.execution.getResolvedHistoryFilePath();
    if (runToFinalize && runToFinalize !== resolvedHistoryFilePath) {
      const previousActiveHistoryFilePath =
        this.port.execution.getActiveHistoryFilePath();
      this.port.execution.setActiveHistoryFilePath(runToFinalize);
      this.port.status.report(
        {
          kind: FINAL_STEP_PHASES.QUEUE,
          stepIndex: executionFailureStepIndex,
        },
        executionFailureStatusMessage,
        STATUS_MESSAGE_SEVERITY.ERROR,
        { timestampMs: executionFailureTimestampMs }
      );
      this.port.execution.setActiveHistoryFilePath(
        previousActiveHistoryFilePath
      );
    } else {
      this.port.status.report(
        {
          kind: FINAL_STEP_PHASES.QUEUE,
          stepIndex: executionFailureStepIndex,
        },
        executionFailureStatusMessage,
        STATUS_MESSAGE_SEVERITY.ERROR,
        { timestampMs: executionFailureTimestampMs }
      );
    }
  }
}
