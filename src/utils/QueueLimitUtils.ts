import {
  BOOLEAN_STRING_VALUES,
  DEFAULT_MAX_QUEUE_SIZE,
} from "../types/DashboardConstants";

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
