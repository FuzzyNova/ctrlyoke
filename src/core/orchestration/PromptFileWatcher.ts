import * as fs from "fs/promises";
import * as path from "path";
import { PromptQueue } from "../PromptQueue";
import { EXECUTION_STATES } from "../../types/CtrlYokeTypes";
import type { IDashboardSink } from "../../types/IDashboardSink";
import { Log } from "../../utils/Log";
import { pathsEqual } from "../../utils/PathCasing";
import { isPathWithinAnyDirectory } from "../../utils/PathSecurity";
import type { FileWatcher, FileWatcherFactory } from "../HostPorts";

/**
 * PromptFileWatcher
 *
 * RESPONSIBILITY: File System Monitoring & Live Reload
 *
 * Handles file watching for working files including:
 * - Setting up a host file watcher for specific files, with a stat-polling
 *   fallback wherever native watching is unavailable or unreliable
 * - Handling file change events (MCP appends, user edits)
 * - Handling file deletion events
 * - Cleanup and disposal of watchers
 */
export class PromptFileWatcher {
  private watcher?: FileWatcher;
  private pollingInterval?: ReturnType<typeof setInterval>;
  private pollingFilePath?: string;
  private pollingFileSignature?: string;
  private pollingInFlight = false;
  private stateChangeSubscription?: { dispose(): void };
  private watchedFilePath?: string;
  private onFileChangedCallback?: (filePath: string) => Promise<void>;
  private onFileDeletedCallback?: (filePath: string) => void;

  constructor(
    private promptQueue: PromptQueue,
    private getDashboard: () => IDashboardSink | undefined = () => undefined,
    /**
     * Host file watcher. Omitted by headless hosts (the CLI), which then rely
     * on polling alone.
     */
    private readonly fileWatcherFactory?: FileWatcherFactory,
    /**
     * Roots under which the host watcher is trusted to deliver events. A file
     * outside every root (e.g. user-scoped run storage) is polled as well.
     */
    private readonly getNativelyWatchedRoots: () => readonly string[] = () => []
  ) {}

  /**
   * Set up file watcher for the working file (not the original prompt file!)
   * Reloads queue when working file changes (from Queue Append, Dynamic Queue, or MCP)
   *
   * @param filePath Path to the working file to watch
   * @param onFileChanged Callback when file changes (should reload queue)
   * @param onFileDeleted Callback when file is deleted (should cleanup references)
   */
  setupFileWatcher(
    filePath: string,
    onFileChanged: (filePath: string) => Promise<void>,
    onFileDeleted: (filePath: string) => void
  ): void {
    // Dispose existing watcher
    this.dispose();

    this.onFileChangedCallback = onFileChanged;
    this.onFileDeletedCallback = onFileDeleted;
    this.stateChangeSubscription = this.promptQueue.onDidChangeState(
      (state) => {
        const nextWorkingFilePath = state.workingFilePath;
        if (!nextWorkingFilePath) {
          this.disposeWatcher();
          this.watchedFilePath = undefined;
          return;
        }
        if (
          !this.watchedFilePath ||
          !pathsEqual(this.watchedFilePath, nextWorkingFilePath)
        ) {
          this.watchFile(nextWorkingFilePath);
        }
      }
    );

    this.watchFile(this.promptQueue.getState().workingFilePath ?? filePath);
  }

  private watchFile(filePath: string): void {
    this.disposeWatcher();

    this.watchFileNatively(filePath);
    Log.trace(`[PromptFileWatcher] Set up file watcher for ${filePath}`);
    this.watchedFilePath = filePath;
    this.startPollingIfNeeded(filePath);
  }

  private watchFileNatively(filePath: string): void {
    if (!this.fileWatcherFactory) {
      return;
    }

    // Create watcher for this specific file (working file)
    this.watcher = this.fileWatcherFactory.create(
      path.dirname(filePath),
      path.basename(filePath)
    );

    this.watcher.onDidChange(async (changedPath) => {
      if (this.onFileChangedCallback) {
        await this.onFileChanged(changedPath, this.onFileChangedCallback);
      }
    });

    // Also handle onDidCreate: on Windows, fs.rename() over an existing file
    // (used by the working-file atomic write) fires onDidCreate instead of
    // onDidChange, so queue appends would otherwise be missed until the next
    // natural queue write.
    this.watcher.onDidCreate(async (createdPath) => {
      if (this.onFileChangedCallback) {
        await this.onFileChanged(createdPath, this.onFileChangedCallback);
      }
    });

    this.watcher.onDidDelete((deletedPath) => {
      if (this.onFileDeletedCallback) {
        this.onFileDeleted(deletedPath, this.onFileDeletedCallback);
      }
    });
  }

  private startPollingIfNeeded(filePath: string): void {
    const nativelyWatched =
      this.watcher !== undefined &&
      isPathWithinAnyDirectory(filePath, this.getNativelyWatchedRoots());
    if (nativelyWatched) {
      return;
    }

    this.pollingFilePath = filePath;
    this.pollingFileSignature = undefined;
    this.pollingInterval = setInterval(() => {
      void this.pollExternalFile(filePath);
    }, 1_000);
    void this.pollExternalFile(filePath);
  }

  private async pollExternalFile(filePath: string): Promise<void> {
    if (
      this.pollingInFlight ||
      !pathsEqual(this.pollingFilePath ?? "", filePath)
    ) {
      return;
    }

    this.pollingInFlight = true;
    try {
      const stats = await fs.stat(filePath);
      const signature = `${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}:${stats.ino}`;
      if (this.pollingFileSignature === undefined) {
        this.pollingFileSignature = signature;
        return;
      }
      if (this.pollingFileSignature === signature) {
        return;
      }
      this.pollingFileSignature = signature;
      if (this.onFileChangedCallback) {
        await this.onFileChanged(filePath, this.onFileChangedCallback);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        Log.trace(
          `[PromptFileWatcher] Unable to poll external working file ${filePath}:`,
          error
        );
      }
    } finally {
      this.pollingInFlight = false;
    }
  }

  /**
   * Handle file change events
   * Only reloads during active execution states to support MCP appends
   *
   * @param filePath Changed file path
   * @param onReload Callback to reload queue from file
   */
  private async onFileChanged(
    filePath: string,
    onReload: (filePath: string) => Promise<void>
  ): Promise<void> {
    // Reload during active execution states (RUNNING, PAUSED, CANCELLING) to support MCP appends
    // Do NOT reload when IDLE (not started), COMPLETED, or ERROR (preserve final dashboard view)
    const state = this.promptQueue.getState();
    const shouldReload =
      state.status === EXECUTION_STATES.RUNNING ||
      state.status === EXECUTION_STATES.PAUSED ||
      state.status === EXECUTION_STATES.CANCELLING;

    if (shouldReload) {
      Log.trace(
        `[PromptFileWatcher] Working file changed during execution, reloading queue: ${filePath}`
      );
      await onReload(filePath);
    } else {
      Log.trace(
        `[PromptFileWatcher] Working file changed but ignoring reload (state: ${state.status}) to preserve dashboard view`
      );
    }
  }

  /**
   * Handle file deletion events
   *
   * @param filePath Deleted file path
   * @param onDelete Callback to cleanup file references
   */
  private onFileDeleted(
    filePath: string,
    onDelete: (filePath: string) => void
  ): void {
    Log.trace(`[PromptFileWatcher] Working file deleted: ${filePath}`);

    // A promoted draft is moved, not lost: `WorkingFileManager.finalizeRun`
    // removes `draft/workflow.ctrlyoke.json` once its content lives on in
    // `run-<ts>/workflow.ctrlyoke.json`. That delete is delivered
    // asynchronously and routinely lands after the queue has already switched
    // to the run file, so a delete for anything other than the queue's
    // *current* working file means the definition moved rather than
    // disappeared. Acting on it would blank the panel mid-run and — because
    // `dispose()` also drops the `onDidChangeState` subscription — would
    // permanently stop the watcher from following `workingFilePath`,
    // reinstating the exact defect that subscription exists to fix.
    const activeWorkingFile = this.promptQueue.getState().workingFilePath;
    if (activeWorkingFile && !pathsEqual(activeWorkingFile, filePath)) {
      Log.trace(
        `[PromptFileWatcher] Ignoring delete for superseded working file (active: ${activeWorkingFile})`
      );
      return;
    }

    // Cleanup file references
    onDelete(filePath);

    // The watched file really is gone. Drop the watcher and its polling
    // fallback, but keep the state subscription so a later working-file change
    // can still re-point the watcher.
    this.disposeWatcher();
    this.watchedFilePath = undefined;

    // Update dashboard to show no file selected
    const dashboard = this.getDashboard();
    if (dashboard) {
      dashboard.updateFileSelected("No file selected", []);
    }
  }

  /**
   * Dispose the file watcher
   */
  dispose(): void {
    this.disposeWatcher();
    this.stateChangeSubscription?.dispose();
    this.stateChangeSubscription = undefined;
    this.watchedFilePath = undefined;
    this.onFileChangedCallback = undefined;
    this.onFileDeletedCallback = undefined;
  }

  private disposeWatcher(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    if (this.pollingInterval !== undefined) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = undefined;
    }
    this.pollingFilePath = undefined;
    this.pollingFileSignature = undefined;
    this.pollingInFlight = false;
  }
}
