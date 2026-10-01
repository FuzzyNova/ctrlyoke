import { resolveExecutionProperties } from "@root/types/ExecutionPropertyResolver";
import {
  HARNESS_IDS,
  MCP_SKILL_NAMES,
  PRIOR_CONTEXT_KEYWORDS,
  type HarnessId,
} from "@root/types/DashboardConstants";
import type { PromptStep } from "@root/types/WebviewMessageTypes";
import { useEditorStore, type PropertyValues } from "@store/editorStore";
import {
  useSettingsStore,
  type GlobalSettings,
  type WorkflowProperties,
} from "@store/settingsStore";
import {
  createDefaults,
  toCorePromptStep,
  toCoreWorkflow,
} from "@utils/coreWorkflowAdapter";

const MCP_SKILL_NAME_SET = new Set<string>(Object.values(MCP_SKILL_NAMES));
const HARNESS_ID_SET = new Set<string>(Object.values(HARNESS_IDS));

function isHarnessId(value: string): value is HarnessId {
  return HARNESS_ID_SET.has(value);
}

export interface BuildReplyPropertyValuesInput {
  step: PromptStep;
  sessionId: string;
  /** Harness paired with the selected session ID, when its source provides one. */
  sessionHarness?: string;
  /** Model paired with the selected session ID, when its source provides one. */
  sessionModel?: string;
  workflowProperties: WorkflowProperties;
  globalSettings: GlobalSettings;
}

/** Build explicit editor overrides for replying to an already-run prompt step. */
export function buildReplyPropertyValues({
  step,
  sessionId,
  sessionHarness,
  sessionModel,
  workflowProperties,
  globalSettings,
}: BuildReplyPropertyValuesInput): PropertyValues & { harness: HarnessId } {
  const runtime = step._runtime;
  const harnessToResolve =
    sessionHarness !== undefined && isHarnessId(sessionHarness)
      ? sessionHarness
      : runtime?.harness !== undefined && isHarnessId(runtime.harness)
        ? runtime.harness
        : undefined;
  const { properties } = resolveExecutionProperties(
    {
      ...toCorePromptStep(step),
      ...(harnessToResolve ? { harness: harnessToResolve } : {}),
    },
    toCoreWorkflow([], null, workflowProperties),
    { defaults: createDefaults(globalSettings), hostCanProvidePty: true }
  );
  const harness = properties.harness;
  const runtimeMatchesHarness = runtime?.harness === harness;
  const resolvedSkills =
    runtimeMatchesHarness && runtime?.skills !== undefined
      ? runtime.skills
      : properties.skills;
  const skills = (resolvedSkills ?? []).filter(
    (skill) => !MCP_SKILL_NAME_SET.has(skill)
  );
  const agent =
    runtimeMatchesHarness && runtime?.agent !== undefined
      ? runtime.agent
      : properties.agent;
  const resolvedSecrets =
    runtimeMatchesHarness && runtime?.secrets !== undefined
      ? runtime.secrets
      : properties.secrets;
  const secrets = resolvedSecrets ?? [];
  const mcpServers = properties.mcpServers;
  const hooks = properties.hooks;
  const additionalArgs = properties.additionalArgs;
  const toolPermissions = properties.toolPermissions;

  return {
    harness,
    model:
      sessionModel ??
      (runtimeMatchesHarness && runtime?.model !== undefined
        ? runtime.model
        : properties.model),
    executionMode:
      runtimeMatchesHarness && runtime?.executionMode !== undefined
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

/**
 * Turn the new-prompt editor into a follow-up to `step`, resolving against the
 * workflow and global settings current at click time.
 */
export function startReplyFromStep(
  step: PromptStep,
  sessionId: string,
  sourceLabel: string,
  sessionHarness?: string,
  sessionModel?: string
): void {
  const { workflowProperties, globalSettings } = useSettingsStore.getState();
  const properties = buildReplyPropertyValues({
    step,
    sessionId,
    sessionHarness,
    sessionModel,
    workflowProperties,
    globalSettings,
  });
  useEditorStore.getState().startReplyToStep({
    properties,
    sessionId,
    harness: properties.harness,
    sourceLabel,
  });
}
