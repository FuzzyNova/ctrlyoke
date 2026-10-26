/**
 * Optimistic "pause requested" feedback for run controls.
 *
 * Pause is honoured by the engine within milliseconds, but the dashboard only
 * learns about it when the extension's `pausing` state update is applied — and
 * every inbound message runs through one serialized queue, so on a busy
 * dashboard that update can trail the click by minutes. Without feedback the
 * Pause button looks ignored and gets clicked again.
 *
 * This store records a pause request per run address at click time so every
 * Pause surface can render the run as PAUSING immediately. It never edits the
 * authoritative state: a request is dropped as soon as anything the dashboard
 * knows about that run's execution state changes (whatever it changed to),
 * when the user cancels the pause, when the viewed workflow changes, or after
 * `PAUSE_REQUEST_FEEDBACK_TIMEOUT_MS` so a lost request cannot pin the button.
 */
import { create } from "zustand";
import type { WorkflowViewAddress } from "@root/types/CtrlYokeTypes";
import { MESSAGE_TYPES } from "../types/messages";
import { sendMessage } from "../hooks/useMessageHandler";
import {
  areWorkflowAddressesEqual,
  workflowViewAddressKey,
  type RunViewAddress,
} from "@utils/viewAddress";
import { PAUSE_REQUEST_FEEDBACK_TIMEOUT_MS } from "../constants";
import { useUiStore } from "./uiStore";
import { useWorkflowStore } from "./workflowStore";

interface PendingPauseRequest {
  address: RunViewAddress;
  /** The run's observed execution state(s) at click time; see `observeRunState`. */
  observedState: string;
}

interface PauseRequestState {
  pending: Record<string, PendingPauseRequest>;
}

interface PauseRequestActions {
  /**
   * Send PAUSE_RUN for `address` and show it as pausing until the
   * authoritative state catches up. A repeat request for a run that is
   * already pending is a no-op, so it never sends a second PAUSE_RUN.
   * Returns whether a message was sent.
   */
  requestPause: (address: RunViewAddress) => boolean;
  /** Send CANCEL_PAUSE_RUN for `address` and drop any pending request for it. */
  cancelPause: (address: RunViewAddress) => void;
  clearPauseRequest: (address: RunViewAddress) => void;
  reset: () => void;
}

const timeouts = new Map<string, ReturnType<typeof setTimeout>>();
let unsubscribers: Array<() => void> = [];

/**
 * Everything the dashboard knows about a run's execution state: the live
 * `loadedWorkflows` mirror and, when that run is the one on screen, the viewed
 * state. Any change to either means an authoritative update has landed.
 */
function observeRunState(address: RunViewAddress): string {
  const ui = useUiStore.getState();
  const live =
    ui.loadedWorkflows.find(
      (workflow) =>
        workflow.workflowKey === address.workflowKey &&
        workflow.runRef === address.runRef
    )?.executionState ?? "";
  const viewed = areWorkflowAddressesEqual(ui.displayedViewAddress, address)
    ? useWorkflowStore.getState().executionState
    : "";
  return `${live}|${viewed}`;
}

function dropKeys(keys: readonly string[]): void {
  if (keys.length === 0) return;
  for (const key of keys) {
    const timer = timeouts.get(key);
    if (timer !== undefined) clearTimeout(timer);
    timeouts.delete(key);
  }
  usePauseRequestStore.setState((state) => {
    const pending = { ...state.pending };
    for (const key of keys) delete pending[key];
    return { pending };
  });
  if (Object.keys(usePauseRequestStore.getState().pending).length === 0) {
    stopObserving();
  }
}

function reconcile(): void {
  const { pending } = usePauseRequestStore.getState();
  dropKeys(
    Object.entries(pending)
      .filter(
        ([, request]) =>
          observeRunState(request.address) !== request.observedState
      )
      .map(([key]) => key)
  );
}

function startObserving(): void {
  if (unsubscribers.length > 0) return;
  unsubscribers = [
    useUiStore.subscribe((state, previous) => {
      const viewedKey = (address: WorkflowViewAddress | null) =>
        address ? workflowViewAddressKey(address) : null;
      if (
        viewedKey(state.displayedViewAddress) !==
        viewedKey(previous.displayedViewAddress)
      ) {
        // The viewed workflow changed: a stale optimistic state must not
        // follow the user to (or back from) another view.
        dropKeys(Object.keys(usePauseRequestStore.getState().pending));
        return;
      }
      if (state.loadedWorkflows !== previous.loadedWorkflows) reconcile();
    }),
    useWorkflowStore.subscribe((state, previous) => {
      if (state.executionState !== previous.executionState) reconcile();
    }),
  ];
}

function stopObserving(): void {
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];
}

export const usePauseRequestStore = create<
  PauseRequestState & PauseRequestActions
>()((set, get) => ({
  pending: {},

  requestPause: (address) => {
    const key = workflowViewAddressKey(address);
    if (get().pending[key]) return false;
    sendMessage(MESSAGE_TYPES.PAUSE_RUN, { address });
    set((state) => ({
      pending: {
        ...state.pending,
        [key]: { address, observedState: observeRunState(address) },
      },
    }));
    startObserving();
    timeouts.set(
      key,
      setTimeout(() => {
        timeouts.delete(key);
        dropKeys([key]);
      }, PAUSE_REQUEST_FEEDBACK_TIMEOUT_MS)
    );
    return true;
  },

  cancelPause: (address) => {
    dropKeys([workflowViewAddressKey(address)]);
    sendMessage(MESSAGE_TYPES.CANCEL_PAUSE_RUN, { address });
  },

  clearPauseRequest: (address) => {
    const key = workflowViewAddressKey(address);
    if (get().pending[key]) dropKeys([key]);
  },

  reset: () => {
    dropKeys(Object.keys(get().pending));
    stopObserving();
  },
}));

/** Whether a pause was requested for `address` and has not been answered yet. */
export function useIsPauseRequested(
  address: RunViewAddress | null | undefined
): boolean {
  const key = address ? workflowViewAddressKey(address) : null;
  return usePauseRequestStore((state) =>
    key === null ? false : key in state.pending
  );
}
