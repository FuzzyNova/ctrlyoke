import type { HarnessStatus } from "./HarnessIntegration";
import type { RunRef, WorkflowKey } from "../types/CtrlYokeTypes";
import type { HarnessId } from "../types/DashboardConstants";

export interface HarnessDetailedStatus {
  initializationStatus: HarnessStatus;
  isReady: boolean;
  message: string;
}

/** Availability of the workspace's default harness, for idle host chrome. */
export interface DefaultHarnessStatus extends HarnessDetailedStatus {
  readonly harnessId: HarnessId;
}

/** A host-owned lifetime handle. */
export interface Disposable {
  dispose(): void;
}

/** A host-owned collection to which shared services can register lifetimes. */
export interface DisposableRegistry {
  add(disposable: Disposable): void;
}

/** Minimal asynchronous key/value storage used by shared orchestration code. */
export interface KeyValueStore {
  update(key: string, value: unknown): Promise<void>;
}

/** One workflow named by the status bar. */
export interface WorkflowActivityEntry {
  readonly workflowId: string;
  readonly workflowName: string;
}

/** A live workflow and its step progress label (e.g. `3/7`). */
export interface LiveWorkflowActivity extends WorkflowActivityEntry {
  readonly progressLabel: string;
}

/** A run that failed during this session and has not been viewed since. */
export interface FailedWorkflowActivity extends WorkflowActivityEntry {
  readonly workflowKey?: WorkflowKey;
  readonly runRef?: RunRef;
}

/**
 * What the status bar shows: every live workflow, plus the failures and the
 * completion that happened in this session. It deliberately does not describe
 * the workflow a client is viewing — the dashboard already shows that — so
 * opening an old errored run from history never colors the bar.
 */
export interface WorkflowActivitySummary {
  /** Running, pausing, or cancelling. */
  readonly running: readonly LiveWorkflowActivity[];
  readonly paused: readonly LiveWorkflowActivity[];
  /** Oldest first. */
  readonly unseenFailures: readonly FailedWorkflowActivity[];
  /** Set briefly after a live run completes. */
  readonly recentCompletion?: WorkflowActivityEntry;
}

export const EMPTY_WORKFLOW_ACTIVITY: WorkflowActivitySummary = {
  running: [],
  paused: [],
  unseenFailures: [],
};

/** Optional host chrome for workflow status and queue context state. */
export interface StatusBarSink {
  updateStatusBar(
    activity: WorkflowActivitySummary,
    harnessStatus?: DefaultHarnessStatus
  ): void;
  setHasQueuedStepsContext(hasQueuedSteps: boolean): void;
}

/** Host-neutral file watcher events, normalized to absolute string paths. */
export interface FileWatcher {
  onDidCreate(listener: (filePath: string) => void): Disposable;
  onDidChange(listener: (filePath: string) => void): Disposable;
  onDidDelete(listener: (filePath: string) => void): Disposable;
  dispose(): void;
}

/** Creates host-neutral file watchers rooted at an absolute base path. */
export interface FileWatcherFactory {
  create(basePath: string, glob: string): FileWatcher;
}
