import { resolveExecutionProperties } from "@root/types/ExecutionPropertyResolver";
import {
  MCP_SKILL_NAMES,
  PRIOR_CONTEXT_KEYWORDS,
} from "@root/types/DashboardConstants";
import type { PromptStep } from "@root/types/WebviewMessageTypes";
import type { PropertyValues } from "@store/editorStore";
import type {
  GlobalSettings,
  WorkflowProperties,
} from "@store/settingsStore";
import {
  createDefaults,
  toCorePromptStep,
  toCoreWorkflow,
} from "@utils/coreWorkflowAdapter";

const MCP_SKILL_NAME_SET = new Set<string>(Object.values(MCP_SKILL_NAMES));

export interface BuildReplyPropertyValuesInput {
  step: PromptStep;
  sessionId: string;
  workflowProperties: WorkflowProperties;
  globalSettings: GlobalSettings;
}

/** Build explicit editor overrides for replying to an already-run prompt step. */
export function buildReplyPropertyValues({
  step,
  sessionId,
  workflowProperties,
  globalSettings,
}: BuildReplyPropertyValuesInput): PropertyValues {
  const { properties } = resolveExecutionProperties(
    toCorePromptStep(step),
    toCoreWorkflow([], null, workflowProperties),
    { defaults: createDefaults(globalSettings), hostCanProvidePty: true }
  );
  const runtime = step._runtime;
  const resolvedSkills =
    runtime?.skills !== undefined ? runtime.skills : properties.skills;
  const skills = (resolvedSkills ?? []).filter(
    (skill) => !MCP_SKILL_NAME_SET.has(skill)
  );
  const agent = runtime?.agent !== undefined ? runtime.agent : properties.agent;
  const resolvedSecrets =
    runtime?.secrets !== undefined ? runtime.secrets : properties.secrets;
  const secrets = resolvedSecrets ?? [];
  const mcpServers = properties.mcpServers;
  const hooks = properties.hooks;
  const additionalArgs = properties.additionalArgs;
  const toolPermissions = properties.toolPermissions;

  return {
    harness:
      runtime?.harness !== undefined ? runtime.harness : properties.harness,
    model: runtime?.model !== undefined ? runtime.model : properties.model,
    executionMode:
      runtime?.executionMode !== undefined
        ? runtime.executionMode
        : properties.executionMode,
    color: step.color,
    agent: agent || null,
    skills: skills.length > 0 ? skills : null,
    secrets: secrets.length > 0 ? secrets : null,
    resumeSession: true,
    sessionId,
    mcpServers: mcpServers && mcpServers.length > 0 ? mcpServers : null,
    hooks: hooks && hooks.length > 0 ? hooks : null,
    errorBehavior: properties.errorBehavior ?? null,
    endCondition: properties.endCondition ?? null,
    preCondition: properties.preCondition ?? null,
    priorContext: PRIOR_CONTEXT_KEYWORDS.NONE,
    additionalArgs: additionalArgs || null,
    toolPermissions: toolPermissions
      ? {
          mode: toolPermissions.mode,
          allowedTools: [...toolPermissions.allowedTools],
          deniedTools: [...toolPermissions.deniedTools],
        }
      : null,
  };
}
