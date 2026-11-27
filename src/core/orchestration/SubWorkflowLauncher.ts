import type {
  SubWorkflowHandle,
  SubWorkflowHost,
  SubWorkflowInstance,
  SubWorkflowInstanceFactory,
  SubWorkflowLaunchRequest,
  SubWorkflowResult,
} from "../../types/SubWorkflowTypes";
import {
  isSameSubWorkflowParentLink,
  SUB_WORKFLOW_SOURCE_KINDS,
} from "../../types/SubWorkflowTypes";
import {
  ACTIVE_EXECUTION_STATES,
  EXECUTION_STATES,
  PROMPT_TERMINAL_STATUS,
  SUB_WORKFLOW_CANCELLATION_SOURCES,
} from "../../types/DashboardConstants";
import { manifestPath } from "../../utils/WorkflowPaths";
import { TimelineRecorder } from "./TimelineRecorder";
import { Log } from "../../utils/Log";
import { WorkingFileManager } from "../WorkingFileManager";
import type { WorkingFileWorktreeRuntime } from "../../types/CtrlYokeTypes";
import { forwardSubWorkflowControl } from "./SubWorkflowControlRelay";

const LOG_SOURCE = "SubWorkflowLauncher";

/** A control the handle holds until the child's execution cycle starts. */
const HELD_CONTROLS = { PAUSE: "pause", STOP: "stop" } as const;
type HeldControl = (typeof HELD_CONTROLS)[keyof typeof HELD_CONTROLS];

/** What ended the launcher's wait on a child's run. */
const RUN_WAIT_OUTCOMES = {
  CYCLE_ENDED: "cycleEnded",
  SETTLED: "settled",
  DISPOSED: "disposed",
} as const;
type RunWaitOutcome =
  (typeof RUN_WAIT_OUTCOMES)[keyof typeof RUN_WAIT_OUTCOMES];

/**
 * Observes one child from the moment it is created, so neither a dispose
 * (host shutdown) nor the start of its first execution cycle can happen
 * before anyone is listening.
 */
class LaunchedChildWatch {
  readonly disposed: Promise<void>;
  private started = false;
  private startListener: (() => void) | undefined;
  private readonly subscriptions: Array<{ dispose(): void }> = [];

  constructor(instance: SubWorkflowInstance) {
    let markDisposed!: () => void;
    this.disposed = new Promise<void>((resolve) => {
      markDisposed = resolve;
    });
    this.subscriptions.push(
      instance.onDidDispose(() => markDisposed()),
      instance.onDidStartExecutionCycle(() => {
        if (this.started) return;
        this.started = true;
        const listener = this.startListener;
        this.startListener = undefined;
        listener?.();
      })
    );
  }

  /** The child has reached the point where stop and pause act on it. */
  get hasStarted(): boolean {
    return this.started;
  }

  /** Call `listener` once the first execution cycle starts. */
  onFirstStart(listener: () => void): void {
    this.startListener = listener;
  }

  dispose(): void {
    this.startListener = undefined;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions.length = 0;
  }
}

/**
 * Launches child runs without coupling execution to a particular host.
 *
 * The launcher owns each child it creates from creation until the handle's
 * `done` settles (or the launch fails), and then calls `releaseInstance`. A
 * host whose own lifecycle retires or disposes instances must leave an owned
 * child alone: a D6 continuation restores the child's STOPPED or ERROR state
 * while it loads, and disposing it then would settle `done` at once while its
 * execution carried on without a runner-lock heartbeat.
 */
export class SubWorkflowLauncher implements SubWorkflowHost {
  constructor(
    private readonly createInstance: SubWorkflowInstanceFactory,
    private readonly releaseInstance?: (instance: SubWorkflowInstance) => void
  ) {}

  async launch(request: SubWorkflowLaunchRequest): Promise<SubWorkflowHandle> {
    const instance = this.createInstance({
      concurrent: request.concurrent,
      ancestorPaths: request.ancestorPaths ?? [],
      delegationChain: request.delegationChain,
    });
    const watch = new LaunchedChildWatch(instance);
    let handedOver = false;
    try {
      const execution = await this.startChild(instance, request);
      if (!execution.ok) {
        return this.createFailedToLoadHandle(instance, execution.message);
      }
      handedOver = true;
      return this.executionHandle(
        instance,
        execution.execution,
        execution.identity,
        watch
      );
    } finally {
      if (!handedOver) {
        watch.dispose();
        this.releaseInstance?.(instance);
      }
    }
  }

  /**
   * Load (or bind) the child and start its execution, returning once its
   * run identity exists. A load failure is reported, not thrown.
   */
  private async startChild(
    instance: SubWorkflowInstance,
    request: SubWorkflowLaunchRequest
  ): Promise<
    | {
        ok: true;
        execution: Promise<void>;
        identity: { workflowKey: string; runRef: string };
      }
    | { ok: false; message: string }
  > {
    const parentDefinition =
      request.source.kind === SUB_WORKFLOW_SOURCE_KINDS.INLINE
        ? request.source.parentDefinition
        : undefined;

    let loaded: boolean;
    try {
      if (request.resumeChildRun) {
        const target = request.resumeChildRun;
        const recordedManifest = await new TimelineRecorder().readManifest(
          manifestPath(request.stateRoot, target.workflowKey, target.runRef)
        );
        if (
          !isSameSubWorkflowParentLink(
            recordedManifest.parentRun,
            request.parent
          )
        ) {
          throw new Error(
            "Recorded child run does not belong to this parent step"
          );
        }
        const execution = instance.executeContinuationAtRun(
          target.workflowKey,
          target.runRef,
          recordedManifest.definitionRevision,
          undefined,
          {
            parentRun: request.parent,
            parentExecution: request.parentExecution,
            delegationChain: request.delegationChain,
            ...(parentDefinition ? { parentDefinition } : {}),
          }
        );
        const identity = await this.waitForRunIdentity(instance, execution);
        if (!identity?.workflowKey || !identity.runRef) {
          return {
            ok: false,
            message: "Sub-workflow continuation did not bind to a run identity",
          };
        }
        return {
          ok: true,
          execution,
          identity: {
            workflowKey: identity.workflowKey,
            runRef: identity.runRef,
          },
        };
      }
      if (request.source.kind === SUB_WORKFLOW_SOURCE_KINDS.FILE) {
        loaded = await instance.loadPromptFile(
          request.source.resolvedPath,
          // A group preflight's parse; undefined parses the file here.
          request.source.parsed,
          {
            parentRun: request.parent,
            parentExecution: request.parentExecution,
            delegationChain: request.delegationChain,
          }
        );
      } else {
        await instance.loadFromMemoryOrThrow(
          request.source.definition,
          request.source.displayName,
          {
            parentRun: request.parent,
            parentExecution: request.parentExecution,
            delegationChain: request.delegationChain,
            parentDefinition: request.source.parentDefinition,
          }
        );
        loaded = !!instance.promptQueue.getWorkflowFile().steps?.length;
      }
      if (!loaded) {
        return { ok: false, message: "Failed to load sub-workflow file" };
      }
      if (instance.promptQueue.getWorkflowFile().worktree) {
        await request.parentExecution.prepareWorktreeChild?.();
      }
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }

    // A real instance promotes its loaded draft when execution starts, so the
    // runRef may not exist until executeLoadedPromptFile has begun.
    const execution = instance.executeLoadedPromptFile();
    const initialState = await this.waitForRunIdentity(instance, execution);
    if (!initialState?.workflowKey || !initialState.runRef) {
      return {
        ok: false,
        message: "Sub-workflow did not create a run identity after starting",
      };
    }
    return {
      ok: true,
      execution,
      identity: {
        workflowKey: initialState.workflowKey,
        runRef: initialState.runRef,
      },
    };
  }

  private executionHandle(
    instance: SubWorkflowInstance,
    execution: Promise<void>,
    identity: { workflowKey: string; runRef: string },
    watch: LaunchedChildWatch
  ): SubWorkflowHandle {
    let parentStopped = false;
    // Once `done` has settled the child is no longer the parent's to control:
    // the parent's own stop, which follows a CANCELLED step, must not stop a
    // finished child again (that turns its STOPPED back into CANCELLING).
    let settled = false;
    // The handle exists from the child's run identity, but its execution
    // cycle starts later: a fresh child is still IDLE, a continued one is
    // still STOPPED or PAUSED while it rewinds and reopens its run. A stop
    // there takes the detector fallback and a pause is rejected, so the
    // handle holds either until the cycle starts and then replays it. A
    // stop supersedes a held pause; a cancelPause drops a held pause.
    let held: HeldControl | undefined;
    watch.onFirstStart(() => {
      const action = held;
      held = undefined;
      if (!action) return;
      // Not inside the child's own startup transition.
      queueMicrotask(() => {
        void forwardSubWorkflowControl(instance, action, LOG_SOURCE);
      });
    });

    let rejectResume: (error: unknown) => void = () => undefined;
    const resumeFailure = new Promise<never>((_, reject) => {
      rejectResume = reject;
    });
    resumeFailure.catch(() => undefined);
    const done = this.collectExecution(
      instance,
      execution,
      () =>
        parentStopped
          ? SUB_WORKFLOW_CANCELLATION_SOURCES.PARENT
          : SUB_WORKFLOW_CANCELLATION_SOURCES.CHILD,
      resumeFailure,
      watch
    )
      .catch((error): SubWorkflowResult => ({
        status: PROMPT_TERMINAL_STATUS.FAILED,
        failureMessage: errorMessage(error),
      }))
      .then((result): SubWorkflowResult =>
        // A stop still held when the run settles: the child never started
        // the cycle the parent stopped, so it ended by that request.
        held === HELD_CONTROLS.STOP
          ? {
              status: PROMPT_TERMINAL_STATUS.CANCELLED,
              cancelledBy: SUB_WORKFLOW_CANCELLATION_SOURCES.PARENT,
              worktree: this.worktree(instance),
            }
          : result
      )
      .then(async (result) => this.withRecordedWorktree(instance, result))
      .finally(() => {
        settled = true;
        watch.dispose();
        this.releaseInstance?.(instance);
      });
    return {
      workflowKey: identity.workflowKey as SubWorkflowHandle["workflowKey"],
      runRef: identity.runRef as SubWorkflowHandle["runRef"],
      done,
      pause: async () => {
        if (settled) return;
        if (!watch.hasStarted) {
          if (held !== HELD_CONTROLS.STOP) held = HELD_CONTROLS.PAUSE;
          return;
        }
        await instance.pause();
      },
      cancelPause: async () => {
        if (settled) return;
        if (!watch.hasStarted) {
          if (held === HELD_CONTROLS.PAUSE) held = undefined;
          return;
        }
        // A child that already reached its step boundary is PAUSED, where
        // cancelPause() is a no-op, so resuming the parent resumes it. Its
        // resume() runs the whole remaining cycle: start it without waiting,
        // or the parent commits its own RUNNING only once the child ends.
        // `done` settles on the resumed run, or on the resume's failure.
        if (
          instance.promptQueue.getState().status !== EXECUTION_STATES.PAUSED
        ) {
          await instance.cancelPause();
          return;
        }
        instance.resume().catch((error: unknown) => {
          Log.warn(
            `[${LOG_SOURCE}] Resuming sub-workflow ${identity.workflowKey}/${identity.runRef} failed: ${errorMessage(error)}`
          );
          rejectResume(error);
        });
      },
      stop: async () => {
        if (settled) return;
        parentStopped = true;
        if (!watch.hasStarted) {
          held = HELD_CONTROLS.STOP;
          return;
        }
        await instance.stop();
      },
    };
  }

  private async collectExecution(
    instance: SubWorkflowInstance,
    execution: Promise<void>,
    cancelledBy: () => SubWorkflowResult["cancelledBy"],
    resumeFailure: Promise<never>,
    watch: LaunchedChildWatch
  ): Promise<SubWorkflowResult> {
    const disposed = watch.disposed;
    // Host shutdown is not a child failure: CANCELLED stops the parent
    // whatever its onFail (D9), and the child run stays continuable (D6).
    // A child that had already settled keeps its own outcome.
    const cancelled = (): SubWorkflowResult => ({
      status: PROMPT_TERMINAL_STATUS.CANCELLED,
      cancelledBy: cancelledBy(),
      worktree: this.worktree(instance),
    });
    try {
      const cycleEnded = execution.then(() => RUN_WAIT_OUTCOMES.CYCLE_ENDED);
      cycleEnded.catch(() => undefined);
      let outcome: RunWaitOutcome = await Promise.race([
        cycleEnded,
        disposed.then(() => RUN_WAIT_OUTCOMES.DISPOSED),
      ]);
      // A cycle that ends with the run still active paused it at a step
      // boundary, or a resume has already begun the next cycle; either way
      // the run has not settled yet.
      if (
        outcome === RUN_WAIT_OUTCOMES.CYCLE_ENDED &&
        ACTIVE_EXECUTION_STATES.has(instance.promptQueue.getState().status)
      ) {
        outcome = await this.waitForSettledRun(
          instance,
          resumeFailure,
          disposed
        );
      }
      if (outcome === RUN_WAIT_OUTCOMES.DISPOSED) {
        // Before its cycle starts, a child still loading shows the state it
        // restored (a continued run is STOPPED or ERROR), not an outcome.
        const ownOutcome = watch.hasStarted
          ? this.settledResult(instance, cancelledBy)
          : undefined;
        await this.endDisposedExecution(instance, execution, watch, {
          stop: ownOutcome === undefined,
        });
        return ownOutcome ?? cancelled();
      }
    } catch (error) {
      return this.failedResult(instance, errorMessage(error));
    }

    try {
      return (
        this.settledResult(instance, cancelledBy) ??
        this.failedResult(
          instance,
          `Sub-workflow settled in unexpected state: ${instance.promptQueue.getState().status}`
        )
      );
    } catch (error) {
      return this.failedResult(instance, errorMessage(error));
    }
  }

  /**
   * After a dispose, end the child's execution and wait for it, so no
   * executor outlives its instance (whose dispose has already stopped the
   * runner-lock heartbeat). An in-flight cycle is stopped now; a cycle that
   * has not started yet is stopped as soon as it starts. A PAUSED child has
   * nothing in flight, and its pause survives the shutdown like any other
   * paused run's.
   */
  private async endDisposedExecution(
    instance: SubWorkflowInstance,
    execution: Promise<void>,
    watch: LaunchedChildWatch,
    options: { stop: boolean }
  ): Promise<void> {
    if (options.stop) {
      if (!watch.hasStarted) {
        // Supersedes any held control: a stop replaces a held pause.
        watch.onFirstStart(() => {
          queueMicrotask(() => {
            void forwardSubWorkflowControl(
              instance,
              HELD_CONTROLS.STOP,
              LOG_SOURCE
            );
          });
        });
      } else if (
        instance.promptQueue.getState().status !== EXECUTION_STATES.PAUSED
      ) {
        await forwardSubWorkflowControl(
          instance,
          HELD_CONTROLS.STOP,
          LOG_SOURCE
        );
      }
    }
    await execution.catch(() => undefined);
    await instance.whenExecutionSettled();
  }

  /** The outcome of a child in a terminal state; undefined otherwise. */
  private settledResult(
    instance: SubWorkflowInstance,
    cancelledBy: () => SubWorkflowResult["cancelledBy"]
  ): SubWorkflowResult | undefined {
    const state = instance.promptQueue.getState();
    switch (state.status) {
      case EXECUTION_STATES.COMPLETED:
        return {
          status: PROMPT_TERMINAL_STATUS.COMPLETED,
          worktree: this.worktree(instance),
        };
      case EXECUTION_STATES.STOPPED:
        return {
          status: PROMPT_TERMINAL_STATUS.CANCELLED,
          cancelledBy: cancelledBy(),
          worktree: this.worktree(instance),
        };
      case EXECUTION_STATES.ERROR:
        return this.failedResult(instance, this.failureMessage(instance));
      default:
        return undefined;
    }
  }

  /**
   * Wait until the child no longer owns an executor and its cycle has ended,
   * or until it is disposed first: a disposed child never leaves PAUSED, so
   * waiting on its state would never end.
   */
  private async waitForSettledRun(
    instance: SubWorkflowInstance,
    resumeFailure: Promise<never>,
    disposed: Promise<void>
  ): Promise<RunWaitOutcome> {
    const subscriptions: Array<{ dispose(): void }> = [];
    try {
      const outcome = await Promise.race([
        new Promise<RunWaitOutcome>((resolve) => {
          const check = () => {
            if (
              !ACTIVE_EXECUTION_STATES.has(
                instance.promptQueue.getState().status
              )
            ) {
              resolve(RUN_WAIT_OUTCOMES.SETTLED);
            }
          };
          subscriptions.push(instance.promptQueue.onDidChangeState(check));
          check();
        }),
        disposed.then(() => RUN_WAIT_OUTCOMES.DISPOSED),
        resumeFailure,
      ]);
      if (outcome === RUN_WAIT_OUTCOMES.DISPOSED) return outcome;
    } finally {
      for (const subscription of subscriptions) subscription.dispose();
    }
    const cycleSettled = instance
      .whenExecutionSettled()
      .then(() => RUN_WAIT_OUTCOMES.SETTLED);
    return Promise.race([
      cycleSettled,
      disposed.then(() => RUN_WAIT_OUTCOMES.DISPOSED),
    ]);
  }

  private async waitForRunIdentity(
    instance: SubWorkflowInstance,
    execution: Promise<void>
  ): Promise<
    ReturnType<SubWorkflowInstance["promptQueue"]["getState"]> | undefined
  > {
    const current = instance.promptQueue.getState();
    if (current.workflowKey && current.runRef) return current;

    return new Promise((resolve, reject) => {
      let settled = false;
      const subscription = instance.promptQueue.onDidChangeState((state) => {
        if (state.workflowKey && state.runRef) {
          settled = true;
          subscription.dispose();
          resolve(state);
        }
      });
      execution.then(
        () => {
          if (settled) return;
          settled = true;
          subscription.dispose();
          resolve(undefined);
        },
        (error) => {
          if (settled) return;
          settled = true;
          subscription.dispose();
          reject(error);
        }
      );
      const afterSubscribe = instance.promptQueue.getState();
      if (!settled && afterSubscribe.workflowKey && afterSubscribe.runRef) {
        settled = true;
        subscription.dispose();
        resolve(afterSubscribe);
      }
    });
  }

  private createFailedToLoadHandle(
    instance: SubWorkflowInstance,
    message: string
  ): SubWorkflowHandle {
    const state = instance.promptQueue.getState();
    const workflowKey = state.workflowKey;
    const runRef = state.runRef;
    if (!workflowKey || !runRef) {
      // WorkflowInstance allocates its identities during ordinary file loading.
      // A failed load before allocation still needs a usable handle identity;
      // preserve any known state and reject only if the host violated that API.
      throw new Error(message);
    }
    return {
      workflowKey,
      runRef,
      done: Promise.resolve({
        status: PROMPT_TERMINAL_STATUS.FAILED,
        failedToStart: true,
        failureMessage: message,
        worktree: this.worktree(instance),
      }),
      pause: () => instance.pause(),
      cancelPause: () => instance.cancelPause(),
      stop: () => instance.stop(),
    };
  }

  private failedResult(
    instance: SubWorkflowInstance,
    message: string
  ): SubWorkflowResult {
    const state = instance.promptQueue.getState();
    const reachedRunning = state.steps.some(
      (step) => step._runtime?.startedAt !== undefined
    );
    return {
      status: PROMPT_TERMINAL_STATUS.FAILED,
      failedToStart: !reachedRunning,
      failureMessage: message,
      worktree: this.worktree(instance),
    };
  }

  private failureMessage(instance: SubWorkflowInstance): string {
    const failedStep = [...instance.promptQueue.getState().steps]
      .reverse()
      .find((step) => step._runtime?.failureMessage);
    if (failedStep?._runtime?.failureMessage) {
      return failedStep._runtime.failureMessage;
    }
    const failed = [...instance.promptQueue.getState().results]
      .reverse()
      .find((result) => result.status === PROMPT_TERMINAL_STATUS.FAILED);
    return (
      (failed &&
      "failureReason" in failed &&
      typeof failed.failureReason === "string"
        ? failed.failureReason
        : undefined) ?? "Sub-workflow failed"
    );
  }

  /**
   * `result` with the worktree its child's run file records. Worktree
   * lifecycle metadata is disk-authoritative and kept out of the queue's
   * in-memory projection (`WorkingFileManager.updateWorktreeRuntime`), so a
   * child loaded from a file never holds it in memory: read it from the run
   * file once the run has settled, and fall back to memory only when the
   * file cannot be read.
   */
  private async withRecordedWorktree(
    instance: SubWorkflowInstance,
    result: SubWorkflowResult
  ): Promise<SubWorkflowResult> {
    const workingFilePath = instance.promptQueue.getState().workingFilePath;
    if (!workingFilePath) return result;
    let recorded: WorkingFileWorktreeRuntime | undefined;
    try {
      recorded = (
        await WorkingFileManager.readWorkingFileFromDisk(workingFilePath)
      )._runtime?.worktree;
    } catch (error) {
      Log.warn(
        `[${LOG_SOURCE}] Could not read the child's worktree from ${workingFilePath}: ${errorMessage(error)}`
      );
      return result;
    }
    return recorded
      ? { ...result, worktree: projectWorktree(recorded) }
      : result;
  }

  private worktree(
    instance: SubWorkflowInstance
  ): SubWorkflowResult["worktree"] {
    const worktree = instance.promptQueue.getWorkflowFile()._runtime?.worktree;
    return worktree ? projectWorktree(worktree) : undefined;
  }
}

/** The worktree fields a settled child reports (D12a). */
function projectWorktree(
  worktree: WorkingFileWorktreeRuntime
): NonNullable<SubWorkflowResult["worktree"]> {
  const {
    mode,
    branchName,
    baseCommit,
    finalBranchTip,
    changedFileCount,
    landingOutcome,
    mergeOutcome,
    conflictFiles,
  } = worktree;
  return {
    mode,
    branchName,
    baseCommit,
    finalBranchTip,
    changedFileCount,
    landingOutcome,
    mergeOutcome,
    conflictFiles,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
