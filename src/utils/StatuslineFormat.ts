export type UsagePercentDirection = "used" | "remaining";

/** Convert a canonical used percentage into the user's display direction. */
export function formatUsagePercentForDisplay(
  usedPercent: number,
  direction: UsagePercentDirection
): number {
  return direction === "remaining" ? 100 - usedPercent : usedPercent;
}
