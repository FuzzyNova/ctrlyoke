import { formatCompactTokenMagnitude } from "@root/utils/TokenFormatting";

/**
 * Numeric utility functions
 */

/** Restricts `value` to the inclusive range `[min, max]`. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Formats a non-negative magnitude using one decimal place for compact tiers.
 * Negative values stay unscaled, and non-finite values pass through using
 * their JavaScript string representation.
 */
export function formatMagnitude(value: number): string {
  if (!Number.isFinite(value)) {
    return value.toString();
  }
  if (value >= 1_000) {
    return formatCompactTokenMagnitude(value, { uppercaseSuffix: true });
  }
  return value.toString();
}
