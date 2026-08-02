import { describe, expect, it } from "vitest";
import { workflowPermissionDiagnostic } from "@utils/compatibilityDiagnostics";
import { HARNESS_IDS } from "@root/types/DashboardConstants";
import type { CompatibilityExecutionTarget } from "@root/types/CompatibilityAnalyzer";
import type { HarnessCapabilityRegistrySnapshot } from "@root/types/CompatibilityTypes";

function target(
  mode: string,
  allowedTools: string[],
  deniedTools: string[]
): CompatibilityExecutionTarget {
  return {
    consumer: { kind: "queue", stepIndex: 0 },
    resolved: {
      properties: {
        harness: HARNESS_IDS.CODEX_CLI,
        model: "",
        executionMode: "headless",
        resumeSession: false,
        mcpServers: null,
        hooks: null,
        toolPermissions: {
          mode: mode as never,
          allowedTools,
          deniedTools,
        },
      },
      sources: {},
    },
  };
}

const unsupportedSnapshot: HarnessCapabilityRegistrySnapshot = {
  schemaVersion: 1,
  enabledDomains: ["permissions"],
  harnesses: {
    [HARNESS_IDS.CODEX_CLI]: {
      available: true,
      version: "1.0.0",
      descriptor: { harnessId: HARNESS_IDS.CODEX_CLI },
      effective: {
        permissions: {
          mode: { fidelity: "exact", mechanism: "native", verification: "verified" },
          allowedTools: { fidelity: "unsupported", mechanism: "none", verification: "verified" },
          deniedTools: { fidelity: "unsupported", mechanism: "none", verification: "verified" },
        },
      },
    },
  } as HarnessCapabilityRegistrySnapshot["harnesses"],
};

describe("workflowPermissionDiagnostic", () => {
  it("ignores leftover lists on a target whose resolved mode is dangerouslyAllowAll", () => {
    const targets = [target("dangerouslyAllowAll", ["shell(git:*)"], ["shell(rm:*)"])];
    expect(
      workflowPermissionDiagnostic("allowedTools", targets, unsupportedSnapshot)
    ).toBeUndefined();
    expect(
      workflowPermissionDiagnostic("deniedTools", targets, unsupportedSnapshot)
    ).toBeUndefined();
  });

  it("still reports ignored lists for a custom-mode target on an unsupported harness", () => {
    const targets = [target("custom", ["shell(git:*)"], [])];
    expect(
      workflowPermissionDiagnostic("allowedTools", targets, unsupportedSnapshot)
    ).toBeDefined();
  });
});
