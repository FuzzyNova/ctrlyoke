import { useMemo } from "react";
import { isStandalone } from "@hooks/useVsCodeApi";
import { useCompatibilityStore } from "@store/compatibilityStore";
import { useSettingsStore, type WorkflowProperties } from "@store/settingsStore";
import { useWorkflowStore, type WorkflowStep } from "@store/workflowStore";
import {
  STEP_TYPES,
  type HarnessId,
} from "@root/types/DashboardConstants";
import {
  analyzeCompatibility,
  enumerateCompatibilityTargets,
} from "@root/types/CompatibilityAnalyzer";
import { resolveExecutionProperties } from "@root/types/ExecutionPropertyResolver";
import type {
  PromptFile,
  PromptStep as CorePromptStep,
  ScriptStep as CoreScriptStep,
  WorkflowStep as CoreWorkflowStep,
} from "@root/types/CtrlYokeTypes";
import type { CompatibilityDiagnostic } from "@root/types/CompatibilityTypes";

export interface UseCompatibilityDiagnosticsResult {
  diagnostics: CompatibilityDiagnostic[];
  isChecking: boolean;
  snapshotStatus: "checking" | "ready";
}

function toCorePromptStep(step: Exclude<WorkflowStep, CoreScriptStep>): CorePromptStep {
  return {
    type: step.type,
    name: step.name,
    enabled: step.enabled,
    prompt: step.prompt,
    harness: step.harness as HarnessId | undefined,
    model: step.model,
    executionMode: step.executionMode,
    agent: step.agent,
    skills: step.skills,
    resumeSession: step.resumeSession,
    sessionId: step.sessionId,
    mcpServers: step.mcpServers as CorePromptStep["mcpServers"],
    hooks: step.hooks,
    endCondition: step.endCondition as CorePromptStep["endCondition"],
    preCondition: step.preCondition,
    priorContext: step.priorContext,
    additionalArgs: step.additionalArgs,
    toolPermissions: step.toolPermissions,
    errorBehavior: step.errorBehavior,
  };
}

function toCoreStep(step: WorkflowStep): CoreWorkflowStep {
  return step.type === STEP_TYPES.SCRIPT
    ? (step as CoreScriptStep)
    : toCorePromptStep(step);
}

function toCoreWorkflow(
  steps: WorkflowStep[],
  finalStep: WorkflowStep | null,
  properties: WorkflowProperties
): PromptFile {
  return {
    harness: properties.harness as HarnessId | undefined,
    model: properties.model,
    executionMode: properties.executionMode,
    agent: properties.agent,
    skills: properties.skills,
    resumeSession: properties.resumeSession,
    sessionId: properties.sessionId,
    mcpServers: properties.mcpServers as PromptFile["mcpServers"],
    hooks: properties.hooks as PromptFile["hooks"],
    endCondition: properties.endCondition as PromptFile["endCondition"],
    preCondition: properties.preCondition,
    priorContext: properties.priorContext,
    additionalArgs: properties.additionalArgs,
    toolPermissions: properties.toolPermissions,
    errorBehavior: properties.errorBehavior,
    steps: steps.map(toCoreStep),
    ...(finalStep ? { finalStep: toCoreStep(finalStep) } : {}),
  };
}

function createDefaults(
  globalSettings: ReturnType<typeof useSettingsStore.getState>["globalSettings"]
) {
  return {
    harness: globalSettings.harness,
    modelsByHarness: globalSettings.harnessDefaultModels,
    additionalArgsByHarness: globalSettings.harnessDefaultAdditionalArgs,
    executionMode: globalSettings.executionMode,
    agent: globalSettings.agent,
    skills: globalSettings.skills,
    resumeSession: globalSettings.resumeSession,
    mcpServers: globalSettings.mcpServers as PromptFile["mcpServers"],
    hooks: globalSettings.hooks as PromptFile["hooks"],
    priorContext: globalSettings.priorContext as PromptFile["priorContext"],
    toolPermissions: globalSettings.toolPermissions as PromptFile["toolPermissions"],
    endCondition: globalSettings.defaultEndCondition,
    preCondition: globalSettings.defaultPreCondition,
    errorBehavior: globalSettings.defaultErrorBehavior,
  };
}

/**
 * Resolve and analyze the current authoring state synchronously during render.
 * The backend snapshot is the only capability input; no harness implementation
 * or version probe is reachable from this hook.
 */
export function useCompatibilityDiagnostics(): UseCompatibilityDiagnosticsResult {
  const steps = useWorkflowStore((state) => state.steps);
  const finalStep = useWorkflowStore((state) => state.finalStep);
  const globalSettings = useSettingsStore((state) => state.globalSettings);
  const workflowProperties = useSettingsStore(
    (state) => state.workflowProperties
  );
  const capabilitySnapshot = useCompatibilityStore(
    (state) => state.capabilitySnapshot
  );
  const snapshotStatus = useCompatibilityStore(
    (state) => state.capabilitySnapshotStatus
  );

  const diagnostics = useMemo(() => {
    if (snapshotStatus !== "ready" || !capabilitySnapshot) {
      return [];
    }

    const workflow = toCoreWorkflow(steps, finalStep, workflowProperties);
    const context = {
      defaults: createDefaults(globalSettings),
      hostCanProvidePty: !isStandalone,
    };
    const executionTargets = enumerateCompatibilityTargets(
      workflow,
      (prompt, resolvedWorkflow) =>
        resolveExecutionProperties(prompt, resolvedWorkflow, context)
    );

    return analyzeCompatibility({
      workflow,
      executionTargets,
      capabilities: capabilitySnapshot,
      workspace: { workspaceRoot: globalSettings.workspaceRoot },
    });
  }, [
    capabilitySnapshot,
    finalStep,
    globalSettings,
    isStandalone,
    snapshotStatus,
    steps,
    workflowProperties,
  ]);

  return {
    diagnostics,
    isChecking: snapshotStatus === "checking",
    snapshotStatus,
  };
}
