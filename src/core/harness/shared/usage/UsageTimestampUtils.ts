/** Unix epoch seconds are below this threshold; ctrlyoke persists milliseconds. */
export const UNIX_SECONDS_THRESHOLD = 100_000_000_000;

/**
 * Normalize provider timestamps at the boundary into epoch milliseconds.
 * Codex supplies Unix seconds while Claude status-line payloads supply ISO text.
 */
export function normalizeUsageTimestamp(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return undefined;
    }
    const milliseconds =
      Math.abs(value) < UNIX_SECONDS_THRESHOLD ? value * 1000 : value;
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  return undefined;
}
