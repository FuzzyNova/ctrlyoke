import { beforeEach, describe, expect, it } from "vitest";
import { SETTING_SCOPES } from "@root/types/DashboardConstants";
import { useSecretRegistryStore } from "@store/secretRegistryStore";

beforeEach(() => {
  useSecretRegistryStore.getState().resetSecretRegistry();
});

describe("secret registry store", () => {
  it("keeps registry entries separated by scope", () => {
    const entry = {
      name: "API_TOKEN",
      scope: SETTING_SCOPES.WORKSPACE,
      state: "from-environment-and-detected" as const,
      usedBy: { mcpServers: [], workflows: ["deploy.ctrlyoke.yaml"] },
    };

    useSecretRegistryStore
      .getState()
      .setEntries(SETTING_SCOPES.WORKSPACE, [entry]);

    expect(
      useSecretRegistryStore.getState().entriesByScope[SETTING_SCOPES.WORKSPACE]
    ).toEqual([entry]);
    expect(
      useSecretRegistryStore.getState().entriesByScope[SETTING_SCOPES.USER]
    ).toEqual([]);
    expect(
      useSecretRegistryStore.getState().loadingByScope[SETTING_SCOPES.WORKSPACE]
    ).toBe(false);
  });

  it("stores only the safe write confirmation", () => {
    const action = {
      type: "secretSet" as const,
      name: "API_TOKEN",
      scope: SETTING_SCOPES.USER,
      state: "set" as const,
    };

    useSecretRegistryStore.getState().setLastAction(action);
    expect(useSecretRegistryStore.getState().lastAction).toEqual(action);
    expect(JSON.stringify(useSecretRegistryStore.getState())).not.toContain(
      "secret-value"
    );
  });
});
