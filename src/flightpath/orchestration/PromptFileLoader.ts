import * as vscode from "vscode";
import * as path from "path";
import { PromptFileParser } from "../PromptFileParser";
import { PromptQueue } from "../PromptQueue";
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
      console.log(`FlightPath: Loading prompt file: ${filePath}`);

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
        } catch (error) {
          console.error("FlightPath: Failed to create working file:", error);
          // Continue without working file (fallback to in-memory queue)
        }
      } else {
        console.warn(
          "FlightPath: No workspace folder, skipping working file creation"
        );
      }

      // Load prompts into queue with working file path
      this.promptQueue.loadPrompts(promptFile.prompts, workingFilePath);

      // Notify dashboard about file selection
      if (this.dashboardProvider) {
        this.dashboardProvider.updateFileSelected(
          fileName,
          promptFile.prompts.map((p) => ({ prompt: p.prompt }))
        );
      }

      console.log(
        `FlightPath: Loaded ${promptFile.prompts.length} prompt(s) from ${fileName}`
      );

      return workingFilePath;
    } catch (error) {
      console.error("FlightPath: Failed to load prompt file:", error);
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
      console.log(
        `FlightPath: Auto-saving dirty file before execution: ${filePath}`
      );
      try {
        await openDocument.save();
        // Reload the prompt file to pick up saved changes
        await onReload();
      } catch (error) {
        console.error("FlightPath: Failed to auto-save file:", error);
        // Continue anyway - user may have unsaved changes but we'll use disk version
        vscode.window.showWarningMessage(
          "FlightPath: Could not auto-save file. Running with last saved version."
        );
      }
    }
  }

  /**
   * Reload queue from working file (used by Dynamic Queue and file watcher)
   * Handles two scenarios:
   * - IDLE: User selecting new file → Reset everything, send FILE_SELECTED
   * - EXECUTING: MCP/append during execution → Merge prompts, send QUEUE_EXTENDED
   *
   * @param workingFilePath Path to working file
   */
  async reloadFromWorkingFile(workingFilePath: string): Promise<void> {
    try {
      // Read working file
      const workingFile =
        await this.promptQueue.readWorkingFile(workingFilePath);

      // Check if prompts exist
      if (!workingFile.prompts || workingFile.prompts.length === 0) {
        console.error("FlightPath: Working file has no prompts");
        return;
      }

      // Validate prompts
      const validation = this.promptFileParser.validatePromptItems(
        workingFile.prompts
      );
      if (!validation.valid) {
        console.error(
          "FlightPath: Working file validation failed:",
          validation.errors
        );
        return;
      }

      const queueState = this.promptQueue.getState();
      const isIdle = queueState.status === EXECUTION_STATES.IDLE;

      if (isIdle) {
        // Scenario 1: User selecting new file (IDLE state)
        // Reset everything and send FILE_SELECTED
        console.log(
          `FlightPath: Loading new file in IDLE state (${workingFile.prompts.length} prompts)`
        );
        this.promptQueue.loadPrompts(workingFile.prompts, workingFilePath);

        if (this.dashboardProvider) {
          const fileName = path.basename(workingFile.originalFile);
          this.dashboardProvider.updateFileSelected(
            fileName,
            workingFile.prompts.map((p) => ({ prompt: p.prompt }))
          );
        }
      } else {
        // Scenario 2: Queue extended during execution (RUNNING/PAUSED/CANCELLING)
        // Merge new prompts preserving state and send QUEUE_EXTENDED
        console.log(
          `FlightPath: Merging prompts during execution (state: ${queueState.status})`
        );
        const newPromptsCount = await this.promptQueue.mergePromptsFromDisk();

        if (newPromptsCount > 0 && this.dashboardProvider) {
          // Get updated state after merge
          const updatedState = this.promptQueue.getState();
          console.log(
            `FlightPath: Queue extended by ${newPromptsCount} prompts (total: ${updatedState.prompts.length}). Sending PROMPTS_EXTENDED to dashboard.`
          );

          // Send PROMPTS_EXTENDED message with updated prompt list
          this.dashboardProvider.updatePromptsExtended(updatedState.prompts);
        } else if (newPromptsCount === 0) {
          console.log(
            "FlightPath: Working file changed but no new prompts detected"
          );
        }
      }

      console.log(
        `FlightPath: Reloaded ${workingFile.prompts.length} prompts from working file`
      );
    } catch (error) {
      console.error("FlightPath: Failed to reload working file:", error);
    }
  }
}
