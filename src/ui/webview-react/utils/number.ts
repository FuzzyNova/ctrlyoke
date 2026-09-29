import { formatCompactTokenMagnitude } from "@root/utils/CompactMagnitude";

/**
 * Numeric utility functions
 */

/** Restricts `value` to the inclusive range `[min, max]`. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const BYTES_PER_KIBIBYTE = 1024;
const BYTE_UNITS = ["KB", "MB", "GB", "TB"] as const;

/**
 * Formats a byte count for display: `512 B`, `1.5 KB`, `12 KB`, `3.2 MB`.
 * Binary (1024) units with one trimmed decimal place. The unit follows the
 * rounded value, so 1023.96 KB promotes to `1 MB` rather than `1024 KB`.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < BYTES_PER_KIBIBYTE) {
    return `${bytes} B`;
  }
  let value = bytes / BYTES_PER_KIBIBYTE;
  let unitIndex = 0;
  while (
    unitIndex < BYTE_UNITS.length - 1 &&
    Number(value.toFixed(1)) >= BYTES_PER_KIBIBYTE
  ) {
    value /= BYTES_PER_KIBIBYTE;
    unitIndex += 1;
  }
  return `${value.toFixed(1).replace(/\.0$/, "")} ${BYTE_UNITS[unitIndex]}`;
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
