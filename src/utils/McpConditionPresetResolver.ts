import type {
  ConditionPreset,
  EndCondition,
  PreCondition,
  WorkingFile,
} from "../types/CtrlYokeTypes";
import { resolveRetryBudgetMaxRetries } from "../core/RetryBudget";
import {
  MCP_WORKFLOW_STATUS_TOOL_NAME,
  MCP_EDIT_STEP_TOOL_NAME,
  type McpConditionPresetSummary,
  type McpConditionPresetUse,
} from "./McpToolDefinitions";
import {
  promptFirstLinePreview,
  STEP_LISTING_PROMPT_PREVIEW_MAX_CHARS,
} from "./TextUtils";
import { formatDeclaredPresetList, getDeclaredPreset } from "./McpNamedPresets";

/** Maximum size of one caller-provided environment value for a preset. */
const MCP_CONDITION_PARAM_MAX_LENGTH = 4096;

type ConditionField = "endCondition" | "preCondition";

/**
 * Describe every preset the workflow declares, in declaration order. This is
 * the only way an MCP caller learns which names `use` accepts, so the
 * orchestrator can tell "no presets" apart from "presets it has not seen".
 */
export function summarizeMcpConditionPresets(
  workingFile: WorkingFile,
  defaultMaxRetries: number
): McpConditionPresetSummary[] {
  return Object.entries(workingFile.conditions ?? {}).map(([name, preset]) => ({
    name,
    script: promptFirstLinePreview(
      preset.script,
      STEP_LISTING_PROMPT_PREVIEW_MAX_CHARS
    ),
    params: [...(preset.params ?? [])],
    maxRetries: resolveRetryBudgetMaxRetries(preset, defaultMaxRetries),
  }));
}

/** "committed, inspect (params: BUG_FILE)", or "none". */
function formatPresetList(workingFile: WorkingFile): string {
  return formatDeclaredPresetList(workingFile.conditions, (name, preset) =>
    preset.params && preset.params.length > 0
      ? `${name} (params: ${preset.params.join(", ")})`
      : name
  );
}

/** The preset name lane guidance recommends, when the workflow declares it. */
const LANE_COMMIT_PRESET_NAME = "committed";

function formatIndexList(indices: readonly number[]): string {
  return `${indices.length === 1 ? "Step" : "Steps"} ${indices.join(", ")}`;
}

/**
 * Warning for appended steps that run with no end condition at all while the
 * workflow declares presets one of them could have attached. Lanes (D14) are
 * listed too and get their own sentence: a lane runs in its own worktree, so
 * a clean-tree preset can gate it even as a parallel member, and it should
 * carry one. Returns undefined when there is nothing to warn about.
 */
export function formatUngatedAppendedStepsWarning(
  workingFile: WorkingFile,
  ungatedIndices: readonly number[],
  ungatedLaneIndices: readonly number[] = []
): string | undefined {
  const indices = [...new Set([...ungatedIndices, ...ungatedLaneIndices])].sort(
    (a, b) => a - b
  );
  if (
    indices.length === 0 ||
    Object.keys(workingFile.conditions ?? {}).length === 0
  ) {
    return undefined;
  }
  const warning = `${formatIndexList(indices)} will run with no end condition, but this workflow declares condition presets: ${formatPresetList(workingFile)}. To gate a step, call ${MCP_EDIT_STEP_TOOL_NAME} with updates.endCondition: { "use": "<name>" }; ${MCP_WORKFLOW_STATUS_TOOL_NAME} lists each preset under metadata.conditionPresets.`;
  if (ungatedLaneIndices.length === 0) return warning;
  const lanes = [...ungatedLaneIndices].sort((a, b) => a - b);
  const recommended = getDeclaredPreset(
    workingFile.conditions,
    LANE_COMMIT_PRESET_NAME
  )
    ? ` such as { "use": "${LANE_COMMIT_PRESET_NAME}" }`
    : "";
  const lanePhrase =
    lanes.length === 1
      ? "is a lane and runs in its own worktree, so it"
      : "are lanes and run in their own worktree, so they";
  return `${warning} ${formatIndexList(lanes)} ${lanePhrase} should carry an end condition${recommended} that checks the work was committed.`;
}

/** Resolve an MCP preset reference into an ordinary, immutable step condition. */
export function materializeMcpConditionPreset(
  workingFile: WorkingFile,
  field: ConditionField,
  reference: McpConditionPresetUse,
  defaultMaxRetries = 0
): EndCondition | PreCondition {
  const preset = getDeclaredPreset(workingFile.conditions, reference.use);
  if (!preset) {
    throw new Error(
      `${field}: unknown condition preset '${reference.use}'. Available presets: ${formatPresetList(workingFile)}. ${MCP_WORKFLOW_STATUS_TOOL_NAME} lists each preset under metadata.conditionPresets.`
    );
  }

  const declaredParams = preset.params ?? [];
  const suppliedParams = reference.params ?? {};
  const env = preset.env ?? {};

  for (const name of declaredParams) {
    if (Object.prototype.hasOwnProperty.call(env, name)) {
      throw new Error(
        `${field}: preset '${reference.use}' declares param '${name}' that collides with its own env; the preset cannot be attached.`
      );
    }
    if (!Object.prototype.hasOwnProperty.call(suppliedParams, name)) {
      throw new Error(
        `${field}: preset '${reference.use}' requires param '${name}'.`
      );
    }
  }
  for (const name of Object.keys(suppliedParams)) {
    if (!declaredParams.includes(name)) {
      throw new Error(
        `${field}: param '${name}' is not declared by preset '${reference.use}'. Declared params: ${declaredParams.length > 0 ? declaredParams.join(", ") : "none"}.`
      );
    }
    const value = suppliedParams[name];
    if (value.length === 0) {
      throw new Error(`${field}: param '${name}' must not be empty.`);
    }
    if (value.length > MCP_CONDITION_PARAM_MAX_LENGTH) {
      throw new Error(
        `${field}: param '${name}' must be at most ${MCP_CONDITION_PARAM_MAX_LENGTH} characters.`
      );
    }
    if (value.includes("\0")) {
      throw new Error(`${field}: param '${name}' must not contain NUL.`);
    }
  }

  const presetLimit = resolveRetryBudgetMaxRetries(preset, defaultMaxRetries);
  const maxRetries = resolveMaxRetries(preset, reference, field, presetLimit);
  const condition = { ...preset };
  delete condition.params;
  const literalEnvKeys = Object.keys(suppliedParams);
  return {
    ...condition,
    env: { ...env, ...suppliedParams },
    ...(literalEnvKeys.length > 0 ? { mcpLiteralEnvKeys: literalEnvKeys } : {}),
    ...(reference.retryPrompt === undefined
      ? {}
      : { retryPrompt: reference.retryPrompt }),
    ...(reference.passRetryPrompt === undefined
      ? {}
      : { passRetryPrompt: reference.passRetryPrompt }),
    // A preset's own retryPrompt intentionally keeps using the user's retry default.
    ...(reference.maxRetries === undefined &&
    (reference.retryPrompt !== undefined ||
      reference.passRetryPrompt !== undefined) &&
    preset.retryPrompt === undefined
      ? { maxRetries: presetLimit }
      : {}),
    ...(maxRetries === undefined ? {} : { maxRetries }),
  } as EndCondition | PreCondition;
}

function resolveMaxRetries(
  preset: ConditionPreset,
  reference: McpConditionPresetUse,
  field: ConditionField,
  presetLimit: number
): number | undefined {
  if (reference.maxRetries === undefined) return preset.maxRetries;
  if (!Number.isInteger(reference.maxRetries)) {
    throw new Error(`${field}: maxRetries must be an integer.`);
  }
  if (
    presetLimit !== -1 &&
    (reference.maxRetries === -1 || reference.maxRetries > presetLimit)
  ) {
    throw new Error(
      `${field}: maxRetries ${reference.maxRetries} exceeds preset '${reference.use}' limit ${presetLimit}.`
    );
  }
  return reference.maxRetries;
}
