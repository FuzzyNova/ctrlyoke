import { create } from "zustand";
import { MESSAGE_TYPES } from "../types/messages";
import type {
  ExecutionPreviewResultMessage,
  ExecutionPreviewEditorSnapshot,
  ExecutionPreviewScope,
} from "@root/types/WebviewMessageTypes";
import type { WorkflowViewAddress } from "@root/types/CtrlYokeTypes";
import type { WorkflowExecutionPreview } from "@root/types/ExecutionPreviewTypes";
import { sendMessage } from "../hooks/useMessageHandler";
import {
  PREVIEW_SCOPES,
  PREVIEW_STATUSES,
} from "@root/types/DashboardConstants";
import { workflowViewAddressKey } from "@utils/viewAddress";

export type ExecutionPreviewStatus =
  (typeof PREVIEW_STATUSES)[keyof typeof PREVIEW_STATUSES];

interface ExecutionPreviewState {
  preview: WorkflowExecutionPreview | null;
  status: ExecutionPreviewStatus;
  scope: ExecutionPreviewScope | null;
  requestToken: number | null;
  displayedDefinitionRevision: number | null;
  displayedAddress: WorkflowViewAddress | null;
  /** Monotonic definition heads observed from requestless dashboard pushes. */
  definitionRevisionHeads: Record<string, number>;
  /** True when the displayed snapshot no longer matches its definition head. */
  isStale: boolean;
}

interface ExecutionPreviewActions {
  open: (
    scope: ExecutionPreviewScope,
    editorSnapshot?: ExecutionPreviewEditorSnapshot
  ) => number;
  resolve: (message: ExecutionPreviewResultMessage) => void;
  observeDefinitionRevision: (
    address: WorkflowViewAddress,
    definitionRevision: number,
    authoritative?: boolean
  ) => void;
  close: () => void;
  reset: () => void;
}

let requestSequence = 0;

function sameScope(
  left: ExecutionPreviewScope,
  right: ExecutionPreviewScope
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind !== PREVIEW_SCOPES.STEP ||
      (right.kind === PREVIEW_SCOPES.STEP &&
        left.stepIndex === right.stepIndex))
  );
}

const initialState: ExecutionPreviewState = {
  preview: null,
  status: PREVIEW_STATUSES.CHECKING,
  scope: null,
  requestToken: null,
  displayedDefinitionRevision: null,
  displayedAddress: null,
  definitionRevisionHeads: {},
  isStale: false,
};

export const useExecutionPreviewStore = create<
  ExecutionPreviewState & ExecutionPreviewActions
>((set, get) => ({
  ...initialState,

  open: (scope, editorSnapshot) => {
    requestSequence += 1;
    const requestToken = requestSequence;
    set({
      preview: null,
      status: PREVIEW_STATUSES.CHECKING,
      scope,
      requestToken,
      displayedDefinitionRevision: null,
      displayedAddress: null,
      isStale: false,
    });
    sendMessage(MESSAGE_TYPES.REQUEST_EXECUTION_PREVIEW, {
      scope,
      ...(editorSnapshot ? { editorSnapshot } : {}),
      requestToken,
    });
    return requestToken;
  },

  resolve: (message) => {
    const state = get();
    if (
      state.status !== PREVIEW_STATUSES.CHECKING ||
      state.requestToken !== message.requestToken ||
      !state.scope ||
      !sameScope(state.scope, message.scope)
    ) {
      return;
    }
    const key = workflowViewAddressKey(message.address);
    // A push that overtook this response may already have moved the head
    // past the previewed revision. Only authoritative view pushes lower it
    // (a discarded continuation restores an older revision).
    const currentHead = Math.max(
      state.definitionRevisionHeads[key] ?? message.displayedDefinitionRevision,
      message.displayedDefinitionRevision
    );
    set({
      preview: message.preview,
      status: PREVIEW_STATUSES.READY,
      displayedDefinitionRevision: message.displayedDefinitionRevision,
      displayedAddress: message.address,
      definitionRevisionHeads: {
        ...state.definitionRevisionHeads,
        [key]: currentHead,
      },
      isStale: currentHead !== message.displayedDefinitionRevision,
    });
  },

  observeDefinitionRevision: (
    address,
    definitionRevision,
    authoritative = false
  ) =>
    set((state) => {
      const key = workflowViewAddressKey(address);
      const head = authoritative
        ? definitionRevision
        : Math.max(
            state.definitionRevisionHeads[key] ?? definitionRevision,
            definitionRevision
          );
      const isPlanAddress =
        state.displayedAddress !== null &&
        workflowViewAddressKey(state.displayedAddress) === key;
      return {
        definitionRevisionHeads: {
          ...state.definitionRevisionHeads,
          [key]: head,
        },
        ...(isPlanAddress && state.displayedDefinitionRevision !== null
          ? { isStale: head !== state.displayedDefinitionRevision }
          : {}),
      };
    }),

  close: () => {
    requestSequence += 1;
    set({
      preview: null,
      status: PREVIEW_STATUSES.CHECKING,
      scope: null,
      requestToken: null,
      displayedDefinitionRevision: null,
      displayedAddress: null,
      isStale: false,
    });
  },

  reset: () => {
    requestSequence += 1;
    set({ ...initialState, definitionRevisionHeads: {} });
  },
}));

export type { ExecutionPreviewState, ExecutionPreviewActions };
