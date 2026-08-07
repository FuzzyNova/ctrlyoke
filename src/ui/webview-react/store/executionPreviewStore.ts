import { create } from "zustand";
import { MESSAGE_TYPES } from "../types/messages";
import type {
  ExecutionPreviewResultMessage,
  ExecutionPreviewScope,
} from "@root/types/WebviewMessageTypes";
import type { WorkflowViewAddress } from "@root/types/CtrlYokeTypes";
import type { WorkflowExecutionPreview } from "@root/types/ExecutionPreviewTypes";
import { sendMessage } from "../hooks/useMessageHandler";

export type ExecutionPreviewStatus = "checking" | "ready";

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
  open: (scope: ExecutionPreviewScope) => number;
  resolve: (message: ExecutionPreviewResultMessage) => void;
  observeDefinitionRevision: (
    address: WorkflowViewAddress,
    definitionRevision: number
  ) => void;
  close: () => void;
  reset: () => void;
}

let requestSequence = 0;

function addressKey(address: WorkflowViewAddress): string {
  return address.kind === "run"
    ? `${address.workflowKey}:run:${address.runRef}`
    : `${address.workflowKey}:draft`;
}

function sameScope(
  left: ExecutionPreviewScope,
  right: ExecutionPreviewScope
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind !== "step" ||
      (right.kind === "step" && left.stepIndex === right.stepIndex))
  );
}

const initialState: ExecutionPreviewState = {
  preview: null,
  status: "checking",
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

  open: (scope) => {
    requestSequence += 1;
    const requestToken = requestSequence;
    set({
      preview: null,
      status: "checking",
      scope,
      requestToken,
      displayedDefinitionRevision: null,
      displayedAddress: null,
      isStale: false,
    });
    sendMessage(MESSAGE_TYPES.REQUEST_EXECUTION_PREVIEW, {
      scope,
      requestToken,
    });
    return requestToken;
  },

  resolve: (message) => {
    const state = get();
    if (
      state.status !== "checking" ||
      state.requestToken !== message.requestToken ||
      !state.scope ||
      !sameScope(state.scope, message.scope)
    ) {
      return;
    }
    const key = addressKey(message.address);
    const currentHead = Math.max(
      state.definitionRevisionHeads[key] ?? message.displayedDefinitionRevision,
      message.displayedDefinitionRevision
    );
    set({
      preview: message.preview,
      status: "ready",
      displayedDefinitionRevision: message.displayedDefinitionRevision,
      displayedAddress: message.address,
      definitionRevisionHeads: {
        ...state.definitionRevisionHeads,
        [key]: currentHead,
      },
      isStale: currentHead !== message.displayedDefinitionRevision,
    });
  },

  observeDefinitionRevision: (address, definitionRevision) =>
    set((state) => {
      const key = addressKey(address);
      const head = Math.max(
        state.definitionRevisionHeads[key] ?? definitionRevision,
        definitionRevision
      );
      const isPlanAddress =
        state.displayedAddress !== null &&
        addressKey(state.displayedAddress) === key;
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
      status: "checking",
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
