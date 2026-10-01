import { UNLIMITED_LIMIT } from "../types/DashboardConstants";

/** Return whether a limit uses the shared unlimited sentinel. */
export function isUnlimited(limit: number): boolean {
  return limit === UNLIMITED_LIMIT;
}

/** Format a retry limit for user-facing text. */
export function formatRetryDenominator(maxRetries: number): string {
  return isUnlimited(maxRetries) ? "∞" : String(maxRetries);
}

/** Return whether a count is strictly greater than a finite limit. */
export function exceedsLimit(count: number, limit: number): boolean {
  return !isUnlimited(limit) && count > limit;
}
