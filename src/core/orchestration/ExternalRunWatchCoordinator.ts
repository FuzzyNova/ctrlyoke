import * as fs from "fs";
import * as path from "path";
import {
  EXECUTION_STATES,
  deriveWorkflowFinalStepSummary,
  type QueueState,
  type RunnerHostIdentity,
  type WorkflowKey,
  type WorkflowStep,
  type WorkflowSummary,
  type WorkingFile,
  type WorkspaceWorktreeOwnership,
} from "../../types/CtrlYokeTypes";
import {
  ACTIVE_EXECUTION_STATES,
  EXECUTION_PHASES,
  EXTERNAL_EXECUTION_REASONS,
  EXTERNAL_EXECUTION_RESOLUTION_KINDS,
  FINAL_STEP_PHASES,
  OUTPUT_HISTORY_KINDS,
  RUNNER_IDS,
  WORKFLOW_LOCK_LIVENESS,
  WORKFLOW_LOCK_LOCALITIES,
  type FinalStepPhase,
  type StepStatus,
} from "../../types/DashboardConstants";
import type { CliOutput } from "../../types/WebviewMessageTypes";
import type { IDashboardSink } from "../../types/IDashboardSink";
import type { FileWatcherFactory } from "../HostPorts";
import {
  deriveStepStatusesFromRuntime,
  type StepWithRuntimeStatus,
} from "../../utils/StepStatusDerivation";
import { Log } from "../../utils/Log";
import {
  assertWritableSchema,
  PERSISTED_STORES,
} from "../../utils/PersistedSchemaGuard";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { WorkflowLockManager } from "../../utils/WorkflowLockManager";
import { OutputHistoryManager } from "./OutputHistoryManager";
import {
  ExternalRunWatchSession,
  type ExternalRunWatchFinishReason,
} from "./ExternalRunWatchSession";
import {
  ExternalExecutionResolver,
  type ActiveExternalLockInspection,
  type ExternalExecutionResolution,
} from "./ExternalExecutionResolver";
import { readWorkflowLockOwnershipInspection } from "../../utils/WorkflowLockInspector";
import { WorktreeManager } from "./WorktreeManager";
import { WorkingFileManager } from "../WorkingFileManager";
import { stripLegacyWorkingFileLineageMetadata } from "../../utils/WorkingFileMetadata";
import type { RunViewPublisherExternalRunWatchPort } from "./RunViewPublisher";

export interface ExternalRunWatchBroadcast {
  notifyWorkflowAdded(summary: WorkflowSummary): void;
  notifyWorkflowDismissed(workflowId: string): void;
  notifyWorkflowSummaryUpdated(summary: WorkflowSummary): void;
  notifyCliWatchOutput(
    workflowId: string,
    stepIndex: number,
    output: CliOutput,
    prompt?: string
  ): void;
  notifyCliPromptsExtended(
    workflowId: string,
    steps: any[],
    definitionRevision?: number,
    parallelGroups?: import("../../types/CtrlYokeTypes").ParallelGroupDefinition[]
  ): void;
  updateStepStatus(
    stepIndex: number,
    status: {
      state: string;
      duration?: number;
      message?: string;
      endConditionResult?: unknown;
    },
    details?: Record<string, unknown>,
    workflowId?: string
  ): void;
  updateSessionRestored: IDashboardSink["updateSessionRestored"];
}

export interface ExternalRunWatchInstance {
  readonly id: string;
  getSummary(): WorkflowSummary;
  getQueueState(): QueueState;
}

export interface ExternalRunWatchLineageRepository {
  listLineageKeys(workspaceRoot: string): Promise<WorkflowKey[]>;
  readWorkflowDisplayName(
    workspaceRoot: string,
    workflowKey: WorkflowKey
  ): Promise<string>;
  pruneStaleStagingDirs(
    workspaceRoot: string,
    workflowKey: WorkflowKey
  ): Promise<void>;
}

export interface ExternalRunWatchHost {
  broadcast: ExternalRunWatchBroadcast;
  lineageRepository: ExternalRunWatchLineageRepository;
  findInstanceForWorkingFile(
    workingFilePath: string,
    includeRetired?: boolean
  ): ReadonlyArray<ExternalRunWatchInstance>;
  retireWorkflow(workflowId: string): void;
  workspaceRoot: string | undefined;
  saveState(): Promise<void>;
  getOutputHistoryManager(): OutputHistoryManager;
  runnerHostIdentity: RunnerHostIdentity;
  fileWatcherFactory: FileWatcherFactory;
}

export interface ExternalRunWatchEntry {
  session: ExternalRunWatchSession;
  summary: WorkflowSummary;
  /** Last per-step statuses broadcast for this run. */
  lastStepStatuses: StepStatus[];
  /** Serializes history snapshots so older reads cannot replace newer output. */
  historyLoadPromise: Promise<void>;
  /** Prevents watcher callbacks from queuing reads after the final snapshot. */
  finishing?: boolean;
}

export class ExternalRunWatchCoordinator implements RunViewPublisherExternalRunWatchPort {
  private readonly externalRunSessions = new Map<
    string,
    ExternalRunWatchEntry
  >();
  private readonly pendingStarts = new Map<string, Promise<boolean>>();
  private runnerJsonCreateWatcher?: import("../HostPorts").FileWatcher;
  private runnerJsonDiscoveryPollInterval?: ReturnType<typeof setInterval>;
  private readonly polledRunnerJsonMtimes = new Map<string, number>();
  private lastLoggedExternalExecutionDecision?: Map<string, string>;
  private activationWorktreeOwnership?: WorkspaceWorktreeOwnership;

  constructor(private readonly host: ExternalRunWatchHost) {}

  hasSession(workflowId: string): boolean {
    return this.externalRunSessions.has(workflowId);
  }

  getEntry(workflowId: string): ExternalRunWatchEntry | undefined {
    return this.externalRunSessions.get(workflowId);
  }

  getSummaries(): WorkflowSummary[] {
    return [...this.externalRunSessions.values()].map((entry) => entry.summary);
  }

  getActivationWorktreeOwnership(): WorkspaceWorktreeOwnership | undefined {
    return this.activationWorktreeOwnership;
  }

  async setupExternalRunWatching(): Promise<void> {
    const workspaceFolderPath = this.host.workspaceRoot;
    if (!workspaceFolderPath) {
      return;
    }

    const runsRootDir = WorkflowPaths.runsRoot(workspaceFolderPath);
    try {
      await fs.promises.mkdir(runsRootDir, { recursive: true });
    } catch (err) {
      Log.warn(
        `[WorkflowOrchestrator] setupExternalRunWatching: unable to create runs root "${runsRootDir}" — external-run discovery watcher not installed:`,
        err
      );
      return;
    }

    let activeRunPaths: string[];
    let recoveredPaths: string[];
    try {
      const workflowKeys =
        await this.host.lineageRepository.listLineageKeys(workspaceFolderPath);
      const normalized = await WorkflowLockManager.normalizeStaleLocks(
        workspaceFolderPath,
        workflowKeys
      );
      activeRunPaths = normalized.activeRunFiles;
      recoveredPaths = normalized.recoveredRunFiles;
    } catch (err) {
      Log.warn(
        "[WorkflowOrchestrator] setupExternalRunWatching: normalizeStaleLocks failed:",
        err
      );
      activeRunPaths = [];
      recoveredPaths = [];
    }

    try {
      const workflowKeys =
        await this.host.lineageRepository.listLineageKeys(workspaceFolderPath);
      for (const workflowKey of workflowKeys) {
        await this.host.lineageRepository.pruneStaleStagingDirs(
          workspaceFolderPath,
          workflowKey
        );
      }
    } catch (err) {
      Log.warn(
        "[WorkflowOrchestrator] setupExternalRunWatching: pruneStaleStagingDirs failed:",
        err
      );
    }

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
          recoveredAddress.runRef,
          stepCount
        );
      }
    } catch (err) {
      Log.warn(
        "[WorkflowOrchestrator] setupExternalRunWatching: interrupted-run recovery failed:",
        err
      );
    }

    for (const workingFilePath of new Set(activeRunPaths)) {
      await this.startExternalRunWatchSessionIfExternal(
        workingFilePath,
        workspaceFolderPath
      );
    }
    this.setupRunnerJsonCreateWatcher(workspaceFolderPath, runsRootDir);
  }

  async discoverWorktreesOnActivation(): Promise<void> {
    const workspaceFolderPath = this.host.workspaceRoot;
    if (!workspaceFolderPath) return;
    this.activationWorktreeOwnership = undefined;

    try {
      const report = await new WorktreeManager().discoverActivationState({
        sourceCheckoutRoot: workspaceFolderPath,
      });
      const inUse = report.worktrees.filter((entry) => entry.inUse);
      const prunable = report.worktrees.filter((entry) => entry.prunableReason);
      this.activationWorktreeOwnership = report.currentManagedWorktree;

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

  setupRunnerJsonCreateWatcher(
    workspaceFolderPath: string,
    runsRootDir: string
  ): void {
    const watcher = this.host.fileWatcherFactory.create(
      runsRootDir,
      "*/runner.json"
    );
    this.runnerJsonCreateWatcher = watcher;
    watcher.onDidCreate(async (filePath) => {
      Log.debug(
        `[WorkflowOrchestrator] runner.json created: ${path.basename(filePath)}`
      );
      await this.handleRunnerJsonEvent(filePath, workspaceFolderPath);
    });
    watcher.onDidChange(async (filePath) => {
      await this.handleRunnerJsonEvent(filePath, workspaceFolderPath);
    });
    this.runnerJsonDiscoveryPollInterval = setInterval(() => {
      void this.pollRunnerJsonDiscovery(runsRootDir, workspaceFolderPath);
    }, 1_000);
  }

  async pollRunnerJsonDiscovery(
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
          .filter((entry) => !this.externalRunSessions.has(entry.name))
          .map(async (entry) => {
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
      for (const trackedPath of this.polledRunnerJsonMtimes.keys()) {
        if (!seenRunnerPaths.has(trackedPath)) {
          this.polledRunnerJsonMtimes.delete(trackedPath);
          this.lastLoggedExternalExecutionDecision?.delete(
            path.basename(path.dirname(trackedPath))
          );
        }
      }
    } catch (err) {
      Log.warn(
        `[WorkflowOrchestrator] pollRunnerJsonDiscovery: unable to scan "${runsRootDir}":`,
        err
      );
    }
  }

  async handleRunnerJsonEvent(
    lockFilePath: string,
    workspaceFolderPath: string
  ): Promise<void> {
    const workflowKey = path.basename(
      path.dirname(lockFilePath)
    ) as WorkflowKey;
    const lockInspection = await readWorkflowLockOwnershipInspection(
      workspaceFolderPath,
      workflowKey,
      this.host.runnerHostIdentity
    );
    if (lockInspection.liveness !== WORKFLOW_LOCK_LIVENESS.ACTIVE) {
      return;
    }
    const lock = lockInspection.lock;
    const workflowId = lock.workflowKey;
    const workingFilePath = WorkflowPaths.runFilePath(
      workspaceFolderPath,
      lock.workflowKey,
      lock.runRef
    );
    const resolution = await this.resolveExternalExecutionForPath(
      workingFilePath,
      workspaceFolderPath
    );
    if (
      resolution.kind !==
      EXTERNAL_EXECUTION_RESOLUTION_KINDS.EXTERNAL_ACTIVE_RUN
    ) {
      return;
    }
    if (this.externalRunSessions.has(workflowId)) {
      return;
    }
    await this.startExternalRunWatchSession(
      workingFilePath,
      workspaceFolderPath,
      resolution.inspection
    );
  }

  async startExternalRunWatchSessionIfExternal(
    workingFilePath: string,
    workspaceFolderPath: string
  ): Promise<boolean> {
    const resolution = await this.resolveExternalExecutionForPath(
      workingFilePath,
      workspaceFolderPath
    );
    return resolution.kind ===
      EXTERNAL_EXECUTION_RESOLUTION_KINDS.EXTERNAL_ACTIVE_RUN
      ? this.startExternalRunWatchSession(
          workingFilePath,
          workspaceFolderPath,
          resolution.inspection
        )
      : false;
  }

  async startExternalRunWatchSession(
    workingFilePath: string,
    workspaceFolderPath: string,
    inspection: ActiveExternalLockInspection
  ): Promise<boolean> {
    const workflowId = inspection.lock.workflowKey;
    if (this.externalRunSessions.has(workflowId)) return true;
    const pending = this.pendingStarts.get(workflowId);
    if (pending) return pending;

    const start = this.createExternalRunWatchSession(
      workingFilePath,
      workspaceFolderPath,
      inspection
    ).finally(() => {
      if (this.pendingStarts.get(workflowId) === start) {
        this.pendingStarts.delete(workflowId);
      }
    });
    this.pendingStarts.set(workflowId, start);
    return start;
  }

  private async createExternalRunWatchSession(
    workingFilePath: string,
    workspaceFolderPath: string,
    inspection: ActiveExternalLockInspection
  ): Promise<boolean> {
    const address =
      WorkflowPaths.parseWorkingFileAddressFromPath(workingFilePath);
    if (!address?.runRef) {
      Log.warn(
        `[WorkflowOrchestrator] startExternalRunWatchSession: "${workingFilePath}" is not a promoted run file — skipping`
      );
      return false;
    }
    const { workflowKey, runRef } = address;
    const workflowId = workflowKey;
    if (
      inspection.lock.workflowKey !== workflowKey ||
      inspection.lock.runRef !== runRef
    ) {
      Log.warn(
        `[WorkflowOrchestrator] startExternalRunWatchSession: external proof does not match "${workingFilePath}" — skipping`
      );
      return false;
    }

    const currentResolution = await this.resolveExternalExecutionForPath(
      workingFilePath,
      workspaceFolderPath
    );
    if (
      currentResolution.kind !==
      EXTERNAL_EXECUTION_RESOLUTION_KINDS.EXTERNAL_ACTIVE_RUN
    ) {
      return false;
    }
    const currentInspection = currentResolution.inspection;
    if (
      currentInspection.lock.ownerToken !== inspection.lock.ownerToken ||
      currentInspection.lock.workflowKey !== inspection.lock.workflowKey ||
      currentInspection.lock.runRef !== inspection.lock.runRef
    ) {
      Log.info(
        `[WorkflowOrchestrator] startExternalRunWatchSession: external lock acquisition changed for "${workflowId}" — skipping stale proof`
      );
      return false;
    }

    const workingFile = currentResolution.workingFile;
    const executionState = workingFile._runtime?.executionState;
    if (!executionState || !ACTIVE_EXECUTION_STATES.has(executionState)) {
      Log.info(
        `[WorkflowOrchestrator] startExternalRunWatchSession: "${workflowId}" has a live ${currentInspection.lock.runner} lock but persisted state is ${executionState ?? "missing"} — skipping external watch session`
      );
      return false;
    }
    const externalOwner = {
      locality: WORKFLOW_LOCK_LOCALITIES.EXTERNAL,
      runner: currentInspection.lock.runner,
    };

    for (const instance of this.host.findInstanceForWorkingFile(
      workingFilePath
    )) {
      const localSummary = instance.getSummary();
      const hasInFlightStep =
        localSummary.executionState === EXECUTION_STATES.RUNNING ||
        localSummary.executionState === EXECUTION_STATES.PAUSING ||
        localSummary.executionState === EXECUTION_STATES.CANCELLING;
      if (hasInFlightStep) {
        Log.info(
          `[WorkflowOrchestrator] startExternalRunWatchSession: "${workflowId}" is already owned by this process's in-flight WorkflowInstance inst:${instance.id.slice(0, 8)} (executionState=${localSummary.executionState}) — skipping external watch session instead of retiring it`
        );
        return false;
      }
      if (localSummary.executionState !== EXECUTION_STATES.PAUSED) {
        continue;
      }
      Log.info(
        `[WorkflowOrchestrator] startExternalRunWatchSession: retiring conflicting WorkflowInstance inst:${instance.id.slice(0, 8)} for "${workflowId}"`
      );
      this.host.retireWorkflow(instance.id);
      break;
    }

    const currentIndex = workingFile._runtime?.currentIndex ?? 0;
    const totalSteps = workingFile.steps?.length ?? 0;
    const finalStepSummary = deriveWorkflowFinalStepSummary(
      workingFile.finalStep,
      workingFile._runtime?.finalStep
    );
    const summary: WorkflowSummary = {
      id: workflowId,
      workflowKey,
      runRef,
      workflowName: await this.host.lineageRepository.readWorkflowDisplayName(
        workspaceFolderPath,
        workflowKey
      ),
      filePath: workingFilePath,
      workingFilePath,
      executionState,
      currentStep: currentIndex,
      totalSteps,
      startedAt: workingFile.startedAt,
      externalOwner,
      tokenTotals: workingFile._runtime?.tokenTotals,
      worktree: workingFile._runtime?.worktree,
      ...finalStepSummary,
    };

    const session = new ExternalRunWatchSession(
      workingFilePath,
      workflowKey,
      runRef,
      workspaceFolderPath,
      currentInspection,
      this.host.runnerHostIdentity,
      (partialSummary, updatedSteps) => {
        const entry = this.externalRunSessions.get(workflowId);
        if (!entry) return;
        const prevTotalSteps = entry.summary.totalSteps;
        const updatedSummary: WorkflowSummary = {
          ...entry.summary,
          ...partialSummary,
          externalOwner,
        };
        entry.summary = updatedSummary;
        this.host.broadcast.notifyWorkflowSummaryUpdated(updatedSummary);
        this.broadcastExternalRunStepStatuses(
          workflowId,
          entry,
          updatedSteps,
          updatedSummary
        );
        if (updatedSummary.totalSteps > prevTotalSteps) {
          const provider = this.host.broadcast;
          fs.promises
            .readFile(workingFilePath, "utf8")
            .then((content) => {
              const wf = JSON.parse(content) as {
                steps?: unknown[];
                definitionRevision?: number;
                parallelGroups?: import("../../types/CtrlYokeTypes").ParallelGroupDefinition[];
              };
              if (wf.steps) {
                Log.info(
                  `[WorkflowOrchestrator] CLI extended queue for "${workflowId}": ${prevTotalSteps} ${updatedSummary.totalSteps} steps`
                );
                provider.notifyCliPromptsExtended(
                  workflowId,
                  wf.steps,
                  wf.definitionRevision ?? 1,
                  wf.parallelGroups
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
        this.handleExternalRunWatchOutput(workflowId, historyFilePath);
      },
      (reason) => {
        void this.handleExternalRunFinished(
          workflowId,
          workingFilePath,
          reason
        );
      },
      this.host.fileWatcherFactory
    );

    if (this.externalRunSessions.has(workflowId)) {
      session.dispose();
      return true;
    }
    this.externalRunSessions.set(workflowId, {
      session,
      summary,
      lastStepStatuses: deriveStepStatusesFromRuntime(
        (workingFile.steps as StepWithRuntimeStatus[] | undefined) ?? [],
        currentIndex,
        executionState,
        undefined,
        workingFile._runtime?.finalStep?.phase
      ),
      historyLoadPromise: Promise.resolve(),
    });
    await session.start();
    const activeEntry = this.externalRunSessions.get(workflowId);
    if (activeEntry?.session !== session) {
      session.dispose();
      return false;
    }
    this.host.broadcast.notifyWorkflowAdded(activeEntry.summary);
    Log.info(
      `[WorkflowOrchestrator] external run watch session started for "${workflowId}" (runner=${externalOwner.runner})`
    );
    return true;
  }

  broadcastExternalRunStepStatuses(
    workflowId: string,
    entry: { lastStepStatuses: StepStatus[] },
    steps: readonly StepWithRuntimeStatus[],
    summary: WorkflowSummary
  ): void {
    const statuses = deriveStepStatusesFromRuntime(
      steps,
      summary.currentStep ?? 0,
      summary.executionState,
      undefined,
      summary.finalStepPhase
    );
    for (const [index, status] of statuses.entries()) {
      if (entry.lastStepStatuses[index] === status) continue;
      this.host.broadcast.updateStepStatus(
        index,
        { state: status },
        undefined,
        workflowId
      );
    }
    entry.lastStepStatuses = statuses;
  }

  async sendExternalRunFullStateToDashboard(
    workflowId: string,
    externalEntry: ExternalRunWatchEntry,
    sink?: IDashboardSink
  ): Promise<void> {
    const workingFilePath = externalEntry.summary.workingFilePath;
    if (!workingFilePath) return;
    let steps: WorkflowStep[] = [];
    let currentIndex = externalEntry.summary.currentStep ?? 0;
    let finalStep: WorkflowStep | null = null;
    let finalStepRuntime:
      | { status?: StepStatus; loopCount: number; phase: FinalStepPhase }
      | undefined;
    try {
      const content = await fs.promises.readFile(workingFilePath, "utf8");
      const workingFile = stripLegacyWorkingFileLineageMetadata(
        JSON.parse(content) as WorkingFile
      );
      steps = ((workingFile.steps as WorkflowStep[]) ?? []).map((p) => ({
        ...p,
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
        `[WorkflowOrchestrator] sendExternalRunFullStateToDashboard: could not read working file:`,
        err
      );
    }
    const statuses = deriveStepStatusesFromRuntime(
      steps,
      currentIndex,
      externalEntry.summary.executionState,
      undefined,
      finalStepRuntime?.phase
    );
    externalEntry.lastStepStatuses = statuses;
    const results = statuses.map((status) => ({ status }));
    const fileName = path.basename(workingFilePath);
    const target: Pick<IDashboardSink, "updateSessionRestored"> =
      sink ?? this.host.broadcast;
    await target.updateSessionRestored(
      fileName,
      steps,
      results,
      externalEntry.summary.executionState,
      currentIndex,
      externalEntry.summary.workflowName,
      finalStep,
      finalStepRuntime,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    );
    const historyFilePath = externalEntry.session.getActiveHistoryFilePath();
    if (historyFilePath) {
      if (sink) {
        await this.replayExternalHistoryFileTo(historyFilePath, sink);
      } else {
        await this.replayExternalWatchHistoryFile(workflowId, historyFilePath);
      }
    }
  }

  async replayExternalHistoryFileTo(
    historyFilePath: string,
    sink: IDashboardSink
  ): Promise<void> {
    try {
      const history = await this.host
        .getOutputHistoryManager()
        .loadHistory(historyFilePath);
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
          sink.updateCliOutput(
            stepIndex,
            entry.cliOutput as CliOutput,
            undefined,
            entry.prompt
          );
        }
      }
    } catch (err) {
      Log.warn(
        `[WorkflowOrchestrator] replayExternalHistoryFileTo: failed:`,
        err
      );
    }
  }

  async replayExternalWatchHistoryFile(
    workflowId: string,
    historyFilePath: string
  ): Promise<void> {
    const entry = this.externalRunSessions.get(workflowId);
    if (!entry) return;
    const load = entry.historyLoadPromise.then(async () => {
      if (this.externalRunSessions.get(workflowId) !== entry) return;
      try {
        const history = await this.host
          .getOutputHistoryManager()
          .loadHistory(historyFilePath);
        this.broadcastChangedCliWatchOutputs(workflowId, entry, history);
      } catch (err) {
        Log.warn(
          `[WorkflowOrchestrator] replayExternalWatchHistoryFile: failed to read history file:`,
          err
        );
      }
    });
    entry.historyLoadPromise = load;
    await load;
  }

  handleExternalRunWatchOutput(
    workflowId: string,
    historyFilePath: string
  ): void {
    const entry = this.externalRunSessions.get(workflowId);
    if (!entry || entry.finishing) return;
    void this.replayExternalWatchHistoryFile(workflowId, historyFilePath).catch(
      (err: unknown) => {
        Log.warn(
          `[WorkflowOrchestrator] handleExternalRunWatchOutput: failed to read history file:`,
          err
        );
      }
    );
  }

  private broadcastChangedCliWatchOutputs(
    workflowId: string,
    entry: ExternalRunWatchEntry,
    history: Awaited<ReturnType<OutputHistoryManager["loadHistory"]>>
  ): void {
    for (const historyEntry of history.orderedEntries) {
      if (this.externalRunSessions.get(workflowId) !== entry) return;
      if (
        historyEntry.kind !== OUTPUT_HISTORY_KINDS.CLI ||
        historyEntry.target.kind !== FINAL_STEP_PHASES.QUEUE
      ) {
        continue;
      }
      const stepIndex = historyEntry.target.stepIndex;
      const output = historyEntry.cliOutput as CliOutput;
      const entryKey = [
        `queue:${stepIndex}`,
        `run:${historyEntry.runIndex ?? output.runIndex ?? 0}`,
        `attempt:${historyEntry.attemptIndex ?? output.attemptIndex ?? 0}`,
        `phase:${historyEntry.phase ?? EXECUTION_PHASES.PROMPT}`,
      ].join(":");
      const signature = getCliOutputSignature(output);
      if (!entry.session.shouldBroadcastOutput(entryKey, signature)) continue;
      if (this.externalRunSessions.get(workflowId) !== entry) return;
      this.host.broadcast.notifyCliWatchOutput(
        workflowId,
        stepIndex,
        output,
        historyEntry.prompt
      );
    }
  }

  async handleExternalRunFinished(
    workflowId: string,
    workingFilePath: string,
    reason: ExternalRunWatchFinishReason
  ): Promise<void> {
    const entry = this.externalRunSessions.get(workflowId);
    if (!entry || entry.finishing) return;
    entry.finishing = true;
    Log.info(
      `[WorkflowOrchestrator] external run session finished for "${workflowId}" (reason=${reason})`
    );
    // The terminal working-file notification can beat the final manifest
    // rewrite. Read history once more while the session is still registered,
    // and finish only after that tail has reached the dashboard.
    await this.replayExternalWatchHistoryFile(
      workflowId,
      entry.session.getActiveHistoryFilePath()
    );
    if (this.externalRunSessions.get(workflowId) !== entry) return;
    entry.session.dispose();
    this.externalRunSessions.delete(workflowId);

    if (reason === "ownership-changed") {
      const workspaceFolderPath = this.host.workspaceRoot;
      const workflowKey = entry.summary.workflowKey;
      if (workspaceFolderPath && workflowKey) {
        void this.restartExternalRunWatchSession(
          workspaceFolderPath,
          workflowKey
        ).catch((error) => {
          Log.warn(
            `[WorkflowOrchestrator] failed to restart external watch session for "${workflowKey}":`,
            error
          );
          this.host.broadcast.notifyWorkflowDismissed(workflowId);
        });
      } else {
        this.host.broadcast.notifyWorkflowDismissed(workflowId);
      }
      return;
    }

    try {
      const content = await fs.promises.readFile(workingFilePath, "utf8");
      const workingFile = JSON.parse(content) as {
        _runtime?: {
          executionState?: string;
          currentIndex?: number;
          tokenTotals?: WorkflowSummary["tokenTotals"];
          finalStep?: NonNullable<WorkingFile["_runtime"]>["finalStep"];
        };
        steps?: StepWithRuntimeStatus[];
        finalStep?: WorkingFile["finalStep"];
        workflowName?: string;
        startedAt?: number;
      };
      let finalState =
        workingFile._runtime?.executionState ?? EXECUTION_STATES.STOPPED;
      if (finalState === EXECUTION_STATES.RUNNING) {
        finalState = EXECUTION_STATES.STOPPED;
        if (workingFile._runtime) {
          workingFile._runtime.executionState = EXECUTION_STATES.STOPPED;
        }
        try {
          // A newer ctrlyoke's run is displayed as stopped but never rewritten.
          assertWritableSchema(
            PERSISTED_STORES.RUN_FILE,
            workingFile._runtime,
            workingFilePath
          );
          await WorkingFileManager.writeWorkingFileAtomic(
            workingFilePath,
            workingFile as WorkingFile
          );
        } catch (writeErr) {
          Log.warn(
            `[WorkflowOrchestrator] handleExternalRunFinished: failed to normalize working file:`,
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
        externalOwner: undefined,
        tokenTotals: workingFile._runtime?.tokenTotals,
        ...deriveWorkflowFinalStepSummary(
          workingFile.finalStep,
          workingFile._runtime?.finalStep
        ),
        finalStepRunning: false,
      };
      this.broadcastExternalRunStepStatuses(
        workflowId,
        entry,
        workingFile.steps ?? [],
        finalSummary
      );
      this.host.broadcast.notifyWorkflowSummaryUpdated(finalSummary);
      this.host.broadcast.notifyWorkflowDismissed(workflowId);
      void this.host.saveState();
    } catch (err) {
      Log.warn(
        `[WorkflowOrchestrator] handleExternalRunFinished: failed to read working file:`,
        err
      );
      this.host.broadcast.notifyWorkflowDismissed(workflowId);
    }
  }

  async restartExternalRunWatchSession(
    workspaceFolderPath: string,
    workflowKey: WorkflowKey
  ): Promise<void> {
    const lockInspection = await readWorkflowLockOwnershipInspection(
      workspaceFolderPath,
      workflowKey,
      this.host.runnerHostIdentity
    );
    if (lockInspection.liveness !== WORKFLOW_LOCK_LIVENESS.ACTIVE) {
      this.host.broadcast.notifyWorkflowDismissed(workflowKey);
      return;
    }
    const workingFilePath = WorkflowPaths.runFilePath(
      workspaceFolderPath,
      workflowKey,
      lockInspection.lock.runRef
    );
    const started = await this.startExternalRunWatchSessionIfExternal(
      workingFilePath,
      workspaceFolderPath
    );
    if (!started) {
      this.host.broadcast.notifyWorkflowDismissed(workflowKey);
    }
  }

  async ensureExternalRunWatchSession(
    workingFilePath: string
  ): Promise<boolean> {
    const workflowId =
      WorkflowPaths.parseWorkingFileAddressFromPath(workingFilePath)
        ?.workflowKey ?? "";
    if (!workflowId) return false;
    if (this.externalRunSessions.has(workflowId)) return true;
    const workspaceFolderPath = this.host.workspaceRoot;
    if (!workspaceFolderPath) return false;
    const resolution = await this.resolveExternalExecutionForPath(
      workingFilePath,
      workspaceFolderPath
    );
    if (
      resolution.kind !==
      EXTERNAL_EXECUTION_RESOLUTION_KINDS.EXTERNAL_ACTIVE_RUN
    ) {
      return false;
    }
    Log.info(
      `[WorkflowOrchestrator] ensureExternalRunWatchSession: registering external watch session for "${workflowId}" (watcher hadn't fired yet)`
    );
    return this.startExternalRunWatchSession(
      workingFilePath,
      workspaceFolderPath,
      resolution.inspection
    );
  }

  async resolveExternalExecutionForPath(
    workingFilePath: string,
    workspaceFolderPath: string
  ): Promise<ExternalExecutionResolution> {
    return new ExternalExecutionResolver(
      workspaceFolderPath,
      this.host.runnerHostIdentity,
      {
        onDecision: (decision) => {
          const key = decision.workflowKey ?? workingFilePath;
          const signature = JSON.stringify(decision);
          const cache = (this.lastLoggedExternalExecutionDecision ??=
            new Map());
          if (cache.get(key) === signature) return;
          cache.set(key, signature);
          const message = `[WorkflowOrchestrator] external execution resolution: ${signature}`;
          if (decision.locality === WORKFLOW_LOCK_LOCALITIES.INDETERMINATE) {
            Log.warn(message);
          } else {
            Log.debug(message);
          }
        },
      }
    ).resolve(workingFilePath);
  }

  shouldDeclineUntrackedOwnership(
    workingFilePath: string,
    resolution: ExternalExecutionResolution
  ): boolean {
    if (
      resolution.kind !== EXTERNAL_EXECUTION_RESOLUTION_KINDS.NOT_EXTERNAL ||
      (resolution.reason !== EXTERNAL_EXECUTION_REASONS.SELF_OWNED &&
        resolution.reason !== EXTERNAL_EXECUTION_REASONS.INDETERMINATE_OWNER)
    ) {
      return false;
    }
    const hasResidentExecution = this.host
      .findInstanceForWorkingFile(workingFilePath, true)
      .some((instance) =>
        isExecutionOwnerState(instance.getQueueState().status)
      );
    if (hasResidentExecution) return false;
    const address =
      WorkflowPaths.parseWorkingFileAddressFromPath(workingFilePath);
    const diagnostic = {
      event: "workflow-ownership-invariant",
      workflowKey: address?.workflowKey,
      runRef: address?.runRef,
      locality:
        resolution.reason === EXTERNAL_EXECUTION_REASONS.SELF_OWNED
          ? "self-owned-but-untracked"
          : "indeterminate-owner",
      decision: "preserve-non-mutating",
    } as const;
    const message =
      `[WorkflowOrchestrator] active run ownership requires reconciliation: ` +
      JSON.stringify(diagnostic);
    if (resolution.reason === EXTERNAL_EXECUTION_REASONS.SELF_OWNED) {
      Log.error(message);
    } else {
      Log.warn(message);
    }
    return true;
  }

  async stopExternalRunSession(workflowId: string): Promise<void> {
    const entry = this.externalRunSessions.get(workflowId);
    if (!entry) {
      Log.warn(
        `[WorkflowOrchestrator] stopExternalRunSession: no external run session found for workflowId="${workflowId}"`
      );
      return;
    }
    const workspaceFolderPath = this.host.workspaceRoot;
    if (!workspaceFolderPath || !entry.summary.workingFilePath) {
      Log.warn(
        `[WorkflowOrchestrator] stopExternalRunSession: no active external run for workflowId="${workflowId}"`
      );
      return;
    }
    const resolution = await this.resolveExternalExecutionForPath(
      entry.summary.workingFilePath,
      workspaceFolderPath
    );
    if (
      resolution.kind !==
        EXTERNAL_EXECUTION_RESOLUTION_KINDS.EXTERNAL_ACTIVE_RUN ||
      resolution.inspection.lock.runner !== RUNNER_IDS.CLI ||
      resolution.inspection.lock.ownerToken !== entry.session.getOwnerToken()
    ) {
      Log.warn(
        `[WorkflowOrchestrator] stopExternalRunSession: external lock acquisition is no longer owned by the tracked session for workflowId="${workflowId}"`
      );
      return;
    }
    const lock = resolution.inspection.lock;
    Log.info(
      `[WorkflowOrchestrator] stopExternalRunSession: sending stop request to ${lock.runner} pid=${lock.pid} for workflowId="${workflowId}"`
    );
    try {
      process.kill(lock.pid, "SIGTERM");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") {
        Log.warn(
          `[WorkflowOrchestrator] stopExternalRunSession: process.kill(${lock.pid}) failed:`,
          err
        );
      }
    }
  }

  dispose(): void {
    for (const entry of this.externalRunSessions.values()) {
      entry.session.dispose();
    }
    this.externalRunSessions.clear();
    this.pendingStarts.clear();
    this.runnerJsonCreateWatcher?.dispose();
    this.runnerJsonCreateWatcher = undefined;
    if (this.runnerJsonDiscoveryPollInterval !== undefined) {
      clearInterval(this.runnerJsonDiscoveryPollInterval);
      this.runnerJsonDiscoveryPollInterval = undefined;
    }
    this.polledRunnerJsonMtimes.clear();
  }
}

function isExecutionOwnerState(status: QueueState["status"]): boolean {
  return (
    status === EXECUTION_STATES.RUNNING ||
    status === EXECUTION_STATES.PAUSING ||
    status === EXECUTION_STATES.PAUSED ||
    status === EXECUTION_STATES.CANCELLING
  );
}

function getCliOutputSignature(output: CliOutput): string {
  const content = JSON.stringify(output);
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index++) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${content.length}:${hash >>> 0}`;
}
