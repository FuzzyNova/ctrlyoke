import * as vscode from "vscode";
import * as path from "path";
import { PromptQueue } from "../PromptQueue";
import { EXECUTION_STATES } from "../../types/FlightPathTypes";
import type { IDashboardProvider } from "../../ui/IDashboardProvider";
import { Log } from "../../utils/Log";

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

  constructor(
    private promptQueue: PromptQueue,
    private getDashboard: () => IDashboardProvider | undefined = () => undefined
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

    // Create watcher for this specific file (working file)
    const pattern = new vscode.RelativePattern(
      path.dirname(filePath),
      path.basename(filePath)
    );

    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    this.watcher.onDidChange(async (uri) => {
      await this.onFileChanged(uri, onFileChanged);
    });

    this.watcher.onDidDelete((uri) => {
      this.onFileDeleted(uri, onFileDeleted);
    });

    Log.debug(`Set up file watcher for ${filePath}`);
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
      Log.debug(
        `Working file changed during execution, reloading queue: ${uri.fsPath}`
      );
      await onReload(uri.fsPath);
    } else {
      Log.debug(
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
    Log.debug(`Working file deleted: ${uri.fsPath}`);

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
    this.watcher?.dispose();
    this.watcher = undefined;
  }
}
