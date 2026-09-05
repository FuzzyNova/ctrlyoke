import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { PromptQueue } from "../PromptQueue";
import { EXECUTION_STATES } from "../../types/CtrlYokeTypes";
import type { IDashboardSink } from "../../types/IDashboardSink";
import { Log } from "../../utils/Log";
import { pathsEqual } from "../../utils/PathCasing";

/**
 * PromptFileWatcher
 *
 * RESPONSIBILITY: File System Monitoring & Live Reload
 *
 * Handles file watching for working files including:
 * - Setting up FileSystemWatcher for specific files
 * - Handling file change events (MCP appends, user edits)
 * - Handling file deletion events
 * - Cleanup and disposal of watchers
 */
export class PromptFileWatcher {
  private watcher?: vscode.FileSystemWatcher;
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
    private getDashboard: () => IDashboardSink | undefined = () => undefined
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

    // Create watcher for this specific file (working file)
    const pattern = new vscode.RelativePattern(
      path.dirname(filePath),
      path.basename(filePath)
    );

    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    this.watcher.onDidChange(async (uri) => {
      if (this.onFileChangedCallback) {
        await this.onFileChanged(uri, this.onFileChangedCallback);
      }
    });

    // Also handle onDidCreate: on Windows, fs.rename() over an existing file
    // (used by the working-file atomic write) fires onDidCreate instead of
    // onDidChange, so queue appends would otherwise be missed until the next
    // natural queue write.
    this.watcher.onDidCreate(async (uri) => {
      if (this.onFileChangedCallback) {
        await this.onFileChanged(uri, this.onFileChangedCallback);
      }
    });

    this.watcher.onDidDelete((uri) => {
      if (this.onFileDeletedCallback) {
        this.onFileDeleted(uri, this.onFileDeletedCallback);
      }
    });

    Log.trace(`Set up file watcher for ${filePath}`);
    this.watchedFilePath = filePath;
    this.startExternalFilePolling(filePath);
  }

  private startExternalFilePolling(filePath: string): void {
    const isExternalFile =
      vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath)) ===
      undefined;
    if (!isExternalFile) {
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
        await this.onFileChanged(vscode.Uri.file(filePath), this.onFileChangedCallback);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        Log.trace(`Unable to poll external working file ${filePath}:`, error);
      }
    } finally {
      this.pollingInFlight = false;
    }
  }

  /**
   * Handle file change events
   * Only reloads during active execution states to support MCP appends
   *
   * @param uri Changed file URI
   * @param onReload Callback to reload queue from file
   */
  private async onFileChanged(
    uri: vscode.Uri,
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
        `Working file changed during execution, reloading queue: ${uri.fsPath}`
      );
      await onReload(uri.fsPath);
    } else {
      Log.trace(
        `Working file changed but ignoring reload (state: ${state.status}) to preserve dashboard view`
      );
    }
  }

  /**
   * Handle file deletion events
   *
   * @param uri Deleted file URI
   * @param onDelete Callback to cleanup file references
   */
  private onFileDeleted(
    uri: vscode.Uri,
    onDelete: (filePath: string) => void
  ): void {
    Log.trace(`Working file deleted: ${uri.fsPath}`);

    // Cleanup file references
    onDelete(uri.fsPath);

    // Dispose the watcher since file no longer exists
    this.dispose();

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
