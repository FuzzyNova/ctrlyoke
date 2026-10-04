import type { PromptFile, ExecutionProperties } from "../types/CtrlYokeTypes";
import {
  EXECUTION_MODES,
  type HarnessId,
} from "../types/DashboardConstants";
import type { CliExecutionOptions } from "./CliRunCommandDefinitions";

/** Flag names reserved for the later --force phase. */
export const ForceableFlag = {
  HARNESS: "harness",
  MODEL: "model",
  PERMISSION_MODE: "permission-mode",
  ALLOW_TOOL: "allow-tool",
  DENY_TOOL: "deny-tool",
} as const;

export type ForceableFlag = (typeof ForceableFlag)[keyof typeof ForceableFlag];

export interface CliPropertyOverrides {
  workflow: Partial<ExecutionProperties>;
  forced: ReadonlySet<ForceableFlag>;
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
    forced: new Set<ForceableFlag>(),
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

  return notices;
}
