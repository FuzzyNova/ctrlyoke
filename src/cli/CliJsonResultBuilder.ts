import * as path from "path";

import {
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  STEP_STATUS,
  STEP_TYPES,
  type ExecutionMode,
  type ExecutionState,
  type FailureKind,
  type ConditionAction,
  type StepStatus,
  type StepType,
  type CliValidateStrictPolicy,
  type CliValidateTargetKind,
  type HarnessId,
} from "../types/DashboardConstants";
import type {
  ConditionEvaluationSummary,
  FinalStepRuntimeState,
  PromptFile,
  PromptResult,
  QueueState,
  RunRef,
  WorkflowKey,
  WorkflowStep,
} from "../types/CtrlYokeTypes";
import {
  queueTargetKey,
  type RunAttemptProjection,
  type RunFileChangeProjection,
  type RunOutputProjection,
} from "../core/orchestration/RunOutputResolver";
import {
  TIMELINE_ATTEMPT_START_REASONS,
  TIMELINE_ATTEMPT_TERMINAL_STATES,
  type TimelineAttemptStartReason,
  type TimelineAttemptTerminalState,
} from "../types/WorkflowTimelineTypes";
import type { WorkflowExecutionPreview } from "../types/ExecutionPreviewTypes";
import type { CompatibilityDiagnostic } from "../types/CompatibilityTypes";
import { redactExecutionPreview } from "../types/PreviewRedactor";
import { secretRedactionService } from "../utils/SecretRedactionService";

/** Redact again at the standalone CLI serialization boundary. */
export function buildCliPreviewJsonResult(
  preview: WorkflowExecutionPreview
): WorkflowExecutionPreview {
  return secretRedactionService.redactValue(redactExecutionPreview(preview));
}

export const CLI_VALIDATE_JSON_SCHEMA_VERSION = 1 as const;

export interface CliValidationJsonHarness {
  harnessId: HarnessId;
  available: boolean;
  version: string | null;
}

export interface CliValidationJsonResult {
  schemaVersion: typeof CLI_VALIDATE_JSON_SCHEMA_VERSION;
  success: boolean;
  parsed: boolean;
  workflowFile: string;
  target: {
    kind: CliValidateTargetKind;
    harnesses: CliValidationJsonHarness[];
  } | null;
  strict: CliValidateStrictPolicy | null;
  consumerCount: number;
  diagnostics: CompatibilityDiagnostic[];
  error: string | null;
}

export interface CliValidationJsonResultInput {
  success: boolean;
  parsed: boolean;
  workflowFile: string;
  target?: CliValidationJsonResult["target"];
  strict?: CliValidateStrictPolicy;
  consumerCount?: number;
  diagnostics?: readonly CompatibilityDiagnostic[];
  error?: string;
}

export function buildCliValidationJsonResult(
  input: CliValidationJsonResultInput
): CliValidationJsonResult {
  return {
    schemaVersion: CLI_VALIDATE_JSON_SCHEMA_VERSION,
    success: input.success,
    parsed: input.parsed,
    workflowFile: input.workflowFile,
    target: input.target ?? null,
    strict: input.strict ?? null,
    consumerCount: input.consumerCount ?? 0,
    diagnostics: [...(input.diagnostics ?? [])],
    error: input.error ?? null,
  };
}

export interface CliJsonCondition {
  passed: boolean;
  action: ConditionAction | null;
  script: string;
  actual: string;
  actualSource: ConditionEvaluationSummary["actualSource"];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number | null;
  error: string | null;
}

export interface CliJsonLastAttempt {
  number: number;
  startReason: TimelineAttemptStartReason;
  terminalState: TimelineAttemptTerminalState | null;
  reason: string | null;
}

export interface CliJsonFileChange {
  path: string;
  scope: "workspace" | "external";
  operations: RunFileChangeProjection["operations"];
}

export interface CliJsonScriptOutput {
  command: string;
  stdout: string | null;
  stderr: string | null;
  exitCode: number | null;
}

export interface CliJsonStepResult {
  index: number;
  name: string | null;
  type: StepType;
  enabled: boolean;
  harness: HarnessId | null;
  model: string | null;
  executionMode: ExecutionMode | null;
  status: StepStatus;
  success: boolean | null;
  attempts: number;
  lastAttempt: CliJsonLastAttempt | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  sessionId: string | null;
  preCondition: CliJsonCondition | null;
  filesChanged: CliJsonFileChange[];
  endCondition: CliJsonCondition | null;
  script?: CliJsonScriptOutput;
  failureKind: FailureKind | null;
  error: string | null;
}

export interface CliJsonSummary {
  total: number;
  completed: number;
  failed: number;
  skipped: number;
}

export interface CliJsonFinalLoop {
  status: StepStatus | null;
  success: boolean | null;
  attempts: number;
  lastAttempt: CliJsonLastAttempt | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  sessionId: string | null;
  preCondition: CliJsonCondition | null;
  endCondition: CliJsonCondition | null;
  script?: CliJsonScriptOutput;
}

export interface CliJsonFinalStep {
  type: StepType;
  harness: HarnessId | null;
  model: string | null;
  executionMode: ExecutionMode | null;
  status: StepStatus | null;
  success: boolean | null;
  loopCount: number;
  attempts: number;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  filesChanged: CliJsonFileChange[];
  script?: CliJsonScriptOutput;
  failureKind: FailureKind | null;
  error: string | null;
  lastLoop: CliJsonFinalLoop | null;
}

export interface CliJsonError {
  step: number | "finalStep" | null;
  loop: number | null;
  message: string;
  attempt: number | null;
}

export interface CliJsonResult {
  schemaVersion: 1;
  success: boolean;
  workflowFile: string | null;
  workflowKey: WorkflowKey | null;
  runRef: RunRef | null;
  harness: HarnessId | null;
  model: string | null;
  status: ExecutionState;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  varNames: string[];
  summary: CliJsonSummary;
  steps: CliJsonStepResult[];
  finalStep: CliJsonFinalStep | null;
  error: CliJsonError | null;
}

export interface CliJsonResultInput {
  state?: QueueState;
  promptFile?: PromptFile;
  harness?: HarnessId;
  model?: string;
  workflowFileReference?: string;
  workspaceRoot: string;
  workflowKey?: WorkflowKey;
  runRef?: RunRef;
  outputProjection?: RunOutputProjection;
  finalStepRuntime?: FinalStepRuntimeState;
  error?: unknown;
}

/** Build the stable JSON v1 result without mutating queue or workflow state. */
export function buildCliJsonResult(input: CliJsonResultInput): CliJsonResult {
  const state = input.state;
  const promptFile = input.promptFile;
  const workflowKey = input.workflowKey ?? state?.workflowKey ?? null;
  const runRef = input.runRef ?? state?.runRef ?? null;
  const base = {
    schemaVersion: 1 as const,
    workflowFile: input.workflowFileReference ?? null,
    workflowKey,
    runRef,
    harness: input.harness ?? null,
    model: input.model ?? null,
    varNames: Object.keys(promptFile?.vars ?? {}),
  };

  if (!state || input.error !== undefined) {
    return secretRedactionService.redactValue({
      ...base,
      success: false,
      status: EXECUTION_STATES.ERROR,
      startedAt: null,
      completedAt: null,
      durationMs: null,
      summary: emptySummary(),
      steps: [],
      finalStep: null,
      error: createSetupError(input.error),
    });
  }

  const steps = state.steps.map((step, index) =>
    buildStepResult(
      step,
      state.results[index],
      index,
      input,
      input.outputProjection?.targets.get(queueTargetKey(index))
    )
  );
  const finalStep = buildFinalStep(
    promptFile?.finalStep,
    input.finalStepRuntime,
    input.outputProjection?.finalStep,
    input
  );
  const startedAt = toIso(state.startTime);
  const completedAt = toIso(state.executionEndTime);

  return secretRedactionService.redactValue({
    ...base,
    success: state.status === EXECUTION_STATES.COMPLETED,
    status: state.status,
    startedAt,
    completedAt,
    durationMs: getDuration(state.startTime, state.executionEndTime),
    summary: buildSummary(state.steps, state.results),
    steps,
    finalStep,
    error: selectTopLevelError(state, steps, finalStep),
  });
}

function buildStepResult(
  step: WorkflowStep,
  result: PromptResult | undefined,
  index: number,
  input: CliJsonResultInput,
  projection: RunAttemptProjection | undefined
): CliJsonStepResult {
  const isScript = step.type === STEP_TYPES.SCRIPT;
  const enabled = step.enabled !== false;
  const status = result?.status ?? STEP_STATUS.PENDING;
  const runtime = step._runtime;
  const hasRun =
    projection?.attempts !== undefined
      ? projection.attempts > 0
      : runtime?.startedAt !== undefined ||
        status === STEP_STATUS.COMPLETED ||
        status === STEP_STATUS.FAILED;
  const metadata = getEffectiveMetadata(runtime, input, hasRun, isScript);
  const startedAt = toIso(runtime?.startedAt);
  const completedAt = toIso(runtime?.completedAt);
  const scriptOutput = projection?.scriptOutput;

  return {
    index,
    name: step.name ?? null,
    type: isScript ? STEP_TYPES.SCRIPT : STEP_TYPES.PROMPT,
    enabled,
    ...metadata,
    status,
    success: getStepSuccess(status, enabled),
    attempts:
      projection?.attempts ?? getFallbackAttempts(result, runtime, status),
    lastAttempt: projection
      ? projection.latestAttempt
        ? toLastAttempt(projection.latestAttempt)
        : null
      : getFallbackLastAttempt(result, runtime, status),
    startedAt,
    completedAt,
    durationMs: getDuration(runtime?.startedAt, runtime?.completedAt),
    sessionId: isScript ? null : (runtime?.sessionId ?? null),
    preCondition: isScript ? null : toCondition(result?.preCondition),
    filesChanged: shapeFileChanges(
      projection?.filesChanged ?? [],
      input.workspaceRoot
    ),
    endCondition: isScript ? null : toCondition(result?.endCondition),
    ...(isScript
      ? {
          script: buildScriptOutput(
            step.script,
            scriptOutput?.stdout ?? result?.scriptOutput,
            scriptOutput?.stderr,
            scriptOutput?.exitCode
          ),
        }
      : {}),
    failureKind: runtime?.failureKind ?? null,
    error: getStepError(result, runtime),
  };
}

function buildFinalStep(
  step: WorkflowStep | undefined,
  runtime: FinalStepRuntimeState | undefined,
  projection: NonNullable<RunOutputProjection["finalStep"]> | undefined,
  input: CliJsonResultInput
): CliJsonFinalStep | null {
  if (!step) {
    return null;
  }

  const isScript = step.type === STEP_TYPES.SCRIPT;
  const stepRuntime = step._runtime;
  const status = runtime?.status ?? null;
  const loopCount =
    projection?.loopCount ??
    (runtime
      ? runtime.phase === FINAL_STEP_PHASES.FINAL_STEP
        ? runtime.loopCount + 1
        : runtime.loopCount
      : 0);
  const filesChanged = shapeFileChanges(
    projection?.filesChanged ?? [],
    input.workspaceRoot
  );
  const lastLoop = projection?.latestLoop
    ? buildFinalLoop(step, runtime, projection.latestLoop)
    : null;
  const hasRun = Boolean(
    projection?.attempts ||
    stepRuntime?.startedAt !== undefined ||
    status === STEP_STATUS.COMPLETED ||
    status === STEP_STATUS.FAILED
  );
  const metadata = getEffectiveMetadata(stepRuntime, input, hasRun, isScript);
  const latestScriptOutput = projection?.latestLoop?.scriptOutput;

  return {
    type: isScript ? STEP_TYPES.SCRIPT : STEP_TYPES.PROMPT,
    ...metadata,
    status,
    success: getNullableStepSuccess(status),
    loopCount,
    attempts: projection?.attempts ?? 0,
    startedAt: toIso(runtime?.startedAt ?? stepRuntime?.startedAt),
    completedAt: toIso(runtime?.completedAt ?? stepRuntime?.completedAt),
    durationMs: getDuration(
      runtime?.startedAt ?? stepRuntime?.startedAt,
      runtime?.completedAt ?? stepRuntime?.completedAt
    ),
    filesChanged,
    ...(isScript
      ? {
          script: buildScriptOutput(
            step.script,
            latestScriptOutput?.stdout,
            latestScriptOutput?.stderr,
            latestScriptOutput?.exitCode
          ),
        }
      : {}),
    failureKind: stepRuntime?.failureKind ?? null,
    error: stepRuntime?.failureMessage ?? null,
    lastLoop,
  };
}

function buildFinalLoop(
  step: WorkflowStep,
  runtime: FinalStepRuntimeState | undefined,
  projection: RunAttemptProjection
): CliJsonFinalLoop {
  const isScript = step.type === STEP_TYPES.SCRIPT;
  const stepRuntime = step._runtime;
  const status = runtime?.status ?? null;
  const scriptOutput = projection.scriptOutput;
  return {
    status,
    success: getNullableStepSuccess(status),
    attempts: projection.attempts,
    lastAttempt: projection.latestAttempt
      ? toLastAttempt(projection.latestAttempt)
      : null,
    startedAt: toIso(runtime?.startedAt ?? stepRuntime?.startedAt),
    completedAt: toIso(runtime?.completedAt ?? stepRuntime?.completedAt),
    durationMs: getDuration(
      runtime?.startedAt ?? stepRuntime?.startedAt,
      runtime?.completedAt ?? stepRuntime?.completedAt
    ),
    sessionId: isScript ? null : (stepRuntime?.sessionId ?? null),
    preCondition: isScript ? null : toCondition(runtime?.preCondition),
    endCondition: isScript ? null : toCondition(runtime?.endCondition),
    ...(isScript
      ? {
          script: buildScriptOutput(
            step.script,
            scriptOutput?.stdout,
            scriptOutput?.stderr,
            scriptOutput?.exitCode
          ),
        }
      : {}),
  };
}

function getEffectiveMetadata(
  runtime: WorkflowStep["_runtime"],
  input: CliJsonResultInput,
  hasRun: boolean,
  isScript: boolean
): Pick<CliJsonStepResult, "harness" | "model" | "executionMode"> {
  return {
    harness: isScript
      ? null
      : (runtime?.harness ?? (hasRun ? (input.harness ?? null) : null)),
    model: isScript
      ? null
      : (runtime?.model ?? (hasRun ? (input.model ?? null) : null)),
    executionMode: runtime?.executionMode ?? null,
  };
}

function toLastAttempt(
  attempt: NonNullable<RunAttemptProjection["latestAttempt"]>
): CliJsonLastAttempt {
  return {
    number: attempt.number,
    startReason: attempt.startReason,
    terminalState: attempt.terminalState ?? null,
    reason: attempt.terminalReason ?? null,
  };
}

function toCondition(
  summary: ConditionEvaluationSummary | undefined
): CliJsonCondition | null {
  if (!summary) {
    return null;
  }
  return {
    passed: summary.passed,
    action: summary.action ?? null,
    script: summary.script,
    actual: summary.actual,
    actualSource: summary.actualSource,
    stdout: summary.stdout,
    stderr: summary.stderr,
    exitCode: summary.exitCode ?? null,
    durationMs: summary.durationMs ?? null,
    error: summary.error ?? null,
  };
}

function buildScriptOutput(
  command: string,
  stdout: string | undefined,
  stderr: string | undefined,
  exitCode: number | undefined
): CliJsonScriptOutput {
  return {
    command,
    stdout: stdout ?? null,
    stderr: stderr ?? null,
    exitCode: exitCode ?? null,
  };
}

function shapeFileChanges(
  changes: readonly RunFileChangeProjection[],
  workspaceRoot: string
): CliJsonFileChange[] {
  const deduplicated = new Map<
    string,
    Set<RunFileChangeProjection["operations"][number]>
  >();
  for (const change of changes) {
    const shapedPath = shapeFilePath(change, workspaceRoot);
    const key = `${change.scope}:${shapedPath}`;
    const operations = deduplicated.get(key) ?? new Set();
    change.operations.forEach((operation) => operations.add(operation));
    deduplicated.set(key, operations);
  }
  return [...deduplicated].map(([key, operations]) => {
    const separator = key.indexOf(":");
    const scope = key.slice(0, separator) as CliJsonFileChange["scope"];
    return {
      path: key.slice(separator + 1),
      scope,
      operations: [...operations],
    };
  });
}

function shapeFilePath(
  change: RunFileChangeProjection,
  workspaceRoot: string
): string {
  if (change.scope === "external") {
    return change.path.replace(/\\/g, "/");
  }
  if (!path.isAbsolute(change.path)) {
    return change.path.replace(/\\/g, "/");
  }
  const relative = path.relative(workspaceRoot, change.path);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.replace(/\\/g, "/")
    : change.path.replace(/\\/g, "/");
}

function buildSummary(
  steps: readonly WorkflowStep[],
  results: readonly PromptResult[]
): CliJsonSummary {
  return {
    total: steps.length,
    completed: results.filter(
      (result) => result.status === STEP_STATUS.COMPLETED
    ).length,
    failed: results.filter((result) => result.status === STEP_STATUS.FAILED)
      .length,
    skipped: steps.filter(
      (step, index) =>
        step.enabled === false || results[index]?.status === STEP_STATUS.SKIPPED
    ).length,
  };
}

function emptySummary(): CliJsonSummary {
  return { total: 0, completed: 0, failed: 0, skipped: 0 };
}

function getStepSuccess(status: StepStatus, enabled: boolean): boolean | null {
  if (!enabled) {
    return null;
  }
  return getNullableStepSuccess(status);
}

function getNullableStepSuccess(status: StepStatus | null): boolean | null {
  if (status === STEP_STATUS.COMPLETED) {
    return true;
  }
  if (status === STEP_STATUS.FAILED) {
    return false;
  }
  return null;
}

function getFallbackAttempts(
  result: PromptResult | undefined,
  runtime: WorkflowStep["_runtime"],
  status: StepStatus
): number {
  if (
    status !== STEP_STATUS.COMPLETED &&
    status !== STEP_STATUS.FAILED &&
    runtime?.startedAt === undefined
  ) {
    return 0;
  }
  return (result?.retryCount ?? 0) + 1;
}

function getFallbackLastAttempt(
  result: PromptResult | undefined,
  runtime: WorkflowStep["_runtime"],
  status: StepStatus
): CliJsonLastAttempt | null {
  const attempts = getFallbackAttempts(result, runtime, status);
  if (attempts === 0) {
    return null;
  }
  return {
    number: attempts,
    startReason:
      attempts > 1
        ? TIMELINE_ATTEMPT_START_REASONS.RETRY
        : TIMELINE_ATTEMPT_START_REASONS.INITIAL,
    terminalState:
      status === STEP_STATUS.COMPLETED
        ? TIMELINE_ATTEMPT_TERMINAL_STATES.COMPLETED
        : status === STEP_STATUS.FAILED
          ? TIMELINE_ATTEMPT_TERMINAL_STATES.FAILED
          : null,
    reason: getStepError(result, runtime),
  };
}

function getStepError(
  result: PromptResult | undefined,
  runtime: WorkflowStep["_runtime"]
): string | null {
  return result?.error ?? runtime?.failureMessage ?? null;
}

function selectTopLevelError(
  state: QueueState,
  steps: readonly CliJsonStepResult[],
  finalStep: CliJsonFinalStep | null
): CliJsonError | null {
  const failedStep = steps.find((step) => step.status === STEP_STATUS.FAILED);
  if (failedStep) {
    return {
      step: failedStep.index,
      loop: null,
      message: failedStep.error ?? `Step ${failedStep.index} failed`,
      attempt: failedStep.lastAttempt?.number ?? null,
    };
  }
  if (finalStep?.status === STEP_STATUS.FAILED) {
    return {
      step: "finalStep",
      loop: finalStep.loopCount > 0 ? finalStep.loopCount - 1 : null,
      message: finalStep.error ?? "Final step failed",
      attempt: finalStep.lastLoop?.lastAttempt?.number ?? null,
    };
  }
  if (state.status !== EXECUTION_STATES.ERROR) {
    return null;
  }
  return {
    step: null,
    loop: null,
    message: "Workflow ended with an error",
    attempt: null,
  };
}

function createSetupError(error: unknown): CliJsonError {
  return {
    step: null,
    loop: null,
    message:
      error instanceof Error
        ? error.message
        : error === undefined
          ? "Unable to build CLI JSON result"
          : String(error),
    attempt: null,
  };
}

function toIso(timestamp: number | undefined): string | null {
  if (timestamp === undefined) {
    return null;
  }
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function getDuration(
  startedAt: number | undefined,
  completedAt: number | undefined
): number | null {
  return startedAt !== undefined && completedAt !== undefined
    ? completedAt - startedAt
    : null;
}
