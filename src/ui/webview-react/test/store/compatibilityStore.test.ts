import { beforeEach, describe, expect, it } from "vitest";
import { useCompatibilityStore } from "@store/compatibilityStore";
import type { HarnessCapabilityRegistrySnapshot } from "@root/types/CompatibilityTypes";
import { CAPABILITY_DOMAINS } from "@root/types/DashboardConstants";

describe("compatibilityStore", () => {
  beforeEach(() => {
    useCompatibilityStore.getState().resetCapabilitySnapshot();
  });

  it("starts in a neutral checking state", () => {
    const state = useCompatibilityStore.getState();

    expect(state.capabilitySnapshot).toBeNull();
    expect(state.capabilitySnapshotStatus).toBe("checking");
  });

  it("caches a snapshot and marks the probe ready", () => {
    const snapshot: HarnessCapabilityRegistrySnapshot = {
      schemaVersion: 1,
      enabledDomains: [CAPABILITY_DOMAINS.PERMISSIONS],
      harnesses: {} as HarnessCapabilityRegistrySnapshot["harnesses"],
    };

    useCompatibilityStore.getState().setCapabilitySnapshot(snapshot);

    expect(useCompatibilityStore.getState()).toMatchObject({
      capabilitySnapshot: snapshot,
      capabilitySnapshotStatus: "ready",
    });
  });
});
