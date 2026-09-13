import type { RunHistoryLocation } from "../types/CtrlYokeSettings";
import { RUN_HISTORY_LOCATIONS } from "../types/DashboardConstants";

let frozenLocation: RunHistoryLocation | undefined;

/**
 * Opening of the error {@link initializeRunHistoryLocation} throws on a second
 * call. Callers that legitimately race the freeze match on this rather than on
 * the whole message, because the trailing location varies — see
 * {@link isRunHistoryLocationFrozenError}.
 */
export const RUN_HISTORY_LOCATION_FROZEN_ERROR_PREFIX =
  "Run history location is already frozen";

/** Freeze the process-wide run-history location after configuration bootstrap. */
export function initializeRunHistoryLocation(
  location: RunHistoryLocation
): void {
  if (frozenLocation !== undefined) {
    throw new Error(
      `${RUN_HISTORY_LOCATION_FROZEN_ERROR_PREFIX} as "${frozenLocation}".`
    );
  }
  frozenLocation = location;
}

/**
 * Whether `error` is the "already frozen" rejection above.
 *
 * Matching the message is the only option across a bundle boundary: `out/
 * mcp-server.js` and `out/extension.js` each carry their own copy of this
 * module, so an `instanceof` check against the importer's copy would not
 * recognise a throw from theirs.
 */
export function isRunHistoryLocationFrozenError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith(RUN_HISTORY_LOCATION_FROZEN_ERROR_PREFIX)
  );
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
