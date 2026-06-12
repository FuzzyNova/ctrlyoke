import { STEP_TYPES } from "@root/types/DashboardConstants";
import type { WorkflowStep } from "../store/workflowStore";

/** Preview of what auto-resume would do for a blank Session ID field. */
export interface AutoResumePreview {
  /** Whether a prior step's session can be auto-resumed. */
  resumable: boolean;
  /** Human-readable label for the step that would be resumed, e.g. `Step 3`. */
  stepLabel?: string;
}

/**
 * Mirrors `SessionResolver.autoResumeFromPrevious()`: searches steps before
 * `beforeIndex` (most recent first) for the first one whose recorded
 * `_runtime.harness` matches `harness` and that has a `_runtime.sessionId`.
 */
export function getAutoResumePreview(
  steps: WorkflowStep[],
  beforeIndex: number,
  harness: string | undefined
): AutoResumePreview {
  if (!harness) {
    return { resumable: false };
  }

  const start = Math.min(beforeIndex, steps.length);
  for (let i = start - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.type === STEP_TYPES.SCRIPT) {
      continue;
    }
    const runtime = step._runtime;
    if (runtime?.harness === harness && runtime?.sessionId) {
      return {
        resumable: true,
        stepLabel: step.name ? `Step ${i + 1} ("${step.name}")` : `Step ${i + 1}`,
      };
    }
  }

  return { resumable: false };
}
