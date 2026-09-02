import { create } from "zustand";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import type { ShowBatchApprovalRequestMessage } from "@root/types/WebviewMessageTypes";
import { sendMessage } from "@hooks/useMessageHandler";

export type PendingBatchApprovalRequest =
  ShowBatchApprovalRequestMessage["request"];

export interface BatchApprovalState {
  pendingRequest: PendingBatchApprovalRequest | null;
  setPendingRequest: (request: PendingBatchApprovalRequest) => void;
  /** Send the user's decision and clear the pending request. */
  respond: (approvedValues: string[], deniedValues: string[]) => void;
  /** Dismiss without a decision — the extension will ask again later. */
  dismiss: () => void;
}

export const useBatchApprovalStore = create<BatchApprovalState>((set, get) => ({
  pendingRequest: null,

  setPendingRequest: (request) => set({ pendingRequest: request }),

  respond: (approvedValues, deniedValues) => {
    const request = get().pendingRequest;
    if (!request) return;
    sendMessage(MESSAGE_TYPES.BATCH_APPROVAL_RESPONSE, {
      id: request.id,
      result: { approvedValues, deniedValues },
    });
    set({ pendingRequest: null });
  },

  dismiss: () => {
    const request = get().pendingRequest;
    if (!request) return;
    sendMessage(MESSAGE_TYPES.BATCH_APPROVAL_RESPONSE, {
      id: request.id,
      result: null,
    });
    set({ pendingRequest: null });
  },
}));
