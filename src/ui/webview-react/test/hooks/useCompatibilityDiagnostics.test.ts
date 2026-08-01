import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useCompatibilityDiagnostics } from "@hooks/useCompatibilityDiagnostics";
import { useCompatibilityStore } from "@store/compatibilityStore";
import { useSettingsStore } from "@store/settingsStore";
import { useWorkflowStore } from "@store/workflowStore";
import {
  CAPABILITY_DOMAINS,
  HARNESS_IDS,
  PERMISSION_MODES,
} from "@root/types/DashboardConstants";
import { analyzeCompatibility, enumerateCompatibilityTargets } from "@root/types/CompatibilityAnalyzer";
import { resolveExecutionProperties } from "@root/types/ExecutionPropertyResolver";
import type { HarnessCapabilityRegistrySnapshot } from "@root/types/CompatibilityTypes";
import type { PromptFile } from "@root/types/CtrlYokeTypes";

function makeSnapshot(): HarnessCapabilityRegistrySnapshot {
  const harnesses = {} as HarnessCapabilityRegistrySnapshot["harnesses"];
  for (const harnessId of Object.values(HARNESS_IDS)) {
    const declaration = {
      fidelity: "exact" as const,
      mechanism: "native" as const,
    };
    const state = {
      fidelity: "exact" as const,
      mechanism: "native" as const,
      verification: "verified" as const,
    };
    harnesses[harnessId] = {
      available: true,
      descriptor: {
        harnessId,
        permissions: {
          mode: declaration,
          allowedTools: declaration,
          deniedTools: declaration,
        },
      },
      effective: {
        permissions: {
          mode: state,
          allowedTools: state,
          deniedTools: state,
        },
      },
    };
  }

  const codex = harnesses[HARNESS_IDS.CODEX_CLI];
  const unsupported = {
    fidelity: "unsupported" as const,
    mechanism: "none" as const,
    verification: "verified" as const,
  };
  codex.effective!.permissions.allowedTools = unsupported;
  codex.effective!.permissions.deniedTools = unsupported;

  return {
    schemaVersion: 1,
    enabledDomains: [CAPABILITY_DOMAINS.PERMISSIONS],
    harnesses,
  };
}

function resetStores(): void {
  useCompatibilityStore.getState().resetCapabilitySnapshot();
  useSettingsStore.getState().resetSettings();
  useWorkflowStore.setState({
    steps: [],
    finalStep: null,
  });
}

describe("useCompatibilityDiagnostics", () => {
  beforeEach(resetStores);

  it("emits no speculative diagnostics while the capability snapshot is pending", () => {
    useWorkflowStore.setState({
      steps: [
        {
          prompt: "Use tools",
          toolPermissions: {
            mode: PERMISSION_MODES.CUSTOM,
            allowedTools: ["shell(git:*)"],
            deniedTools: ["shell(rm:*)"],
          },
        },
      ],
    });

    const { result } = renderHook(() => useCompatibilityDiagnostics());

    expect(result.current.isChecking).toBe(true);
    expect(result.current.diagnostics).toEqual([]);
  });

  it("recalculates immediately when the effective harness changes", () => {
    useSettingsStore.getState().setGlobalSettings({
      ...useSettingsStore.getState().globalSettings,
      harness: HARNESS_IDS.CLAUDE_CLI,
    });
    useWorkflowStore.setState({
      steps: [
        {
          prompt: "Use tools",
          toolPermissions: {
            mode: PERMISSION_MODES.CUSTOM,
            allowedTools: ["shell(git:*)"],
            deniedTools: ["shell(rm:*)"],
          },
        },
      ],
    });
    useCompatibilityStore.getState().setCapabilitySnapshot(makeSnapshot());

    const { result } = renderHook(() => useCompatibilityDiagnostics());
    expect(result.current.diagnostics).toEqual([]);

    act(() => {
      useWorkflowStore.getState().updatePrompt(0, {
        harness: HARNESS_IDS.CODEX_CLI,
      });
    });

    expect(result.current.diagnostics.map((item) => item.code)).toEqual([
      "compatibility.permissions.allowedTools.notEnforced",
      "compatibility.permissions.deniedTools.notEnforced",
    ]);
  });

  it("matches the backend resolver/analyzer for the same inputs", () => {
    const snapshot = makeSnapshot();
    const settings = useSettingsStore.getState();
    settings.setGlobalSettings({
      ...settings.globalSettings,
      harness: HARNESS_IDS.CODEX_CLI,
    });
    useSettingsStore.getState().setWorkflowProperties({
      toolPermissions: {
        mode: PERMISSION_MODES.CUSTOM,
        allowedTools: ["shell(git:*)"],
        deniedTools: ["shell(rm:*)"],
      },
    });
    useWorkflowStore.setState({
      steps: [{ prompt: "Use tools", harness: HARNESS_IDS.CODEX_CLI }],
    });
    useCompatibilityStore.getState().setCapabilitySnapshot(snapshot);

    const { result } = renderHook(() => useCompatibilityDiagnostics());
    const workflow: PromptFile = {
      harness: HARNESS_IDS.CODEX_CLI,
      toolPermissions: {
        mode: PERMISSION_MODES.CUSTOM,
        allowedTools: ["shell(git:*)"],
        deniedTools: ["shell(rm:*)"],
      },
      steps: [{ prompt: "Use tools", harness: HARNESS_IDS.CODEX_CLI }],
    };
    const defaults = {
      harness: HARNESS_IDS.CODEX_CLI,
      modelsByHarness: {},
      additionalArgsByHarness: {},
      executionMode: settings.globalSettings.executionMode,
      resumeSession: false,
    };
    const context = { defaults, hostCanProvidePty: true };
    const backendDiagnostics = analyzeCompatibility({
      workflow,
      executionTargets: enumerateCompatibilityTargets(workflow, (prompt, file) =>
        resolveExecutionProperties(prompt, file, context)
      ),
      capabilities: snapshot,
    });

    expect(result.current.diagnostics.map(projectDiagnostic)).toEqual(
      backendDiagnostics.map(projectDiagnostic)
    );
  });
});

function projectDiagnostic(diagnostic: {
  code: string;
  harnessId: string;
  capability: string;
  consumer?: unknown;
  propertyPointer?: string;
  sourceTier?: string;
}): unknown {
  return {
    code: diagnostic.code,
    harnessId: diagnostic.harnessId,
    capability: diagnostic.capability,
    consumer: diagnostic.consumer,
    propertyPointer: diagnostic.propertyPointer,
    sourceTier: diagnostic.sourceTier,
  };
}
