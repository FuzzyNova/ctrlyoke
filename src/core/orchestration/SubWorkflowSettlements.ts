import { FINAL_STEP_PHASES } from "../../types/DashboardConstants";
import {
  isSubWorkflowStep,
  type SubWorkflowOutput,
  type WorkflowStep,
} from "../../types/CtrlYokeTypes";
import type { OutputExecutionTarget } from "../../types/OutputHistoryTypes";

/** One recorded `subWorkflowSettled` event, in timeline order. */
export interface SubWorkflowSettlement {
  target: OutputExecutionTarget;
  output: SubWorkflowOutput;
  /** The parent queue step's `stepId`, when the event recorded one. */
  stepId?: string;
}

/**
 * The parent queue step a settlement belongs to. The recorded `stepId` wins;
 * an event written before it was recorded falls back to the current step that
 * still links this child, then to the current step at the recorded index.
 */
export function resolveSettlementStepId(
  settlement: SubWorkflowSettlement,
  steps: readonly WorkflowStep[]
): string | undefined {
  if (settlement.target.kind !== FINAL_STEP_PHASES.QUEUE) return undefined;
  if (settlement.stepId) return settlement.stepId;
  const linked = steps.find(
    (step) =>
      isSubWorkflowStep(step) &&
      step._runtime?.childRunRef === settlement.output.childRunRef
  );
  const step = linked ?? steps[settlement.target.stepIndex];
  return step && isSubWorkflowStep(step) ? step._runtime?.stepId : undefined;
}

export interface LatestSubWorkflowSettlements {
  /** Latest settlement for each current queue step, by its current index. */
  queue: Map<number, SubWorkflowOutput>;
  /** Latest settlement of the latest finalStep pass that settled a child. */
  finalStep?: { passNumber: number; output: SubWorkflowOutput };
}

/**
 * Reduce settlements to what a step reports now: the latest one per queue
 * step (identity by `stepId`, so a reorder cannot misattribute a child) and
 * the latest finalStep pass. Later events win, so a child stopped and
 * continued reports its latest outcome.
 */
export function selectLatestSubWorkflowSettlements(
  settlements: readonly SubWorkflowSettlement[],
  steps: readonly WorkflowStep[]
): LatestSubWorkflowSettlements {
  const byStepId = new Map<string, SubWorkflowOutput>();
  const byRecordedIndex = new Map<number, SubWorkflowOutput>();
  let finalStep: LatestSubWorkflowSettlements["finalStep"];
  for (const settlement of settlements) {
    const { target, output } = settlement;
    if (target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
      const passNumber = target.loopIndex + 1;
      if (!finalStep || passNumber >= finalStep.passNumber)
        finalStep = { passNumber, output };
      continue;
    }
    const stepId = resolveSettlementStepId(settlement, steps);
    if (stepId) byStepId.set(stepId, output);
    else byRecordedIndex.set(target.stepIndex, output);
  }
  const queue = new Map<number, SubWorkflowOutput>();
  steps.forEach((step, index) => {
    const stepId = step._runtime?.stepId;
    const output =
      (stepId ? byStepId.get(stepId) : undefined) ?? byRecordedIndex.get(index);
    if (output) queue.set(index, output);
  });
  return { queue, ...(finalStep ? { finalStep } : {}) };
}
