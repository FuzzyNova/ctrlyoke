import type { PromptFile, ExecutionProperties } from "../types/CtrlYokeTypes";
import { EXECUTION_MODES, type HarnessId } from "../types/DashboardConstants";
import { isScriptStep, type WorkflowStep } from "../types/CtrlYokeTypes";
import type { CliExecutionOptions } from "./CliRunCommandDefinitions";

/** CLI property flag names that can be extended to workflow steps. */
export const ForceableFlag = {
  HARNESS: "harness",
  MODEL: "model",
  HEADLESS: "headless",
  INTERACTIVE: "interactive",
  PERMISSION_MODE: "permission-mode",
  ALLOW_TOOL: "allow-tool",
  DENY_TOOL: "deny-tool",
  RESUME_SESSION: "resume-session",
  SESSION_ID: "session-id",
  SCRIPT_TIMEOUT: "script-timeout",
} as const;

export const FORCE_ALL_KEYWORD = "all";

export type ForceableFlag = (typeof ForceableFlag)[keyof typeof ForceableFlag];

export interface CliPropertyOverrides {
  workflow: Partial<ExecutionProperties>;
  forced: ReadonlySet<ForceableFlag>;
  scriptTimeout?: number;
  /** Effective settings/workflow harness before applying a harness flag. */
  effectiveHarness?: HarnessId;
}

export function buildCliPropertyOverrides(
  options: Pick<
    CliExecutionOptions,
    | "harness"
    | "model"
    | "permissionMode"
    | "allowTool"
    | "denyTool"
    | "headless"
    | "interactive"
    | "resumeSession"
    | "sessionId"
    | "scriptTimeout"
    | "force"
  >,
  defaultHarness?: HarnessId
): CliPropertyOverrides {
  const workflow: Partial<ExecutionProperties> = {};
  if (options.harness) workflow.harness = options.harness as HarnessId;
  if (options.model) workflow.model = options.model;
  if (options.headless) workflow.executionMode = EXECUTION_MODES.HEADLESS;
  else if (options.interactive)
    workflow.executionMode = EXECUTION_MODES.INTERACTIVE;
  if (options.resumeSession !== undefined) {
    workflow.resumeSession = options.resumeSession;
  }
  if (options.sessionId !== undefined) {
    workflow.sessionId = options.sessionId;
    workflow.resumeSession = true;
  }

  if (
    options.permissionMode ||
    options.allowTool?.length ||
    options.denyTool?.length
  ) {
    workflow.toolPermissions = {
      ...(options.permissionMode ? { mode: options.permissionMode } : {}),
      ...(options.allowTool?.length
        ? { allowedTools: [...options.allowTool] }
        : {}),
      ...(options.denyTool?.length
        ? { deniedTools: [...options.denyTool] }
        : {}),
    };
  }

  return {
    workflow,
    forced: parseAndValidateForcedFlags(options),
    ...(options.scriptTimeout !== undefined
      ? { scriptTimeout: options.scriptTimeout }
      : {}),
    ...(defaultHarness ? { effectiveHarness: defaultHarness } : {}),
  };
}

export function applyCliPropertyOverrides(
  workflow: PromptFile,
  overrides: CliPropertyOverrides
): string[] {
  const notices: string[] = [];
  const oldHarness = workflow.harness ?? overrides.effectiveHarness;
  const newHarness = overrides.workflow.harness;
  const modelWasProvided = overrides.workflow.model !== undefined;
  const forceModel = overrides.forced.has(ForceableFlag.MODEL);

  if (
    newHarness &&
    oldHarness &&
    newHarness !== oldHarness &&
    !modelWasProvided &&
    workflow.model
  ) {
    const droppedModel = workflow.model;
    delete workflow.model;
    notices.push(
      `workflow model "${droppedModel}" dropped: it was set for ${oldHarness}`
    );
  }

  if (newHarness) {
    workflow.harness = newHarness;
  }
  if (modelWasProvided) {
    workflow.model = overrides.workflow.model;
  }
  if (overrides.workflow.executionMode !== undefined) {
    workflow.executionMode = overrides.workflow.executionMode;
  }
  if (overrides.workflow.resumeSession !== undefined) {
    workflow.resumeSession = overrides.workflow.resumeSession;
  }
  if (overrides.workflow.sessionId !== undefined) {
    workflow.sessionId = overrides.workflow.sessionId;
  }

  const permissions = overrides.workflow.toolPermissions;
  if (permissions) {
    workflow.toolPermissions = {
      ...(workflow.toolPermissions ?? {}),
      ...permissions,
    };
  }

  for (const step of getWorkflowSteps(workflow)) {
    for (const flag of overrides.forced) {
      applyForcedFlagToStep(
        step,
        flag,
        workflow,
        overrides,
        oldHarness,
        notices
      );
    }
  }

  if (forceModel) {
    const harnessSteps = new Map<HarnessId | undefined, string[]>();
    for (const step of getWorkflowSteps(workflow)) {
      if (isScriptStep(step)) continue;
      const harness =
        step.harness ?? workflow.harness ?? overrides.effectiveHarness;
      const labels = harnessSteps.get(harness) ?? [];
      labels.push(getStepLabel(step, workflow));
      harnessSteps.set(harness, labels);
    }
    if (harnessSteps.size > 1) {
      const conflicts = [...harnessSteps.entries()]
        .map(
          ([harness, labels]) =>
            (harness ?? "default harness") + ": " + labels.join(", ")
        )
        .join("; ");
      throw new Error(
        "--force model cannot apply one model across steps using multiple harnesses (" +
          conflicts +
          "); add --force harness"
      );
    }
  }

  return notices;
}

function applyForcedFlagToStep(
  step: WorkflowStep,
  flag: ForceableFlag,
  workflow: PromptFile,
  overrides: CliPropertyOverrides,
  oldHarness: HarnessId | undefined,
  notices: string[]
): void {
  switch (flag) {
    case ForceableFlag.HARNESS:
      if (!isScriptStep(step) && overrides.workflow.harness) {
        const priorHarness = step.harness ?? oldHarness;
        step.harness = overrides.workflow.harness;
        if (
          priorHarness !== overrides.workflow.harness &&
          !overrides.forced.has(ForceableFlag.MODEL) &&
          step.model
        ) {
          const droppedModel = step.model;
          delete step.model;
          notices.push(
            "step " +
              getStepLabel(step, workflow) +
              ' model "' +
              droppedModel +
              '" dropped: it was set for ' +
              (priorHarness ?? "the prior harness")
          );
        }
      }
      return;
    case ForceableFlag.MODEL:
      if (!isScriptStep(step) && overrides.workflow.model !== undefined) {
        step.model = overrides.workflow.model;
      }
      return;
    case ForceableFlag.HEADLESS:
    case ForceableFlag.INTERACTIVE:
      if (overrides.workflow.executionMode !== undefined) {
        step.executionMode = overrides.workflow.executionMode;
      }
      return;
    case ForceableFlag.PERMISSION_MODE:
    case ForceableFlag.ALLOW_TOOL:
    case ForceableFlag.DENY_TOOL:
    case ForceableFlag.RESUME_SESSION:
    case ForceableFlag.SESSION_ID:
      if (!isScriptStep(step)) {
        applyForcedPromptProperty(step, flag, overrides);
      }
      return;
    case ForceableFlag.SCRIPT_TIMEOUT:
      if (overrides.scriptTimeout !== undefined) {
        if (isScriptStep(step)) {
          step.timeoutSec = overrides.scriptTimeout;
        } else {
          if (step.preCondition)
            step.preCondition.timeoutSec = overrides.scriptTimeout;
          if (step.endCondition)
            step.endCondition.timeoutSec = overrides.scriptTimeout;
        }
      }
      return;
  }
}

function parseAndValidateForcedFlags(
  options: Pick<
    CliExecutionOptions,
    | "force"
    | "harness"
    | "model"
    | "headless"
    | "interactive"
    | "permissionMode"
    | "allowTool"
    | "denyTool"
    | "resumeSession"
    | "sessionId"
    | "scriptTimeout"
  >
): Set<ForceableFlag> {
  const requested = (options.force ?? []).flatMap((value) =>
    value.split(",").map((name) => name.trim())
  );
  if (requested.length === 0) return new Set();
  const valid = new Set<string>(Object.values(ForceableFlag));
  const unknown = requested.filter(
    (name) => name !== FORCE_ALL_KEYWORD && !valid.has(name)
  );
  if (unknown.length) {
    throw new Error(
      "--force cannot include " +
        unknown.map((name) => '"' + name + '"').join(", ") +
        "; choose from " +
        [...valid].join(", ") +
        ", " +
        FORCE_ALL_KEYWORD
    );
  }
  const passed = new Map<ForceableFlag, boolean>([
    [ForceableFlag.HARNESS, options.harness !== undefined],
    [ForceableFlag.MODEL, options.model !== undefined],
    [ForceableFlag.HEADLESS, options.headless === true],
    [ForceableFlag.INTERACTIVE, options.interactive === true],
    [ForceableFlag.PERMISSION_MODE, options.permissionMode !== undefined],
    [ForceableFlag.ALLOW_TOOL, (options.allowTool?.length ?? 0) > 0],
    [ForceableFlag.DENY_TOOL, (options.denyTool?.length ?? 0) > 0],
    [ForceableFlag.RESUME_SESSION, options.resumeSession !== undefined],
    [ForceableFlag.SESSION_ID, options.sessionId !== undefined],
    [ForceableFlag.SCRIPT_TIMEOUT, options.scriptTimeout !== undefined],
  ]);
  const selected = requested.includes(FORCE_ALL_KEYWORD)
    ? [...passed].filter(([, wasPassed]) => wasPassed).map(([flag]) => flag)
    : (requested as ForceableFlag[]);
  for (const flag of selected) {
    if (!passed.get(flag)) {
      const optionName =
        flag === ForceableFlag.RESUME_SESSION && options.resumeSession === false
          ? "--no-resume-session"
          : "--" + flag;
      throw new Error("--force " + flag + " requires " + optionName);
    }
  }
  return new Set(selected);
}

function getWorkflowSteps(workflow: PromptFile): WorkflowStep[] {
  return [
    ...(workflow.steps ?? []),
    ...(workflow.finalStep ? [workflow.finalStep] : []),
  ];
}

function getStepLabel(step: WorkflowStep, workflow: PromptFile): string {
  if (step === workflow.finalStep) return "finalStep";
  const index = workflow.steps?.indexOf(step) ?? -1;
  return step.name
    ? "step " + (index + 1) + ' ("' + step.name + '")'
    : "step " + (index + 1);
}

function applyForcedPromptProperty(
  step: Extract<WorkflowStep, { prompt: string }>,
  flag: ForceableFlag,
  overrides: CliPropertyOverrides
): void {
  if (
    flag === ForceableFlag.RESUME_SESSION &&
    overrides.workflow.resumeSession !== undefined
  ) {
    step.resumeSession = overrides.workflow.resumeSession;
    if (!overrides.workflow.resumeSession) delete step.sessionId;
  }
  if (
    flag === ForceableFlag.SESSION_ID &&
    typeof overrides.workflow.sessionId === "string"
  ) {
    step.sessionId = overrides.workflow.sessionId;
    step.resumeSession = true;
  }
  const supplied = overrides.workflow.toolPermissions;
  if (!supplied) return;
  const permissions = { ...(step.toolPermissions ?? {}) };
  if (flag === ForceableFlag.PERMISSION_MODE && supplied.mode !== undefined) {
    permissions.mode = supplied.mode;
  }
  if (
    flag === ForceableFlag.ALLOW_TOOL &&
    supplied.allowedTools !== undefined
  ) {
    permissions.allowedTools = [...supplied.allowedTools];
  }
  if (flag === ForceableFlag.DENY_TOOL && supplied.deniedTools !== undefined) {
    permissions.deniedTools = [...supplied.deniedTools];
  }
  if (Object.keys(permissions).length) step.toolPermissions = permissions;
}
