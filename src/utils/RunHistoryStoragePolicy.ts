import type { RunHistoryLocation } from "../types/CtrlYokeSettings";

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

/** Reset the process-wide policy for isolated unit tests. */
export function resetRunHistoryLocationForTests(): void {
  frozenLocation = undefined;
}
