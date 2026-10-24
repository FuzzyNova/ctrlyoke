import type { WorkflowViewAddress } from "../types/CtrlYokeTypes";
import { WORKFLOW_VIEW_ADDRESS_KIND } from "../types/DashboardConstants";

/**
 * True when both addresses name the same draft or the same run. Shared by the
 * extension host and the webview, so it stays free of Node and VS Code.
 */
export function sameViewAddress(
  a: WorkflowViewAddress | null | undefined,
  b: WorkflowViewAddress | null | undefined
): boolean {
  if (!a || !b) return false;
  if (a.workflowKey !== b.workflowKey || a.kind !== b.kind) return false;
  return (
    a.kind !== WORKFLOW_VIEW_ADDRESS_KIND.RUN ||
    (b.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN && a.runRef === b.runRef)
  );
}
