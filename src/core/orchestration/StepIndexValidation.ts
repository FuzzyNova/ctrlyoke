/** Format the shared zero-based range used by step mutation and history commands. */
export function formatValidStepIndexRange(stepCount: number): string {
  return stepCount > 0
    ? `valid zero-based indices are 0 to ${stepCount - 1}`
    : "this run has no valid zero-based step indices";
}

export function assertStepIndex(
  stepCount: number,
  index: number,
  operation: string
): void {
  if (!Number.isInteger(index) || index < 0 || index >= stepCount) {
    // State the range so API callers can distinguish an off-by-one from a
    // request against the wrong run.
    throw new Error(
      `Invalid ${operation} index: ${index}. This run has ${stepCount} step${
        stepCount === 1 ? "" : "s"
      }${stepCount > 0 ? `, so ${formatValidStepIndexRange(stepCount)}` : ""}.`
    );
  }
}
