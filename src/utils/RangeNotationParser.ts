/** Sanity bound against accidental huge expansions; workflow limits are separate. */
export const MAX_RANGE_NOTATION_INDICES = 10_000;

/**
 * Parse range notation like "1,2,4-10" into a sorted, deduplicated number[].
 * Returns null if the input is invalid or empty.
 */
export function parseRangeNotation(text: string): number[] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(",");
  const result = new Set<number>();
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
      if (rangeCount > MAX_RANGE_NOTATION_INDICES - result.size) return null;
      for (let i = start; i <= end; i++) result.add(i);
      continue;
    }

    if (/^\d+$/.test(p)) {
      const n = parseInt(p, 10);
      if (!Number.isSafeInteger(n) || n < 1) return null;
      if (!result.has(n) && result.size >= MAX_RANGE_NOTATION_INDICES)
        return null;
      result.add(n);
      continue;
    }

    return null;
  }

  if (result.size === 0) return null;
  return [...result].sort((a, b) => a - b);
}
