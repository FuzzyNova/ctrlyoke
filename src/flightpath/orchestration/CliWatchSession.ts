import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { WorkflowSummary, EXECUTION_STATES } from "../../types/FlightPathTypes";
import { WorkflowLockManager } from "../../utils/WorkflowLockManager";
import { LOCK_STATUS } from "../../types/DashboardConstants";
import { Log } from "../../utils/Log";
import { PATH_CONSTANTS } from "../../utils/ConfigurationUtils";

/**
 * CliWatchSession
 *
 * Owns three file watchers for a single CLI-managed workflow:
 *   1. Working file watcher — tracks step progress (currentIndex, executionState)
 *   2. History file watcher — streams CLI output chunks to the dashboard
 *   3. Lock file watcher   — detects when the CLI finishes (lock deleted)
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
  /** Absolute path to the active history file being watched */
  private activeHistoryFilePath: string = "";

  constructor(
    private readonly workingFilePath: string,
    private readonly workflowId: string,
    private readonly workspaceFolderPath: string,
    /**
     * Called when the working file changes: partial WorkflowSummary update
     * with the latest currentStep and executionState.
     */
    private readonly onUpdate: (summary: Partial<WorkflowSummary>) => void,
    /**
     * Called when the active history file changes.
     * Passes the absolute path to the history file so the caller can read
     * and diff outputs.
     */
    private readonly onOutput: (historyFilePath: string) => void,
    /**
     * Called when the CLI has finished (lock deleted or heartbeat stale).
     */
    private readonly onFinished: () => void
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    Log.debug(
      `[CliWatchSession] start: workflowId="${this.workflowId}" workingFile="${path.basename(this.workingFilePath)}"`
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
    Log.debug(`[CliWatchSession] disposed: workflowId="${this.workflowId}"`);
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
    try {
      const content = await fs.promises.readFile(this.workingFilePath, "utf8");
      const workingFile = JSON.parse(content) as {
        _runtime?: { currentIndex?: number; executionState?: string };
        prompts?: unknown[];
      };

      const currentIndex = workingFile._runtime?.currentIndex ?? 0;
      const executionState =
        (workingFile._runtime?.executionState as string | undefined) ??
        EXECUTION_STATES.RUNNING;

      this.onUpdate({
        currentStep: currentIndex,
        totalSteps: workingFile.prompts?.length ?? 0,
        executionState: executionState as WorkflowSummary["executionState"],
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
        WorkflowLockManager.getLockPath(this.workingFilePath)
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
          `[CliWatchSession] lock file deleted — CLI finished for workflowId="${this.workflowId}"`
        );
        this.onFinished();
      })
    );
    this.disposables.push(watcher);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // History file watcher
  // ─────────────────────────────────────────────────────────────────────────

  private setupHistoryWatcher(): void {
    const historyDir = path.join(
      this.workspaceFolderPath,
      PATH_CONSTANTS.FLIGHTPATH_DIR,
      PATH_CONSTANTS.HISTORY_DIR,
      this.workflowId
    );

    // Find the latest existing run file synchronously on startup
    try {
      const latest = this.findLatestHistoryFileSync(historyDir);
      if (latest) {
        this.activeHistoryFilePath = latest;
        this.watchHistoryFile(latest);
      }
    } catch {
      // History directory may not exist yet — that's fine
    }

    // Watch for new run files appearing in the history directory
    this.watchForNewRunFiles(historyDir);
  }

  private findLatestHistoryFileSync(historyDir: string): string | undefined {
    let entries: string[];
    try {
      entries = fs.readdirSync(historyDir);
    } catch {
      return undefined;
    }
    const runFiles = entries
      .filter((f) => /^run-.*\.json$/.test(f))
      .sort()
      .reverse(); // lexicographic descending = newest first (ISO timestamps sort correctly)

    if (runFiles.length === 0) {
      return undefined;
    }
    return path.join(historyDir, runFiles[0]);
  }

  private watchHistoryFile(historyFilePath: string): void {
    Log.debug(
      `[CliWatchSession] watching history file: ${path.basename(historyFilePath)}`
    );
    const pattern = new vscode.RelativePattern(
      this.workspaceFolderPath,
      path
        .relative(this.workspaceFolderPath, historyFilePath)
        .replace(/\\/g, "/")
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    this.disposables.push(
      watcher.onDidChange(() => {
        this.onOutput(historyFilePath);
      })
    );
    this.disposables.push(watcher);
  }

  private watchForNewRunFiles(historyDir: string): void {
    // Watch the history directory for creation of new run-*.json files
    const historyDirRelative = path
      .relative(this.workspaceFolderPath, historyDir)
      .replace(/\\/g, "/");

    const pattern = new vscode.RelativePattern(
      this.workspaceFolderPath,
      `${historyDirRelative}/run-*.json`
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    this.disposables.push(
      watcher.onDidCreate((uri) => {
        const newFilePath = uri.fsPath;
        Log.debug(
          `[CliWatchSession] new history run file: ${path.basename(newFilePath)}`
        );

        // If it's newer than the current active history file, switch to it
        if (
          !this.activeHistoryFilePath ||
          newFilePath > this.activeHistoryFilePath
        ) {
          // Reset output tracking for the new run
          this.lastKnownOutputByStep = {};
          this.activeHistoryFilePath = newFilePath;
          this.watchHistoryFile(newFilePath);
        }
      })
    );
    this.disposables.push(watcher);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Heartbeat staleness poll
  // ─────────────────────────────────────────────────────────────────────────

  private startHeartbeatPoll(): void {
    this.heartbeatPollInterval = setInterval(() => {
      WorkflowLockManager.checkLock(this.workingFilePath)
        .then((status) => {
          if (status === LOCK_STATUS.NONE || status === LOCK_STATUS.STALE) {
            Log.debug(
              `[CliWatchSession] heartbeat poll: lock is ${status} for workflowId="${this.workflowId}" — calling onFinished`
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

  /** Returns the absolute path to the currently-watched history file, or empty string. */
  getActiveHistoryFilePath(): string {
    return this.activeHistoryFilePath;
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
