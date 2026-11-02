import {
  SESSION_AVAILABILITY,
  type HarnessId,
  type SessionAvailability,
} from "../../../types/DashboardConstants";

/** Why a resolved session was not resumed. */
export type SessionResumeFailure =
  typeof SESSION_AVAILABILITY.MISSING | typeof SESSION_AVAILABILITY.MALFORMED;

export function isSessionResumeFailure(
  availability: SessionAvailability | undefined
): availability is SessionResumeFailure {
  return (
    availability === SESSION_AVAILABILITY.MISSING ||
    availability === SESSION_AVAILABILITY.MALFORMED
  );
}

/**
 * The status line every path that drops a resume shows
 * (dev/implemented/RUN_EXPORT_PLAN.md §5.4): the preflight probe, a malformed ID,
 * and a harness that rejects the resume at runtime.
 */
export function buildSessionResumeWarning(
  promptIndex: number,
  harness: HarnessId,
  reason: SessionResumeFailure
): string {
  const detail =
    reason === SESSION_AVAILABILITY.MALFORMED
      ? `its ID is not a valid ${harness} session ID`
      : "it was not found on this machine";
  return `Step ${promptIndex + 1} could not resume the ${harness} session because ${detail}. Started a new session.`;
}
