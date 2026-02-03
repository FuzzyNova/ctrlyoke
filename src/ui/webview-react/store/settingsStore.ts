import { create } from "zustand";

interface SettingsState {
  modelOptions: Record<string, string[]>;
  availableAgents: Array<{ name: string; path: string }>;
  providerStatus: Record<string, "available" | "checking" | "unavailable">;

  setModelOptions: (options: Record<string, string[]>) => void;
  setAvailableAgents: (agents: Array<{ name: string; path: string }>) => void;
  setProviderStatus: (provider: string, status: string) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  modelOptions: {},
  availableAgents: [],
  providerStatus: {},

  setModelOptions: (options) => set({ modelOptions: options }),
  setAvailableAgents: (agents) => set({ availableAgents: agents }),
  setProviderStatus: (provider, status) =>
    set((state) => ({
      providerStatus: {
        ...state.providerStatus,
        [provider]: status as any,
      },
    })),
}));
