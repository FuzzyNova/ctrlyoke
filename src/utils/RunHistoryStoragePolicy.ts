import type { RunHistoryLocation } from "../types/CtrlYokeSettings";
import { RUN_HISTORY_LOCATIONS } from "../types/DashboardConstants";

let frozenLocation: RunHistoryLocation | undefined;

/** Freeze the process-wide run-history location after configuration bootstrap. */
export function initializeRunHistoryLocation(
  location: RunHistoryLocation
): void {
  if (frozenLocation !== undefined) {
    throw new Error(
      `Run history location is already frozen as "${frozenLocation}".`
    );
  }
  frozenLocation = location;
}

/** Return the startup-frozen run-history location. */
export function getFrozenRunHistoryLocation(): RunHistoryLocation {
  if (frozenLocation === undefined) {
    throw new Error(
      "Run history location has not been initialized; initialize it after config bootstrap."
    );
  }
  return frozenLocation;
}

/** Return whether startup has already frozen the process-wide location. */
export function isRunHistoryLocationInitialized(): boolean {
  return frozenLocation !== undefined;
}

/** Parse the MCP environment representation, defaulting to the user scope. */
export function parseRunHistoryLocation(
  value: string | undefined
): RunHistoryLocation {
  if (value === undefined || value === RUN_HISTORY_LOCATIONS.USER) {
    return RUN_HISTORY_LOCATIONS.USER;
  }
  if (value === RUN_HISTORY_LOCATIONS.WORKSPACE) {
    return RUN_HISTORY_LOCATIONS.WORKSPACE;
  }
  throw new Error(`Unsupported run history location: ${value}`);
}

/** Reset the process-wide policy for isolated unit tests. */
export function resetRunHistoryLocationForTests(): void {
  frozenLocation = undefined;
}
