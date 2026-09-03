import { create } from "zustand";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import type { ShowChoiceRequestMessage } from "@root/types/WebviewMessageTypes";
import { sendMessage } from "@hooks/useMessageHandler";

export type PendingChoiceRequest = ShowChoiceRequestMessage["request"];

interface ChoiceState {
  pendingRequest: PendingChoiceRequest | null;
  setPendingRequest: (request: PendingChoiceRequest) => void;
  respond: (value: string) => void;
  dismiss: () => void;
}

export const useChoiceStore = create<ChoiceState>((set, get) => ({
  pendingRequest: null,

  setPendingRequest: (request) => set({ pendingRequest: request }),

  respond: (value) => {
    const request = get().pendingRequest;
    if (!request) return;
    sendMessage(MESSAGE_TYPES.CHOICE_RESPONSE, {
      id: request.id,
      value,
    });
    set({ pendingRequest: null });
  },

  dismiss: () => {
    const request = get().pendingRequest;
    if (!request) return;
    sendMessage(MESSAGE_TYPES.CHOICE_RESPONSE, {
      id: request.id,
      value: null,
    });
    set({ pendingRequest: null });
  },
}));
