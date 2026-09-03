/**
 * Stable client view-address comparison.
 *
 * A `WorkflowViewAddress` is the client's editing/viewing target, and several
 * unrelated layers need to ask "is this message about the address I am looking
 * at?" — the recent-workflows list, route application, and the message handler
 * that decides whether an in-flight run-view switch owns the address. Keeping
 * one implementation here prevents those copies from drifting apart.
 */
import type { WorkflowViewAddress } from "@root/types/CtrlYokeTypes";
import { WORKFLOW_VIEW_ADDRESS_KIND } from "@root/types/DashboardConstants";

export function areWorkflowAddressesEqual(
  left: WorkflowViewAddress | null | undefined,
  right: WorkflowViewAddress | null | undefined
): boolean {
  return (
    !!left &&
    !!right &&
    left.workflowKey === right.workflowKey &&
    left.kind === right.kind &&
    (left.kind !== WORKFLOW_VIEW_ADDRESS_KIND.RUN ||
      right.kind !== WORKFLOW_VIEW_ADDRESS_KIND.RUN ||
      left.runRef === right.runRef)
  );
}

/** Return the stable record key for a client's addressed workflow view. */
export function workflowViewAddressKey(address: WorkflowViewAddress): string {
  return address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN
    ? `${address.workflowKey}:run:${address.runRef}`
    : `${address.workflowKey}:draft`;
}
