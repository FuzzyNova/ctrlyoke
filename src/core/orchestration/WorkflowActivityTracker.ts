import {
  workflowStepProgressLabel,
  type WorkflowSummary,
  type WorkflowViewAddress,
} from "../../types/CtrlYokeTypes";
import {
  EXECUTION_STATES,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "../../types/DashboardConstants";
import type {
  FailedWorkflowActivity,
  LiveWorkflowActivity,
  WorkflowActivityEntry,
  WorkflowActivitySummary,
} from "../HostPorts";
import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";
import { isExecutionOwnerState } from "./WorkflowInstanceRegistry";

/** How long the status bar shows a completed run before returning to idle. */
export const RECENT_COMPLETION_DISPLAY_MS = 5000;

/** The summary fields the tracker reads from a workflow instance. */
export type WorkflowActivitySource = Pick<
  WorkflowSummary,
  | "id"
  | "workflowKey"
  | "runRef"
  | "workflowName"
  | "executionState"
  | "currentStep"
  | "totalSteps"
  | "finalStepRunning"
>;

/**
 * Builds the status bar's {@link WorkflowActivitySummary}.
 *
 * A failure or completion counts only when it is a *transition* out of a live
 * execution state seen in this session. Loading an errored run from history
 * goes straight from idle to `ERROR`, so it never raises an alert. A failure
 * stays until a client navigates to that run or a new run starts on the same
 * lineage, which is the user having dealt with it.
 */
export class WorkflowActivityTracker {
  private readonly liveInstanceIds = new Set<string>();
  /** Insertion order is failure order. */
  private readonly unseenFailures = new Map<string, FailedWorkflowActivity>();
  private recentCompletion: WorkflowActivityEntry | undefined;
  private completionTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly onDidChange: () => void,
    private readonly completionDisplayMs = RECENT_COMPLETION_DISPLAY_MS
  ) {}

  /**
   * Record an instance's state change. Returns true when the change affects
   * the failures or completion this tracker reports.
   */
  observe(source: WorkflowActivitySource): boolean {
    const wasLive = this.liveInstanceIds.has(source.id);
    if (isExecutionOwnerState(source.executionState)) {
      this.liveInstanceIds.add(source.id);
      return wasLive ? false : this.clearFailuresSupersededBy(source);
    }
    this.liveInstanceIds.delete(source.id);
    if (!wasLive) return false;
    if (source.executionState === EXECUTION_STATES.ERROR) {
      this.unseenFailures.delete(source.id);
      this.unseenFailures.set(source.id, {
        workflowId: source.id,
        workflowName: source.workflowName,
        workflowKey: source.workflowKey,
        runRef: source.runRef,
      });
      return true;
    }
    if (source.executionState === EXECUTION_STATES.COMPLETED) {
      this.showCompletion({
        workflowId: source.id,
        workflowName: source.workflowName,
      });
      return true;
    }
    return false;
  }

  /**
   * A client navigated to a workflow instance and/or run address. Returns true
   * when that dismissed a failure.
   */
  acknowledgeView(
    workflowId: string | null,
    address: WorkflowViewAddress | null
  ): boolean {
    let changed = false;
    for (const [id, failure] of this.unseenFailures) {
      const viewedInstance = workflowId !== null && id === workflowId;
      const viewedRun =
        address?.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN &&
        failure.runRef !== undefined &&
        address.workflowKey === failure.workflowKey &&
        address.runRef === failure.runRef;
      if (viewedInstance || viewedRun) {
        this.unseenFailures.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  /** The failure the status bar click opens. */
  getOldestUnseenFailure(): FailedWorkflowActivity | undefined {
    return this.unseenFailures.values().next().value;
  }

  /** Remove unseen failures for a deleted run, or every run in its lineage. */
  forgetRun(workflowKey: WorkflowKey, runRef?: RunRef): boolean {
    let changed = false;
    for (const [id, failure] of this.unseenFailures) {
      if (
        failure.workflowKey === workflowKey &&
        (runRef === undefined || failure.runRef === runRef)
      ) {
        this.unseenFailures.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  buildSummary(
    liveInstances: readonly WorkflowActivitySource[]
  ): WorkflowActivitySummary {
    const running: LiveWorkflowActivity[] = [];
    const paused: LiveWorkflowActivity[] = [];
    for (const source of liveInstances) {
      if (!isExecutionOwnerState(source.executionState)) continue;
      const entry: LiveWorkflowActivity = {
        workflowId: source.id,
        workflowName: source.workflowName,
        progressLabel: workflowStepProgressLabel(source),
      };
      if (source.executionState === EXECUTION_STATES.PAUSED) {
        paused.push(entry);
      } else {
        running.push(entry);
      }
    }
    return {
      running,
      paused,
      unseenFailures: [...this.unseenFailures.values()],
      recentCompletion: this.recentCompletion,
    };
  }

  dispose(): void {
    this.clearCompletionTimer();
  }

  /** A fresh run on a lineage means the user has acted on its last failure. */
  private clearFailuresSupersededBy(source: WorkflowActivitySource): boolean {
    let changed = false;
    for (const [id, failure] of this.unseenFailures) {
      const sameLineage =
        source.workflowKey !== undefined &&
        failure.workflowKey === source.workflowKey;
      if (id === source.id || sameLineage) {
        this.unseenFailures.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  private showCompletion(entry: WorkflowActivityEntry): void {
    this.clearCompletionTimer();
    this.recentCompletion = entry;
    this.completionTimer = setTimeout(() => {
      this.completionTimer = undefined;
      this.recentCompletion = undefined;
      this.onDidChange();
    }, this.completionDisplayMs);
  }

  private clearCompletionTimer(): void {
    if (this.completionTimer !== undefined) {
      clearTimeout(this.completionTimer);
      this.completionTimer = undefined;
    }
  }
}
