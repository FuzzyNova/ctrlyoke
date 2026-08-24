/**
 * Shared fill-color thresholds for usage percentage bars (workflow step
 * context bar, quota usage bars). Change the thresholds/classes here so
 * every bar updates together.
 */
const USAGE_BAR_ERROR_THRESHOLD = 85;
const USAGE_BAR_WARNING_THRESHOLD = 70;

export function getUsageBarColorClass(percent: number): string {
  if (percent >= USAGE_BAR_ERROR_THRESHOLD) return "bg-error-fg opacity-90";
  if (percent >= USAGE_BAR_WARNING_THRESHOLD) return "bg-warning-fg opacity-85";
  return "bg-info-fg opacity-80";
}
