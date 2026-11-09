import {
  FINAL_STEP_PHASES,
  getExecutionPhaseKeySuffix,
  type ExecutionPhase,
} from "../types/DashboardConstants";
import type { OutputExecutionTarget } from "../types/OutputHistoryTypes";

export type OutputTargetKey = `queue:${number}` | `final:${number}`;

/**
 * The one producer of output-target keys (`queue:<stepIndex>`, `final:<loopIndex>`).
 * These strings are looked up across modules and appear in CLI `--json` output,
 * so a hand-built literal that drifts silently turns lookups into misses.
 */
export function queueTargetKey(stepIndex: number): OutputTargetKey {
  return `queue:${stepIndex}`;
}

export function finalTargetKey(loopIndex: number): OutputTargetKey {
  return `final:${loopIndex}`;
}

export function outputTargetKey(
  target: OutputExecutionTarget
): OutputTargetKey {
  return target.kind === FINAL_STEP_PHASES.QUEUE
    ? queueTargetKey(target.stepIndex)
    : finalTargetKey(target.loopIndex);
}

export function outputAttemptKey(
  target: OutputExecutionTarget,
  runIndex: number,
  attemptIndex: number,
  phase?: ExecutionPhase
): string {
  return `${outputTargetKey(target)}:run:${runIndex}:attempt:${attemptIndex}${getExecutionPhaseKeySuffix(phase)}`;
}
