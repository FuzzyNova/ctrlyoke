import * as fs from "fs/promises";
import * as path from "path";
import { PromptFileParser } from "../PromptFileParser";
import { PATH_CONSTANTS } from "../../utils/ConfigurationUtils";
import { Log } from "../../utils/Log";
import { PromptItem, WorkingFile } from "../../types/FlightPathTypes";
import type { PlatformAdapter } from "../../platform/PlatformAdapter";

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
  constructor(
    private promptFileParser: PromptFileParser,
    private readonly platform: PlatformAdapter
  ) {}

  /**
   * Auto-load the most recent workflow session from .flightpath/.queue/
   * This enables seamless resume after VS Code restarts or crashes
   *
   * @param workspaceFolder Current workspace folder
   * @param onLoad Callback to load the working file
   */
  async autoLoadRecentSession(
    workspaceFolderPath: string,
    onLoad: (workingFilePath: string) => Promise<void>
  ): Promise<void> {
    try {
      const queueDir = path.join(
        workspaceFolderPath,
        PATH_CONSTANTS.FLIGHTPATH_DIR,
        PATH_CONSTANTS.QUEUE_DIR
      );

      // Check if queue directory exists
      try {
        await fs.stat(queueDir);
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

      Log.info(
        `FlightPath: Auto-loaded recent session: ${workflowName} (${mostRecentFile})`
      );

      // Optional: Show subtle notification (not intrusive)
      // vscode.window.showInformationMessage(
      //   `FlightPath: Resumed session: ${workflowName}`
      // );
    } catch (error) {
      Log.error("FlightPath: Failed to auto-load recent session:", error);
      // Don't show error to user - just log and continue
    }
  }

  /**
   * Discover all prompt files in the workspace
   *
   * @param workspaceFolder Current workspace folder
   * @returns Array of prompt file paths
   */
  async discoverPromptFiles(workspaceFolderPath: string): Promise<string[]> {
    try {
      const promptFiles =
        await this.promptFileParser.discoverPromptFiles(workspaceFolderPath);
      Log.info(`FlightPath: Discovered ${promptFiles.length} prompt files`);
      return promptFiles;
    } catch (error) {
      Log.error("FlightPath: Failed to discover prompt files:", error);
      return [];
    }
  }

  /**
   * Find the most recent working file in the queue directory
   * Sorted by lastModifiedAt timestamp (or startedAt if not available)
   *
   * @param queueDir Path to .flightpath/.queue/ directory
   * @returns Most recent filename or undefined if none found
   */
  private async findMostRecentWorkingFile(
    queueDir: string
  ): Promise<string | undefined> {
    try {
      // Read directory contents
      const entries = await fs.readdir(queueDir, { withFileTypes: true });

      // Filter to .flightpath.json files
      const workingFiles = entries
        .filter(
          (entry) => entry.isFile() && entry.name.endsWith(".flightpath.json")
        )
        .map((entry) => entry.name);

      if (workingFiles.length === 0) {
        return undefined;
      }

      // Read each file to get lastModifiedAt timestamp
      const filesWithTimestamps = await Promise.all(
        workingFiles.map(async (filename) => {
          try {
            const filePath = path.join(queueDir, filename);
            const content = await fs.readFile(filePath, "utf8");
            const workingFile = JSON.parse(content) as WorkingFile;

            // Use lastModifiedAt if available, fall back to startedAt
            const timestamp =
              workingFile.lastModifiedAt || workingFile.startedAt || 0;

            return { filename, timestamp };
          } catch (error) {
            Log.warn(`Failed to read ${filename}:`, error);
            return { filename, timestamp: 0 };
          }
        })
      );

      // Sort by timestamp (newest first)
      filesWithTimestamps.sort((a, b) => b.timestamp - a.timestamp);

      return filesWithTimestamps[0]?.filename;
    } catch (error) {
      Log.error("FlightPath: Failed to find most recent working file:", error);
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

  /**
   * Discover all available sessions in .flightpath/.queue
   * Returns session metadata for UI display
   *
   * @param workspaceFolder Current workspace folder
   * @returns Array of session info objects or empty array if none found
   */
  async discoverSessions(workspaceFolderPath: string): Promise<
    Array<{
      label: string;
      description: string;
      detail: string;
      filePath: string;
    }>
  > {
    try {
      const queueDir = path.join(
        workspaceFolderPath,
        PATH_CONSTANTS.FLIGHTPATH_DIR,
        PATH_CONSTANTS.QUEUE_DIR
      );

      // Check if queue directory exists
      try {
        await fs.stat(queueDir);
      } catch {
        return []; // No queue directory
      }

      // Find all working files
      const entries = await fs.readdir(queueDir, { withFileTypes: true });

      const workingFiles = entries
        .filter(
          (entry) => entry.isFile() && entry.name.endsWith(".flightpath.json")
        )
        .map((entry) => entry.name);

      if (workingFiles.length === 0) {
        return [];
      }

      // Sort by timestamp (newest first)
      const sortedFiles = workingFiles.sort().reverse();

      // Read each file to get metadata
      const sessions = [];

      for (const filename of sortedFiles) {
        try {
          const filePath = path.join(queueDir, filename);
          const content = await fs.readFile(filePath, "utf8");
          const workingFile = JSON.parse(content) as WorkingFile;

          const runtime = workingFile._runtime;
          // completedPrompts is a legacy field (no longer on WorkingFileRuntime interface)
          // but may exist in older working files on disk. Use prompts' _runtime.completedAt instead.
          const completedCount =
            workingFile.prompts?.filter(
              (p: PromptItem) => p._runtime?.completedAt
            ).length || 0;
          const totalCount = workingFile.prompts?.length || 0;
          const currentIndex = runtime?.currentIndex || 0;

          // Phase 4: Count prompts with session IDs (per-prompt _runtime metadata)
          const promptsWithSessions =
            workingFile.prompts?.filter(
              (p: PromptItem) => p._runtime?.sessionId
            ).length || 0;

          // Format timestamp
          const timestamp = new Date(workingFile.startedAt).toLocaleString();

          // Determine status icon
          let statusIcon = "⏸"; // Default paused/idle
          if (runtime?.executionState === "completed") {
            statusIcon = "✓";
          } else if (runtime?.executionState === "error") {
            statusIcon = "✗";
          } else if (runtime?.executionState === "running") {
            statusIcon = "▶";
          }

          // Build detail string with optional session info
          let detail = `Started: ${timestamp} • Current: Step ${currentIndex + 1}/${totalCount}`;
          if (promptsWithSessions > 0) {
            detail += ` • Sessions: ${promptsWithSessions}`;
          }

          sessions.push({
            label: `${statusIcon} ${workingFile.workflowName}`,
            description: `${completedCount}/${totalCount} completed`,
            detail,
            filePath,
          });
        } catch (error) {
          // Skip invalid files
          Log.warn(`Failed to read session file ${filename}:`, error);
        }
      }

      return sessions;
    } catch (error) {
      Log.error("Failed to discover sessions:", error);
      return [];
    }
  }
}
