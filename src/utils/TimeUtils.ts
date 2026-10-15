/**
 * Format a future timestamp for compact display, e.g. in a reset-time tooltip.
 *
 * @param timestampMs - Future timestamp in milliseconds
 * @param now - Reference "current" time in milliseconds (defaults to Date.now(), pass explicitly in tests)
 * @returns Compact time string relative to `now`
 *
 * @example
 * formatFutureTime(fiveThisAfternoon)                 // "5:00 PM today"
 * formatFutureTime(fiveTomorrowAfternoon)              // "5:00 PM tomorrow"
 * formatFutureTime(fiveNextWednesdayAfternoon)         // "5:00 PM Wed"
 * formatFutureTime(fiveInThreeWeeksAfternoon)          // "5:00 PM 8/31"
 */
export function formatFutureTime(
  timestampMs: number,
  now: number = Date.now()
): string {
  const target = new Date(timestampMs);
  const reference = new Date(now);
  const time = target.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  const startOfDay = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round(
    (startOfDay(target) - startOfDay(reference)) / 86_400_000
  );

  if (dayDiff === 0) return `${time} today`;
  if (dayDiff === 1) return `${time} tomorrow`;
  if (dayDiff > 1 && dayDiff < 7) {
    return `${time} ${target.toLocaleDateString(undefined, { weekday: "short" })}`;
  }
  return `${time} ${target.toLocaleDateString(undefined, { month: "numeric", day: "numeric" })}`;
}
