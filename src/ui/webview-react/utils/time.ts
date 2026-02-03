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
