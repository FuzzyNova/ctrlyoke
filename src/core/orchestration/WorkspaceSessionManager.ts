import * as fs from "fs/promises";
import * as path from "path";
import { PromptFileParser } from "../PromptFileParser";
import { Log } from "../../utils/Log";
import type {
  WorkflowKey,
  WorkflowLineageDescriptor,
  WorkflowStep,
  WorkingFile,
} from "../../types/CtrlYokeTypes";
import { EXECUTION_STATES } from "../../types/DashboardConstants";
import type { PlatformAdapter } from "../../platform/PlatformAdapter";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { WorkflowLineageRepository } from "./WorkflowLineageRepository";
import {
  getLineageLastModifiedAt,
  getLineageLastModifiedUpperBound,
  stripLegacyWorkingFileLineageMetadata,
} from "../../utils/WorkingFileMetadata";

/**
 * WorkspaceSessionManager
 *
 * RESPONSIBILITY: Session Persistence & Recovery
 *
 * Handles session management including:
 * - Auto-loading most recent session from run storage
 * - Discovering prompt files in workspace
 * - Finding and sorting each lineage's current definition file by recency
 * - Session continuity after VS Code restart or crash
 */
export class WorkspaceSessionManager {
  private readonly lineageRepository = new WorkflowLineageRepository();

  constructor(
    private promptFileParser: PromptFileParser,
    _platform: PlatformAdapter
  ) {}

  /**
   * Auto-load the most recent workflow session from run storage.
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

      const address =
        WorkflowPaths.parseWorkingFileAddressFromPath(workingFilePath);
      const workflowName = address
        ? await this.lineageRepository.readWorkflowDisplayName(
            workspaceFolderPath,
            address.workflowKey
          )
        : path.basename(workingFilePath);

      Log.debug(
        `[WorkspaceSessionManager] ctrlyoke: Auto-loaded recent session: ${workflowName} (${path.basename(workingFilePath)})`
      );

      // Optional: Show subtle notification (not intrusive)
      // vscode.window.showInformationMessage(
      //   `ctrlyoke: Resumed session: ${workflowName}`
      // );
    } catch (error) {
      Log.error(
        "[WorkspaceSessionManager] ctrlyoke: Failed to auto-load recent session:",
        error
      );
      // Don't show error to user - just log and continue
    }
  }

  /**
   * Resolve the current most-recent working file from run storage.
   * Reads lineage metadata from disk each time so reconnecting clients always
   * use fresh recency data rather than a startup snapshot.
   *
   * Gives the same answer as the head of {@link listWorkingFilesByRecency}
   * without reading every lineage's run files. That full scan parsed every
   * working file in run storage (~3,300 with ~1,450 lineages) and ran inside a
   * browser client's READY, stalling the shared message queue for 5–7 s per
   * phone connect. Lineages are visited in descending order of a stat-only
   * upper bound on their recency, and the walk stops once the best exact
   * recency found beats every remaining bound.
   */
  async getMostRecentWorkingFilePath(
    workspaceFolderPath: string
  ): Promise<string | undefined> {
    try {
      const workflowKeys =
        await this.lineageRepository.listLineageKeys(workspaceFolderPath);
      const candidates = (
        await Promise.all(
          workflowKeys.map(async (workflowKey, order) => {
            const descriptor = await this.readRecentSessionDescriptor(
              workspaceFolderPath,
              workflowKey
            );
            if (!descriptor) return undefined;
            const upperBound = await getLineageLastModifiedUpperBound(
              workspaceFolderPath,
              workflowKey,
              descriptor.lastModifiedAt
            );
            return { workflowKey, descriptor, order, upperBound };
          })
        )
      )
        .filter((candidate) => candidate !== undefined)
        .sort((a, b) => b.upperBound - a.upperBound || a.order - b.order);

      // Ties keep listing order, matching the stable sort of the full scan.
      let best:
        { filePath: string; timestamp: number; order: number } | undefined;
      for (const candidate of candidates) {
        if (best && best.timestamp > candidate.upperBound) break;
        const entry = await this.readRecencyEntry(
          workspaceFolderPath,
          candidate.workflowKey,
          candidate.descriptor
        );
        if (!entry) continue;
        if (
          !best ||
          entry.timestamp > best.timestamp ||
          (entry.timestamp === best.timestamp && candidate.order < best.order)
        ) {
          best = {
            filePath: entry.filePath,
            timestamp: entry.timestamp,
            order: candidate.order,
          };
        }
      }
      return best?.filePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      Log.error(
        "[WorkspaceSessionManager] ctrlyoke: Failed to resolve most recent working file path:",
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
      Log.debug(
        `[WorkspaceSessionManager] ctrlyoke: Discovered ${promptFiles.length} prompt files`
      );
      return promptFiles;
    } catch (error) {
      Log.error(
        "[WorkspaceSessionManager] ctrlyoke: Failed to discover prompt files:",
        error
      );
      return [];
    }
  }

  /**
   * Resolve each lineage's CURRENT definition file — the descriptor's
   * `latestRunRef` file if a run has ever executed, otherwise the draft — and
   * sort them by recency (`resolveLineageLastModifiedAt`).
   *
   * @param workspaceFolderPath Path to the workspace root
   */
  private async listWorkingFilesByRecency(workspaceFolderPath: string): Promise<
    Array<{
      filePath: string;
      workingFile: WorkingFile;
      timestamp: number;
    }>
  > {
    const workflowKeys =
      await this.lineageRepository.listLineageKeys(workspaceFolderPath);
    if (workflowKeys.length === 0) {
      return [];
    }

    const filesWithTimestamps = await Promise.all(
      workflowKeys.map(async (workflowKey) => {
        const descriptor = await this.readRecentSessionDescriptor(
          workspaceFolderPath,
          workflowKey
        );
        return descriptor
          ? this.readRecencyEntry(workspaceFolderPath, workflowKey, descriptor)
          : undefined;
      })
    );

    return filesWithTimestamps
      .filter((entry) => entry !== undefined)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * A lineage's descriptor, or `undefined` when it is unreadable or the
   * lineage is system-generated and so excluded from recent sessions.
   */
  private async readRecentSessionDescriptor(
    workspaceFolderPath: string,
    workflowKey: WorkflowKey
  ): Promise<WorkflowLineageDescriptor | undefined> {
    try {
      const descriptor = await this.lineageRepository.readDescriptor(
        workspaceFolderPath,
        workflowKey
      );
      return descriptor.isSystemGenerated ? undefined : descriptor;
    } catch (error) {
      Log.warn(
        `[WorkspaceSessionManager] Failed to read lineage ${workflowKey}:`,
        error
      );
      return undefined;
    }
  }

  /**
   * Read a lineage's CURRENT definition file — the descriptor's `latestRunRef`
   * run file, otherwise the draft — and its exact recency.
   */
  private async readRecencyEntry(
    workspaceFolderPath: string,
    workflowKey: WorkflowKey,
    descriptor: WorkflowLineageDescriptor
  ): Promise<
    | { filePath: string; workingFile: WorkingFile; timestamp: number }
    | undefined
  > {
    const filePath = descriptor.latestRunRef
      ? WorkflowPaths.runFilePath(
          workspaceFolderPath,
          workflowKey,
          descriptor.latestRunRef
        )
      : WorkflowPaths.draftFilePath(workspaceFolderPath, workflowKey);
    try {
      const content = await fs.readFile(filePath, "utf8");
      const workingFile = stripLegacyWorkingFileLineageMetadata(
        JSON.parse(content) as WorkingFile
      );
      const timestamp = await getLineageLastModifiedAt(
        workspaceFolderPath,
        workflowKey,
        descriptor.lastModifiedAt
      );
      return { filePath, workingFile, timestamp };
    } catch (error) {
      Log.warn(
        `[WorkspaceSessionManager] Failed to read lineage ${workflowKey}:`,
        error
      );
      return undefined;
    }
  }

  /**
   * Discover all available sessions under run storage.
   * Returns session metadata for UI display.
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
      const workingFiles =
        await this.listWorkingFilesByRecency(workspaceFolderPath);

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
          const worktree = runtime?.worktree;
          if (worktree) {
            detail +=
              ` • Worktree: ${worktree.branchName} (${worktree.mode}, ` +
              `lifecycle ${worktree.lifecycleState}, directory ${worktree.directoryState}, ` +
              `branch ${worktree.branchState})`;
          }
          if (runtime?.worktreeNotice) {
            detail += ` • ${runtime.worktreeNotice}`;
          }

          sessions.push({
            label: `${statusIcon} ${await this.lineageRepository.readWorkflowDisplayName(
              workspaceFolderPath,
              WorkflowPaths.parseWorkingFileAddressFromPath(filePath)!
                .workflowKey
            )}`,
            description: `${completedCount}/${totalCount} completed`,
            detail,
            filePath,
          });
        } catch (error) {
          // Skip invalid files
          Log.warn(
            `[WorkspaceSessionManager] Failed to read session file ${path.basename(filePath)}:`,
            error
          );
        }
      }

      return sessions;
    } catch (error) {
      Log.error(
        "[WorkspaceSessionManager] Failed to discover sessions:",
        error
      );
      return [];
    }
  }
}
