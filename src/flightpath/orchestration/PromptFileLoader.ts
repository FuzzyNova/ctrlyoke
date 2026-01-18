import * as vscode from "vscode";
import * as path from "path";
import { PromptFileParser } from "../PromptFileParser";
import { PromptQueue } from "../PromptQueue";
import { Log } from "../../utils/Log";
import {
  PromptFile,
  PromptItem,
  EXECUTION_STATES,
} from "../../types/FlightPathTypes";
import { FlightPathDashboardProvider } from "../../ui/FlightPathDashboardProvider";

/**
 * PromptFileLoader
 *
 * RESPONSIBILITY: Prompt File Loading & Validation
 *
 * Handles all prompt file I/O operations including:
 * - Loading and parsing prompt files
 * - Auto-saving dirty files before execution
 * - Reloading from working files (MCP/append scenarios)
 * - Validation and error handling
 */
export class PromptFileLoader {
  constructor(
    private promptFileParser: PromptFileParser,
    private promptQueue: PromptQueue,
    private dashboardProvider?: FlightPathDashboardProvider
  ) {}

  /**
   * Load a prompt file into the queue without executing
   * @param filePath Path to the prompt file
   * @param workspaceFolder Current workspace folder for working file creation
   * @returns Working file path if created, undefined otherwise
   */
  async loadPromptFile(
    filePath: string,
    workspaceFolder?: vscode.WorkspaceFolder
  ): Promise<string | undefined> {
    try {
      Log.info(`Loading prompt file: ${filePath}`);

      const fileName = path.basename(filePath);

      // Parse prompt file (parser handles all formats including .prompt.md)
      const promptFile = await this.promptFileParser.parsePromptFile(filePath);

      if (!promptFile || !promptFile.prompts) {
        vscode.window.showErrorMessage(
          "FlightPath: Failed to parse prompt file"
        );
        return undefined;
      }

      // Validate prompts
      const validation = this.promptFileParser.validatePromptItems(
        promptFile.prompts
      );
      if (!validation.valid) {
        const errors = validation.errors.join("\n");
        vscode.window.showErrorMessage(
          `FlightPath: Validation failed:\n${errors}`
        );
        return undefined;
      }

      // Create working file in .flightpath/.queue/ directory
      let workingFilePath: string | undefined;
      if (workspaceFolder) {
        try {
          workingFilePath = await this.promptQueue.createWorkingFile(
            filePath,
            promptFile.prompts,
            workspaceFolder
          );

          // Copy workflow-level properties from loaded file to working file
          // This ensures file properties take precedence over pending/global settings
          if (workingFilePath) {
            // Copy workflow-level properties (if defined in loaded file)
            const propertiesToCopy = [
              "provider",
              "model",
              "agent",
              "newChatSession",
              "allowDynamicExtension",
              "endCondition",
            ] as const;

            const updates: Record<string, unknown> = {};
            for (const key of propertiesToCopy) {
              if ((promptFile as any)[key] !== undefined) {
                updates[key] = (promptFile as any)[key];
              }
            }

            if (Object.keys(updates).length > 0) {
              const result = await this.promptQueue.updateWorkingFileProperties(
                updates
              );

              if (result?.appliedKeys.length) {
                for (const key of result.appliedKeys) {
                  Log.info(
                    `Copied workflow property '${key}' from loaded file to working file: ${JSON.stringify((promptFile as any)[key])}`
                  );
                }
                Log.info(
                  "Persisted workflow-level properties from loaded file to working file"
                );
              }
            }
          }
        } catch (error) {
          Log.error("Failed to create working file:", error);
          // Continue without working file (fallback to in-memory queue)
        }
      } else {
        Log.warn("No workspace folder, skipping working file creation");
      }

      // Load prompts into queue with working file path
      this.promptQueue.loadPrompts(promptFile, workingFilePath);

      // Notify dashboard about file selection
      if (this.dashboardProvider) {
        // Send full prompt objects with all properties
        this.dashboardProvider.updateFileSelected(fileName, promptFile.prompts);
      }

      Log.info(
        `Loaded ${promptFile.prompts.length} prompt(s) from ${fileName}`
      );

      return workingFilePath;
    } catch (error) {
      Log.error("Failed to load prompt file:", error);
      vscode.window.showErrorMessage(
        `FlightPath: Failed to load file: ${error}`
      );
      return undefined;
    }
  }

  /**
   * Save the file if it's open in an editor with unsaved changes, then trigger reload callback
   * This ensures we always execute the latest user edits
   *
   * @param filePath Path to the file to check and save
   * @param onReload Callback to trigger after save (e.g., reload prompt file)
   */
  async saveAndReloadIfDirty(
    filePath: string,
    onReload: () => Promise<void>
  ): Promise<void> {
    // Find if this file is open in any editor
    const openDocument = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.fsPath === filePath
    );

    if (openDocument && openDocument.isDirty) {
      Log.info(`Auto-saving dirty file before execution: ${filePath}`);
      try {
        await openDocument.save();
        // Reload the prompt file to pick up saved changes
        await onReload();
      } catch (error) {
        Log.error("Failed to auto-save file:", error);
        // Continue anyway - user may have unsaved changes but we'll use disk version
        vscode.window.showWarningMessage(
          "FlightPath: Could not auto-save file. Running with last saved version."
        );
      }
    }
  }

  /**
   * Reload queue from working file
   * Handles three scenarios:
   * - 'replace': Loading a different session (resume/auto-load) → Clear queue and restore state
   * - 'merge': Same file changed (MCP/append) → Merge new prompts into existing queue
   * - 'auto': Detect based on queue state (IDLE = restore, otherwise = merge)
   *
   * @param workingFilePath Path to working file
   * @param mode Reload mode: 'replace' | 'merge' | 'auto' (default: 'auto')
   */
  async reloadFromWorkingFile(
    workingFilePath: string,
    mode: "replace" | "merge" | "auto" = "auto"
  ): Promise<void> {
    try {
      // Read working file
      const workingFile =
        await this.promptQueue.readWorkingFile(workingFilePath);

      // Check if prompts exist
      if (!workingFile.prompts || workingFile.prompts.length === 0) {
        Log.error("Working file has no prompts");
        return;
      }

      // Validate prompts
      const validation = this.promptFileParser.validatePromptItems(
        workingFile.prompts
      );
      if (!validation.valid) {
        const errorMessage = validation.errors.join(",");
        Log.error("Working file validation failed:", errorMessage);
        throw new Error(`Working file validation failed: ${errorMessage}`);
      }

      const queueState = this.promptQueue.getState();
      const isIdle = queueState.status === EXECUTION_STATES.IDLE;

      // Determine actual mode based on parameter and queue state
      let actualMode = mode;
      if (mode === "auto") {
        actualMode = isIdle ? "replace" : "merge";
      }

      if (actualMode === "replace") {
        // Scenario 1: Loading a different session (resume/auto-load)
        // Clear queue and restore full state including completed prompts, currentIndex, etc.
        Log.info(
          `Restoring session from working file (${workingFile.prompts.length} prompts, mode: ${mode})`
        );
        await this.promptQueue.restoreFromWorkingFile(workingFilePath);

        if (this.dashboardProvider) {
          const fileName = path.basename(workingFile.originalFile);
          // Get the restored state to send accurate prompt info with runtime state
          const restoredState = this.promptQueue.getState();
          this.dashboardProvider.updateSessionRestored(
            fileName,
            restoredState.prompts,
            restoredState.results,
            restoredState.status,
            restoredState.currentIndex,
            restoredState.workflowName || undefined
          );
        }
      } else {
        // Scenario 2: Queue extended during execution (MCP/append to same file)
        // Merge new prompts preserving state and send PROMPTS_EXTENDED
        Log.info(
          `Merging prompts from working file (state: ${queueState.status}, mode: ${mode})`
        );
        const newPromptsCount = await this.promptQueue.mergePromptsFromDisk();

        if (newPromptsCount > 0 && this.dashboardProvider) {
          // Get updated state after merge
          const updatedState = this.promptQueue.getState();
          Log.info(
            `Queue extended by ${newPromptsCount} prompts (total: ${updatedState.prompts.length}). Sending PROMPTS_EXTENDED to dashboard.`
          );

          // Send PROMPTS_EXTENDED message with updated prompt list
          this.dashboardProvider.updatePromptsExtended(updatedState.prompts);
        } else if (newPromptsCount === 0) {
          Log.info("Working file changed but no new prompts detected");
        }
      }

      Log.info(
        `Reloaded ${workingFile.prompts.length} prompts from working file`
      );
    } catch (error) {
      Log.error("Failed to reload working file:", error);
      // Re-throw so caller knows the operation failed
      throw error;
    }
  }
}
