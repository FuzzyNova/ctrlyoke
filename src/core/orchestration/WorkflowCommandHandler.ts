import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import {
  DASHBOARD_ACTION_RESULT_STATUSES,
  USER_FEEDBACK_SEVERITY,
} from "../../types/DashboardConstants";
import { Log } from "../../utils/Log";
import { getErrorMessage } from "../../utils/ErrorUtils";
import { notifyUserFeedback, type UserFeedbackSink } from "../UserFeedbackSink";
import type { DashboardHostActions } from "../HostPorts";

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
    private readonly hostActions: DashboardHostActions,
    private readonly userFeedbackSink?: UserFeedbackSink
  ) {}

  /**
   * Open ctrlyoke panel/dashboard
   */
  async openPanel(): Promise<void> {
    // Focus the ctrlyoke dashboard panel
    try {
      this.hostActions.focusDashboard?.();
    } catch (error) {
      Log.error(
        "[WorkflowCommandHandler] Failed to focus ctrlyoke dashboard:",
        error
      );
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
      Log.info(
        `[WorkflowCommandHandler] ctrlyoke: Opened prompt file: ${currentFilePath}`
      );
    } catch (error) {
      Log.error(
        "[WorkflowCommandHandler] ctrlyoke: Failed to open prompt file:",
        error
      );
      notifyUserFeedback(
        this.userFeedbackSink,
        USER_FEEDBACK_SEVERITY.ERROR,
        `ctrlyoke: Failed to open file: ${getErrorMessage(error)}`
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
    const result = await this.hostActions.openWorkspaceTarget({
      path: filePath,
      openAsText: true,
      ...(ConfigurationUtils.shouldOpenPromptsInSecondGroup()
        ? { viewColumn: 2 }
        : {}),
    });
    if (result.status === DASHBOARD_ACTION_RESULT_STATUSES.FAILED)
      throw new Error(result.message);
    if (result.status === DASHBOARD_ACTION_RESULT_STATUSES.UNSUPPORTED)
      throw new Error(
        result.message ?? "Opening files is not supported by this host."
      );
  }
}
