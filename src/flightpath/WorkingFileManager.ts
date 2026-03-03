import * as fs from "fs/promises";
import * as path from "path";
import type { PromptItem, WorkingFile } from "../types/FlightPathTypes";
import { Harness } from "../types/FlightPathTypes";
import { EXECUTION_STATES } from "../types/DashboardConstants";
import type { ExecutionState } from "../types/DashboardConstants";
import { Log } from "../utils/Log";
import {
  ConfigurationUtils,
  PATH_CONSTANTS,
} from "../utils/ConfigurationUtils";
import { withFileLock } from "../utils/FileLockUtils";

/**
 * Interface providing queue state access for working file persistence operations.
 * Implemented as an adapter by PromptQueue to decouple file I/O from queue state management.
 */
export interface IWorkingFileQueueAccess {
  /** The current working file path, if any */
  getWorkingFilePath(): string | undefined;

  /** Current prompts in the queue */
  getPrompts(): PromptItem[];

  /** Current execution index */
  getCurrentIndex(): number;

  /** Current execution status */
  getStatus(): ExecutionState;

  /** Current workflow name */
  getWorkflowName(): string | undefined;

  /** Merge disk prompts into memory, returning newly added prompts */
  mergeDiskPrompts(diskPrompts: PromptItem[]): PromptItem[];

  /** Emit state change notification to listeners */
  emitStateChange(): void;

  /** Update a workflow property in cached workflow file */
  updateWorkflowProperty(key: string, value: unknown): void;
}

/**
 * Manages working file (.flightpath/.queue/*.flightpath.json) persistence.
 *
 * Extracted from PromptQueue to separate file I/O concerns from queue state management.
 * All serialized operations go through an internal operation queue to prevent races.
 *
 * The class accesses queue state through the IWorkingFileQueueAccess interface,
 * allowing PromptQueue to remain the single owner of queue state while this class
 * handles only persistence.
 */
export class WorkingFileManager {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly queueAccess: IWorkingFileQueueAccess) {}

  // ==================== Pure File Operations ====================

  /**
   * Generate working file path in .flightpath/.queue/ directory
   */
  private async generateWorkingFilePath(
    originalFilePath: string,
    workspaceFolderPath: string
  ): Promise<string> {
    const fileName = path.basename(
      originalFilePath,
      path.extname(originalFilePath)
    );
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .substring(0, 19);
    const queueDir = path.join(
      workspaceFolderPath,
      PATH_CONSTANTS.FLIGHTPATH_DIR,
      PATH_CONSTANTS.QUEUE_DIR
    );

    // Ensure directory exists
    await fs.mkdir(queueDir, { recursive: true });

    // Sanitize filename to avoid spaces/special chars in generated working file path
    const sanitizedFileName =
      (fileName || "workflow")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "workflow";
    return path.join(
      queueDir,
      `${sanitizedFileName}-${timestamp}.flightpath.json`
    );
  }

  /**
   * Read working file from disk
   * @param workingFilePath Path to working file
   * @returns Parsed working file
   */
  public async readWorkingFile(workingFilePath: string): Promise<WorkingFile> {
    try {
      const content = await fs.readFile(workingFilePath, "utf-8");
      const parsed = JSON.parse(content) as WorkingFile;
      return parsed;
    } catch (error) {
      throw new Error(
        `Failed to read working file: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Write working file atomically (temp + rename)
   * @param workingFilePath Path to working file
   * @param workingFile Working file data
   */
  private async writeWorkingFileAtomic(
    workingFilePath: string,
    workingFile: WorkingFile,
    options: { skipLock?: boolean } = {}
  ): Promise<void> {
    const tempPath = `${workingFilePath}.tmp`;

    const writeAction = async () => {
      try {
        // Write to temp file
        await fs.writeFile(tempPath, JSON.stringify(workingFile, null, 2));

        // Atomic rename
        await fs.rename(tempPath, workingFilePath);
      } catch (error) {
        // Clean up temp file on error
        try {
          await fs.unlink(tempPath);
        } catch {}

        throw new Error(
          `Failed to write working file: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    };

    if (options.skipLock) {
      await writeAction();
      return;
    }

    await withFileLock(workingFilePath, writeAction);
  }

  // ==================== Higher-Level Operations ====================

  /**
   * Create working file from original prompt file
   * @param nameForFile Display name or file path used to generate the working file's filename
   * @param prompts Prompts to store in working file
   * @param workspaceFolder Current workspace folder
   * @param workflowName Computed workflow name for the working file
   * @param originalFilePath The true source file path (if any). Only set for file-based workflows;
   *   leave undefined for ephemeral/dashboard-created workflows so the save dialog defaults correctly.
   * @returns Path to created working file
   */
  public async createWorkingFile(
    nameForFile: string,
    prompts: PromptItem[],
    workspaceFolderPath: string,
    workflowName: string,
    originalFilePath?: string
  ): Promise<string> {
    const workingFilePath = await this.generateWorkingFilePath(
      nameForFile,
      workspaceFolderPath
    );

    const workingFile: WorkingFile = {
      ...(originalFilePath ? { originalFile: originalFilePath } : {}),
      workflowName,
      startedAt: Date.now(),
      lastModifiedAt: Date.now(),
      prompts: prompts,
      _runtime: {
        currentIndex: 0,
        executionState: EXECUTION_STATES.IDLE,
      },
    };

    // Write atomically (temp + rename)
    await this.writeWorkingFileAtomic(workingFilePath, workingFile);

    Log.info(` Created working file: ${workingFilePath}`);
    return workingFilePath;
  }

  /**
   * Update working file with current queue state (serialized through operation queue).
   * This is called after prompt completion, append, or any queue modification.
   * @param skipMerge If true, writes memory state directly without checking for MCP changes (used for deletes/updates)
   */
  public async updateWorkingFile(skipMerge: boolean = false): Promise<void> {
    if (!this.queueAccess.getWorkingFilePath()) {
      return; // No working file to update
    }

    // Serialize operation to prevent race conditions
    this.operationQueue = this.operationQueue
      .then(async () => {
        await this.updateWorkingFileDirect(skipMerge);
      })
      .catch((err) => {
        Log.error(
          `operationQueue: updateWorkingFile failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });

    await this.operationQueue;
  }

  /**
   * Direct working file update (no operation queue serialization).
   * Use this when already executing within the operation queue context (e.g., from runInQueue).
   * @param skipMerge If true, writes memory state directly without checking for MCP changes
   */
  public async updateWorkingFileDirect(
    skipMerge: boolean = false
  ): Promise<void> {
    const workingFilePath = this.queueAccess.getWorkingFilePath();
    if (!workingFilePath) {
      return; // No working file to update
    }

    try {
      await withFileLock(workingFilePath, async () => {
        // Read current working file from disk
        const workingFile = await this.readWorkingFile(workingFilePath);

        // CRITICAL FIX: Merge prompts from disk instead of blindly overwriting
        // This preserves MCP-appended prompts that may have been added while we were running
        // BUT: Skip merge for intentional writes (delete/update) to avoid undoing changes
        if (!skipMerge) {
          const diskPrompts = workingFile.prompts || [];

          const newPromptsFromDisk =
            this.queueAccess.mergeDiskPrompts(diskPrompts);

          // If disk has new prompts, log and emit state change
          if (newPromptsFromDisk.length > 0) {
            Log.info(
              `updateWorkingFile - Detected ${newPromptsFromDisk.length} prompts added externally (likely via MCP), merging into queue`
            );

            // Emit state change so dashboard updates
            this.queueAccess.emitStateChange();
          }
        } // End skipMerge check

        // Now write back the prompts array (merged or direct from memory)
        // CRITICAL: Preserve _runtime metadata during save (Phase 4: Per-Prompt Session Management)
        workingFile.prompts = this.queueAccess.getPrompts().map((prompt) => ({
          ...prompt,
        }));
        // Count prompts with _runtime metadata (Phase 4: Session Management)
        const promptsWithRuntime = workingFile.prompts.filter(
          (p) => p._runtime
        ).length;
        Log.info(
          `updateWorkingFile - Writing ${workingFile.prompts.length} prompts to ${workingFilePath}, ` +
            `_runtime: ${promptsWithRuntime}/${workingFile.prompts.length} prompts`
        );

        // Update workflow name if set in state
        const workflowName = this.queueAccess.getWorkflowName();
        if (workflowName) {
          workingFile.workflowName = workflowName;
        }

        // Update last modified timestamp
        workingFile.lastModifiedAt = Date.now();

        // Update workflow-level runtime state
        // completedPrompts is no longer written; per-prompt _runtime.completedAt is the source of truth
        workingFile._runtime = {
          currentIndex: this.queueAccess.getCurrentIndex(),
          executionState: this.queueAccess.getStatus(),
        };

        // Write atomically while holding lock
        await this.writeWorkingFileAtomic(workingFilePath, workingFile, {
          skipLock: true,
        });
      });
      Log.info(`updateWorkingFile - Successfully wrote working file`);
    } catch (error) {
      Log.error(
        `FlightPath: Failed to update working file: ${error instanceof Error ? error.message : String(error)}`
      );
      // Don't throw - this is a background operation
    }
  }

  /**
   * Update workflow-level properties in the working file (atomic + serialized).
   */
  public async updateWorkingFileProperties(
    properties: Record<string, unknown>,
    options: {
      onlyIfUndefined?: boolean;
      ensureHarnessAndModel?: boolean;
      allowDeletes?: boolean;
    } = {}
  ): Promise<{ workingFile: WorkingFile; appliedKeys: string[] } | null> {
    const workingFilePath = this.queueAccess.getWorkingFilePath();
    if (!workingFilePath) {
      return null;
    }

    let result: { workingFile: WorkingFile; appliedKeys: string[] } | null =
      null;

    this.operationQueue = this.operationQueue
      .then(async () => {
        const appliedKeys: string[] = [];

        await withFileLock(workingFilePath, async () => {
          const workingFile = await this.readWorkingFile(workingFilePath);

          let modified = false;
          for (const [key, value] of Object.entries(properties)) {
            if (value === undefined) {
              if (
                options.allowDeletes &&
                (workingFile as any)[key] !== undefined
              ) {
                delete (workingFile as any)[key];
                modified = true;
                appliedKeys.push(key);
              }
              continue;
            }

            if (
              options.onlyIfUndefined &&
              (workingFile as any)[key] !== undefined
            ) {
              continue;
            }

            if ((workingFile as any)[key] !== value) {
              (workingFile as any)[key] = value;
              modified = true;
              appliedKeys.push(key);
            }
          }

          if (options.ensureHarnessAndModel) {
            if (!workingFile.harness) {
              workingFile.harness = ConfigurationUtils.getIntegrationMode();
              modified = true;
              appliedKeys.push("harness");
            }

            if (!workingFile.model) {
              workingFile.model = this.getDefaultModelForHarness(
                workingFile.harness
              );
              modified = true;
              appliedKeys.push("model");
            }
          }

          if (modified) {
            workingFile.lastModifiedAt = Date.now();
            await this.writeWorkingFileAtomic(workingFilePath, workingFile, {
              skipLock: true,
            });
          }

          for (const key of appliedKeys) {
            this.queueAccess.updateWorkflowProperty(
              key,
              (workingFile as any)[key]
            );
          }

          result = { workingFile, appliedKeys };
        });
      })
      .catch((err) => {
        Log.error(
          `operationQueue: updateWorkingFileProperties failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });

    await this.operationQueue;
    return result;
  }

  /**
   * Run an async function serialized in the operation queue.
   * Used by PromptQueue for compound operations that need both state mutations
   * and file I/O to be atomic (e.g., appendPrompts).
   */
  public async runInQueue(fn: () => Promise<void>): Promise<void> {
    this.operationQueue = this.operationQueue.then(fn).catch((err) => {
      Log.error(
        `operationQueue: serialized operation failed: ${err instanceof Error ? err.message : String(err)}`
      );
    });

    await this.operationQueue;
  }

  // ==================== Private Helpers ====================

  /**
   * Get default model for a given harness from settings
   */
  private getDefaultModelForHarness(harness: Harness): string {
    switch (harness) {
      case Harness.CopilotCli:
        return ConfigurationUtils.getCliModel();
      case Harness.CopilotChat:
        return ConfigurationUtils.getCopilotChatModel();
      case Harness.ClaudeCli:
        return ConfigurationUtils.getClaudeCliModel();
      case Harness.CodexCli:
        return ConfigurationUtils.getCodexCliModel();
      default:
        return ConfigurationUtils.getCliModel();
    }
  }
}
