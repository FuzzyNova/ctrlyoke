import { DEFAULT_MAX_STEPS } from "../types/DashboardConstants";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "../types/CtrlYokeSettings";

/**
 * Read the workflow step limit from the environment supplied to a harness's MCP
 * server. Invalid or missing values use the shared default.
 */
export function getGlobalMaxSteps(): number {
  const envValue = process.env.CTRLYOKE_MAX_STEPS;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && (parsed === -1 || parsed > 0)) {
      return parsed;
    }
  }
  return DEFAULT_MAX_STEPS;
}

/**
 * A resolved queue-capacity policy. Enforcement is the caller's to opt into:
 * the environment variables below are supplied only to a harness's MCP server
 * subprocess, so an in-process caller (the extension host, the CLI) that read
 * them would silently get the default limit instead of the user's configured
 * `queue.maxSteps`.
 */
export interface QueueLimitPolicy {
  maxSteps: number;
}

/** Resolve the policy from the MCP server's environment. */
export function resolveQueueLimitPolicy(): QueueLimitPolicy {
  return { maxSteps: getGlobalMaxSteps() };
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
