import * as fs from "fs/promises";
import * as path from "path";
import { PromptFileParser } from "../PromptFileParser";
import { PATH_CONSTANTS } from "../../utils/ConfigurationUtils";
import { Log } from "../../utils/Log";
import { WorkflowStep, WorkingFile } from "../../types/CtrlYokeTypes";
import { EXECUTION_STATES } from "../../types/DashboardConstants";
import type { PlatformAdapter } from "../../platform/PlatformAdapter";

/**
 * WorkspaceSessionManager
 *
 * RESPONSIBILITY: Session Persistence & Recovery
 *
 * Handles session management including:
 * - Auto-loading most recent session from .ctrlyoke/.queue/
 * - Discovering prompt files in workspace
 * - Finding and sorting working files by timestamp
 * - Session continuity after VS Code restart or crash
 */
export class WorkspaceSessionManager {
  constructor(
    private promptFileParser: PromptFileParser,
    _platform: PlatformAdapter
  ) {}

  /**
   * Auto-load the most recent workflow session from .ctrlyoke/.queue/
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
      const workingFilePath =
        await this.getMostRecentWorkingFilePath(workspaceFolderPath);

      if (!workingFilePath) {
        return; // No sessions to load
      }

      // Load from working file
      await onLoad(workingFilePath);

      // Extract workflow name from filename for logging
      const workflowName = this.extractWorkflowName(
        path.basename(workingFilePath)
      );

      Log.debug(
        `ctrlyoke: Auto-loaded recent session: ${workflowName} (${path.basename(workingFilePath)})`
      );

      // Optional: Show subtle notification (not intrusive)
      // vscode.window.showInformationMessage(
      //   `ctrlyoke: Resumed session: ${workflowName}`
      // );
    } catch (error) {
      Log.error("ctrlyoke: Failed to auto-load recent session:", error);
      // Don't show error to user - just log and continue
    }
  }

  /**
   * Resolve the current most-recent working file from .ctrlyoke/.queue/.
   * Reads queue metadata from disk each time so reconnecting clients always
   * use fresh recency data rather than a startup snapshot.
   */
  async getMostRecentWorkingFilePath(
    workspaceFolderPath: string
  ): Promise<string | undefined> {
    try {
      const queueDir = path.join(
        workspaceFolderPath,
        PATH_CONSTANTS.CTRLYOKE_DIR,
        PATH_CONSTANTS.QUEUE_DIR
      );
      const workingFiles = await this.listWorkingFilesByRecency(queueDir);
      return workingFiles[0]?.filePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      Log.error(
        "ctrlyoke: Failed to resolve most recent working file path:",
        error
      );
      return undefined;
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
      Log.debug(`ctrlyoke: Discovered ${promptFiles.length} prompt files`);
      return promptFiles;
    } catch (error) {
      Log.error("ctrlyoke: Failed to discover prompt files:", error);
      return [];
    }
  }

  /**
   * Read all working files in the queue directory, sorted by recency.
   * Uses lastModifiedAt when available, falling back to startedAt.
   *
   * @param queueDir Path to .ctrlyoke/.queue/ directory
   */
  private async listWorkingFilesByRecency(queueDir: string): Promise<
    Array<{
      filename: string;
      filePath: string;
      workingFile: WorkingFile;
      timestamp: number;
    }>
  > {
    try {
      await fs.stat(queueDir);

      // Read directory contents
      const entries = await fs.readdir(queueDir, { withFileTypes: true });

      // Filter to .flightpath.json files
      const workingFiles = entries
        .filter(
          (entry) => entry.isFile() && entry.name.endsWith(".flightpath.json")
        )
        .map((entry) => entry.name);

      if (workingFiles.length === 0) {
        return [];
      }

      // Read each file to get lastModifiedAt timestamp
      const filesWithTimestamps = await Promise.all(
        workingFiles.map(async (filename) => {
          const filePath = path.join(queueDir, filename);
          try {
            const content = await fs.readFile(filePath, "utf8");
            const workingFile = JSON.parse(content) as WorkingFile;

            // Use lastModifiedAt if available, fall back to startedAt
            const timestamp =
              workingFile.lastModifiedAt || workingFile.startedAt || 0;

            return { filename, filePath, workingFile, timestamp };
          } catch (error) {
            Log.warn(`Failed to read ${filename}:`, error);
            return undefined;
          }
        })
      );

      // Sort by timestamp (newest first)
      return filesWithTimestamps
        .filter(
          (
            entry
          ): entry is {
            filename: string;
            filePath: string;
            workingFile: WorkingFile;
            timestamp: number;
          } => entry !== undefined
        )
        .sort((a, b) => b.timestamp - a.timestamp);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      Log.error("ctrlyoke: Failed to find most recent working file:", error);
      return [];
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
   * Discover all available sessions in .ctrlyoke/.queue
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
        PATH_CONSTANTS.CTRLYOKE_DIR,
        PATH_CONSTANTS.QUEUE_DIR
      );

      // Check if queue directory exists
      try {
        await fs.stat(queueDir);
      } catch {
        return []; // No queue directory
      }

      const workingFiles = await this.listWorkingFilesByRecency(queueDir);

      if (workingFiles.length === 0) {
        return [];
      }

      // Read each file to get metadata
      const sessions = [];

      for (const { filePath, workingFile } of workingFiles) {
        try {
          const runtime = workingFile._runtime;
          // completedPrompts is a legacy field (no longer on WorkingFileRuntime interface)
          // but may exist in older working files on disk. Use prompts' _runtime.completedAt instead.
          const completedCount =
            workingFile.steps?.filter(
              (p: WorkflowStep) => p._runtime?.completedAt
            ).length || 0;
          const totalCount = workingFile.steps?.length || 0;
          const currentIndex = runtime?.currentIndex || 0;

          // Phase 4: Count prompts with session IDs (per-prompt _runtime metadata)
          const promptsWithSessions =
            workingFile.steps?.filter(
              (p: WorkflowStep) => p._runtime?.sessionId
            ).length || 0;

          // Format timestamp
          const timestamp = new Date(workingFile.startedAt).toLocaleString();

          // Determine status icon
          let statusIcon = "⏸"; // Default paused/idle
          if (runtime?.executionState === EXECUTION_STATES.COMPLETED) {
            statusIcon = "✓";
          } else if (runtime?.executionState === EXECUTION_STATES.ERROR) {
            statusIcon = "✗";
          } else if (runtime?.executionState === EXECUTION_STATES.RUNNING) {
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
          Log.warn(
            `Failed to read session file ${path.basename(filePath)}:`,
            error
          );
        }
      }

      return sessions;
    } catch (error) {
      Log.error("Failed to discover sessions:", error);
      return [];
    }
  }
}
