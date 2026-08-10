/**
 * Time utility functions
 */

/**
 * Get current timestamp in milliseconds
 * @returns Current time in milliseconds since epoch
 */
export function getTimestamp(): number {
  return new Date().getTime();
}

/**
 * Format timestamp as locale time string
 * @param timestampMs - Timestamp in milliseconds
 * @returns Formatted time string (e.g., "2:30:45 PM")
 */
export function formatTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString();
}

/**
 * Format timestamp as relative time ago
 *
 * @param timestampMs - Timestamp in milliseconds
 * @returns Relative time string
 *
 * @example
 * formatRelativeTime(Date.now() - 30000) // "just now"
 * formatRelativeTime(Date.now() - 60000) // "1 min"
 * formatRelativeTime(Date.now() - 2700000) // "45 min"
 * formatRelativeTime(Date.now() - 7200000) // "2 hr"
 * formatRelativeTime(Date.now() - 172800000) // "2 days"
 */
export function formatRelativeTime(timestampMs: number): string {
  const now = Date.now();
  const diffMs = now - timestampMs;

  // Calculate time units
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  // Format based on largest unit
  if (days > 0) {
    return `${days} day${days !== 1 ? "s" : ""}`;
  } else if (hours > 0) {
    return `${hours} hr`;
  } else if (minutes > 0) {
    return `${minutes} min`;
  } else {
    return "just now";
  }
}

/**
 * Format timestamp as verbose relative time ago
 *
 * Uses a verbose format matching the RecentWorkflows display style.
 * Returns undefined for undefined input (no timestamp available).
 *
 * @param timestamp - Timestamp in milliseconds, or undefined
 * @returns Verbose relative time string, or undefined
 *
 * @example
 * formatRelativeTimeVerbose(Date.now() - 30000)    // "Just now"
 * formatRelativeTimeVerbose(Date.now() - 90000)    // "1 minute ago"
 * formatRelativeTimeVerbose(Date.now() - 7200000)  // "2 hours ago"
 * formatRelativeTimeVerbose(Date.now() - 86400000) // "Yesterday"
 * formatRelativeTimeVerbose(Date.now() - 172800000)// "2 days ago"
 * formatRelativeTimeVerbose(undefined)             // undefined
 */
export function formatRelativeTimeVerbose(
  timestamp: number | undefined
): string | undefined {
  if (timestamp === undefined) {
    return undefined;
  }

  const now = Date.now();
  const diff = now - timestamp;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return days === 1 ? "Yesterday" : `${days} days ago`;
  }
  if (hours > 0) {
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  if (minutes > 0) {
    return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  }
  return "Just now";
}

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

  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round(
    (startOfDay(target) - startOfDay(reference)) / 86_400_000
  );

  if (dayDiff === 0) {
    return `${time} today`;
  }
  if (dayDiff === 1) {
    return `${time} tomorrow`;
  }
  if (dayDiff > 1 && dayDiff < 7) {
    return `${time} ${target.toLocaleDateString(undefined, { weekday: "short" })}`;
  }
  return `${time} ${target.toLocaleDateString(undefined, { month: "numeric", day: "numeric" })}`;
}

/**
 * Format duration in milliseconds to human-readable string
 * @param durationMs - Duration in milliseconds
 * @returns Formatted duration string (e.g., "1m 30s", "2h 15m")
 */
export function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0
      ? `${hours}h ${remainingMinutes}m`
      : `${hours}h`;
  } else if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return remainingSeconds > 0
      ? `${minutes}m ${remainingSeconds}s`
      : `${minutes}m`;
  } else {
    return `${seconds}s`;
  }
}
