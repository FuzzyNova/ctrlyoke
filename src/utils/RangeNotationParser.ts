/**
 * Parse range notation like "1,2,4-10" into a sorted, deduplicated number[].
 * Returns null if the input is invalid or empty.
 */
export function parseRangeNotation(text: string): number[] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(",");
  const result: number[] = [];

  for (const part of parts) {
    const p = part.trim();
    if (!p) return null;

    const rangeMatch = p.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (start < 1 || end < 1 || start > end) return null;
      for (let i = start; i <= end; i++) result.push(i);
      continue;
    }

    if (/^\d+$/.test(p)) {
      const n = parseInt(p, 10);
      if (n < 1) return null;
      result.push(n);
      continue;
    }

    return null;
  }

  if (result.length === 0) return null;
  return [...new Set(result)].sort((a, b) => a - b);
}
