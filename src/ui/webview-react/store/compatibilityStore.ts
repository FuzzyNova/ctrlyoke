import { create } from "zustand";
import type { HarnessCapabilityRegistrySnapshot } from "@root/types/CompatibilityTypes";

export type CapabilitySnapshotStatus = "checking" | "ready";

interface CompatibilityState {
  capabilitySnapshot: HarnessCapabilityRegistrySnapshot | null;
  capabilitySnapshotStatus: CapabilitySnapshotStatus;
}

interface CompatibilityActions {
  setCapabilitySnapshot: (
    snapshot: HarnessCapabilityRegistrySnapshot
  ) => void;
  resetCapabilitySnapshot: () => void;
}

const initialState: CompatibilityState = {
  capabilitySnapshot: null,
  capabilitySnapshotStatus: "checking",
};

/** Client cache for backend-owned capability facts. */
export const useCompatibilityStore = create<
  CompatibilityState & CompatibilityActions
>((set) => ({
  ...initialState,

  setCapabilitySnapshot: (capabilitySnapshot) =>
    set({ capabilitySnapshot, capabilitySnapshotStatus: "ready" }),

  resetCapabilitySnapshot: () => set(initialState),
}));

export type { CompatibilityState, CompatibilityActions };
