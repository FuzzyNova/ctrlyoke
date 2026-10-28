/**
 * Accessible names for the output pane's landmarks: the heading on each step
 * header and the article around each assistant message. Screen-reader users
 * move through the pane by these (H for headings in NVDA/JAWS, the rotor in
 * VoiceOver), so each name says which step it is and how it went.
 */
import { FINAL_STEP_PHASES } from "@root/types/DashboardConstants";
import { formatStepTargetLabel } from "@root/utils/FinalStepLabels";
import type { OutputMessageTarget } from "./outputProjection";

/** The heading level of a step header within the output pane. */
export const OUTPUT_STEP_HEADING_LEVEL = 3;

export const STEP_HEADING_STATES = {
  RUNNING: "running",
  STOPPED: "stopped",
  FAILED: "failed",
  FINISHED: "finished",
} as const;

export type StepHeadingState =
  (typeof STEP_HEADING_STATES)[keyof typeof STEP_HEADING_STATES];

export interface StepHeadingInput {
  /** "Step 3", or a condition script's own label such as "End condition". */
  label: string;
  name?: string;
  /** Run/retry badge, e.g. "Run 2 · Retry 1". */
  executionBadge?: string;
  harness?: string;
  state: StepHeadingState;
}

/** "Step 3, Fix tests, Retry 1, Claude, running". */
export function describeStepHeading(input: StepHeadingInput): string {
  return [
    input.label,
    input.name?.trim(),
    input.executionBadge,
    input.harness,
    input.state,
  ]
    .filter(Boolean)
    .join(", ");
}

/** Accessible name of an assistant message: "Response, Step 3". */
export function describeResponseArticle(target: OutputMessageTarget): string {
  return `Response, ${formatStepTargetLabel(
    target.kind === FINAL_STEP_PHASES.FINAL_STEP,
    target.index
  )}`;
}
