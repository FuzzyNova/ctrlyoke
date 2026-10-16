import type { HarnessStatus } from "./HarnessIntegration";
import type { RunRef, WorkflowKey } from "../types/CtrlYokeTypes";
import {
  DASHBOARD_ACTION_RESULT_STATUSES,
  PATH_SELECTION_KINDS,
  type HarnessId,
  type WorkspaceFolderPicker,
} from "../types/DashboardConstants";

/** Result of asking the host to perform a UI action. */
export type ActionResult =
  | { status: typeof DASHBOARD_ACTION_RESULT_STATUSES.OPENED }
  | {
      status: typeof DASHBOARD_ACTION_RESULT_STATUSES.UNSUPPORTED;
      message?: string;
    }
  | {
      status: typeof DASHBOARD_ACTION_RESULT_STATUSES.FAILED;
      message: string;
    };

/** A resolved workspace target to open in the host's editor. */
export interface WorkspaceOpenTarget {
  readonly path: string;
  readonly isDirectory?: boolean;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly openAsText?: boolean;
  readonly viewColumn?: number;
  readonly workflowSourcePath?: string;
}

/** Content rendered in a host-owned preview document. */
export interface ContentPreview {
  readonly content: string;
  readonly language: string;
}

/** Native picker requested by a dashboard operation. */
export interface PathSelectionRequest {
  readonly kind: (typeof PATH_SELECTION_KINDS)[keyof typeof PATH_SELECTION_KINDS];
  readonly title?: string;
  readonly openLabel?: string;
  readonly fileExtensions?: readonly string[];
  readonly defaultPath?: string;
  readonly filters?: Readonly<Record<string, readonly string[]>>;
}

/** Inputs to a native source-control diff view. */
export interface GitDiffRequest {
  readonly kind: "change" | "worktree";
  readonly workspaceRoot?: string;
  readonly ref?: string;
  readonly sourceCheckoutRoot?: string;
  readonly baseCommit?: string;
  readonly branchName?: string;
}

/** A workspace root's stable display name and filesystem path. */
export interface NamedRoot {
  readonly name: string;
  readonly fsPath: string;
}

/** Host UI actions used by shared orchestration and dashboard services. */
export interface DashboardHostActions {
  /** Open a file or selection in the host's editor. */
  openWorkspaceTarget(target: WorkspaceOpenTarget): Promise<ActionResult>;
  openContentPreview?(content: ContentPreview): Promise<ActionResult>;
  selectWorkspacePath?(
    request: PathSelectionRequest
  ): Promise<string | undefined>;
  revealOutput?(): Promise<void>;
  /** Focus the dashboard when this host provides one. */
  focusDashboard?(): void;
  openFolderWindow?(absolutePath: string): Promise<ActionResult>;
  /** Let the user open a folder into this window, which has none. */
  pickWorkspaceFolder?(picker: WorkspaceFolderPicker): Promise<ActionResult>;
  openGitDiff?(request: GitDiffRequest): Promise<ActionResult>;
  revealInOs?(absolutePath: string): Promise<ActionResult>;
  browseMcpGallery?(): Promise<void>;
  reloadHost?(): Promise<void>;
}

/** Controls the lifetime and access token of the hosted dashboard server. */
export interface HostedServerControl {
  enable?(): Promise<void>;
  disable?(): Promise<void>;
  regenerateToken?(): Promise<void>;
}

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
  get<T>(key: string): T | undefined;
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
  setHarnessDetectedContext(detected: boolean): void;
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
