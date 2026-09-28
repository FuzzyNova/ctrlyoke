import {
  DEFAULT_MAX_STEPS,
  UNLIMITED_LIMIT,
} from "../types/DashboardConstants";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "../types/CtrlYokeSettings";

/**
 * Read the workflow step limit from the environment supplied to a harness's MCP
 * server. Invalid or missing values use the shared default. In-process callers
 * must read `ConfigurationUtils` instead of this environment accessor.
 */
export function getGlobalMaxSteps(): number {
  const envValue = process.env.CTRLYOKE_MAX_STEPS;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && (parsed === UNLIMITED_LIMIT || parsed > 0)) {
      return parsed;
    }
  }
  return DEFAULT_MAX_STEPS;
}

export type EffectiveMaxStepsSource =
  "workflow maxSteps" | "setting queue.maxSteps";

/** An explicit workflow value, including -1, overrides the global setting. */
export function resolveEffectiveMaxSteps(
  workflowMaxSteps: number | undefined,
  globalMaxSteps: number
): number {
  return workflowMaxSteps === undefined ? globalMaxSteps : workflowMaxSteps;
}

export function getEffectiveMaxStepsSource(
  workflowMaxSteps: number | undefined
): EffectiveMaxStepsSource {
  return workflowMaxSteps === undefined
    ? "setting queue.maxSteps"
    : "workflow maxSteps";
}

export function buildStepLimitError(
  count: number,
  limit: number,
  source: EffectiveMaxStepsSource
): string {
  return `Step limit reached: this run has ${count}/${limit} steps (${source}: ${limit}). Do not retry; finish without appending.`;
}

/**
 * Read the active parallel-group width exported to a harness MCP process.
 * Invalid, missing, and non-positive values use the shared settings default.
 */
export function getMaxParallelSteps(): number {
  const envValue = process.env.CTRLYOKE_MAX_PARALLEL_STEPS;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return CTRLYOKE_SETTINGS_DEFAULTS.queue.maxParallelSteps;
}
