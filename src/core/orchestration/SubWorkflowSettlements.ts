import { FINAL_STEP_PHASES } from "../../types/DashboardConstants";
import {
  isSubWorkflowStep,
  type FinalStepRuntimeState,
  type StepLifecycleRuntime,
  type SubWorkflowOutput,
  type SubWorkflowRuntimeMetadata,
  type WorkflowStep,
} from "../../types/CtrlYokeTypes";
import type { OutputExecutionTarget } from "../../types/OutputHistoryTypes";
import type { SubWorkflowSettledEvent } from "../../types/WorkflowTimelineTypes";

/** One recorded `subWorkflowSettled` event, in timeline order. */
export interface SubWorkflowSettlement {
  target: OutputExecutionTarget;
  output: SubWorkflowOutput;
  /** The parent queue step's `stepId`, when the event recorded one. */
  stepId?: string;
  /** When the settlement was recorded. */
  timestampMs: number;
}

/** The one conversion from a timeline event to a settlement. */
export function toSubWorkflowSettlement(
  event: SubWorkflowSettledEvent
): SubWorkflowSettlement {
  return {
    target: event.target,
    output: event.payload,
    ...(event.stepId !== undefined ? { stepId: event.stepId } : {}),
    timestampMs: event.timestampMs,
  };
}

/**
 * A child run's identity. A `RunRef` is unique only within its own lineage,
 * so two children of different workflows can share one; the pair cannot.
 */
export function subWorkflowChildKey(
  child: Required<Pick<SubWorkflowOutput, "childWorkflowKey" | "childRunRef">>
): string {
  return JSON.stringify([child.childWorkflowKey, child.childRunRef]);
}

function linksChild(
  runtime: SubWorkflowRuntimeMetadata | undefined,
  output: SubWorkflowOutput
): boolean {
  // A settlement with no child identity (the step failed before a child run
  // existed) links nothing: two absent identities are not the same child.
  return (
    output.childWorkflowKey !== undefined &&
    output.childRunRef !== undefined &&
    runtime?.childWorkflowKey === output.childWorkflowKey &&
    runtime.childRunRef === output.childRunRef
  );
}

/** A settlement written for a step that failed before any child run existed. */
export function hasNoChildRun(output: SubWorkflowOutput): boolean {
  return (
    output.childWorkflowKey === undefined || output.childRunRef === undefined
  );
}

/** Claimed for its current execution and not settled yet. */
function isExecuting(
  window: Pick<StepLifecycleRuntime, "startedAt" | "completedAt"> | undefined
): window is { startedAt: number } {
  return window?.startedAt !== undefined && window.completedAt === undefined;
}

/**
 * Whether a settlement is an earlier execution's outcome of the child its
 * owner is running now. A stopped child continues under the same run, so its
 * `cancelled` settlement stays in the timeline while it runs again; it is
 * not that run's current status.
 */
function predatesCurrentExecution(
  settlement: SubWorkflowSettlement,
  runtime: SubWorkflowRuntimeMetadata | undefined,
  window: Pick<StepLifecycleRuntime, "startedAt" | "completedAt"> | undefined
): boolean {
  return (
    isExecuting(window) &&
    (linksChild(runtime, settlement.output) ||
      hasNoChildRun(settlement.output)) &&
    settlement.timestampMs < window.startedAt
  );
}

/** Where a settlement belongs in the run's current definition. */
export type AttributedSubWorkflowSettlement =
  | {
      kind: typeof FINAL_STEP_PHASES.QUEUE;
      settlement: SubWorkflowSettlement;
      /** The owning queue step's `stepId`, when it has one. */
      stepId?: string;
      /** The owning step's current index; absent once it was removed. */
      stepIndex?: number;
    }
  | {
      kind: typeof FINAL_STEP_PHASES.FINAL_STEP;
      settlement: SubWorkflowSettlement;
      passNumber: number;
    };

export interface SubWorkflowSettlementContext {
  steps: readonly WorkflowStep[];
  finalStep?: WorkflowStep;
  finalStepRuntime?: FinalStepRuntimeState;
}

/**
 * The queue step a settlement belongs to, or undefined when it belongs to
 * none. The recorded `stepId` wins; an event written before it was recorded
 * falls back to the current step that links this exact child, then to the
 * current step at the recorded index if that is still a workflow step.
 */
function attributeQueueSettlement(
  settlement: SubWorkflowSettlement,
  steps: readonly WorkflowStep[]
): { stepId?: string; stepIndex?: number } | undefined {
  if (settlement.target.kind !== FINAL_STEP_PHASES.QUEUE) return undefined;
  if (settlement.stepId) {
    const stepIndex = steps.findIndex(
      (step) => step._runtime?.stepId === settlement.stepId
    );
    return {
      stepId: settlement.stepId,
      ...(stepIndex >= 0 ? { stepIndex } : {}),
    };
  }
  const linked = steps.findIndex(
    (step) =>
      isSubWorkflowStep(step) && linksChild(step._runtime, settlement.output)
  );
  const recorded = settlement.target.stepIndex;
  const stepIndex =
    linked >= 0
      ? linked
      : steps[recorded] && isSubWorkflowStep(steps[recorded])
        ? recorded
        : -1;
  if (stepIndex < 0) return undefined;
  const stepId = steps[stepIndex]._runtime?.stepId;
  return { ...(stepId ? { stepId } : {}), stepIndex };
}

/**
 * Attribute settlements, in timeline order, to the queue step or finalStep
 * pass they belong to. A settlement no current step owns, and one that
 * predates its owner's current execution of the same child, is dropped, so
 * every surface reports the same children.
 */
export function attributeSubWorkflowSettlements(
  settlements: readonly SubWorkflowSettlement[],
  context: SubWorkflowSettlementContext
): AttributedSubWorkflowSettlement[] {
  const { steps, finalStep, finalStepRuntime } = context;
  const finalRuntime =
    finalStep && isSubWorkflowStep(finalStep) ? finalStep._runtime : undefined;
  const attributed: AttributedSubWorkflowSettlement[] = [];
  for (const settlement of settlements) {
    const { target } = settlement;
    if (target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
      const runningPass =
        finalStepRuntime?.phase === FINAL_STEP_PHASES.FINAL_STEP &&
        finalStepRuntime.loopCount === target.loopIndex;
      if (
        runningPass &&
        predatesCurrentExecution(settlement, finalRuntime, finalStepRuntime)
      )
        continue;
      attributed.push({
        kind: FINAL_STEP_PHASES.FINAL_STEP,
        settlement,
        passNumber: target.loopIndex + 1,
      });
      continue;
    }
    const owner = attributeQueueSettlement(settlement, steps);
    if (!owner) continue;
    const step =
      owner.stepIndex !== undefined ? steps[owner.stepIndex] : undefined;
    if (
      step &&
      isSubWorkflowStep(step) &&
      predatesCurrentExecution(settlement, step._runtime, step._runtime)
    )
      continue;
    attributed.push({ kind: FINAL_STEP_PHASES.QUEUE, settlement, ...owner });
  }
  return attributed;
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
 * continued reports its latest outcome, and none while it runs again.
 */
export function selectLatestSubWorkflowSettlements(
  settlements: readonly SubWorkflowSettlement[],
  context: SubWorkflowSettlementContext
): LatestSubWorkflowSettlements {
  const queue = new Map<number, SubWorkflowOutput>();
  let finalStep: LatestSubWorkflowSettlements["finalStep"];
  for (const entry of attributeSubWorkflowSettlements(settlements, context)) {
    const { output } = entry.settlement;
    if (entry.kind === FINAL_STEP_PHASES.FINAL_STEP) {
      if (!finalStep || entry.passNumber >= finalStep.passNumber)
        finalStep = { passNumber: entry.passNumber, output };
    } else if (entry.stepIndex !== undefined) {
      queue.set(entry.stepIndex, output);
    }
  }
  return { queue, ...(finalStep ? { finalStep } : {}) };
}
