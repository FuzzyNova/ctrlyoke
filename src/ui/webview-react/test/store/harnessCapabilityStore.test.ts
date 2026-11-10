import { beforeEach, describe, expect, it } from "vitest";
import { useHarnessCapabilityStore } from "@store/harnessCapabilityStore";
import type { HarnessCapabilityRegistrySnapshot } from "@root/types/CompatibilityTypes";
import { CAPABILITY_DOMAINS } from "@root/types/DashboardConstants";

describe("harnessCapabilityStore", () => {
  beforeEach(() => {
    useHarnessCapabilityStore.getState().resetCapabilitySnapshot();
  });

  it("starts in a neutral checking state", () => {
    const state = useHarnessCapabilityStore.getState();

    expect(state.capabilitySnapshot).toBeNull();
    expect(state.capabilitySnapshotStatus).toBe("checking");
  });

  it("caches a snapshot and marks the probe ready", () => {
    const snapshot: HarnessCapabilityRegistrySnapshot = {
      schemaVersion: 1,
      enabledDomains: [CAPABILITY_DOMAINS.PERMISSIONS],
      harnesses: {} as HarnessCapabilityRegistrySnapshot["harnesses"],
    };

    useHarnessCapabilityStore.getState().setCapabilitySnapshot(snapshot);

    expect(useHarnessCapabilityStore.getState()).toMatchObject({
      capabilitySnapshot: snapshot,
      capabilitySnapshotStatus: "ready",
    });
  });
});
