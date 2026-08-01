import { useMemo } from "react";
import { isStandalone } from "@hooks/useVsCodeApi";
import { useCompatibilityStore } from "@store/compatibilityStore";
import { useSettingsStore, type WorkflowProperties } from "@store/settingsStore";
import { useWorkflowStore, type WorkflowStep } from "@store/workflowStore";
import type { PropertyValues, EditorSelectionTarget } from "@store/editorStore";
import {
  FINAL_STEP_PHASES,
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
import type { CompatibilityExecutionTarget } from "@root/types/CompatibilityAnalyzer";

export interface UseCompatibilityDiagnosticsResult {
  diagnostics: CompatibilityDiagnostic[];
  executionTargets: CompatibilityExecutionTarget[];
  capabilitySnapshot: ReturnType<typeof useCompatibilityStore.getState>["capabilitySnapshot"];
  isChecking: boolean;
  snapshotStatus: "checking" | "ready";
}

export interface UseCompatibilityDiagnosticsOptions {
  /** Unsaved prompt properties to evaluate for the selected target. */
  promptProperties?: PropertyValues;
  promptTarget?: EditorSelectionTarget;
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

function applyPromptProperties(
  step: WorkflowStep,
  properties: PropertyValues
): CorePromptStep {
  const coreStep = toCorePromptStep(step as Exclude<WorkflowStep, CoreScriptStep>);
  return {
    ...coreStep,
    harness: properties.harness as HarnessId | undefined,
    model: properties.model,
    executionMode: properties.executionMode,
    agent: properties.agent,
    skills: properties.skills,
    resumeSession: properties.resumeSession,
    sessionId: properties.sessionId || undefined,
    mcpServers: properties.mcpServers as CorePromptStep["mcpServers"],
    hooks: properties.hooks as CorePromptStep["hooks"],
    errorBehavior: properties.errorBehavior as CorePromptStep["errorBehavior"],
    endCondition: properties.endCondition as CorePromptStep["endCondition"],
    preCondition: properties.preCondition,
    priorContext: properties.priorContext,
    additionalArgs: properties.additionalArgs,
    toolPermissions: properties.toolPermissions,
  };
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
export function useCompatibilityDiagnostics(
  options: UseCompatibilityDiagnosticsOptions = {}
): UseCompatibilityDiagnosticsResult {
  const steps = useWorkflowStore((state) => state.steps);
  const finalStep = useWorkflowStore((state) => state.finalStep);
  const globalSettings = useSettingsStore((state) => state.globalSettings);
  const workflowProperties = useSettingsStore(
    (state) => state.workflowProperties
  );
  const promptProperties = options.promptProperties;
  const promptTarget = options.promptTarget;
  const capabilitySnapshot = useCompatibilityStore(
    (state) => state.capabilitySnapshot
  );
  const snapshotStatus = useCompatibilityStore(
    (state) => state.capabilitySnapshotStatus
  );

  const analysis = useMemo(() => {
    if (snapshotStatus !== "ready" || !capabilitySnapshot) {
      return { diagnostics: [], executionTargets: [] };
    }

    let workflow = toCoreWorkflow(steps, finalStep, workflowProperties);
    if (promptProperties && promptTarget) {
      if (
        promptTarget.kind === FINAL_STEP_PHASES.QUEUE &&
        steps[promptTarget.index]
      ) {
        workflow = {
          ...workflow,
          steps: (workflow.steps ?? []).map((step, index) =>
            index === promptTarget.index && step.type !== STEP_TYPES.SCRIPT
              ? applyPromptProperties(steps[index], promptProperties)
              : step
          ),
        };
      } else if (
        promptTarget.kind === FINAL_STEP_PHASES.FINAL_STEP &&
        finalStep &&
        finalStep.type !== STEP_TYPES.SCRIPT
      ) {
        workflow = {
          ...workflow,
          finalStep: applyPromptProperties(finalStep, promptProperties),
        };
      }
    }
    const context = {
      defaults: createDefaults(globalSettings),
      hostCanProvidePty: !isStandalone,
    };
    const executionTargets = enumerateCompatibilityTargets(
      workflow,
      (prompt, resolvedWorkflow) =>
        resolveExecutionProperties(prompt, resolvedWorkflow, context)
    );

    return {
      diagnostics: analyzeCompatibility({
      workflow,
      executionTargets,
      capabilities: capabilitySnapshot,
      workspace: { workspaceRoot: globalSettings.workspaceRoot },
      }),
      executionTargets,
    };
  }, [
    capabilitySnapshot,
    finalStep,
    globalSettings,
    isStandalone,
    snapshotStatus,
    steps,
    promptProperties,
    promptTarget,
    workflowProperties,
  ]);

  return {
    diagnostics: analysis.diagnostics,
    executionTargets: analysis.executionTargets,
    capabilitySnapshot,
    isChecking: snapshotStatus === "checking",
    snapshotStatus,
  };
}
