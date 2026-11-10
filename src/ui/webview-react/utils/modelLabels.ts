import type { ModelOption } from "@store/settingsStore";
import {
  MODEL_NONE_LABELS,
  MODEL_OPTION_VALUES,
} from "@root/types/DashboardConstants";

/**
 * Compact label for a model value shown inside another label, such as
 * `Inherit (…)` or the footer quick picker's chip. `none` reads as
 * "Harness default" there instead of nesting the option's own parentheses.
 * Unknown ids show as themselves.
 */
export function modelSummaryLabel(
  value: string,
  models: ReadonlyArray<ModelOption>
): string {
  if (value === MODEL_OPTION_VALUES.NONE) return MODEL_NONE_LABELS.SHORT;
  return models.find((m) => m.value === value)?.label ?? value;
}
