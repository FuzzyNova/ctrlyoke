import * as vscode from "vscode";
import {
  ConfigurationUtils,
} from "../../utils/ConfigurationUtils";
import {
  HARNESS_STATUS_STRINGS,
  USER_FEEDBACK_SEVERITY,
} from "../../types/DashboardConstants";
import { Log } from "../../utils/Log";
import { notifyUserFeedback, type UserFeedbackSink } from "../UserFeedbackSink";

/**
 * WorkflowCommandHandler
 *
 * RESPONSIBILITY: Command Routing & UI Interactions
 *
 * Handles all user-facing commands including:
 * - Opening files and panels
 * - Opening current prompt file
 */
export class WorkflowCommandHandler {
  constructor(
    private readonly userFeedbackSink?: UserFeedbackSink
  ) {
  }

  /**
   * Open ctrlyoke panel/dashboard
   * Shows warning and retry if harness is unavailable
   *
   * @param getHarnessStatus Callback to get current harness status
   * @param onRetry Callback to retry harness detection
   */
  async openPanel(
    getHarnessStatus: () => { initializationStatus: string },
    onRetry: () => Promise<void>
  ): Promise<void> {
    // Check if harness is unavailable and offer retry
    const harnessStatus = getHarnessStatus();

    if (
      harnessStatus.initializationStatus === HARNESS_STATUS_STRINGS.UNAVAILABLE
    ) {
      const action = await vscode.window.showWarningMessage(
        "ctrlyoke: HarnessId automation is unavailable. Would you like to retry detection?",
        "Retry Detection",
        "Continue Anyway"
      );

      if (action === "Retry Detection") {
        await onRetry();
        return;
      }
    }

    // Focus the ctrlyoke dashboard panel
    try {
      await vscode.commands.executeCommand("ctrlyoke.dashboard.focus");
    } catch (error) {
      Log.error("Failed to focus ctrlyoke dashboard:", error);
      throw error; // Let caller handle fallback
    }
  }

  /**
   * Open the currently loaded prompt file in the editor
   *
   * @param currentFilePath Current prompt file path or undefined
   */
  async openCurrentPromptFile(currentFilePath?: string): Promise<void> {
    if (!currentFilePath) {
      notifyUserFeedback(
        this.userFeedbackSink,
        USER_FEEDBACK_SEVERITY.WARNING,
        "ctrlyoke: No prompt file loaded. Use 'Select' button to choose a file first."
      );
      return;
    }

    try {
      await this.openPromptFile(currentFilePath);
      Log.info(`ctrlyoke: Opened prompt file: ${currentFilePath}`);
    } catch (error) {
      Log.error("ctrlyoke: Failed to open prompt file:", error);
      notifyUserFeedback(
        this.userFeedbackSink,
        USER_FEEDBACK_SEVERITY.ERROR,
        `ctrlyoke: Failed to open file: ${error}`
      );
    }
  }

  /**
   * Open a prompt file in the editor
   * Respects openPromptsInSecondGroup setting
   *
   * @param filePath Path to the prompt file to open
   */
  private async openPromptFile(filePath: string): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(filePath);

      if (ConfigurationUtils.shouldOpenPromptsInSecondGroup()) {
        // Open in second editor group (right side) to keep main code visible
        await vscode.window.showTextDocument(document, {
          viewColumn: vscode.ViewColumn.Two,
          preview: false,
          preserveFocus: false,
        });
      } else {
        // Open in active editor (default VS Code behavior)
        await vscode.window.showTextDocument(document);
      }
    } catch (error) {
      Log.error("ctrlyoke: Failed to open prompt file:", error);
    }
  }

}
