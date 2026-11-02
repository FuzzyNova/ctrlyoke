import type { HarnessId } from "../../../types/DashboardConstants";

export function buildSessionResumeWarning(
  promptIndex: number,
  harness: HarnessId,
  reason: "invalid-id" | "not-found"
): string {
  const detail =
    reason === "invalid-id"
      ? "its ID is not valid"
      : "it was not found on this machine";
  return `Step ${promptIndex + 1} could not resume the ${harness} session because ${detail}. Started a new session.`;
}
