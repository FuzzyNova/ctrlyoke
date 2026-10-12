import * as fs from "fs";
import * as path from "path";
import type { Disposable, FileWatcherFactory } from "../HostPorts";
import {
  WorkflowSummary,
  WorkflowTokenTotals,
  EXECUTION_STATES,
  deriveWorkflowFinalStepSummary,
  type FinalStepRuntimeState,
  type WorkingFile,
  type RunRef,
  type RunnerHostIdentity,
  type WorkflowKey,
} from "../../types/CtrlYokeTypes";
import type { ActiveExternalLockInspection } from "./ExternalExecutionResolver";
import { WorkflowLockManager } from "../../utils/WorkflowLockManager";
import {
  ACTIVE_EXECUTION_STATES,
  WORKFLOW_LOCK_LIVENESS,
  WORKFLOW_LOCK_LOCALITIES,
} from "../../types/DashboardConstants";
import { Log } from "../../utils/Log";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { invalidateRunSummaryFor } from "./RunSummaryCache";
import { readWorkflowLockOwnershipInspection } from "../../utils/WorkflowLockInspector";
import type { StepWithRuntimeStatus } from "../../utils/StepStatusDerivation";

export type ExternalRunWatchFinishReason =
  "terminal-working-file" | "lock-deleted" | "lock-stale" | "ownership-changed";

/**
 * ExternalRunWatchSession
 *
 * Owns three file watchers for a single externally managed workflow, all pinned to the exact
 * `RunRef` named by the lineage's runner lock — never "the newest run" — so a client
 * browsing a different (older) run of the same lineage can never redirect this watcher:
 *   1. Run file watcher     — tracks step progress (currentIndex, executionState)
 *   2. Manifest/events watcher — streams CLI output chunks to the dashboard
 *   3. Lock file watcher    — detects when the CLI finishes (lock deleted)
 *
 * Also runs a 10-second heartbeat staleness poll as a fallback for CLI crashes
 * (lock file exists but heartbeat has gone stale).
 *
 * Created by WorkflowOrchestrator when an active external CLI or sibling-VSCode lock is
 * detected. Disposed when the lock is deleted, goes stale, or changes ownership.
 */
/**
 * Leading+trailing throttle window for working-file change notifications.
 * A tight-loop out-of-process writer (see handleWorkingFileChange's comment)
 * can otherwise fire onDidChange dozens of times per second; each one used to
 * fan out an unconditional WORKFLOW_SUMMARY_UPDATED broadcast to every
 * connected dashboard client (VS Code panel + every hosted-browser tab),
 * which — because several webview quick pickers subscribe to uiStore with no
 * selector — showed up as a footer/quick-picker re-render storm bad enough to
 * intermittently break click hit-testing near a responsive-layout breakpoint.
 */
const WORKING_FILE_CHANGE_THROTTLE_MS = 150;

export class ExternalRunWatchSession implements Disposable {
  private disposables: Disposable[] = [];
  private heartbeatPollInterval: ReturnType<typeof setInterval> | undefined;
  private finished = false;
  /** One compact content signature per logical CLI attempt already sent. */
  private readonly lastSentOutputSignatures = new Map<string, string>();
  private readonly manifestPath: string;
  private workingFileChangeThrottleTimer:
    ReturnType<typeof setTimeout> | undefined;
  private workingFileChangePendingDuringThrottle = false;

  constructor(
    private readonly workingFilePath: string,
    private readonly workflowKey: WorkflowKey,
    private readonly runRef: RunRef,
    private readonly workspaceFolderPath: string,
    private readonly inspection: ActiveExternalLockInspection,
    private readonly observer: RunnerHostIdentity,
    /**
     * Called when the working file changes: partial WorkflowSummary update
     * with the latest currentStep and executionState, plus the steps array as
     * just read from disk. The steps ride along because the caller has to
     * re-derive per-step statuses on every change (the summary alone carries
     * only the position), and this read already parsed them.
     */
    private readonly onUpdate: (
      summary: Partial<WorkflowSummary>,
      steps: readonly StepWithRuntimeStatus[]
    ) => void,
    /**
     * Called when the run's manifest/events change.
     * Passes the absolute path to the manifest file so the caller can read
     * and diff outputs.
     */
    private readonly onOutput: (historyFilePath: string) => void,
    /**
     * Called when the external run has finished or ownership changed.
     */
    private readonly onFinished: (reason: ExternalRunWatchFinishReason) => void,
    private readonly fileWatcherFactory: FileWatcherFactory
  ) {
    this.manifestPath = WorkflowPaths.manifestPath(
      workspaceFolderPath,
      workflowKey,
      runRef
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    Log.debug(
      `[ExternalRunWatchSession] start: workflowKey="${this.workflowKey}" runRef="${this.runRef}"`
    );

    this.setupWorkingFileWatcher();
    this.setupLockFileWatcher();
    this.setupHistoryWatcher();
    this.startHeartbeatPoll();

    // Watchers are installed before this read so a run cannot complete in the
    // gap between the startup snapshot and watcher registration. This also
    // catches a terminal run whose runner lock remains live only to reserve a
    // named worktree for an injectable PTY.
    await this.handleWorkingFileChange();
  }

  dispose(): void {
    this.finished = true;
    if (this.heartbeatPollInterval !== undefined) {
      clearInterval(this.heartbeatPollInterval);
      this.heartbeatPollInterval = undefined;
    }
    if (this.workingFileChangeThrottleTimer !== undefined) {
      clearTimeout(this.workingFileChangeThrottleTimer);
      this.workingFileChangeThrottleTimer = undefined;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    Log.debug(
      `[ExternalRunWatchSession] disposed: workflowKey="${this.workflowKey}" runRef="${this.runRef}"`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Working file watcher
  // ─────────────────────────────────────────────────────────────────────────

  private setupWorkingFileWatcher(): void {
    const targetPath = this.workingFilePath;
    const watcher = this.fileWatcherFactory.create(
      path.dirname(targetPath),
      path.basename(targetPath)
    );

    this.disposables.push(
      watcher.onDidChange(() => {
        this.scheduleWorkingFileChange();
      })
    );
    // Also handle onDidCreate: on Windows, fs.rename() over an existing file
    // (used by the MCP server's atomic temp-file write) fires onDidCreate
    // instead of onDidChange, so MCP queue appends would otherwise be missed
    // until the next natural queue write.
    this.disposables.push(
      watcher.onDidCreate(() => {
        this.scheduleWorkingFileChange();
      })
    );
    this.disposables.push(watcher);
  }

  /**
   * Leading+trailing throttle around handleWorkingFileChange: the first change
   * in a burst is handled immediately (so a normal, isolated step transition
   * stays instant), further changes within WORKING_FILE_CHANGE_THROTTLE_MS are
   * coalesced, and — if any arrived during the window — one trailing update
   * fires at the end of it so a sustained flood still converges on the latest
   * state instead of going silent until the writer stops.
   */
  private scheduleWorkingFileChange(): void {
    if (this.workingFileChangeThrottleTimer !== undefined) {
      this.workingFileChangePendingDuringThrottle = true;
      return;
    }
    void this.handleWorkingFileChange();
    this.workingFileChangeThrottleTimer = setTimeout(() => {
      this.workingFileChangeThrottleTimer = undefined;
      if (this.workingFileChangePendingDuringThrottle) {
        this.workingFileChangePendingDuringThrottle = false;
        void this.handleWorkingFileChange();
      }
    }, WORKING_FILE_CHANGE_THROTTLE_MS);
  }

  private async handleWorkingFileChange(retried = false): Promise<void> {
    // Mechanism 3 of the run-summary cache: the CLI binary is a separate
    // process, so its writes cannot reach the write-through invalidation, and
    // it is the one out-of-process writer that writes in a tight loop — fast
    // enough that two writes can share a timestamp and defeat stamp validation.
    // This watcher already exists for exactly this file, so it is the signal.
    invalidateRunSummaryFor(this.workingFilePath);
    try {
      const content = await fs.promises.readFile(this.workingFilePath, "utf8");
      const workingFile = JSON.parse(content) as {
        _runtime?: {
          currentIndex?: number;
          executionState?: string;
          tokenTotals?: WorkflowTokenTotals;
          finalStep?: FinalStepRuntimeState;
        };
        finalStep?: WorkingFile["finalStep"];
        steps?: StepWithRuntimeStatus[];
      };

      const currentIndex = workingFile._runtime?.currentIndex ?? 0;
      const executionState =
        (workingFile._runtime?.executionState as string | undefined) ??
        EXECUTION_STATES.RUNNING;
      const steps = workingFile.steps ?? [];
      const finalStepSummary = deriveWorkflowFinalStepSummary(
        workingFile.finalStep,
        workingFile._runtime?.finalStep
      );

      this.onUpdate(
        {
          currentStep: currentIndex,
          totalSteps: steps.length,
          executionState: executionState as WorkflowSummary["executionState"],
          tokenTotals: workingFile._runtime?.tokenTotals,
          ...finalStepSummary,
        },
        steps
      );
      if (
        !ACTIVE_EXECUTION_STATES.has(
          executionState as WorkflowSummary["executionState"]
        )
      ) {
        Log.debug(
          `[ExternalRunWatchSession] working file reached terminal state ${executionState} for workflowKey="${this.workflowKey}" — calling onFinished`
        );
        this.signalFinished("terminal-working-file");
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // File was deleted — that's fine, the lock watcher will handle it
        return;
      }
      if (!retried) {
        // JSON parse error: file may be mid-write — retry once after 50ms
        Log.trace(
          `[ExternalRunWatchSession] handleWorkingFileChange: parse error, retrying in 50ms`
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        await this.handleWorkingFileChange(true);
      } else {
        Log.warn(
          `[ExternalRunWatchSession] handleWorkingFileChange: failed to parse working file after retry:`,
          err
        );
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lock file watcher
  // ─────────────────────────────────────────────────────────────────────────

  private setupLockFileWatcher(): void {
    const targetPath = WorkflowLockManager.getLockPath(
      this.workspaceFolderPath,
      this.workflowKey
    );

    const watcher = this.fileWatcherFactory.create(
      path.dirname(targetPath),
      path.basename(targetPath)
    );

    const validateLock = (): void => {
      void this.validateCurrentLock();
    };
    this.disposables.push(watcher.onDidChange(validateLock));
    this.disposables.push(watcher.onDidCreate(validateLock));
    this.disposables.push(
      watcher.onDidDelete(() => {
        Log.debug(
          `[ExternalRunWatchSession] lock file deleted — external run finished for workflowKey="${this.workflowKey}"`
        );
        this.signalFinished("lock-deleted");
      })
    );
    this.disposables.push(watcher);
  }

  private async validateCurrentLock(): Promise<void> {
    if (this.finished) {
      return;
    }

    const currentInspection = await readWorkflowLockOwnershipInspection(
      this.workspaceFolderPath,
      this.workflowKey,
      this.observer
    );
    if (
      currentInspection.liveness === WORKFLOW_LOCK_LIVENESS.ACTIVE &&
      currentInspection.locality === WORKFLOW_LOCK_LOCALITIES.EXTERNAL &&
      sameLockAcquisition(currentInspection.lock, this.inspection.lock)
    ) {
      return;
    }

    const reason =
      currentInspection.liveness === "stale"
        ? "lock-stale"
        : "ownership-changed";
    Log.debug(
      `[ExternalRunWatchSession] lock ownership changed for workflowKey="${this.workflowKey}" — ending old-owner watch`
    );
    this.signalFinished(reason);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Manifest/events watcher — pinned to this session's exact RunRef
  // ─────────────────────────────────────────────────────────────────────────

  private setupHistoryWatcher(): void {
    Log.debug(
      `[ExternalRunWatchSession] watching run: ${this.workflowKey}/${this.runRef}`
    );
    const targetPath = this.manifestPath;
    const watcher = this.fileWatcherFactory.create(
      path.dirname(targetPath),
      path.basename(targetPath)
    );

    this.disposables.push(
      watcher.onDidChange(() => {
        this.onOutput(this.manifestPath);
      })
    );
    this.disposables.push(watcher);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Heartbeat staleness poll
  // ─────────────────────────────────────────────────────────────────────────

  private startHeartbeatPoll(): void {
    this.heartbeatPollInterval = setInterval(() => {
      void this.validateCurrentLock().catch((err) => {
        Log.warn(
          `[ExternalRunWatchSession] heartbeat poll: lock validation failed:`,
          err
        );
      });
    }, 10_000);
  }

  private signalFinished(reason: ExternalRunWatchFinishReason): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.onFinished(reason);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Accessors
  // ─────────────────────────────────────────────────────────────────────────

  /** Returns the absolute path to this session's manifest file. */
  getActiveHistoryFilePath(): string {
    return this.manifestPath;
  }

  /** Returns the exact owner token this watch session was created for. */
  getOwnerToken(): string {
    return this.inspection.lock.ownerToken;
  }

  /** Returns whether a logical CLI attempt changed since its last broadcast. */
  shouldBroadcastOutput(entryKey: string, signature: string): boolean {
    if (this.lastSentOutputSignatures.get(entryKey) === signature) {
      return false;
    }
    this.lastSentOutputSignatures.set(entryKey, signature);
    return true;
  }
}

function sameLockAcquisition(
  current: ActiveExternalLockInspection["lock"],
  expected: ActiveExternalLockInspection["lock"]
): boolean {
  return (
    current.ownerToken === expected.ownerToken &&
    current.workflowKey === expected.workflowKey &&
    current.runRef === expected.runRef &&
    current.runner === expected.runner &&
    current.hostInstanceId === expected.hostInstanceId &&
    current.executionInstanceId === expected.executionInstanceId
  );
}
