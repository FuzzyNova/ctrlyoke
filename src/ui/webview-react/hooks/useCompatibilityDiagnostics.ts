import { useMemo } from "react";
import { useCompatibilityStore } from "@store/compatibilityStore";
import { useSettingsStore } from "@store/settingsStore";
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
import {
  buildPortabilityReport,
  type PortabilityReport,
} from "@root/types/PortabilityReport";
import { resolveExecutionProperties } from "@root/types/ExecutionPropertyResolver";
import type {
  PromptFile,
  PromptStep as CorePromptStep,
  ScriptStep as CoreScriptStep,
} from "@root/types/CtrlYokeTypes";
import type { CompatibilityDiagnostic } from "@root/types/CompatibilityTypes";
import type { CompatibilityExecutionTarget } from "@root/types/CompatibilityAnalyzer";
import { parseAllFileReferences } from "@root/utils/FileReferenceParser";
import { isImageRefPath } from "@root/types/DashboardConstants";
import {
  createDefaults,
  toCorePromptStep,
  toCoreWorkflow,
} from "@utils/coreWorkflowAdapter";

export interface UseCompatibilityDiagnosticsResult {
  diagnostics: CompatibilityDiagnostic[];
  executionTargets: CompatibilityExecutionTarget[];
  portabilityReport: PortabilityReport | null;
  capabilitySnapshot: ReturnType<
    typeof useCompatibilityStore.getState
  >["capabilitySnapshot"];
  isChecking: boolean;
  snapshotStatus: "checking" | "ready";
}

export interface UseCompatibilityDiagnosticsOptions {
  /** Unsaved prompt properties to evaluate for the selected target. */
  promptProperties?: PropertyValues;
  promptTarget?: EditorSelectionTarget;
  /** Build the workflow-level projection only for the report surface. */
  includePortabilityReport?: boolean;
}

function authoredImageRefs(prompt: string): readonly string[] {
  return parseAllFileReferences(prompt)
    .filter(
      (reference) =>
        !reference.isDirectory &&
        reference.startLine === undefined &&
        reference.endLine === undefined &&
        isImageRefPath(reference.path)
    )
    .map((reference) => reference.path);
}

function applyPromptProperties(
  step: WorkflowStep,
  properties: PropertyValues
): CorePromptStep {
  const coreStep = toCorePromptStep(
    step as Exclude<WorkflowStep, CoreScriptStep>
  );
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
  const includePortabilityReport = options.includePortabilityReport ?? false;
  const capabilitySnapshot = useCompatibilityStore(
    (state) => state.capabilitySnapshot
  );
  const snapshotStatus = useCompatibilityStore(
    (state) => state.capabilitySnapshotStatus
  );

  const analysis = useMemo(() => {
    if (snapshotStatus !== "ready" || !capabilitySnapshot) {
      return {
        diagnostics: [],
        executionTargets: [],
        portabilityReport: null,
      };
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
      // Both the VS Code panel and the hosted browser dashboard are relayed
      // from the same extension-host process, which always spawns the PTY
      // (see WorkflowOrchestrator.buildWorkflowInstance() / ExecutionPreviewService).
      // Only the standalone CLI binary can lack a PTY, and it never renders this hook.
      hostCanProvidePty: true,
    };
    const resolveTarget = (
      prompt: CorePromptStep,
      resolvedWorkflow: PromptFile
    ) => resolveExecutionProperties(prompt, resolvedWorkflow, context);
    const imageFileRefsForTarget = (target: CompatibilityExecutionTarget) =>
      authoredImageRefs(
        (() => {
          const step =
            target.consumer.kind === FINAL_STEP_PHASES.QUEUE
              ? workflow.steps?.[target.consumer.stepIndex]
              : workflow.finalStep;
          return step && step.type !== STEP_TYPES.SCRIPT ? step.prompt : "";
        })()
      );
    const executionTargets = enumerateCompatibilityTargets(
      workflow,
      resolveTarget
    ).map((target) => ({
      ...target,
      imageFileRefs: imageFileRefsForTarget(target),
    }));

    return {
      diagnostics: analyzeCompatibility({
        workflow,
        executionTargets,
        capabilities: capabilitySnapshot,
        workspace: { workspaceRoot: globalSettings.workspaceRoot },
      }),
      executionTargets,
      portabilityReport: includePortabilityReport
        ? buildPortabilityReport({
            workflow,
            capabilities: capabilitySnapshot,
            resolveTarget,
            imageFileRefs: imageFileRefsForTarget,
            workspace: { workspaceRoot: globalSettings.workspaceRoot },
          })
        : null,
    };
  }, [
    capabilitySnapshot,
    finalStep,
    globalSettings,
    snapshotStatus,
    steps,
    promptProperties,
    promptTarget,
    includePortabilityReport,
    workflowProperties,
  ]);

  return {
    diagnostics: analysis.diagnostics,
    executionTargets: analysis.executionTargets,
    portabilityReport: analysis.portabilityReport,
    capabilitySnapshot,
    isChecking: snapshotStatus === "checking",
    snapshotStatus,
  };
}
