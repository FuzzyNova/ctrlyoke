import { PRIOR_CONTEXT_SELECTION_MODES } from "@root/types/DashboardConstants";
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
export function formatPriorContextLabel(value: PriorContext): string {
  if (isPreviousStepsPriorContext(value)) {
    return `${PRIOR_CONTEXT_SELECT_OPTIONS_META.previous.label} ${value.previous}`;
  }
  const mode = getMode(value);
  return PRIOR_CONTEXT_SELECT_OPTIONS_META[mode]?.label ?? String(value);
}
