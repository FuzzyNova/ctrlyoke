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
 * Whether effective properties deliver ctrlyoke's queue-mutating tools by any
 * mechanism. Keep this pure so the resolver remains safe to use in the
 * webview bundle; provider infrastructure re-exports it for core consumers.
 */
export function hasCtrlYokeQueueTools(
  properties: Pick<ResolvedProperties, "mcpServers">
): boolean {
  return (properties.mcpServers ?? []).some(
    (server) =>
      server === MCP_SERVER_IDS.CTRLYOKE ||
      (typeof server === "object" &&
        server !== null &&
        server.id === MCP_SERVER_IDS.CTRLYOKE)
  );
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
  const hasRequestedCtrlYokeServer = hasCtrlYokeQueueTools({
    mcpServers: mcpServers.value,
  });
  const resolvedSkills =
    mcpAvailabilityDisabled && hasRequestedCtrlYokeServer
      ? [
          ...(skills.value ?? []),
          MCP_SKILL_NAMES.TOOLS,
          MCP_SKILL_NAMES.COORDINATION,
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
