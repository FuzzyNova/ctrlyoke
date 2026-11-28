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
import { getErrorMessage } from "../utils/ErrorUtils";

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
  /**
   * Members that are already executing outside this run and must not be
   * dispatched by it. An ad-hoc promotion creates a group around a step the
   * sequential loop is still executing; that anchor is adopted so the group
   * can start its new members immediately instead of waiting for the anchor
   * to settle. Each adopted member holds a worker slot and keeps the drain
   * loop alive until `settleAdoptedMember` reports its outcome.
   */
  readonly adoptedMemberIds?: readonly string[];
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
  /**
   * A member whose dispatch preflight failed and that settles through its own
   * step's failure policy rather than as a bare FAILED: the member to execute
   * so that policy applies, or undefined to settle it FAILED directly. A
   * sub-workflow member returns itself carrying the failure as its prepared
   * launch, the way a group-preflight failure reaches it, so its `onFail`
   * decides.
   */
  readonly failedPreflightMember?: (
    preflight: ParallelGroupMemberPreflightResult
  ) => ParallelGroupPreflightMember | undefined;
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
  private readonly adopted = new Set<string>();
  private adoptionWaiter?: { promise: Promise<void>; resolve: () => void };

  constructor(private readonly options: ParallelGroupRunOptions<TContext>) {
    this.pendingIds = [...options.pendingIds];
    for (const [stepId, outcome] of options.initialOutcomes ?? []) {
      this.outcomes.set(stepId, outcome);
    }
    for (const stepId of options.adoptedMemberIds ?? []) {
      this.adopted.add(stepId);
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

  /** Whether this run can still accept a late member. */
  public get isAdmissionOpen(): boolean {
    return this.admissionOpen;
  }

  /** Members executing outside this run that it is still waiting on. */
  public get adoptedMemberIds(): readonly string[] {
    return [...this.adopted];
  }

  /**
   * Fold in the settlement of a member this run adopted rather than
   * dispatched. The path that owns the adopted member — the sequential loop
   * running a promoted anchor — has already persisted the outcome, released
   * its resources, and captured the group snapshot, so this only records the
   * result, applies the group's fail-fast policy, and wakes the drain loop.
   */
  public async settleAdoptedMember(
    stepId: string,
    outcome: StepExecutionOutcome
  ): Promise<boolean> {
    if (!this.adopted.delete(stepId)) {
      return false;
    }
    this.outcomes.set(stepId, outcome);
    this.releaseAdoptionWaiter();

    if (
      outcome.status === PROMPT_TERMINAL_STATUS.FAILED &&
      outcome.terminalFailure !== false &&
      this.options.group.failFast &&
      !this.failFastTriggered
    ) {
      this.failFastTriggered = true;
      await this.closeAdmission();
      await this.cancelRunning({ includeAdopted: true });
    } else if (this.runStarted) {
      this.startAvailableWorkers();
    }
    return true;
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
      this.outcomes.has(stepId) ||
      this.adopted.has(stepId)
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

        // A member stopped from outside the group (its own child run) stops
        // the workflow at the join, once its siblings settle, and outranks a
        // pause: resuming would otherwise advance without that member.
        const stopped = this.isStopped() || this.hasMemberStoppingWorkflow();
        const paused = !stopped && this.isPaused();
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

        // A pause can be cancelled while closeAdmission() is persisting its
        // CLOSING state. drainWorkers then returns with no active workers,
        // but known members may still be pending. Resume dispatch before join.
        if (
          !stopped &&
          !this.failFastTriggered &&
          this.nextPending < this.pendingIds.length
        ) {
          continue;
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
              this.outcomes.has(stepId) ||
              this.adopted.has(stepId),
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
      this.nextPending < this.pendingIds.length ||
      this.adopted.size > 0
    ) {
      if (this.isPaused()) {
        await this.closeAdmission();
        if (this.isDrained()) return;
      } else if (this.shouldStopDispatching()) {
        await this.closeAdmission();
        await this.cancelRunning();
        await this.cancelRemainingPending();
      } else if (this.activeWorkers === 0) {
        this.startAvailableWorkers();
        if (this.isDrained()) return;
      }

      const outstanding: Promise<unknown>[] = [...this.workerPromises];
      // An adopted member settles from outside this run, so its waiter is the
      // only thing that can wake the drain once no worker of our own is alive.
      if (this.adopted.size > 0) {
        outstanding.push(this.adoptionSettled());
      }
      if (outstanding.length === 0) return;
      await Promise.all(outstanding);
    }
  }

  private isDrained(): boolean {
    return this.activeWorkers === 0 && this.adopted.size === 0;
  }

  private adoptionSettled(): Promise<void> {
    if (!this.adoptionWaiter) {
      let resolve!: () => void;
      const promise = new Promise<void>((settle) => {
        resolve = settle;
      });
      this.adoptionWaiter = { promise, resolve };
    }
    return this.adoptionWaiter.promise;
  }

  private releaseAdoptionWaiter(): void {
    const waiter = this.adoptionWaiter;
    this.adoptionWaiter = undefined;
    waiter?.resolve();
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

  /**
   * Adopted members occupy fan-out slots this run does not own, so they are
   * subtracted before deciding how many workers may dispatch concurrently.
   */
  private effectiveWorkerWidth(): number {
    return Math.max(1, this.options.effectiveWidth - this.adopted.size);
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
        // A member that fails its dispatch preflight conflicts with members
        // already running; group preflight would have refused it before
        // anything started. It fails alone and never triggers fail-fast, so
        // its siblings' work is kept. It holds no reservation (it is never
        // recorded as running with a preflight member).
        const failing = this.options.failedPreflightMember?.(preflight);
        const outcome: StepExecutionOutcome = failing
          ? await this.executeMemberOutcome(target, claim.step, failing)
          : {
              target,
              status: PROMPT_TERMINAL_STATUS.FAILED,
              failureReason: preflight.failureMessage,
            };
        await this.settleMember(stepId, outcome, false, {
          triggersFailFast: false,
        });
        return;
      }

      this.running.set(stepId, {
        stepId,
        target,
        step: claim.step,
        preflightMember: preflight.member,
      });
      let outcome = await this.executeMemberOutcome(
        target,
        claim.step,
        preflight.member
      );
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

  /** Execute one member; a thrown error is its FAILED outcome. */
  private async executeMemberOutcome(
    target: ExecutionTarget,
    step: WorkflowStep,
    member: ParallelGroupPreflightMember
  ): Promise<StepExecutionOutcome> {
    try {
      return await this.options.executeMember(
        target,
        step,
        this.groupContext,
        this.options.effectiveWidth === 1
          ? this.options.snapshotStrategy
          : undefined,
        member
      );
    } catch (error) {
      return {
        target,
        status: PROMPT_TERMINAL_STATUS.FAILED,
        failureReason: getErrorMessage(error),
      };
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
    captureSnapshot: boolean,
    options: { readonly triggersFailFast?: boolean } = {}
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
      options.triggersFailFast !== false &&
      outcome.status === PROMPT_TERMINAL_STATUS.FAILED &&
      outcome.terminalFailure !== false &&
      this.options.group.failFast &&
      !this.failFastTriggered
    ) {
      this.failFastTriggered = true;
      await this.closeAdmission();
      await this.cancelRunning({
        exceptStepId:
          outcome.target.kind === FINAL_STEP_PHASES.QUEUE
            ? this.findStepIdForTarget(outcome.target)
            : undefined,
        includeAdopted: true,
      });
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

  /**
   * Cancel the members this run dispatched. Fail-fast also cancels adopted
   * members: they are siblings like any other, but run outside this run's
   * abort signal. A stop of the whole workflow already reaches an adopted
   * member through the path that owns it, so it is not cancelled twice.
   */
  private async cancelRunning(
    options: { exceptStepId?: string; includeAdopted?: boolean } = {}
  ): Promise<void> {
    this.abortController.abort();
    const targets = [...this.running.entries()]
      .filter(([stepId]) => stepId !== options.exceptStepId)
      .map(([, member]) => member.target);
    if (options.includeAdopted) {
      for (const stepId of this.adopted) {
        const resolved = this.options.resolveStepById(stepId);
        if (resolved) {
          targets.push({
            kind: FINAL_STEP_PHASES.QUEUE,
            stepIndex: resolved.stepIndex,
          });
        }
      }
    }
    await Promise.allSettled(
      targets.map((target) => this.options.cancelTarget?.(target))
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

  private hasMemberStoppingWorkflow(): boolean {
    return [...this.outcomes.values()].some(
      (outcome) => outcome.stopsWorkflowAtJoin === true
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
