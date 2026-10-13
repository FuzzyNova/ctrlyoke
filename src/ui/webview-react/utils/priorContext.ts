import {
  PRIOR_CONTEXT_DETAILS,
  PRIOR_CONTEXT_KEYWORDS,
  PRIOR_CONTEXT_SELECTION_MODES,
  type PriorContextDetail,
} from "@root/types/DashboardConstants";
import {
  isPreviousStepsPriorContext,
  isWorkflowRunAddress,
  type PriorContext,
} from "@root/types/CtrlYokeTypes";
import { PRIOR_CONTEXT_SELECT_OPTIONS_META } from "@root/types/SchemaUiMetadata";

type PriorContextMode = keyof typeof PRIOR_CONTEXT_SELECT_OPTIONS_META;

function getMode(value: PriorContext): PriorContextMode {
  if (Array.isArray(value)) return PRIOR_CONTEXT_SELECTION_MODES.CUSTOM;
  if (isPreviousStepsPriorContext(value))
    return PRIOR_CONTEXT_SELECTION_MODES.PREVIOUS_COUNT;
  if (isWorkflowRunAddress(value)) return PRIOR_CONTEXT_SELECTION_MODES.RUN;
  return value as PriorContextMode;
}

/** Display label for every prior-context value, including object variants. */
export function formatPriorContextLabel(
  value: PriorContext,
  detail: PriorContextDetail = PRIOR_CONTEXT_DETAILS.FULL
): string {
  const suffix = detail === PRIOR_CONTEXT_DETAILS.SUMMARY ? " · summary" : "";
  if (isPreviousStepsPriorContext(value)) {
    return `${PRIOR_CONTEXT_SELECT_OPTIONS_META.previous.label} ${value.previous}${suffix}`;
  }
  const mode = getMode(value);
  const label =
    mode === PRIOR_CONTEXT_KEYWORDS.PREVIOUS
      ? "Previous step"
      : (PRIOR_CONTEXT_SELECT_OPTIONS_META[mode]?.label ?? String(value));
  return `${label}${suffix}`;
}
