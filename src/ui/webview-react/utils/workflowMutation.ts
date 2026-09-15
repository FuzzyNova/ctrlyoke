import { useUiStore } from "../store/uiStore";
import type { WorkflowDefinitionMutation } from "@root/types/WebviewMessageTypes";
import {
  USER_FEEDBACK_SEVERITY,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "@root/types/DashboardConstants";
import { notifyUser } from "@utils/notifyUser";

interface MessageTarget {
  postMessage: (message: unknown) => void;
}

/** Stable address and optimistic revisions for generic definition mutations. */
export function getWorkflowDefinitionMutation():
  WorkflowDefinitionMutation | undefined {
  const state = useUiStore.getState();
  if (
    !state.displayedViewAddress ||
    state.displayedDefinitionRevision === null ||
    state.displayedDescriptorRevision === null
  ) {
    return undefined;
  }
  return {
    address: state.displayedViewAddress,
    expectedDefinitionRevision: state.displayedDefinitionRevision,
    expectedDescriptorRevision: state.displayedDescriptorRevision,
  };
}

/** Attach the shared mutation context for controls that post directly to VS Code. */
export function postWorkflowDefinitionMutation(
  target: MessageTarget,
  message: Record<string, unknown>
): void {
  const mutation = getWorkflowDefinitionMutation();
  target.postMessage({ ...message, ...(mutation ? { mutation } : {}) });
}

/** Post an explicitly addressed promoted-run lifecycle mutation. */
export function postRunLifecycleMutation(
  target: MessageTarget,
  message: Record<string, unknown>
): boolean {
  const state = useUiStore.getState();
  const address = state.displayedViewAddress;
  if (
    address?.kind !== WORKFLOW_VIEW_ADDRESS_KIND.RUN ||
    state.displayedDefinitionRevision === null ||
    state.displayedDescriptorRevision === null
  ) {
    notifyUser(
      "Select a saved run before changing its start position",
      USER_FEEDBACK_SEVERITY.WARNING
    );
    return false;
  }
  target.postMessage({
    ...message,
    address,
    expectedDefinitionRevision: state.displayedDefinitionRevision,
    expectedDescriptorRevision: state.displayedDescriptorRevision,
  });
  return true;
}
