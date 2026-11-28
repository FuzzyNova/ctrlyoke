import { useUiStore } from "../store/uiStore";
import type { WorkflowDefinitionMutation } from "@root/types/WebviewMessageTypes";
import {
  APPEND_MODES,
  QUEUE_POSITION,
  USER_FEEDBACK_SEVERITY,
  WORKFLOW_VIEW_ADDRESS_KIND,
  type QueuePosition,
} from "@root/types/DashboardConstants";
import { MESSAGE_TYPES } from "@/types/messages";
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

/**
 * The keys a workflow-property patch is asking to delete.
 *
 * `undefined` is how a patch says "remove this property", and `JSON.stringify`
 * drops exactly those members on the way to the extension — so the intent has
 * to travel as an explicit key list beside the patch (see
 * `utils/WorkflowPropertyPatch.ts`, which re-materializes it on arrival).
 * Passing an undo snapshot here yields the keys the restored state did not
 * have, because a snapshot is the full normalized property set.
 */
export function clearedWorkflowPropertyKeys(
  properties: Record<string, unknown>
): string[] {
  return Object.entries(properties)
    .filter(([, value]) => value === undefined)
    .map(([key]) => key);
}

/**
 * Attach the shared mutation context for controls that post directly to VS
 * Code, read from the displayed view at the moment of posting.
 */
export function postWorkflowDefinitionMutation(
  target: MessageTarget,
  message: Record<string, unknown>
): void {
  postWithMutation(target, message, getWorkflowDefinitionMutation());
}

/**
 * Post `message` with exactly `mutation`, never re-reading the displayed view:
 * an explicit `undefined` (captured while nothing was displayed) posts none.
 * A default parameter would not do: JavaScript applies it to an explicit
 * `undefined` too.
 */
function postWithMutation(
  target: MessageTarget,
  message: Record<string, unknown>,
  mutation: WorkflowDefinitionMutation | undefined
): void {
  target.postMessage({ ...message, ...(mutation ? { mutation } : {}) });
}

/**
 * Post a "set start position" mutation. Unlike `postRunLifecycleMutation`,
 * this accepts either a `draft` or `run` displayed address — a draft that has
 * never executed can seed its first run starting at a chosen step, not just a
 * promoted run's rewind. Only warns when nothing is displayed at all.
 */
export function postSetStartPositionMutation(
  target: MessageTarget,
  message: Record<string, unknown>
): boolean {
  const mutation = getWorkflowDefinitionMutation();
  if (!mutation) {
    notifyUser(
      "Open a workflow before changing its start position",
      USER_FEEDBACK_SEVERITY.WARNING
    );
    return false;
  }
  target.postMessage({ ...message, ...mutation });
  return true;
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

export interface AppendFileOptions {
  filePath?: string;
  /**
   * The mutation context captured when the user chose the action; omit to use
   * the displayed view's at post time. An explicit `undefined` (nothing was
   * displayed then) posts none rather than reading the view again.
   */
  mutation?: WorkflowDefinitionMutation;
}

export interface SubWorkflowAppendOptions extends AppendFileOptions {
  position?: QueuePosition;
}

/** The mutation `options` captured, else the displayed view's now. */
function appendMutation(
  options: AppendFileOptions
): WorkflowDefinitionMutation | undefined {
  return "mutation" in options
    ? options.mutation
    : getWorkflowDefinitionMutation();
}

/**
 * Queue a workflow file's steps onto the displayed workflow (`APPEND_FILE`).
 * Without a `filePath` the extension opens its native file picker; hosted
 * callers pick through `WorkflowFilePickerModal` first and pass the path.
 */
export function postAppendFile(
  target: MessageTarget,
  options: AppendFileOptions = {}
): void {
  postWithMutation(
    target,
    {
      type: MESSAGE_TYPES.APPEND_FILE,
      ...(options.filePath ? { filePath: options.filePath } : {}),
    },
    appendMutation(options)
  );
}

/**
 * Queue a workflow file as one sub-workflow step on the displayed workflow
 * (`APPEND_FILE` with `appendMode: subWorkflow`). Without a `filePath` the
 * extension opens its native file picker; hosted callers pick through
 * `WorkflowFilePickerModal` first and pass the path.
 */
export function postSubWorkflowAppend(
  target: MessageTarget,
  options: SubWorkflowAppendOptions = {}
): void {
  postWithMutation(
    target,
    {
      type: MESSAGE_TYPES.APPEND_FILE,
      ...(options.filePath ? { filePath: options.filePath } : {}),
      appendMode: APPEND_MODES.SUB_WORKFLOW,
      position: options.position ?? QUEUE_POSITION.END,
    },
    appendMutation(options)
  );
}
