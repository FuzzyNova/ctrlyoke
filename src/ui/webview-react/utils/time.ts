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
 * Format timestamp as a locale date + time string, for contexts (like
 * tooltips) that should show the actual moment rather than a relative label.
 * @param value - Timestamp in milliseconds, or undefined
 * @returns Formatted date/time string, or "Not available" when undefined
 */
export function formatTimestamp(value: number | undefined): string {
  return value === undefined
    ? "Not available"
    : new Date(value).toLocaleString();
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
 * @param now - Reference "current" time in milliseconds (defaults to Date.now(), pass explicitly in tests)
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
  timestamp: number | undefined,
  now: number = Date.now()
): string | undefined {
  if (timestamp === undefined) {
    return undefined;
  }

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

export { formatFutureTime } from "@root/utils/TimeUtils";

/** Below this, durations carry tenths of a second (`0:59.9`, then `1:00`). */
export const CLOCK_DURATION_TENTHS_BELOW_MS = 60_000;

function splitDuration(durationMs: number): {
  hours: number;
  minutes: number;
  seconds: number;
  /** Set only under a minute: floored tenths of a second. */
  tenths?: number;
} {
  // Round to whole milliseconds first so float noise from `seconds * 1000`
  // (4.35 * 1000 === 4349.999…) cannot floor a tenth away.
  const totalMs = Math.max(0, Math.round(durationMs));
  const totalSeconds = Math.floor(totalMs / 1000);
  return {
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor(totalSeconds / 60) % 60,
    seconds: totalSeconds % 60,
    ...(totalMs < CLOCK_DURATION_TENTHS_BELOW_MS
      ? { tenths: Math.floor(totalMs / 100) % 10 }
      : {}),
  };
}

/**
 * Format a step or run duration as a clock: `m:ss.t` under a minute, `m:ss`
 * under an hour, `h:mm:ss` from an hour on. This is the dashboard's one format
 * for how long something ran, so a ticking run timer and the settled value it
 * ends at read the same. Values are floored, matching a ticking clock.
 *
 * @example
 * formatClockDuration(7_400)      // "0:07.4"
 * formatClockDuration(59_990)     // "0:59.9"
 * formatClockDuration(149_700)    // "2:29"
 * formatClockDuration(8_419_000)  // "2:20:19"
 */
export function formatClockDuration(durationMs: number): string {
  const { hours, minutes, seconds, tenths } = splitDuration(durationMs);
  const ss = seconds.toString().padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${ss}`;
  }
  return tenths === undefined ? `${minutes}:${ss}` : `0:${ss}.${tenths}`;
}

/**
 * The spoken form of `formatClockDuration`, for accessible names: a screen
 * reader reads "2:29" as "two colon twenty-nine".
 *
 * @example
 * formatSpokenDuration(7_400)     // "7.4 seconds"
 * formatSpokenDuration(149_700)   // "2 minutes 29 seconds"
 * formatSpokenDuration(3_600_000) // "1 hour"
 */
export function formatSpokenDuration(durationMs: number): string {
  const { hours, minutes, seconds, tenths } = splitDuration(durationMs);
  if (tenths !== undefined) {
    return `${seconds}.${tenths} seconds`;
  }
  const unit = (value: number, name: string) =>
    `${value} ${name}${value === 1 ? "" : "s"}`;
  const parts = [
    hours > 0 && unit(hours, "hour"),
    minutes > 0 && unit(minutes, "minute"),
    seconds > 0 && unit(seconds, "second"),
  ];
  return parts.filter(Boolean).join(" ");
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
