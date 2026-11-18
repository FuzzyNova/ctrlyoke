import {
  EDITOR_TARGET_KINDS,
  HEADLESS_STEER_DELIVERIES,
  SESSION_KINDS,
  STEP_TYPES,
  TERMINAL_SESSION_STATUS,
  getHarnessDisplayName,
} from "@root/types/DashboardConstants";
import type {
  HeadlessControlTargetMessage,
  HeadlessSteerDelivery,
} from "@/types/messages";
import type { TerminalSession } from "@store/terminalStore";
import type { EditorSelectionTarget } from "@store/editorStore";
import {
  formatFinalPassPhrase,
  formatStepTargetLabel,
} from "@root/utils/FinalStepLabels";

export const NO_LIVE_HARNESS = "No live harness session for this workflow";
export const STEER_NOT_NEW_PROMPT = "Only available for a new prompt";
export const STEER_PROMPT_ONLY = "Steering is only available for prompt steps";
export const STEER_NO_CONTENT = "Enter a prompt first";
export const STEER_EXTERNAL_RUN = "Read-only — external run";
export const END_STEP_EARLY_UNSUPPORTED =
  "End Step Early needs a headless Claude Code, Codex or Qwen step";

/** One live session the prompt editor's draft can be steered into. */
export interface SteerTarget {
  sessionId: string;
  /** Zero-based queue index; negative for the final step. */
  stepIndex?: number;
  harnessId?: string;
  /** Set for headless control channels; undefined for interactive PTYs. */
  steerDelivery?: HeadlessSteerDelivery;
  canInterruptTurn?: boolean;
  /** False for a retained interactive terminal whose step has finished. */
  isExecuting: boolean;
}

/**
 * Every live steer destination for one workflow: each open headless control
 * channel and each running AI-CLI PTY (including retained terminals from
 * finished steps). Executing steps come first, by step index, then idle
 * terminals, so the order never depends on rail selection or scroll position.
 */
export function buildSteerTargets(
  headlessTargets: readonly HeadlessControlTargetMessage[] | undefined,
  sessions: readonly TerminalSession[] | undefined,
  activeStepIndices: readonly number[]
): SteerTarget[] {
  const targets: SteerTarget[] = (headlessTargets ?? []).map((target) => ({
    sessionId: target.controlSessionId,
    stepIndex: target.stepIndex,
    harnessId: target.harnessId,
    steerDelivery: target.steerDelivery,
    ...(target.canInterruptTurn !== undefined
      ? { canInterruptTurn: target.canInterruptTurn }
      : {}),
    // A headless channel is open only while its step runs.
    isExecuting: true,
  }));
  for (const session of sessions ?? []) {
    if (
      session.kind !== SESSION_KINDS.AI_CLI ||
      session.status !== TERMINAL_SESSION_STATUS.RUNNING
    ) {
      continue;
    }
    targets.push({
      sessionId: session.id,
      stepIndex: session.stepIndex,
      harnessId: session.harnessId,
      isExecuting:
        session.stepIndex !== undefined &&
        activeStepIndices.includes(session.stepIndex),
    });
  }
  return targets.sort((left, right) => {
    if (left.isExecuting !== right.isExecuting) {
      return left.isExecuting ? -1 : 1;
    }
    return stepSortKey(left.stepIndex) - stepSortKey(right.stepIndex);
  });
}

/**
 * Queue steps in order, then final-step passes in order (signed index
 * `-(loopIndex + 1)`), then sessions with no step.
 */
function stepSortKey(stepIndex: number | undefined): number {
  if (stepIndex === undefined) return Number.MAX_SAFE_INTEGER;
  return stepIndex < 0 ? Number.MAX_SAFE_INTEGER / 2 - stepIndex : stepIndex;
}

function isFinalStepIndex(stepIndex: number | undefined): stepIndex is number {
  return stepIndex !== undefined && stepIndex < 0;
}

/** The live destination owned by one queue step. */
export function findSteerTargetForStep(
  targets: readonly SteerTarget[],
  stepIndex: number
): SteerTarget | undefined {
  return targets.find((target) => target.stepIndex === stepIndex);
}

/**
 * The final step's live destination: its executing pass if one is running,
 * otherwise the latest pass whose terminal is still open.
 */
export function findFinalStepSteerTarget(
  targets: readonly SteerTarget[]
): SteerTarget | undefined {
  const finalTargets = targets.filter((target) =>
    isFinalStepIndex(target.stepIndex)
  );
  return (
    finalTargets.find((target) => target.isExecuting) ??
    finalTargets.reduce<SteerTarget | undefined>(
      (latest, target) =>
        !latest || (target.stepIndex ?? 0) < (latest.stepIndex ?? 0)
          ? target
          : latest,
      undefined
    )
  );
}

/** "Step 3", or "Final Step Pass 2" for the signed final-step index -2. */
export function formatSteerStepLabel(stepIndex: number | undefined): string {
  if (stepIndex === undefined) return "Session";
  return isFinalStepIndex(stepIndex)
    ? formatStepTargetLabel(true, -stepIndex - 1)
    : formatStepTargetLabel(false, stepIndex);
}

function formatSteerStepPhrase(stepIndex: number | undefined): string {
  if (stepIndex === undefined) return "";
  return isFinalStepIndex(stepIndex)
    ? ` (${formatFinalPassPhrase(-stepIndex)})`
    : ` (step ${stepIndex + 1})`;
}

function harnessLabel(target: SteerTarget): string {
  return target.harnessId ? getHarnessDisplayName(target.harnessId) : "harness";
}

/** Run-menu label for one destination, e.g. "Steer Step 3 · Qwen Code (after turn)". */
export function formatSteerTargetLabel(target: SteerTarget): string {
  const suffix =
    target.steerDelivery === HEADLESS_STEER_DELIVERIES.QUEUE
      ? " (after turn)"
      : !target.isExecuting
        ? " (finished)"
        : "";
  return `Steer ${formatSteerStepLabel(target.stepIndex)} · ${harnessLabel(target)}${suffix}`;
}

/** Tooltip describing how a steer reaches this destination. */
export function formatSteerTargetTitle(target: SteerTarget): string {
  const step = formatSteerStepPhrase(target.stepIndex);
  if (target.steerDelivery === HEADLESS_STEER_DELIVERIES.QUEUE) {
    return `Queues for the live ${harnessLabel(target)} session after its current turn${step}. Prompt overrides are ignored.`;
  }
  return `Sends to the live ${harnessLabel(target)} session${step}. Prompt overrides are ignored.`;
}

/**
 * Why the editor's current draft cannot be sent as a steer, independent of
 * which destination receives it. Undefined when the draft is sendable.
 */
export function getSteerDraftDisabledReason({
  selectionTarget,
  stepType,
  promptText,
  isExternallyManaged,
}: {
  selectionTarget: EditorSelectionTarget;
  stepType: string;
  promptText: string;
  isExternallyManaged: boolean;
}): string | undefined {
  if (selectionTarget.kind !== EDITOR_TARGET_KINDS.NEW_PROMPT) {
    return STEER_NOT_NEW_PROMPT;
  }
  if (stepType !== STEP_TYPES.PROMPT) return STEER_PROMPT_ONLY;
  if (promptText.trim().length === 0) return STEER_NO_CONTENT;
  if (isExternallyManaged) return STEER_EXTERNAL_RUN;
  return undefined;
}

export function formatEndStepEarlyTitle(stepIndex: number): string {
  return `Stops ${formatSteerStepLabel(stepIndex).toLowerCase()}'s current turn, keeps its output so far, and continues the workflow.`;
}

export function formatNoLiveSessionReason(stepIndex: number): string {
  return `${formatSteerStepLabel(stepIndex)} has no live harness session`;
}
