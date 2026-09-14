import {
  BOOLEAN_STRING_VALUES,
  DEFAULT_MAX_QUEUE_SIZE,
} from "../types/DashboardConstants";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "../types/CtrlYokeSettings";

/**
 * Read the queue size limit from the environment supplied to a harness's MCP
 * server. Invalid, missing, and non-positive values use the shared default.
 */
export function getMaxQueueSize(): number {
  const envValue = process.env.CTRLYOKE_MAX_QUEUE_SIZE;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_MAX_QUEUE_SIZE;
}

/** Whether queue-size enforcement has been explicitly disabled. */
export function isUnlimitedMode(): boolean {
  return process.env.CTRLYOKE_UNLIMITED_MODE === BOOLEAN_STRING_VALUES.TRUE;
}

/**
 * A resolved queue-capacity policy. Enforcement is the caller's to opt into:
 * the environment variables below are supplied only to a harness's MCP server
 * subprocess, so an in-process caller (the extension host, the CLI) that read
 * them would silently get the default limit instead of the user's configured
 * `queue.maxSize` / `queue.unlimitedMode`.
 */
export interface QueueLimitPolicy {
  maxQueueSize: number;
  unlimited: boolean;
}

/** Resolve the policy from the MCP server's environment. */
export function resolveQueueLimitPolicy(): QueueLimitPolicy {
  return { maxQueueSize: getMaxQueueSize(), unlimited: isUnlimitedMode() };
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
