import {
  STEP_TYPES,
  CONDITION_ACTIONS,
  COMPARE_SOURCES,
  EXECUTION_MODES,
  type ExecutionMode,
} from "../types/DashboardConstants";
import {
  isScriptStep,
  type ErrorBehavior,
  type EndCondition,
  type HarnessId,
  type McpServerConfig,
  type PreCondition,
  type PriorContext,
  type PromptStep,
  type ScriptStep,
  type ToolPermissionsOverride,
  type UserHookConfig,
  type WorkingFile,
  type WorktreeConfig,
  type WorkflowStep,
} from "../types/CtrlYokeTypes";
import type { WorkflowDefinitionSnapshot } from "../types/WorkflowTimelineTypes";

/**
 * Empty-string agent selections are used by settings/UI controls to represent
 * "None", but persisted workflow definitions require an explicit null.
 */
export function normalizeAgentSelection(agent: string | null): string | null {
  return agent === "" ? null : agent;
}

/**
 * Removes per-step `_runtime` (session/response/attempt metadata) from every step.
 * Used wherever a definition must be recorded or seeded independent of what has
 * already executed: timeline snapshots, and seeding a new run from an existing one.
 */
export function stripStepRuntime(steps: WorkflowStep[]): WorkflowStep[] {
  return steps.map((step) => {
    const { _runtime: _omitted, ...rest } = step as WorkflowStep & {
      _runtime?: unknown;
    };
    return rest as WorkflowStep;
  });
}

/**
 * Builds the execution-relevant definition snapshot committed to the timeline
 * before a definition revision's first output (`DEFINITION_REVISION_COMMITTED`).
 * Strips per-step `_runtime` — the snapshot records what will execute, not what already has.
 */
export function buildDefinitionSnapshot(
  workflowName: string,
  steps: WorkflowStep[],
  rewindBoundary?: number,
  finalStep?: WorkflowStep,
  worktree?: WorktreeConfig
): WorkflowDefinitionSnapshot {
  return {
    workflowName,
    steps: stripStepRuntime(steps),
    ...(worktree !== undefined ? { worktree } : {}),
    ...(finalStep ? { finalStep: stripStepRuntime([finalStep])[0] } : {}),
    ...(rewindBoundary !== undefined ? { rewindBoundary } : {}),
  };
}

/**
 * Removes webview-only fields before core queue state is persisted.
 *
 * Step status is projected from queue results and per-step _runtime.completedAt;
 * keeping a copied webview status on the prompt itself makes working files
 * disagree with runtime metadata after rewind/start-position changes.
 */
export function stripViewOnlyWorkflowStepFields(
  step: WorkflowStep
): WorkflowStep {
  const {
    status: _status,
    details: _details,
    ...persistableStep
  } = step as WorkflowStep & {
    status?: unknown;
    details?: unknown;
  };
  return persistableStep as WorkflowStep;
}

/**
 * Drops response values from a working-file step without interpreting them.
 * Pre-release cutover deliberately does not migrate or fall back to these
 * obsolete duplicate fields; events.jsonl is the only durable response record.
 */
function stripTimelineDuplicatedRuntimeOutput(
  step: WorkflowStep
): WorkflowStep {
  if (!step._runtime) {
    return step;
  }
  const {
    responseText: _responseText,
    scriptOutput: _scriptOutput,
    ...runtime
  } = step._runtime as typeof step._runtime & {
    responseText?: unknown;
    scriptOutput?: unknown;
  };
  return { ...step, _runtime: runtime } as WorkflowStep;
}

/** Apply the response-source cutover at every working-file read/write boundary. */
export function stripTimelineDuplicatedWorkingFileOutput(
  workingFile: WorkingFile
): WorkingFile {
  const finalRuntime = workingFile._runtime?.finalStep;
  const { responseTexts: _responseTexts, ...finalStepRuntime } =
    (finalRuntime ?? {}) as typeof finalRuntime & { responseTexts?: unknown };
  return {
    ...workingFile,
    ...(workingFile.steps
      ? { steps: workingFile.steps.map(stripTimelineDuplicatedRuntimeOutput) }
      : {}),
    ...(workingFile.finalStep
      ? {
          finalStep: stripTimelineDuplicatedRuntimeOutput(
            workingFile.finalStep
          ),
        }
      : {}),
    ...(workingFile._runtime
      ? {
          _runtime: {
            ...workingFile._runtime,
            ...(finalRuntime ? { finalStep: finalStepRuntime } : {}),
          },
        }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneStringArray(value: unknown): string[] | undefined {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    return undefined;
  }
  return [...value];
}

function cloneStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value);
  if (!entries.every(([, entryValue]) => typeof entryValue === "string")) {
    return undefined;
  }

  return Object.fromEntries(entries) as Record<string, string>;
}

function cloneMcpServerConfig(value: unknown): McpServerConfig | undefined {
  if (!isRecord(value) || typeof value.id !== "string") {
    return undefined;
  }

  const args = cloneStringArray(value.args);
  const env = cloneStringRecord(value.env);
  const autoApprove =
    value.autoApprove === true ||
    (Array.isArray(value.autoApprove) &&
      value.autoApprove.every((item) => typeof item === "string"))
      ? value.autoApprove
      : undefined;
  const headers = cloneStringRecord(value.headers);
  const deniedTools = cloneStringArray(value.deniedTools);

  return {
    id: value.id,
    ...(typeof value.command === "string" && { command: value.command }),
    ...(args && { args }),
    ...(env && { env }),
    ...(autoApprove !== undefined && { autoApprove }),
    ...(typeof value.url === "string" && { url: value.url }),
    ...(typeof value.transport === "string" && {
      transport: value.transport as "streamable-http" | "sse",
    }),
    ...(headers && { headers }),
    ...(deniedTools && { deniedTools }),
  };
}

function cloneMcpServers(
  value: unknown
): (string | McpServerConfig)[] | null | undefined {
  if (value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const cloned = value.map((item) => {
    if (typeof item === "string") {
      return item;
    }
    return cloneMcpServerConfig(item);
  });

  return cloned.every((item) => item !== undefined)
    ? (cloned as Array<string | McpServerConfig>)
    : undefined;
}

function cloneHooks(value: unknown): UserHookConfig[] | null | undefined {
  if (value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const hooks = value.map((item) => {
    if (!isRecord(item)) {
      return undefined;
    }

    const env = cloneStringRecord(item.env);
    return typeof item.event === "string" && typeof item.command === "string"
      ? {
          event: item.event as UserHookConfig["event"],
          command: item.command,
          ...(env && { env }),
          ...(typeof item.timeoutSec === "number" && {
            timeoutSec: item.timeoutSec,
          }),
        }
      : undefined;
  });

  return hooks.every((item) => item !== undefined)
    ? (hooks as UserHookConfig[])
    : undefined;
}

function cloneToolPermissions(
  value: unknown
): ToolPermissionsOverride | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const allowedTools = cloneStringArray(value.allowedTools);
  const deniedTools = cloneStringArray(value.deniedTools);

  return {
    ...(typeof value.mode === "string" && {
      mode: value.mode as ToolPermissionsOverride["mode"],
    }),
    ...(allowedTools && { allowedTools }),
    ...(deniedTools && { deniedTools }),
  };
}

function clonePriorContext(value: unknown): PriorContext | undefined {
  if (typeof value === "string") {
    return value as PriorContext;
  }
  if (
    Array.isArray(value) &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  ) {
    return [...value];
  }
  return undefined;
}

function cloneEndCondition(value: unknown): EndCondition | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value) || typeof value.script !== "string") {
    return undefined;
  }

  if (typeof value.returns !== "string") {
    return undefined;
  }

  const env = cloneStringRecord(value.env);
  return {
    script: value.script,
    ...(env && { env }),
    returns: value.returns,
    ...(typeof value.compareSource === "string" && {
      compareSource: value.compareSource as EndCondition["compareSource"],
    }),
    ...(typeof value.timeout === "number" && { timeout: value.timeout }),
    ...(typeof value.maxRetries === "number" && {
      maxRetries: value.maxRetries,
    }),
    ...(typeof value.retryPrompt === "string" && {
      retryPrompt: value.retryPrompt,
    }),
    ...(typeof value.passRetryPrompt === "string" && {
      passRetryPrompt: value.passRetryPrompt,
    }),
    ...(typeof value.resumeSessionOnRetry === "boolean" && {
      resumeSessionOnRetry: value.resumeSessionOnRetry,
    }),
    ...(typeof value.onPass === "string" && {
      onPass: value.onPass as EndCondition["onPass"],
    }),
    ...(typeof value.onFail === "string" && {
      onFail: value.onFail as EndCondition["onFail"],
    }),
  };
}

function clonePreCondition(value: unknown): PreCondition | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value) || typeof value.script !== "string") {
    return undefined;
  }

  const env = cloneStringRecord(value.env);
  return {
    script: value.script,
    ...(env && { env }),
    ...(typeof value.compareSource === "string" && {
      compareSource: value.compareSource as PreCondition["compareSource"],
    }),
    ...(typeof value.returns === "string" && { returns: value.returns }),
    ...(typeof value.timeout === "number" && { timeout: value.timeout }),
    ...(typeof value.onPass === "string" && {
      onPass: value.onPass as PreCondition["onPass"],
    }),
    ...(typeof value.onFail === "string" && {
      onFail: value.onFail as PreCondition["onFail"],
    }),
  };
}

function cloneErrorBehavior(value: unknown): ErrorBehavior | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value) || typeof value.onError !== "string") {
    return undefined;
  }

  return {
    onError: value.onError as ErrorBehavior["onError"],
    ...(typeof value.maxRetries === "number" && {
      maxRetries: value.maxRetries,
    }),
    ...(typeof value.retryDelayMs === "number" && {
      retryDelayMs: value.retryDelayMs,
    }),
  };
}

function buildClipboardExecutionProperties(
  step: Record<string, unknown>
): Partial<PromptStep> {
  const skills = cloneStringArray(step.skills);
  const secrets = cloneStringArray(step.secrets);
  const mcpServers = cloneMcpServers(step.mcpServers);
  const hooks = cloneHooks(step.hooks);
  const endCondition = cloneEndCondition(step.endCondition);
  const preCondition = clonePreCondition(step.preCondition);
  const errorBehavior = cloneErrorBehavior(step.errorBehavior);
  const priorContext = clonePriorContext(step.priorContext);
  const toolPermissions = cloneToolPermissions(step.toolPermissions);

  return {
    ...(typeof step.harness === "string" && {
      harness: step.harness as PromptStep["harness"],
    }),
    ...(typeof step.model === "string" && { model: step.model }),
    ...((step.executionMode === EXECUTION_MODES.INTERACTIVE ||
      step.executionMode === EXECUTION_MODES.HEADLESS) && {
      executionMode: step.executionMode,
    }),
    ...((typeof step.agent === "string" || step.agent === null) && {
      agent: normalizeAgentSelection(step.agent),
    }),
    ...((skills !== undefined || step.skills === null) && {
      skills: skills ?? null,
    }),
    ...((secrets !== undefined || step.secrets === null) && {
      secrets: secrets ?? null,
    }),
    ...(typeof step.resumeSession === "boolean" && {
      resumeSession: step.resumeSession,
    }),
    ...((typeof step.sessionId === "string" ||
      typeof step.sessionId === "number") && {
      sessionId: step.sessionId,
    }),
    ...((mcpServers !== undefined || step.mcpServers === null) && {
      mcpServers,
    }),
    ...((hooks !== undefined || step.hooks === null) && { hooks }),
    ...((endCondition !== undefined || step.endCondition === null) && {
      endCondition,
    }),
    ...((preCondition !== undefined || step.preCondition === null) && {
      preCondition,
    }),
    ...((errorBehavior !== undefined || step.errorBehavior === null) && {
      errorBehavior,
    }),
    ...(priorContext !== undefined && { priorContext }),
    ...((typeof step.additionalArgs === "string" ||
      step.additionalArgs === null) && {
      additionalArgs: step.additionalArgs,
    }),
    ...((toolPermissions !== undefined || step.toolPermissions === null) && {
      toolPermissions,
    }),
  };
}

export function sanitizeClipboardWorkflowStep(step: unknown): WorkflowStep {
  if (!isRecord(step)) {
    throw new Error("Clipboard step must be a JSON object");
  }

  const commonFields = {
    ...(typeof step.name === "string" && { name: step.name }),
    ...(step.enabled === false && { enabled: false }),
  };

  if (step.type === STEP_TYPES.SCRIPT) {
    if (typeof step.script !== "string") {
      throw new Error("Clipboard script step is missing a script string");
    }

    const scriptStep: ScriptStep = {
      type: STEP_TYPES.SCRIPT,
      script: step.script,
      ...commonFields,
      ...(cloneStringRecord(step.env) && {
        env: cloneStringRecord(step.env),
      }),
      ...((step.executionMode === EXECUTION_MODES.INTERACTIVE ||
        step.executionMode === EXECUTION_MODES.HEADLESS) && {
        executionMode: step.executionMode,
      }),
      ...(typeof step.timeout === "number" && { timeout: step.timeout }),
      ...(typeof step.compareSource === "string" && {
        compareSource: step.compareSource as ScriptStep["compareSource"],
      }),
      ...(typeof step.returns === "string" && { returns: step.returns }),
      ...((step.errorBehavior !== undefined || step.errorBehavior === null) && {
        errorBehavior: cloneErrorBehavior(step.errorBehavior),
      }),
      ...(typeof step.onPass === "string" && {
        onPass: step.onPass as ScriptStep["onPass"],
      }),
      ...(typeof step.onFail === "string" && {
        onFail: step.onFail as ScriptStep["onFail"],
      }),
    };

    return scriptStep;
  }

  if (step.type !== undefined && step.type !== STEP_TYPES.PROMPT) {
    throw new Error(`Unsupported clipboard step type: ${String(step.type)}`);
  }
  if (typeof step.prompt !== "string") {
    throw new Error("Clipboard prompt step is missing a prompt string");
  }

  const promptStep: PromptStep = {
    ...(step.type === STEP_TYPES.PROMPT && { type: STEP_TYPES.PROMPT }),
    prompt: step.prompt,
    ...commonFields,
    ...buildClipboardExecutionProperties(step),
  };

  return promptStep;
}

function buildClipboardWorkflowStep(step: WorkflowStep): WorkflowStep {
  return sanitizeClipboardWorkflowStep(step);
}

export function serializeWorkflowStepForClipboard(step: WorkflowStep): string {
  return JSON.stringify(buildClipboardWorkflowStep(step), null, 2);
}

export function parseClipboardWorkflowStep(text: string): WorkflowStep {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Clipboard does not contain valid JSON");
  }

  return sanitizeClipboardWorkflowStep(parsed);
}

/**
 * Produces `{ key: undefined }` entries for each key in clearProperties, which
 * when spread into a Partial<PromptStep> removes those fields from the stored prompt.
 * Shared by `WorkflowInstance`'s instance-bound edits and the addressed static
 * mutation path so both build identical step updates from the same dashboard payload.
 */
export function buildClearUpdates(
  clearProperties?: string[]
): Partial<PromptStep> {
  if (!clearProperties?.length) return {};
  return Object.fromEntries(
    clearProperties.map((key) => [key, undefined])
  ) as Partial<PromptStep>;
}

/**
 * Apply an incoming step edit without losing properties the editor does not
 * enumerate. Same-kind script edits merge, same-kind prompt edits retain the
 * existing prompt merge behavior, and a real type change remains wholesale so
 * fields from the previous step kind cannot leak into the new definition.
 */
export function mergeWorkflowStepUpdate(
  existingStep: WorkflowStep,
  incomingStep: WorkflowStep,
  clearProperties?: string[]
): WorkflowStep {
  if (isScriptStep(existingStep) !== isScriptStep(incomingStep)) {
    return incomingStep;
  }

  return {
    ...existingStep,
    ...incomingStep,
    ...buildClearUpdates(clearProperties),
  } as WorkflowStep;
}

/** Build a ScriptStep from properties sent in an EXECUTE_PROMPT / UPDATE_PROMPT message. */
export function buildScriptStepFromProperties(
  script: string,
  props: Record<string, unknown>,
  name?: string
): ScriptStep {
  const secrets = cloneStringArray(props.secrets);

  return {
    type: STEP_TYPES.SCRIPT,
    script,
    ...(cloneStringRecord(props.env) && { env: cloneStringRecord(props.env) }),
    ...((props.executionMode === EXECUTION_MODES.INTERACTIVE ||
      props.executionMode === EXECUTION_MODES.HEADLESS) && {
      executionMode: props.executionMode as ExecutionMode,
    }),
    ...(name?.trim() ? { name: name.trim() } : {}),
    ...((secrets !== undefined || props.secrets === null) && {
      secrets: secrets ?? null,
    }),
    ...(props.enabled !== undefined && {
      enabled: props.enabled as boolean,
    }),
    ...(props.timeout !== undefined &&
      props.timeout !== null && {
        timeout: props.timeout as number,
      }),
    ...(props.onPass !== undefined &&
      props.onPass !== null && {
        onPass: props.onPass as
          | typeof CONDITION_ACTIONS.CONTINUE
          | typeof CONDITION_ACTIONS.STOP_WORKFLOW,
      }),
    ...(props.onFail !== undefined &&
      props.onFail !== null && {
        onFail: props.onFail as
          | typeof CONDITION_ACTIONS.CONTINUE
          | typeof CONDITION_ACTIONS.STOP_WORKFLOW,
      }),
    ...(props.compareSource !== undefined &&
      props.compareSource !== null && {
        compareSource:
          props.compareSource as (typeof COMPARE_SOURCES)[keyof typeof COMPARE_SOURCES],
      }),
    ...(props.returns !== undefined &&
      props.returns !== null && { returns: props.returns as string }),
    ...((props.errorBehavior !== undefined || props.errorBehavior === null) && {
      errorBehavior: cloneErrorBehavior(props.errorBehavior),
    }),
  };
}

/**
 * Build the complete queue step for an EXECUTE_PROMPT submission (dashboard
 * prompt editor). One builder for both the instance-bound append path and the
 * orchestrator's run-addressed append path so an identical payload always
 * produces an identical step.
 */
export function buildEphemeralWorkflowStep(
  text: string,
  properties: unknown,
  promptName?: string
): WorkflowStep {
  const props = properties as Record<string, unknown>;
  return props?.type === STEP_TYPES.SCRIPT
    ? buildScriptStepFromProperties(text, props, promptName)
    : {
        prompt: text,
        ...(promptName?.trim() ? { name: promptName.trim() } : {}),
        ...buildPromptStepProperties(properties),
      };
}

export function buildPromptStepProperties(
  properties: unknown
): Partial<PromptStep> {
  const props = properties as Record<string, unknown>;
  // For non-nullable properties: null coerces to undefined (removes key from PromptStep).
  // For tri-state nullable properties like agent, skills, and additionalArgs,
  // null is stored as-is to represent an explicit "none/disabled" override.
  // "Clear to inherit" is handled separately via buildClearUpdates / clearProperties.
  const coerce = <T>(
    v: unknown,
    isValid?: (value: unknown) => boolean
  ): T | undefined =>
    v === null || (isValid !== undefined && !isValid(v)) ? undefined : (v as T);
  const executionMode = coerce<ExecutionMode>(
    props?.executionMode,
    (value) =>
      value === EXECUTION_MODES.INTERACTIVE ||
      value === EXECUTION_MODES.HEADLESS
  );

  return {
    ...(props?.harness !== undefined && {
      harness: coerce<HarnessId>(props.harness),
    }),
    ...(props?.model !== undefined && { model: coerce<string>(props.model) }),
    ...(executionMode !== undefined && { executionMode }),
    ...(props?.agent !== undefined && {
      agent: normalizeAgentSelection(props.agent as string | null),
    }),
    ...(props?.enabled !== undefined && {
      enabled: props.enabled as boolean,
    }),
    ...(props?.resumeSession !== undefined && {
      resumeSession: coerce<boolean>(props.resumeSession),
    }),
    ...(props?.sessionId !== undefined && {
      sessionId: coerce<string | number>(props.sessionId),
    }),
    ...(props?.mcpServers !== undefined && {
      mcpServers: props.mcpServers as (string | McpServerConfig)[] | null,
    }),
    ...(props?.hooks !== undefined && {
      hooks: props.hooks as UserHookConfig[] | null,
    }),
    ...(props?.endCondition !== undefined && {
      endCondition: coerce<EndCondition>(props.endCondition),
    }),
    ...(props?.preCondition !== undefined && {
      preCondition: props.preCondition as PreCondition | null,
    }),
    ...(props?.errorBehavior !== undefined && {
      errorBehavior: props.errorBehavior as ErrorBehavior | null,
    }),
    ...(props?.skills !== undefined && {
      skills: props.skills as string[] | null,
    }),
    ...(props?.priorContext !== undefined && {
      priorContext: coerce<PriorContext>(props.priorContext),
    }),
    // additionalArgs is three-state: null = explicitly disabled, string = custom, undefined = inherit.
    // Do NOT coerce null to undefined — null must be preserved in PromptStep so the working
    // file retains the "explicitly none" override and the PropertyResolver stops resolution.
    ...(props?.additionalArgs !== undefined && {
      additionalArgs: props.additionalArgs as string | null,
    }),
    // toolPermissions is three-state: null = explicitly none (inject no flags),
    // object = override, undefined = inherit from workflow.
    // Do NOT coerce null to undefined — null must be preserved so the PropertyResolver
    // stops resolution and injects no permission flags for this prompt.
    ...(props?.toolPermissions !== undefined && {
      toolPermissions: props.toolPermissions as ToolPermissionsOverride | null,
    }),
  };
}
