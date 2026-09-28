import { create } from "zustand";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import type { ShowChoiceRequestMessage } from "@root/types/WebviewMessageTypes";
import { sendMessage } from "@hooks/useMessageHandler";
import { dequeueRequest, enqueueRequest } from "./requestQueue";

export type PendingChoiceRequest = ShowChoiceRequestMessage["request"];

interface ChoiceState {
  requests: PendingChoiceRequest[];
  setPendingRequest: (request: PendingChoiceRequest) => void;
  respond: (value: string) => void;
  dismiss: () => void;
}

export const useChoiceStore = create<ChoiceState>((set, get) => ({
  requests: [],

  setPendingRequest: (request) =>
    set((state) => ({ requests: enqueueRequest(state.requests, request) })),

  respond: (value) => {
    const request = get().requests[0];
    if (!request) return;
    sendMessage(MESSAGE_TYPES.CHOICE_RESPONSE, {
      id: request.id,
      value,
    });
    set((state) => ({ requests: dequeueRequest(state.requests) }));
  },

  dismiss: () => {
    const request = get().requests[0];
    if (!request) return;
    sendMessage(MESSAGE_TYPES.CHOICE_RESPONSE, {
      id: request.id,
      value: null,
    });
    set((state) => ({ requests: dequeueRequest(state.requests) }));
  },
}));
