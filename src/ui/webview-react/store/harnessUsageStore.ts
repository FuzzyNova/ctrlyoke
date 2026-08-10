import { create } from "zustand";
import type { HarnessUsageSnapshot } from "@root/types/UsageTypes";
import type { HarnessId } from "@root/types/DashboardConstants";

interface HarnessUsageState {
  snapshotsByHarness: Partial<Record<HarnessId, HarnessUsageSnapshot>>;
  setSnapshots: (snapshots: HarnessUsageSnapshot[]) => void;
}

export const useHarnessUsageStore = create<HarnessUsageState>((set) => ({
  snapshotsByHarness: {},
  setSnapshots: (snapshots) =>
    set({
      snapshotsByHarness: Object.fromEntries(
        snapshots.map((snapshot) => [snapshot.harnessId, snapshot])
      ),
    }),
}));
