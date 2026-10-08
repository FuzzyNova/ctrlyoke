import type {
  ActionResult,
  ContentPreview,
  DashboardHostActions,
  WorkspaceOpenTarget,
} from "../core/HostPorts";
import { DASHBOARD_ACTION_RESULT_STATUSES } from "../types/DashboardConstants";

/** Browser-native actions are already handled by the workspace viewer. */
export class NodeDashboardHostActions implements DashboardHostActions {
  async openWorkspaceTarget(
    _target: WorkspaceOpenTarget
  ): Promise<ActionResult> {
    return { status: DASHBOARD_ACTION_RESULT_STATUSES.OPENED };
  }

  async openContentPreview(_content: ContentPreview): Promise<ActionResult> {
    return { status: DASHBOARD_ACTION_RESULT_STATUSES.OPENED };
  }
}
