import {
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  PARALLEL_GROUP_ADMISSION,
  PROMPT_TERMINAL_STATUS,
  STEP_CLAIM_OUTCOMES,
  type StepClaimOutcome,
  type ParallelGroupAdmission,
} from "../types/DashboardConstants";
import type {
  ParallelGroupDefinition,
  ParallelGroupOutcome,
  StepExecutionOutcome,
  WorkflowStep,
  WorkflowAttemptTarget,
} from "../types/CtrlYokeTypes";
import type {
  ParallelGroupMemberPreflightResult,
  ParallelGroupPreflightMember,
} from "./ParallelGroupPreflight";
import type { RawWorkspaceState } from "../utils/WorkspaceSnapshotService";

type ExecutionTarget = WorkflowAttemptTarget;

interface DisposableLike {
  dispose(): void;
}

export interface ParallelGroupStepResolution {
  readonly step: WorkflowStep;
  readonly stepIndex: number;
}

export interface ParallelGroupRunningMember {
  readonly stepId: string;
  readonly target: ExecutionTarget;
  readonly step: WorkflowStep;
  readonly preflightMember?: ParallelGroupPreflightMember;
}

export interface ParallelGroupReconcileAndCloseResult {
  readonly joined: boolean;
  readonly group?: ParallelGroupDefinition;
}

export interface ParallelGroupRunOptions<TContext extends object> {
  readonly group: ParallelGroupDefinition;
  readonly pendingIds: readonly string[];
  readonly initialOutcomes?: ReadonlyMap<string, StepExecutionOutcome>;
  readonly effectiveWidth: number;
  readonly context: TContext;
  readonly snapshotStrategy: "git" | "filesystem" | undefined;
  readonly groupBeforeState?: RawWorkspaceState;
  readonly resolveStepById: (
    stepId: string
  ) => ParallelGroupStepResolution | undefined;
  /** Release resources acquired during admission for an ID removed while pending. */
  readonly releaseRemovedPendingMember?: (stepId: string) => Promise<void>;
  readonly claimStepById: (
    stepId: string,
    startedAt: number,
    context: TContext
  ) => Promise<{
    readonly status: StepClaimOutcome;
    readonly step?: WorkflowStep;
    readonly stepIndex?: number;
  }>;
  readonly preflightMember: (options: {
    readonly step: WorkflowStep;
    readonly stepIndex: number;
    readonly runningMembers: readonly ParallelGroupPreflightMember[];
  }) => Promise<ParallelGroupMemberPreflightResult>;
  readonly executeMember: (
    target: ExecutionTarget,
    step: WorkflowStep,
    context: TContext,
    snapshotStrategy: "git" | "filesystem" | undefined,
    preflightMember?: ParallelGroupPreflightMember
  ) => Promise<StepExecutionOutcome>;
  readonly persistSettlement: (
    outcome: StepExecutionOutcome,
    context: TContext
  ) => Promise<void>;
  readonly captureGroupSnapshot?: (
    target: ExecutionTarget,
    beforeState: RawWorkspaceState,
    strategy: "git" | "filesystem",
    groupId: string,
    context: TContext
  ) => Promise<void>;
  readonly cancelTarget?: (target: ExecutionTarget) => Promise<void>;
  readonly releaseTargetResources?: (target: ExecutionTarget) => Promise<void>;
  readonly getRuntimeStatus: () => string;
  readonly subscribeToStop?: (onStop: () => void) => DisposableLike;
  readonly getCurrentGroup: (
    groupId: string
  ) => ParallelGroupDefinition | undefined;
  readonly commitJoin: (
    group: ParallelGroupDefinition,
    outcomes: readonly StepExecutionOutcome[]
  ) => Promise<void>;
  readonly persistAdmission?: (
    admission: ParallelGroupAdmission
  ) => Promise<void>;
  /**
   * Atomically merges disk topology, reconciles late IDs, or closes and
   * commits the group. The executor supplies the file-backed implementation.
   */
  readonly reconcileAndClose?: (options: {
    readonly groupId: string;
    readonly outcomes: readonly StepExecutionOutcome[];
    readonly isKnownMember: (stepId: string) => boolean;
    readonly reconcileMembers: (
      stepIds: readonly string[]
    ) => readonly string[];
  }) => Promise<ParallelGroupReconcileAndCloseResult>;
  readonly confirmPause?: () => Promise<void>;
}

/**
 * Owns the mutable lifetime of one active parallel group.
 *
 * Step IDs are the scheduler's identity. Absolute indices are retained only
 * on the execution targets so the existing output, manifest, PTY, snapshot,
 * and coordination projections remain unchanged.
 */
export class ParallelGroupRun<TContext extends object> {
  public readonly pendingIds: string[];
  public readonly running = new Map<string, ParallelGroupRunningMember>();
  public readonly outcomes = new Map<string, StepExecutionOutcome>();
  public readonly abortController = new AbortController();

  private nextPending = 0;
  private activeWorkers = 0;
  private readonly workerPromises = new Set<Promise<void>>();
  private workerError: unknown;
  private failFastTriggered = false;
  private preflightQueue = Promise.resolve();
  private runStarted = false;
  private admissionOpen = true;
  private admissionClosePromise?: Promise<void>;

  constructor(private readonly options: ParallelGroupRunOptions<TContext>) {
    this.pendingIds = [...options.pendingIds];
    for (const [stepId, outcome] of options.initialOutcomes ?? []) {
      this.outcomes.set(stepId, outcome);
    }
  }

  public get group(): ParallelGroupDefinition {
    return this.options.group;
  }

  public get groupContext(): TContext {
    return {
      ...this.options.context,
      abortSignal: this.abortController.signal,
    } as TContext;
  }

  public get isFailFastTriggered(): boolean {
    return this.failFastTriggered;
  }

  /** Whether this run can still accept a late member. */
  public get isAdmissionOpen(): boolean {
    return this.admissionOpen;
  }

  /**
   * Enqueue a late member, starting it immediately when a worker slot is free.
   * A saturated pool intentionally accepts the member and lets the drain loop
   * dispatch it when an existing worker settles.
   */
  public admit(stepId: string): boolean {
    if (
      !this.admissionOpen ||
      this.failFastTriggered ||
      this.shouldStopDispatching() ||
      this.pendingIds.includes(stepId) ||
      this.running.has(stepId) ||
      this.outcomes.has(stepId)
    ) {
      return false;
    }

    this.pendingIds.push(stepId);
    if (this.runStarted && this.activeWorkers < this.effectiveWorkerWidth()) {
      this.spawnWorker();
    }
    return true;
  }

  /**
   * Reconcile persisted members into this run. Both the working-file watcher
   * and an in-process dispatcher may call this, so duplicate IDs are harmless.
   */
  public reconcileMembers(surviving: readonly string[]): string[] {
    const admitted: string[] = [];
    for (const stepId of surviving) {
      if (this.admit(stepId)) {
        admitted.push(stepId);
      }
    }
    return admitted;
  }

  public async run(): Promise<ParallelGroupOutcome> {
    const stopWatcher = this.options.subscribeToStop?.(() => {
      void this.closeAdmission().then(
        () => this.cancelRunning(),
        () => this.cancelRunning()
      );
    });

    try {
      this.runStarted = true;
      while (true) {
        await this.drainWorkers();
        if (this.workerError !== undefined) {
          await this.closeAdmission();
          await this.cancelRunning();
          throw this.workerError;
        }

        const stopped = this.isStopped();
        const paused = this.isPaused();
        if (stopped || this.failFastTriggered) {
          await this.closeAdmission();
          await this.cancelRunning();
          await this.cancelRemainingPending();
        }

        if (paused) {
          await this.closeAdmission();
          await this.options.confirmPause?.();
          return this.createOutcome(
            this.getOrderedOutcomes(),
            false,
            true,
            false
          );
        }

        let joinGroup: ParallelGroupDefinition | undefined;
        if (
          !stopped &&
          !this.failFastTriggered &&
          this.options.reconcileAndClose
        ) {
          const reconciliation = await this.options.reconcileAndClose({
            groupId: this.options.group.id,
            outcomes: this.getOrderedOutcomes(),
            isKnownMember: (stepId) =>
              this.pendingIds.includes(stepId) ||
              this.running.has(stepId) ||
              this.outcomes.has(stepId),
            reconcileMembers: (stepIds) => this.reconcileMembers(stepIds),
          });
          if (!reconciliation.joined) {
            await this.drainWorkers();
            continue;
          }
          this.admissionOpen = false;
          this.admissionClosePromise ??= Promise.resolve();
          joinGroup = reconciliation.group;
        } else {
          // Close before reading the current group or committing the join. A
          // concurrent admission must be rejected once the drain is complete.
          await this.closeAdmission();
          joinGroup = this.options.getCurrentGroup(this.options.group.id);
          if (!joinGroup) {
            throw new Error(
              `Cannot join parallel group ${this.options.group.id}: group is missing from the current definition`
            );
          }
          await this.options.commitJoin(joinGroup, this.getOrderedOutcomes());
        }

        if (!joinGroup) {
          throw new Error(
            `Cannot join parallel group ${this.options.group.id}: commit did not return a group`
          );
        }
        const orderedOutcomes = this.getOrderedOutcomes();

        const terminalFailure = orderedOutcomes.some(
          (outcome) =>
            outcome.status === PROMPT_TERMINAL_STATUS.FAILED &&
            outcome.terminalFailure !== false
        );
        return this.createOutcome(
          orderedOutcomes,
          terminalFailure,
          false,
          stopped,
          joinGroup
        );
      }
    } finally {
      stopWatcher?.dispose();
    }
  }

  private createOutcome(
    outcomes: StepExecutionOutcome[],
    terminalFailure: boolean,
    paused: boolean,
    stopped: boolean,
    group: ParallelGroupDefinition = this.options.group
  ): ParallelGroupOutcome {
    return {
      group,
      outcomes,
      settledCount: outcomes.length,
      terminalFailure,
      paused,
      stopped,
    };
  }

  private async worker(): Promise<void> {
    while (this.nextPending < this.pendingIds.length) {
      if (this.shouldStopDispatching()) return;
      const stepId = this.pendingIds[this.nextPending++];
      await this.runMember(stepId);
    }
  }

  private async drainWorkers(): Promise<void> {
    this.startAvailableWorkers();

    while (
      this.activeWorkers > 0 ||
      this.nextPending < this.pendingIds.length
    ) {
      if (this.isPaused()) {
        await this.closeAdmission();
        if (this.activeWorkers === 0) return;
      } else if (this.shouldStopDispatching()) {
        await this.closeAdmission();
        await this.cancelRunning();
        await this.cancelRemainingPending();
      } else if (this.activeWorkers === 0) {
        this.startAvailableWorkers();
        if (this.activeWorkers === 0) return;
      }

      if (this.workerPromises.size > 0) {
        await Promise.all(this.workerPromises);
      }
    }
  }

  private startAvailableWorkers(): void {
    while (
      this.activeWorkers < this.effectiveWorkerWidth() &&
      this.nextPending < this.pendingIds.length &&
      !this.shouldStopDispatching()
    ) {
      this.spawnWorker();
    }
  }

  private spawnWorker(): void {
    this.activeWorkers += 1;
    let workerPromise!: Promise<void>;
    workerPromise = this.worker()
      .catch((error: unknown) => {
        this.workerError ??= error;
      })
      .finally(() => {
        this.activeWorkers -= 1;
        this.workerPromises.delete(workerPromise);
      });
    this.workerPromises.add(workerPromise);
  }

  private effectiveWorkerWidth(): number {
    return Math.max(1, this.options.effectiveWidth);
  }

  private closeAdmission(): Promise<void> {
    if (this.admissionClosePromise) {
      return this.admissionClosePromise;
    }
    this.admissionOpen = false;
    this.admissionClosePromise =
      this.options.persistAdmission?.(PARALLEL_GROUP_ADMISSION.CLOSING) ??
      Promise.resolve();
    return this.admissionClosePromise;
  }

  private async runMember(stepId: string): Promise<void> {
    const resolved = this.options.resolveStepById(stepId);
    if (!resolved) {
      // A pending member removed by a serialized mutation has no execution
      // settlement. It was intentionally removed, not cancelled.
      await this.options.releaseRemovedPendingMember?.(stepId);
      return;
    }

    const claim = await this.options.claimStepById(
      stepId,
      Date.now(),
      this.groupContext
    );
    if (claim.status === STEP_CLAIM_OUTCOMES.MISSING) {
      await this.options.releaseRemovedPendingMember?.(stepId);
      return;
    }
    if (
      claim.status !== STEP_CLAIM_OUTCOMES.CLAIMED ||
      !claim.step ||
      claim.stepIndex === undefined
    ) {
      throw new Error(
        `Cannot dispatch parallel step ${stepId}: claim ${claim.status}`
      );
    }

    const target: ExecutionTarget = {
      kind: FINAL_STEP_PHASES.QUEUE,
      stepIndex: claim.stepIndex,
    };
    this.running.set(stepId, {
      stepId,
      target,
      step: claim.step,
    });

    try {
      const preflight = await this.runMemberPreflight(
        claim.step,
        claim.stepIndex
      );
      if (preflight.issues.length > 0) {
        await this.settleMember(
          stepId,
          {
            target,
            status: PROMPT_TERMINAL_STATUS.FAILED,
            failureReason: preflight.failureMessage,
          },
          false
        );
        return;
      }

      this.running.set(stepId, {
        stepId,
        target,
        step: claim.step,
        preflightMember: preflight.member,
      });
      let outcome: StepExecutionOutcome;
      try {
        outcome = await this.options.executeMember(
          target,
          claim.step,
          this.groupContext,
          this.options.effectiveWidth === 1
            ? this.options.snapshotStrategy
            : undefined,
          preflight.member
        );
      } catch (error) {
        outcome = {
          target,
          status: PROMPT_TERMINAL_STATUS.FAILED,
          failureReason: error instanceof Error ? error.message : String(error),
        };
      }
      if (
        this.abortController.signal.aborted &&
        this.failFastTriggered &&
        outcome.status === PROMPT_TERMINAL_STATUS.FAILED
      ) {
        outcome = { target, status: PROMPT_TERMINAL_STATUS.CANCELLED };
      }
      await this.settleMember(stepId, outcome, true);
    } finally {
      this.running.delete(stepId);
    }
  }

  private async runMemberPreflight(
    step: WorkflowStep,
    stepIndex: number
  ): Promise<ParallelGroupMemberPreflightResult> {
    const previous = this.preflightQueue;
    let release!: () => void;
    this.preflightQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const runningMembers = [...this.running.values()]
        .map((member) => member.preflightMember)
        .filter(
          (member): member is ParallelGroupPreflightMember =>
            member !== undefined
        );
      return await this.options.preflightMember({
        step,
        stepIndex,
        runningMembers,
      });
    } finally {
      release();
    }
  }

  private async settleMember(
    stepId: string,
    outcome: StepExecutionOutcome,
    captureSnapshot: boolean
  ): Promise<void> {
    this.running.delete(stepId);
    this.outcomes.set(stepId, outcome);
    await this.options.persistSettlement(outcome, this.options.context);
    if (
      captureSnapshot &&
      this.options.groupBeforeState &&
      this.options.snapshotStrategy &&
      this.options.captureGroupSnapshot
    ) {
      await this.options
        .captureGroupSnapshot(
          {
            kind: FINAL_STEP_PHASES.QUEUE,
            stepIndex: this.options.group.startIndex,
          },
          this.options.groupBeforeState,
          this.options.snapshotStrategy,
          this.options.group.id,
          this.options.context
        )
        .catch(() => undefined);
    }
    await this.options.releaseTargetResources?.(outcome.target);

    if (
      outcome.status === PROMPT_TERMINAL_STATUS.FAILED &&
      outcome.terminalFailure !== false &&
      this.options.group.failFast &&
      !this.failFastTriggered
    ) {
      this.failFastTriggered = true;
      await this.closeAdmission();
      await this.cancelRunning(
        outcome.target.kind === FINAL_STEP_PHASES.QUEUE
          ? this.findStepIdForTarget(outcome.target)
          : undefined
      );
    }
  }

  private findStepIdForTarget(target: ExecutionTarget): string | undefined {
    if (target.kind !== FINAL_STEP_PHASES.QUEUE) return undefined;
    for (const [stepId, member] of this.running) {
      if (
        member.target.kind === FINAL_STEP_PHASES.QUEUE &&
        member.target.stepIndex === target.stepIndex
      ) {
        return stepId;
      }
    }
    return undefined;
  }

  private async cancelRunning(exceptStepId?: string): Promise<void> {
    this.abortController.abort();
    await Promise.allSettled(
      [...this.running.entries()]
        .filter(([stepId]) => stepId !== exceptStepId)
        .map(([, member]) => this.options.cancelTarget?.(member.target))
    );
  }

  private async cancelRemainingPending(): Promise<void> {
    for (; this.nextPending < this.pendingIds.length; this.nextPending += 1) {
      const stepId = this.pendingIds[this.nextPending];
      const resolved = this.options.resolveStepById(stepId);
      if (!resolved) continue;
      const cancelled: StepExecutionOutcome = {
        target: {
          kind: FINAL_STEP_PHASES.QUEUE,
          stepIndex: resolved.stepIndex,
        },
        status: PROMPT_TERMINAL_STATUS.CANCELLED,
      };
      await this.settleMember(stepId, cancelled, false);
    }
  }

  private getOrderedOutcomes(): StepExecutionOutcome[] {
    return [...this.outcomes.values()].sort(
      (left, right) => this.targetIndex(left) - this.targetIndex(right)
    );
  }

  private targetIndex(outcome: StepExecutionOutcome): number {
    return outcome.target.kind === FINAL_STEP_PHASES.QUEUE
      ? outcome.target.stepIndex
      : Number.MAX_SAFE_INTEGER;
  }

  private shouldStopDispatching(): boolean {
    return (
      this.abortController.signal.aborted || this.isPaused() || this.isStopped()
    );
  }

  private isStopped(): boolean {
    const status = this.options.getRuntimeStatus();
    return (
      status === EXECUTION_STATES.CANCELLING ||
      status === EXECUTION_STATES.STOPPED
    );
  }

  private isPaused(): boolean {
    const status = this.options.getRuntimeStatus();
    return (
      status === EXECUTION_STATES.PAUSING || status === EXECUTION_STATES.PAUSED
    );
  }
}
