/** Shared compact token-count units, ordered from smallest to largest. */
export const TOKEN_COUNT_UNIT_LADDER = [
  { threshold: 1_000, divisor: 1_000, suffix: "k" },
  { threshold: 1_000_000, divisor: 1_000_000, suffix: "M" },
  { threshold: 1_000_000_000, divisor: 1_000_000_000, suffix: "B" },
] as const;

export interface CompactTokenMagnitudeOptions {
  decimalPlaces?: number;
  trimTrailingZero?: boolean;
  uppercaseSuffix?: boolean;
}

/**
 * Format a non-negative token magnitude using the shared unit ladder. Unit
 * selection follows the rounded display value, so a result that reaches 1000
 * promotes to the next unit instead of displaying as 1000k/1000M.
 */
export function formatCompactTokenMagnitude(
  value: number,
  options: CompactTokenMagnitudeOptions = {}
): string {
  const decimalPlaces = options.decimalPlaces ?? 1;
  if (value < TOKEN_COUNT_UNIT_LADDER[0].threshold) return String(value);
  let unitIndex = 0;
  for (let index = 1; index < TOKEN_COUNT_UNIT_LADDER.length; index += 1) {
    if (value >= TOKEN_COUNT_UNIT_LADDER[index].threshold) {
      unitIndex = index;
    }
  }

  while (unitIndex < TOKEN_COUNT_UNIT_LADDER.length - 1) {
    const unit = TOKEN_COUNT_UNIT_LADDER[unitIndex];
    const rounded = Number((value / unit.divisor).toFixed(decimalPlaces));
    if (rounded < 1_000) break;
    unitIndex += 1;
  }

  const unit = TOKEN_COUNT_UNIT_LADDER[unitIndex];
  let formatted = (value / unit.divisor).toFixed(decimalPlaces);
  if (options.trimTrailingZero) {
    formatted = formatted.replace(/\.0+$/, "");
  }
  const suffix = options.uppercaseSuffix
    ? unit.suffix.toUpperCase()
    : unit.suffix;
  return `${formatted}${suffix}`;
}
