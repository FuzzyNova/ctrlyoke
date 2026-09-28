import { DEFAULT_MAX_STEPS } from "../types/DashboardConstants";

/**
 * Parse range notation like "1,2,4-10" into a sorted, deduplicated number[].
 * Returns null if the input is invalid or empty.
 */
export function parseRangeNotation(text: string): number[] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(",");
  const result = new Set<number>();
  let expandedCount = 0;

  for (const part of parts) {
    const p = part.trim();
    if (!p) return null;

    const rangeMatch = p.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 1 ||
        end < 1 ||
        start > end
      ) {
        return null;
      }
      const rangeCount = end - start + 1;
      if (rangeCount > DEFAULT_MAX_STEPS - expandedCount) return null;
      expandedCount += rangeCount;
      for (let i = start; i <= end; i++) result.add(i);
      continue;
    }

    if (/^\d+$/.test(p)) {
      const n = parseInt(p, 10);
      if (!Number.isSafeInteger(n) || n < 1) return null;
      if (expandedCount >= DEFAULT_MAX_STEPS) return null;
      expandedCount++;
      result.add(n);
      continue;
    }

    return null;
  }

  if (result.size === 0) return null;
  return [...result].sort((a, b) => a - b);
}
