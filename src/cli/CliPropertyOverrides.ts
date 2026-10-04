import type { PromptFile, ExecutionProperties } from "../types/CtrlYokeTypes";
import type { HarnessId } from "../types/DashboardConstants";
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
    "harness" | "model" | "permissionMode" | "allowTool" | "denyTool"
  >,
  defaultHarness?: HarnessId
): CliPropertyOverrides {
  const workflow: Partial<ExecutionProperties> = {};
  if (options.harness) workflow.harness = options.harness as HarnessId;
  if (options.model) workflow.model = options.model;

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

  const permissions = overrides.workflow.toolPermissions;
  if (permissions) {
    workflow.toolPermissions = {
      ...(workflow.toolPermissions ?? {}),
      ...permissions,
    };
  }

  return notices;
}
