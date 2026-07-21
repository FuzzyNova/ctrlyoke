import { STEP_TYPES } from "../types/DashboardConstants";
import type {
  ErrorBehavior,
  EndCondition,
  McpServerConfig,
  PreCondition,
  PriorContext,
  PromptStep,
  ScriptStep,
  ToolPermissionsOverride,
  UserHookConfig,
  WorkingFile,
  WorkflowStep,
} from "../types/CtrlYokeTypes";
import type { WorkflowDefinitionSnapshot } from "../types/WorkflowTimelineTypes";

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
  finalStep?: WorkflowStep
): WorkflowDefinitionSnapshot {
  return {
    workflowName,
    steps: stripStepRuntime(steps),
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
export function stripTimelineDuplicatedRuntimeOutput(
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

    return typeof item.event === "string" && typeof item.command === "string"
      ? {
          event: item.event as UserHookConfig["event"],
          command: item.command,
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

  return {
    script: value.script,
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

  return {
    script: value.script,
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
    ...((typeof step.agent === "string" || step.agent === null) && {
      agent: step.agent as PromptStep["agent"],
    }),
    ...((skills !== undefined || step.skills === null) && {
      skills: skills ?? null,
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
      ...(typeof step.timeout === "number" && { timeout: step.timeout }),
      ...(typeof step.compareSource === "string" && {
        compareSource: step.compareSource as ScriptStep["compareSource"],
      }),
      ...(typeof step.returns === "string" && { returns: step.returns }),
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
