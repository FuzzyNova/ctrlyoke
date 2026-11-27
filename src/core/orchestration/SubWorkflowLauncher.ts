import type {
  SubWorkflowHandle,
  SubWorkflowHost,
  SubWorkflowInstance,
  SubWorkflowInstanceFactory,
  SubWorkflowLaunchRequest,
  SubWorkflowResult,
} from "../../types/SubWorkflowTypes";
import { isSameSubWorkflowParentLink } from "../../types/SubWorkflowTypes";
import {
  EXECUTION_STATES,
  PROMPT_TERMINAL_STATUS,
  SUB_WORKFLOW_CANCELLATION_SOURCES,
} from "../../types/DashboardConstants";
import { manifestPath } from "../../utils/WorkflowPaths";
import { TimelineRecorder } from "./TimelineRecorder";

/** Launches child runs without coupling execution to a particular host. */
export class SubWorkflowLauncher implements SubWorkflowHost {
  constructor(private readonly createInstance: SubWorkflowInstanceFactory) {}

  async launch(request: SubWorkflowLaunchRequest): Promise<SubWorkflowHandle> {
    const instance = this.createInstance({
      concurrent: request.concurrent ?? false,
      ancestorPaths: request.ancestorPaths ?? [],
      delegationChain: request.delegationChain,
    });
    let parentStopped = false;

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
          }
        );
        const identity = await this.waitForRunIdentity(instance, execution);
        if (!identity?.workflowKey || !identity.runRef) {
          return this.createFailedToLoadHandle(
            instance,
            "Sub-workflow continuation did not bind to a run identity"
          );
        }
        return this.executionHandle(
          instance,
          execution,
          identity as { workflowKey: string; runRef: string },
          () => parentStopped,
          () => {
            parentStopped = true;
          }
        );
      }
      loaded = await instance.loadPromptFile(
        request.source.resolvedPath,
        undefined,
        {
          parentRun: request.parent,
          parentExecution: request.parentExecution,
          delegationChain: request.delegationChain,
        }
      );
      if (!loaded) {
        return this.createFailedToLoadHandle(
          instance,
          "Failed to load sub-workflow file"
        );
      }
      if (instance.promptQueue.getWorkflowFile().worktree) {
        await request.parentExecution.prepareWorktreeChild?.();
      }
    } catch (error) {
      return this.createFailedToLoadHandle(instance, errorMessage(error));
    }

    // A real instance promotes its loaded draft when execution starts, so the
    // runRef may not exist until executeLoadedPromptFile has begun.
    const execution = instance.executeLoadedPromptFile();
    const initialState = await this.waitForRunIdentity(instance, execution);
    if (!initialState?.workflowKey || !initialState.runRef) {
      return this.createFailedToLoadHandle(
        instance,
        "Sub-workflow did not create a run identity after starting"
      );
    }

    const workflowKey = initialState.workflowKey;
    const runRef = initialState.runRef;
    return this.executionHandle(
      instance,
      execution,
      { workflowKey, runRef },
      () => parentStopped,
      () => {
        parentStopped = true;
      }
    );
  }

  private executionHandle(
    instance: SubWorkflowInstance,
    execution: Promise<void>,
    identity: { workflowKey: string; runRef: string },
    wasStoppedByParent: () => boolean,
    markParentStopped: () => void
  ): SubWorkflowHandle {
    const done = this.collectExecution(
      instance,
      execution,
      wasStoppedByParent
    ).catch((error): SubWorkflowResult => ({
      status: PROMPT_TERMINAL_STATUS.FAILED,
      failureMessage: errorMessage(error),
    }));
    return {
      workflowKey: identity.workflowKey as SubWorkflowHandle["workflowKey"],
      runRef: identity.runRef as SubWorkflowHandle["runRef"],
      done,
      pause: () => instance.pause(),
      cancelPause: () => instance.cancelPause(),
      stop: async () => {
        markParentStopped();
        await instance.stop();
      },
    };
  }

  private async collectExecution(
    instance: SubWorkflowInstance,
    execution: Promise<void>,
    wasStoppedByParent: () => boolean
  ): Promise<SubWorkflowResult> {
    try {
      await execution;
    } catch (error) {
      return this.failedResult(instance, errorMessage(error));
    }

    try {
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
            cancelledBy: wasStoppedByParent()
              ? SUB_WORKFLOW_CANCELLATION_SOURCES.PARENT
              : SUB_WORKFLOW_CANCELLATION_SOURCES.CHILD,
            worktree: this.worktree(instance),
          };
        case EXECUTION_STATES.ERROR:
          return this.failedResult(instance, this.failureMessage(instance));
        default:
          return this.failedResult(
            instance,
            `Sub-workflow settled in unexpected state: ${state.status}`
          );
      }
    } catch (error) {
      return this.failedResult(instance, errorMessage(error));
    }
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

  private worktree(
    instance: SubWorkflowInstance
  ): SubWorkflowResult["worktree"] {
    const worktree = instance.promptQueue.getWorkflowFile()._runtime?.worktree;
    if (!worktree) return undefined;
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
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
