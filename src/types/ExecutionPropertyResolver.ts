import {
  EXECUTION_MODES,
  MCP_AVAILABILITY_MODES,
  MCP_SERVER_IDS,
  MCP_SKILL_NAMES,
  PERMISSION_MODES,
  PRIOR_CONTEXT_KEYWORDS,
  type ExecutionMode,
  type HarnessId,
  type McpAvailability,
} from "./DashboardConstants";
import type {
  EndCondition,
  ErrorBehavior,
  McpServerConfig,
  PreCondition,
  PriorContext,
  PromptFile,
  PromptStep,
  ToolPermissionsOverride,
  UserHookConfig,
} from "./CtrlYokeTypes";
import type {
  ResolvedProperties,
  ToolPermissionConfig,
} from "./ExecutionPropertyTypes";
import {
  MCP_COORDINATION_TOOL_NAMES,
  MCP_WORKFLOW_MUTATION_TOOL_NAMES,
  MCP_WORKFLOW_TOOL_NAMES,
} from "../utils/McpToolDefinitions";

export const RESOLUTION_SOURCES = {
  PROMPT: "prompt",
  WORKFLOW: "workflow",
  DEFAULTS: "defaults",
} as const;
export type ResolutionSource =
  (typeof RESOLUTION_SOURCES)[keyof typeof RESOLUTION_SOURCES];

/** Platform-neutral defaults supplied by a settings/capability adapter. */
export interface ExecutionPropertyDefaults {
  harness: HarnessId;
  modelsByHarness: Partial<Record<HarnessId, string>>;
  additionalArgsByHarness: Partial<Record<HarnessId, string>>;
  executionMode: ExecutionMode;
  mcpAvailability?: McpAvailability;
  agent?: string | null;
  skills?: string[] | null;
  secrets?: string[] | null;
  resumeSession: boolean;
  mcpServers?: (string | McpServerConfig)[] | null;
  hooks?: UserHookConfig[] | null;
  sessionId?: string | number;
  endCondition?: EndCondition | null;
  preCondition?: PreCondition | null;
  priorContext?: PriorContext;
  toolPermissions?: ToolPermissionsOverride | null;
  errorBehavior?: ErrorBehavior | null;
}

export interface ExecutionResolutionContext {
  defaults: ExecutionPropertyDefaults;
  hostCanProvidePty: boolean;
}

export interface ResolvedExecutionTarget {
  properties: ResolvedProperties;
  sources: Partial<Record<keyof ResolvedProperties, ResolutionSource>>;
}

/**
 * Which families of ctrlyoke tools effective properties actually deliver, by
 * any mechanism. Every field folds the ctrlyoke entry's `deniedTools`, so a
 * step that attaches the server but denies a whole family reads as not having
 * that family — which is what lets a parallel-group member keep the board
 * while giving up step mutation.
 */
export interface CtrlYokeToolFamilies {
  /** At least one ctrlyoke tool survives, so the server/skill is worth attaching. */
  any: boolean;
  /** A step-list mutating tool survives. This is what a parallel group bans. */
  mutation: boolean;
  /** A workflow tool survives, so the workflow skill has something to document. */
  workflow: boolean;
  /** A coordination tool survives, so the coordination skill does too. */
  coordination: boolean;
}

const NO_CTRLYOKE_TOOLS: CtrlYokeToolFamilies = {
  any: false,
  mutation: false,
  workflow: false,
  coordination: false,
};

/**
 * The ctrlyoke entry's denied tool names, or `undefined` when the server is
 * not attached at all — the two cases callers must keep apart, since "denies
 * nothing" and "is not here" both produce an empty denial list.
 */
function resolveCtrlYokeDenials(
  properties: Pick<ResolvedProperties, "mcpServers">
): Set<string> | undefined {
  const entry = (properties.mcpServers ?? []).find(
    (server) =>
      server === MCP_SERVER_IDS.CTRLYOKE ||
      (typeof server === "object" &&
        server !== null &&
        server.id === MCP_SERVER_IDS.CTRLYOKE)
  );
  if (entry === undefined) return undefined;
  return new Set(typeof entry === "object" ? (entry.deniedTools ?? []) : []);
}

/**
 * The ctrlyoke tools this step has denied. Used to keep a denied tool out of
 * the generated built-in skills, which are the whole tool surface in
 * `mcpAvailability: "disabled"` mode.
 */
export function ctrlYokeDeniedToolNames(
  properties: Pick<ResolvedProperties, "mcpServers">
): readonly string[] {
  return [...(resolveCtrlYokeDenials(properties) ?? [])];
}

/**
 * Resolve the ctrlyoke tool families an effective `mcpServers` list delivers.
 * Keep this pure so the resolver remains safe to use in the webview bundle;
 * provider infrastructure re-exports it for core consumers.
 */
export function ctrlYokeToolFamilies(
  properties: Pick<ResolvedProperties, "mcpServers">
): CtrlYokeToolFamilies {
  const denied = resolveCtrlYokeDenials(properties);
  if (denied === undefined) return NO_CTRLYOKE_TOOLS;

  const survives = (names: readonly string[]): boolean =>
    names.some((name) => !denied.has(name));

  const workflow = survives(MCP_WORKFLOW_TOOL_NAMES);
  const coordination = survives(MCP_COORDINATION_TOOL_NAMES);
  return {
    any: workflow || coordination,
    mutation: survives(MCP_WORKFLOW_MUTATION_TOOL_NAMES),
    workflow,
    coordination,
  };
}

function select<T>(
  promptValue: T | undefined,
  workflowValue: T | undefined,
  defaultValue: T
): { value: T; source: ResolutionSource } {
  if (promptValue !== undefined) {
    return { value: promptValue, source: "prompt" };
  }
  if (workflowValue !== undefined) {
    return { value: workflowValue, source: "workflow" };
  }
  return { value: defaultValue, source: "defaults" };
}

function resolveAgent(
  prompt: PromptStep,
  workflow: PromptFile,
  defaults: ExecutionPropertyDefaults
): { value: string | undefined; source: ResolutionSource } {
  const selected = select(prompt.agent, workflow.agent, defaults.agent);
  return { value: selected.value || undefined, source: selected.source };
}

function resolveSkills(
  prompt: PromptStep,
  workflow: PromptFile,
  defaults: ExecutionPropertyDefaults
): { value: string[] | undefined; source: ResolutionSource } {
  const selected = select(prompt.skills, workflow.skills, defaults.skills);
  return {
    value:
      Array.isArray(selected.value) && selected.value.length > 0
        ? selected.value
        : undefined,
    source: selected.source,
  };
}

function resolveSecrets(
  prompt: PromptStep,
  workflow: PromptFile,
  defaults: ExecutionPropertyDefaults
): { value: string[] | undefined; source: ResolutionSource } {
  const selected = select(prompt.secrets, workflow.secrets, defaults.secrets);
  return {
    value:
      Array.isArray(selected.value) && selected.value.length > 0
        ? selected.value
        : undefined,
    source: selected.source,
  };
}

function resolveHooks(
  prompt: PromptStep,
  workflow: PromptFile,
  defaults: ExecutionPropertyDefaults
): { value: UserHookConfig[] | null; source: ResolutionSource } {
  if (prompt.hooks === null) {
    return { value: null, source: "prompt" };
  }
  if (prompt.hooks === undefined && workflow.hooks === null) {
    return { value: null, source: "workflow" };
  }

  const workflowHooks = workflow.hooks ?? defaults.hooks ?? [];
  if (prompt.hooks === undefined || prompt.hooks.length === 0) {
    return {
      value: workflowHooks,
      source: workflow.hooks !== undefined ? "workflow" : "defaults",
    };
  }

  const eventMap = new Map<UserHookConfig["event"], UserHookConfig[]>();
  for (const hook of workflowHooks) {
    if (!eventMap.has(hook.event)) eventMap.set(hook.event, []);
    eventMap.get(hook.event)!.push(hook);
  }
  const promptEvents = new Set(prompt.hooks.map((hook) => hook.event));
  for (const event of promptEvents) {
    eventMap.set(
      event,
      prompt.hooks.filter((hook) => hook.event === event)
    );
  }
  return { value: [...eventMap.values()].flat(), source: "prompt" };
}

function resolveSessionId(
  prompt: PromptStep,
  workflow: PromptFile,
  defaults: ExecutionPropertyDefaults
): { value: string | number | undefined; source: ResolutionSource } {
  if (prompt.sessionId !== undefined && prompt.sessionId !== "") {
    return { value: prompt.sessionId, source: "prompt" };
  }
  if (prompt.sessionId === "" && prompt.resumeSession !== undefined) {
    return { value: undefined, source: "prompt" };
  }
  if (workflow.sessionId !== undefined && workflow.sessionId !== "") {
    return { value: workflow.sessionId, source: "workflow" };
  }
  if (defaults.sessionId !== undefined && defaults.sessionId !== "") {
    return { value: defaults.sessionId, source: "defaults" };
  }
  return { value: undefined, source: "defaults" };
}

function resolveNullable<T>(
  promptValue: T | null | undefined,
  workflowValue: T | null | undefined,
  defaultValue: T | null | undefined
): { value: T | undefined; source: ResolutionSource } {
  const selected = select(promptValue, workflowValue, defaultValue);
  return { value: selected.value ?? undefined, source: selected.source };
}

function resolveAdditionalArgs(
  prompt: PromptStep,
  workflow: PromptFile,
  defaults: ExecutionPropertyDefaults,
  harness: HarnessId
): { value: string | undefined; source: ResolutionSource } {
  const promptValue = prompt.additionalArgs;
  if (promptValue !== undefined) {
    return {
      value:
        promptValue === null || promptValue === "" ? undefined : promptValue,
      source: "prompt",
    };
  }
  const workflowValue = workflow.additionalArgs;
  if (workflowValue !== undefined) {
    return {
      value:
        workflowValue === null || workflowValue === ""
          ? undefined
          : workflowValue,
      source: "workflow",
    };
  }
  return {
    value: defaults.additionalArgsByHarness[harness] || undefined,
    source: "defaults",
  };
}

function resolveToolPermissions(
  prompt: PromptStep,
  workflow: PromptFile,
  defaults: ExecutionPropertyDefaults
): { value: ToolPermissionConfig | null; source: ResolutionSource } {
  const selected = select(
    prompt.toolPermissions,
    workflow.toolPermissions,
    defaults.toolPermissions
  );
  const effective = selected.value;
  if (
    effective === null ||
    effective === undefined ||
    effective.mode === PERMISSION_MODES.NONE
  ) {
    return { value: null, source: selected.source };
  }
  return {
    value: {
      mode: effective.mode ?? PERMISSION_MODES.ALLOW_ALL,
      allowedTools: effective.allowedTools ?? [],
      deniedTools: effective.deniedTools ?? [],
    },
    source: selected.source,
  };
}

/** Resolve effective execution properties without platform or process-global dependencies. */
export function resolveExecutionProperties(
  prompt: PromptStep,
  workflow: PromptFile,
  context: ExecutionResolutionContext
): ResolvedExecutionTarget {
  const { defaults } = context;
  const harness = select(prompt.harness, workflow.harness, defaults.harness);
  const model = select(
    prompt.model,
    workflow.model,
    defaults.modelsByHarness[harness.value] ?? ""
  );
  const executionMode = select(
    prompt.executionMode,
    workflow.executionMode,
    defaults.executionMode
  );
  const agent = resolveAgent(prompt, workflow, defaults);
  const skills = resolveSkills(prompt, workflow, defaults);
  const secrets = resolveSecrets(prompt, workflow, defaults);
  const resumeSession = select(
    prompt.resumeSession,
    workflow.resumeSession,
    defaults.resumeSession
  );
  const mcpServers = select(
    prompt.mcpServers,
    workflow.mcpServers,
    defaults.mcpServers ?? []
  );
  const mcpAvailabilityDisabled =
    defaults.mcpAvailability === MCP_AVAILABILITY_MODES.DISABLED;
  // In disabled mode the built-in skills stand in for the server, so attach
  // only the ones whose tools survived the step's denials — an unfiltered pair
  // spends prompt budget documenting tools the step cannot call.
  const ctrlyokeFamilies = ctrlYokeToolFamilies({
    mcpServers: mcpServers.value,
  });
  const resolvedSkills =
    mcpAvailabilityDisabled && ctrlyokeFamilies.any
      ? [
          ...(skills.value ?? []),
          ...(ctrlyokeFamilies.workflow ? [MCP_SKILL_NAMES.TOOLS] : []),
          ...(ctrlyokeFamilies.coordination
            ? [MCP_SKILL_NAMES.COORDINATION]
            : []),
        ]
      : skills.value;
  const hooks = resolveHooks(prompt, workflow, defaults);
  const sessionId = resolveSessionId(prompt, workflow, defaults);
  const endCondition = resolveNullable(
    prompt.endCondition,
    workflow.endCondition,
    defaults.endCondition
  );
  const preCondition = resolveNullable(
    prompt.preCondition,
    workflow.preCondition,
    defaults.preCondition
  );
  const priorContext = select(
    prompt.priorContext,
    workflow.priorContext,
    defaults.priorContext
  );
  const additionalArgs = resolveAdditionalArgs(
    prompt,
    workflow,
    defaults,
    harness.value
  );
  const toolPermissions = resolveToolPermissions(prompt, workflow, defaults);
  const errorBehavior = resolveNullable(
    prompt.errorBehavior,
    workflow.errorBehavior,
    defaults.errorBehavior
  );

  const resolvedExecutionMode = context.hostCanProvidePty
    ? executionMode.value
    : EXECUTION_MODES.HEADLESS;
  const resolvedPriorContext =
    priorContext.source === RESOLUTION_SOURCES.DEFAULTS &&
    priorContext.value === PRIOR_CONTEXT_KEYWORDS.NONE
      ? undefined
      : priorContext.value;

  const properties: ResolvedProperties = {
    harness: harness.value,
    model: model.value,
    executionMode: resolvedExecutionMode,
    agent: agent.value,
    skills: resolvedSkills,
    secrets: secrets.value,
    resumeSession: resumeSession.value,
    mcpServers: mcpServers.value,
    hooks: hooks.value,
    sessionId: sessionId.value,
    endCondition: endCondition.value,
    preCondition: preCondition.value,
    priorContext: resolvedPriorContext,
    additionalArgs: additionalArgs.value,
    toolPermissions: toolPermissions.value,
    errorBehavior: errorBehavior.value,
  };
  if (mcpAvailabilityDisabled) {
    properties.mcpAvailability = defaults.mcpAvailability;
  }

  return {
    properties,
    sources: {
      harness: harness.source,
      model: model.source,
      executionMode: executionMode.source,
      agent: agent.source,
      skills: skills.source,
      secrets: secrets.source,
      resumeSession: resumeSession.source,
      mcpServers: mcpServers.source,
      hooks: hooks.source,
      sessionId: sessionId.source,
      endCondition: endCondition.source,
      preCondition: preCondition.source,
      priorContext: priorContext.source,
      additionalArgs: additionalArgs.source,
      toolPermissions: toolPermissions.source,
      errorBehavior: errorBehavior.source,
    },
  };
}
