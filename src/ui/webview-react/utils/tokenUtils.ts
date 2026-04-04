/**
 * Returns the context window usage percentage (0-100), or undefined if data unavailable.
 */
export function calcContextPct(
  contextWindowUsed: number | undefined,
  contextWindowSize: number | undefined
): number | undefined {
  if (contextWindowUsed === undefined || !contextWindowSize) return undefined;
  return Math.round((contextWindowUsed / contextWindowSize) * 100);
}
