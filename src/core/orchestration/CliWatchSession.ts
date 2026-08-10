import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {
  WorkflowSummary,
  WorkflowTokenTotals,
  EXECUTION_STATES,
  type RunRef,
  type WorkflowKey,
} from "../../types/CtrlYokeTypes";
import { WorkflowLockManager } from "../../utils/WorkflowLockManager";
import { LOCK_STATUS } from "../../types/DashboardConstants";
import { Log } from "../../utils/Log";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { invalidateRunSummaryFor } from "./RunSummaryCache";

/**
 * CliWatchSession
 *
 * Owns three file watchers for a single CLI-managed workflow, all pinned to the exact
 * `RunRef` named by the lineage's runner lock — never "the newest run" — so a client
 * browsing a different (older) run of the same lineage can never redirect this watcher:
 *   1. Run file watcher     — tracks step progress (currentIndex, executionState)
 *   2. Manifest/events watcher — streams CLI output chunks to the dashboard
 *   3. Lock file watcher    — detects when the CLI finishes (lock deleted)
 *
 * Also runs a 10-second heartbeat staleness poll as a fallback for CLI crashes
 * (lock file exists but heartbeat has gone stale).
 *
 * Created by WorkflowOrchestrator when an active-cli lock is detected.
 * Disposed when the lock is deleted or goes stale.
 */
export class CliWatchSession implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private heartbeatPollInterval: ReturnType<typeof setInterval> | undefined;
  /** stepIndex → last number of outputs sent to the dashboard for that step */
  private lastKnownOutputByStep: Record<number, number> = {};
  private readonly manifestPath: string;

  constructor(
    private readonly workingFilePath: string,
    private readonly workflowKey: WorkflowKey,
    private readonly runRef: RunRef,
    private readonly workspaceFolderPath: string,
    /**
     * Called when the working file changes: partial WorkflowSummary update
     * with the latest currentStep and executionState.
     */
    private readonly onUpdate: (summary: Partial<WorkflowSummary>) => void,
    /**
     * Called when the run's manifest/events change.
     * Passes the absolute path to the manifest file so the caller can read
     * and diff outputs.
     */
    private readonly onOutput: (historyFilePath: string) => void,
    /**
     * Called when the CLI has finished (lock deleted or heartbeat stale).
     */
    private readonly onFinished: () => void
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
      `[CliWatchSession] start: workflowKey="${this.workflowKey}" runRef="${this.runRef}"`
    );

    this.setupWorkingFileWatcher();
    this.setupLockFileWatcher();
    this.setupHistoryWatcher();
    this.startHeartbeatPoll();
  }

  dispose(): void {
    if (this.heartbeatPollInterval !== undefined) {
      clearInterval(this.heartbeatPollInterval);
      this.heartbeatPollInterval = undefined;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    Log.debug(
      `[CliWatchSession] disposed: workflowKey="${this.workflowKey}" runRef="${this.runRef}"`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Working file watcher
  // ─────────────────────────────────────────────────────────────────────────

  private setupWorkingFileWatcher(): void {
    const pattern = new vscode.RelativePattern(
      this.workspaceFolderPath,
      path
        .relative(this.workspaceFolderPath, this.workingFilePath)
        .replace(/\\/g, "/")
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    this.disposables.push(
      watcher.onDidChange(async () => {
        await this.handleWorkingFileChange();
      })
    );
    // Also handle onDidCreate: on Windows, fs.rename() over an existing file
    // (used by the MCP server's atomic temp-file write) fires onDidCreate
    // instead of onDidChange, so MCP queue appends would otherwise be missed
    // until the next natural queue write.
    this.disposables.push(
      watcher.onDidCreate(async () => {
        await this.handleWorkingFileChange();
      })
    );
    this.disposables.push(watcher);
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
        };
        steps?: unknown[];
      };

      const currentIndex = workingFile._runtime?.currentIndex ?? 0;
      const executionState =
        (workingFile._runtime?.executionState as string | undefined) ??
        EXECUTION_STATES.RUNNING;

      this.onUpdate({
        currentStep: currentIndex,
        totalSteps: workingFile.steps?.length ?? 0,
        executionState: executionState as WorkflowSummary["executionState"],
        tokenTotals: workingFile._runtime?.tokenTotals,
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // File was deleted — that's fine, the lock watcher will handle it
        return;
      }
      if (!retried) {
        // JSON parse error: file may be mid-write — retry once after 50ms
        Log.debug(
          `[CliWatchSession] handleWorkingFileChange: parse error, retrying in 50ms`
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        await this.handleWorkingFileChange(true);
      } else {
        Log.warn(
          `[CliWatchSession] handleWorkingFileChange: failed to parse working file after retry:`,
          err
        );
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lock file watcher
  // ─────────────────────────────────────────────────────────────────────────

  private setupLockFileWatcher(): void {
    const lockRelativePath = path
      .relative(
        this.workspaceFolderPath,
        WorkflowLockManager.getLockPath(
          this.workspaceFolderPath,
          this.workflowKey
        )
      )
      .replace(/\\/g, "/");

    const pattern = new vscode.RelativePattern(
      this.workspaceFolderPath,
      lockRelativePath
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    this.disposables.push(
      watcher.onDidDelete(() => {
        Log.debug(
          `[CliWatchSession] lock file deleted — CLI finished for workflowKey="${this.workflowKey}"`
        );
        this.onFinished();
      })
    );
    this.disposables.push(watcher);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Manifest/events watcher — pinned to this session's exact RunRef
  // ─────────────────────────────────────────────────────────────────────────

  private setupHistoryWatcher(): void {
    Log.debug(
      `[CliWatchSession] watching run: ${this.workflowKey}/${this.runRef}`
    );
    const pattern = new vscode.RelativePattern(
      this.workspaceFolderPath,
      path
        .relative(this.workspaceFolderPath, this.manifestPath)
        .replace(/\\/g, "/")
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

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
      WorkflowLockManager.checkLock(this.workspaceFolderPath, this.workflowKey)
        .then((status) => {
          if (status === LOCK_STATUS.NONE || status === LOCK_STATUS.STALE) {
            Log.debug(
              `[CliWatchSession] heartbeat poll: lock is ${status} for workflowKey="${this.workflowKey}" — calling onFinished`
            );
            this.onFinished();
          }
        })
        .catch((err) => {
          Log.warn(`[CliWatchSession] heartbeat poll: checkLock failed:`, err);
        });
    }, 10_000);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Accessors
  // ─────────────────────────────────────────────────────────────────────────

  /** Returns the absolute path to this session's manifest file. */
  getActiveHistoryFilePath(): string {
    return this.manifestPath;
  }

  /** Returns and updates the last-known output count for a step (used for diffing). */
  getAndUpdateLastKnownOutputCount(
    stepIndex: number,
    newCount: number
  ): number {
    const last = this.lastKnownOutputByStep[stepIndex] ?? 0;
    this.lastKnownOutputByStep[stepIndex] = newCount;
    return last;
  }
}
