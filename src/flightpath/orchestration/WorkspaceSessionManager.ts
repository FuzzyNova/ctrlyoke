import * as vscode from "vscode";
import * as path from "path";
import { PromptFileParser } from "../PromptFileParser";

/**
 * WorkspaceSessionManager
 *
 * RESPONSIBILITY: Session Persistence & Recovery
 *
 * Handles session management including:
 * - Auto-loading most recent session from .flightpath/.queue/
 * - Discovering prompt files in workspace
 * - Finding and sorting working files by timestamp
 * - Session continuity after VS Code restart or crash
 */
export class WorkspaceSessionManager {
  constructor(private promptFileParser: PromptFileParser) {}

  /**
   * Auto-load the most recent workflow session from .flightpath/.queue/
   * This enables seamless resume after VS Code restarts or crashes
   *
   * @param workspaceFolder Current workspace folder
   * @param onLoad Callback to load the working file
   */
  async autoLoadRecentSession(
    workspaceFolder: vscode.WorkspaceFolder,
    onLoad: (workingFilePath: string) => Promise<void>
  ): Promise<void> {
    try {
      const queueDir = path.join(
        workspaceFolder.uri.fsPath,
        ".flightpath",
        ".queue"
      );

      // Check if queue directory exists
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(queueDir));
      } catch {
        // Queue directory doesn't exist yet
        return;
      }

      // Find most recent working file
      const mostRecentFile = await this.findMostRecentWorkingFile(queueDir);

      if (!mostRecentFile) {
        return; // No sessions to load
      }

      const workingFilePath = path.join(queueDir, mostRecentFile);

      // Load from working file
      await onLoad(workingFilePath);

      // Extract workflow name from filename for logging
      const workflowName = this.extractWorkflowName(mostRecentFile);

      console.log(
        `FlightPath: Auto-loaded recent session: ${workflowName} (${mostRecentFile})`
      );

      // Optional: Show subtle notification (not intrusive)
      // vscode.window.showInformationMessage(
      //   `FlightPath: Resumed session: ${workflowName}`
      // );
    } catch (error) {
      console.error("FlightPath: Failed to auto-load recent session:", error);
      // Don't show error to user - just log and continue
    }
  }

  /**
   * Discover all prompt files in the workspace
   *
   * @param workspaceFolder Current workspace folder
   * @returns Array of prompt file paths
   */
  async discoverPromptFiles(
    workspaceFolder: vscode.WorkspaceFolder
  ): Promise<string[]> {
    try {
      const promptFiles = await this.promptFileParser.discoverPromptFiles(
        workspaceFolder
      );
      console.log(`FlightPath: Discovered ${promptFiles.length} prompt files`);
      return promptFiles;
    } catch (error) {
      console.error("FlightPath: Failed to discover prompt files:", error);
      return [];
    }
  }

  /**
   * Find the most recent working file in the queue directory
   * Sorted by timestamp in filename (newest first)
   *
   * @param queueDir Path to .flightpath/.queue/ directory
   * @returns Most recent filename or undefined if none found
   */
  private async findMostRecentWorkingFile(
    queueDir: string
  ): Promise<string | undefined> {
    try {
      // Read directory contents
      const files = await vscode.workspace.fs.readDirectory(
        vscode.Uri.file(queueDir)
      );

      // Filter to .flightpath.json files
      const workingFiles = files
        .filter(
          ([name, type]) =>
            type === vscode.FileType.File && name.endsWith(".flightpath.json")
        )
        .map(([name]) => name);

      if (workingFiles.length === 0) {
        return undefined;
      }

      // Sort by timestamp in filename (newest first)
      // Format: workflow-2024-12-22T15-30-00.flightpath.json
      const sorted = workingFiles.sort().reverse();
      return sorted[0];
    } catch (error) {
      console.error(
        "FlightPath: Failed to find most recent working file:",
        error
      );
      return undefined;
    }
  }

  /**
   * Extract workflow name from working file filename
   * Removes timestamp and extension
   *
   * @param filename Working file filename (e.g., "workflow-2024-12-22T15-30-00.flightpath.json")
   * @returns Workflow name (e.g., "workflow")
   */
  private extractWorkflowName(filename: string): string {
    return filename
      .replace(/\.flightpath\.json$/, "")
      .replace(/-\d{4}-\d{2}-\d{2}T.*$/, "");
  }
}
