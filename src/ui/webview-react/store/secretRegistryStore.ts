import { create } from "zustand";
import {
  MESSAGE_TYPES,
  SETTING_SCOPES,
  type SettingWriteScope,
} from "@root/types/DashboardConstants";
import type {
  SecretRegistryEntry,
  SecretDeletedMessage,
  SecretSetMessage,
} from "@root/types/WebviewMessageTypes";
import { sendMessage } from "@hooks/useMessageHandler";

export type SecretRegistryAction = SecretSetMessage | SecretDeletedMessage;

export interface SecretRegistryState {
  entriesByScope: Record<SettingWriteScope, SecretRegistryEntry[]>;
  loadingByScope: Record<SettingWriteScope, boolean>;
  lastAction: SecretRegistryAction | null;

  setEntries: (
    scope: SettingWriteScope,
    entries: SecretRegistryEntry[]
  ) => void;
  setLastAction: (action: SecretRegistryAction) => void;
  requestEntries: (
    scope: SettingWriteScope,
    additionalKnownNames?: string[]
  ) => void;
  setSecret: (
    name: string,
    scope: SettingWriteScope,
    value: string,
    description?: string
  ) => void;
  deleteSecret: (name: string, scope: SettingWriteScope) => void;
  resetSecretRegistry: () => void;
}

const emptyEntries: Record<SettingWriteScope, SecretRegistryEntry[]> = {
  [SETTING_SCOPES.USER]: [],
  [SETTING_SCOPES.WORKSPACE]: [],
};

const initialLoading: Record<SettingWriteScope, boolean> = {
  [SETTING_SCOPES.USER]: false,
  [SETTING_SCOPES.WORKSPACE]: false,
};

export const useSecretRegistryStore = create<SecretRegistryState>((set) => ({
  entriesByScope: emptyEntries,
  loadingByScope: initialLoading,
  lastAction: null,

  setEntries: (scope, entries) =>
    set((state) => ({
      entriesByScope: { ...state.entriesByScope, [scope]: entries },
      loadingByScope: { ...state.loadingByScope, [scope]: false },
    })),

  setLastAction: (action) =>
    set((state) => ({
      lastAction: action,
      loadingByScope: {
        ...state.loadingByScope,
        [action.scope]: false,
      },
    })),

  requestEntries: (scope, additionalKnownNames) => {
    set((state) => ({
      loadingByScope: { ...state.loadingByScope, [scope]: true },
    }));
    sendMessage(MESSAGE_TYPES.REQUEST_SECRET_REGISTRY, {
      scope,
      ...(additionalKnownNames && additionalKnownNames.length > 0
        ? { additionalKnownNames }
        : {}),
    });
  },

  // The value is passed directly to the transport and is never stored in
  // Zustand. Components should clear their input immediately after calling.
  setSecret: (name, scope, value, description) => {
    set((state) => ({
      loadingByScope: { ...state.loadingByScope, [scope]: true },
    }));
    sendMessage(MESSAGE_TYPES.SET_SECRET, {
      name,
      scope,
      value,
      ...(description !== undefined ? { description } : {}),
    });
  },

  deleteSecret: (name, scope) => {
    set((state) => ({
      loadingByScope: { ...state.loadingByScope, [scope]: true },
    }));
    sendMessage(MESSAGE_TYPES.DELETE_SECRET, { name, scope });
  },

  resetSecretRegistry: () =>
    set({
      entriesByScope: {
        [SETTING_SCOPES.USER]: [],
        [SETTING_SCOPES.WORKSPACE]: [],
      },
      loadingByScope: {
        [SETTING_SCOPES.USER]: false,
        [SETTING_SCOPES.WORKSPACE]: false,
      },
      lastAction: null,
    }),
}));
