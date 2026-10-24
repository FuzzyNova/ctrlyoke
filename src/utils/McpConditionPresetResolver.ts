import type {
  ConditionPreset,
  EndCondition,
  PreCondition,
  WorkingFile,
} from "../types/CtrlYokeTypes";
import type { McpConditionPresetUse } from "./McpToolDefinitions";

/** Maximum size of one caller-provided environment value for a preset. */
export const MCP_CONDITION_PARAM_MAX_LENGTH = 4096;

type ConditionField = "endCondition" | "preCondition";

/** Resolve an MCP preset reference into an ordinary, immutable step condition. */
export function materializeMcpConditionPreset(
  workingFile: WorkingFile,
  field: ConditionField,
  reference: McpConditionPresetUse
): EndCondition | PreCondition {
  const conditions = workingFile.conditions ?? {};
  const preset = conditions[reference.use];
  if (!preset) {
    const available = Object.keys(conditions);
    throw new Error(
      `${field}: unknown condition preset '${reference.use}'. Available presets: ${available.length > 0 ? available.join(", ") : "none"}.`
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

  const maxRetries = resolveMaxRetries(preset, reference, field);
  const condition = { ...preset };
  delete condition.params;
  return {
    ...condition,
    env: { ...env, ...suppliedParams },
    ...(reference.retryPrompt === undefined
      ? {}
      : { retryPrompt: reference.retryPrompt }),
    ...(reference.passRetryPrompt === undefined
      ? {}
      : { passRetryPrompt: reference.passRetryPrompt }),
    ...(maxRetries === undefined ? {} : { maxRetries }),
  } as EndCondition | PreCondition;
}

function resolveMaxRetries(
  preset: ConditionPreset,
  reference: McpConditionPresetUse,
  field: ConditionField
): number | undefined {
  if (reference.maxRetries === undefined) return preset.maxRetries;
  if (!Number.isInteger(reference.maxRetries)) {
    throw new Error(`${field}: maxRetries must be an integer.`);
  }
  const presetLimit = preset.maxRetries ?? 0;
  if (presetLimit !== -1 && reference.maxRetries > presetLimit) {
    throw new Error(
      `${field}: maxRetries ${reference.maxRetries} exceeds preset '${reference.use}' limit ${presetLimit}.`
    );
  }
  return reference.maxRetries;
}
