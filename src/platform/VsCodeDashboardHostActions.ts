import * as vscode from "vscode";
import type {
  ActionResult,
  DashboardHostActions,
  WorkspaceOpenTarget,
} from "../core/HostPorts";
import { openResolvedTarget } from "../ui/ExternalFileTrustPrompt";
import { DASHBOARD_ACTION_RESULT_STATUSES } from "../types/DashboardConstants";

/** VS Code implementations of the dashboard's host-native actions. */
export class VsCodeDashboardHostActions implements DashboardHostActions {
  async openWorkspaceTarget(target: WorkspaceOpenTarget): Promise<ActionResult> {
    try {
      await openResolvedTarget(target);
      return { status: DASHBOARD_ACTION_RESULT_STATUSES.OPENED };
    } catch (error) {
      return {
        status: DASHBOARD_ACTION_RESULT_STATUSES.FAILED,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  focusDashboard(): void {
    void vscode.commands.executeCommand("ctrlyoke.dashboard.focus");
  }
}
