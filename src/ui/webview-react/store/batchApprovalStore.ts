import { create } from "zustand";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import type { ShowBatchApprovalRequestMessage } from "@root/types/WebviewMessageTypes";
import { sendMessage } from "@hooks/useMessageHandler";
import { dequeueRequest, enqueueRequest } from "./requestQueue";

export type PendingBatchApprovalRequest =
  ShowBatchApprovalRequestMessage["request"];

export interface BatchApprovalState {
  requests: PendingBatchApprovalRequest[];
  setPendingRequest: (request: PendingBatchApprovalRequest) => void;
  /** Send the user's decision and clear the pending request. */
  respond: (approvedValues: string[], deniedValues: string[]) => void;
  /** Dismiss without a decision — the extension will ask again later. */
  dismiss: () => void;
}

export const useBatchApprovalStore = create<BatchApprovalState>((set, get) => ({
  requests: [],

  setPendingRequest: (request) =>
    set((state) => ({ requests: enqueueRequest(state.requests, request) })),

  respond: (approvedValues, deniedValues) => {
    const request = get().requests[0];
    if (!request) return;
    sendMessage(MESSAGE_TYPES.BATCH_APPROVAL_RESPONSE, {
      id: request.id,
      result: { approvedValues, deniedValues },
    });
    set((state) => ({ requests: dequeueRequest(state.requests) }));
  },

  dismiss: () => {
    const request = get().requests[0];
    if (!request) return;
    sendMessage(MESSAGE_TYPES.BATCH_APPROVAL_RESPONSE, {
      id: request.id,
      result: null,
    });
    set((state) => ({ requests: dequeueRequest(state.requests) }));
  },
}));
