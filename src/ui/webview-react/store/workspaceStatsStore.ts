import { create } from "zustand";
import type { WorkspaceStatsSnapshot } from "@root/types/UsageTypes";

interface WorkspaceStatsState {
  snapshot: WorkspaceStatsSnapshot | undefined;
  setSnapshot: (snapshot: WorkspaceStatsSnapshot | undefined) => void;
}

export const useWorkspaceStatsStore = create<WorkspaceStatsState>((set) => ({
  snapshot: undefined,
  setSnapshot: (snapshot) => set({ snapshot }),
}));
