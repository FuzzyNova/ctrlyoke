import { STEP_TYPES, type HarnessId } from "@root/types/DashboardConstants";
import type {
  PromptFile,
  PromptStep as CorePromptStep,
  ScriptStep as CoreScriptStep,
  WorkflowStep as CoreWorkflowStep,
} from "@root/types/CtrlYokeTypes";
import type { GlobalSettings, WorkflowProperties } from "@store/settingsStore";
import type { WorkflowStep } from "@store/workflowStore";

/** Convert the webview's prompt-step representation to the core workflow type. */
export function toCorePromptStep(
  step: Exclude<WorkflowStep, CoreScriptStep>
): CorePromptStep {
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
    secrets: step.secrets,
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

/** Convert the webview workflow and settings projections into core types. */
export function toCoreWorkflow(
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
    secrets: properties.secrets,
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

/** Project global webview settings into the resolver's default shape. */
export function createDefaults(globalSettings: GlobalSettings) {
  return {
    harness: globalSettings.harness,
    modelsByHarness: globalSettings.harnessDefaultModels,
    additionalArgsByHarness: globalSettings.harnessDefaultAdditionalArgs,
    executionMode: globalSettings.executionMode,
    agent: globalSettings.agent,
    skills: globalSettings.skills,
    secrets: globalSettings.secrets,
    resumeSession: globalSettings.resumeSession,
    mcpServers: globalSettings.mcpServers as PromptFile["mcpServers"],
    hooks: globalSettings.hooks as PromptFile["hooks"],
    priorContext: globalSettings.priorContext as PromptFile["priorContext"],
    toolPermissions:
      globalSettings.toolPermissions as PromptFile["toolPermissions"],
    endCondition: globalSettings.defaultEndCondition,
    preCondition: globalSettings.defaultPreCondition,
    errorBehavior: globalSettings.defaultErrorBehavior,
  };
}
