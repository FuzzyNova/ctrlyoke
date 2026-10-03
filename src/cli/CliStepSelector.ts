import {
  FINAL_STEP_PHASES,
  HISTORY_SHOW_ATTEMPT_SELECTORS,
  HISTORY_SHOW_STEP_SELECTORS,
} from "../types/DashboardConstants";
import type { OutputExecutionTarget } from "../types/OutputHistoryTypes";

/** Upper bound on distinct indices one `--step` list may name. */
export const MAX_HISTORY_SHOW_STEP_INDICES = 10_000;

export type CliHistoryShowStepSelector =
  | { kind: typeof FINAL_STEP_PHASES.QUEUE; stepIndices: number[] }
  | {
      kind: typeof FINAL_STEP_PHASES.FINAL_STEP;
      passNumber?: number | typeof HISTORY_SHOW_ATTEMPT_SELECTORS.LATEST;
    }
  | { kind: typeof HISTORY_SHOW_STEP_SELECTORS.RUNNING }
  | { kind: typeof HISTORY_SHOW_STEP_SELECTORS.LATEST };

export type CliHistoryShowAttemptSelector =
  | { kind: typeof HISTORY_SHOW_ATTEMPT_SELECTORS.ALL }
  | { kind: typeof HISTORY_SHOW_ATTEMPT_SELECTORS.LATEST }
  | { kind: typeof HISTORY_SHOW_ATTEMPT_SELECTORS.NUMBER; number: number };

export function parseHistoryShowStep(
  rawValue: string | undefined
): CliHistoryShowStepSelector | undefined {
  if (rawValue === undefined) return undefined;
  const value = rawValue.trim();
  if (value === HISTORY_SHOW_STEP_SELECTORS.FINAL) {
    return { kind: FINAL_STEP_PHASES.FINAL_STEP };
  }
  if (value === HISTORY_SHOW_STEP_SELECTORS.RUNNING) {
    return { kind: HISTORY_SHOW_STEP_SELECTORS.RUNNING };
  }
  if (value === HISTORY_SHOW_STEP_SELECTORS.LATEST) {
    return { kind: HISTORY_SHOW_STEP_SELECTORS.LATEST };
  }
  if (value.startsWith(`${HISTORY_SHOW_STEP_SELECTORS.FINAL}:`)) {
    const pass = value.slice(HISTORY_SHOW_STEP_SELECTORS.FINAL.length + 1);
    if (pass === HISTORY_SHOW_ATTEMPT_SELECTORS.LATEST) {
      return {
        kind: FINAL_STEP_PHASES.FINAL_STEP,
        passNumber: HISTORY_SHOW_ATTEMPT_SELECTORS.LATEST,
      };
    }
    const passNumber = parsePositiveSafeInteger(pass);
    if (passNumber !== undefined) {
      return { kind: FINAL_STEP_PHASES.FINAL_STEP, passNumber };
    }
    throw invalidStepSelector(value);
  }

  const stepIndices = new Set<number>();
  // Parts are trimmed exactly as `ctrlyoke step reorder` trims its list, so
  // "3, 4" means the same thing to both commands.
  for (const part of value.split(",").map((item) => item.trim())) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!range) throw invalidStepSelector(value);
    const start = parseNonNegativeSafeInteger(range[1]);
    const end =
      range[2] === undefined ? start : parseNonNegativeSafeInteger(range[2]);
    if (start === undefined || end === undefined || end < start) {
      throw invalidStepSelector(value);
    }
    for (let index = start; index <= end; index++) {
      stepIndices.add(index);
      if (stepIndices.size > MAX_HISTORY_SHOW_STEP_INDICES) {
        throw new Error(
          `Invalid --step value "${value}"; the selection is too large (more than ${MAX_HISTORY_SHOW_STEP_INDICES} distinct step indices)`
        );
      }
    }
  }
  if (!stepIndices.size) throw invalidStepSelector(value);
  return {
    kind: FINAL_STEP_PHASES.QUEUE,
    stepIndices: [...stepIndices],
  };
}

export function parseHistoryShowAttempt(
  value: string | undefined
): CliHistoryShowAttemptSelector {
  if (value === undefined || value === HISTORY_SHOW_ATTEMPT_SELECTORS.ALL) {
    return { kind: HISTORY_SHOW_ATTEMPT_SELECTORS.ALL };
  }
  if (value === HISTORY_SHOW_ATTEMPT_SELECTORS.LATEST) {
    return { kind: HISTORY_SHOW_ATTEMPT_SELECTORS.LATEST };
  }
  const number = parsePositiveSafeInteger(value);
  if (number === undefined) {
    throw new Error(
      `Invalid --attempt value "${value}"; use a positive attempt number, latest, or all`
    );
  }
  return { kind: HISTORY_SHOW_ATTEMPT_SELECTORS.NUMBER, number };
}

export function matchesHistoryShowStep(
  target: OutputExecutionTarget,
  selector: CliHistoryShowStepSelector | undefined,
  options: { latest?: boolean; running?: boolean } = {}
): boolean {
  if (!selector) return true;
  if (selector.kind === FINAL_STEP_PHASES.QUEUE) {
    return (
      target.kind === FINAL_STEP_PHASES.QUEUE &&
      selector.stepIndices.includes(target.stepIndex)
    );
  }
  if (selector.kind === FINAL_STEP_PHASES.FINAL_STEP) {
    const passMatches =
      selector.passNumber === undefined ||
      (selector.passNumber === HISTORY_SHOW_ATTEMPT_SELECTORS.LATEST
        ? options.latest === true
        : target.kind === FINAL_STEP_PHASES.FINAL_STEP &&
          target.loopIndex === selector.passNumber - 1);
    return target.kind === FINAL_STEP_PHASES.FINAL_STEP && passMatches;
  }
  return selector.kind === HISTORY_SHOW_STEP_SELECTORS.LATEST
    ? options.latest === true
    : options.running === true;
}

export function parseCliStepIndex(value: string): number {
  const index = parseNonNegativeSafeInteger(value);
  if (index === undefined) {
    throw new Error(
      `Invalid step index "${value}"; expected a non-negative safe integer`
    );
  }
  return index;
}

export function formatCliStepSelector(index: number): string {
  return String(parseCliStepIndex(String(index)));
}

/**
 * The `--step` selector that names one recorded target: the zero-based queue
 * index, or `final:N` with the 1-based final-step pass number.
 */
export function formatHistoryTargetSelector(
  target: OutputExecutionTarget
): string {
  return target.kind === FINAL_STEP_PHASES.QUEUE
    ? formatCliStepSelector(target.stepIndex)
    : formatFinalPassSelector(target.loopIndex + 1);
}

export function formatFinalPassSelector(passNumber: number): string {
  return `${HISTORY_SHOW_STEP_SELECTORS.FINAL}:${passNumber}`;
}

/**
 * Human-readable caption for one final-step pass, using the same "pass"
 * wording as the `final:N` selector and its validation errors.
 */
export function formatFinalPassLabel(passNumber: number): string {
  return `Final Step Pass ${passNumber}`;
}

function parseNonNegativeSafeInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function parsePositiveSafeInteger(value: string): number | undefined {
  const number = parseNonNegativeSafeInteger(value);
  return number !== undefined && number > 0 ? number : undefined;
}

function invalidStepSelector(value: string): Error {
  return new Error(
    `Invalid --step value "${value}"; use a zero-based index, comma-separated indices or ranges, final[:N|latest], running, or latest`
  );
}
