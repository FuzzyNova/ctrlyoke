/** Queue-step fallback label shared by output and file-change views. */
export function getQueueStepLabel(
  stepIndex: number,
  stepName?: string | null
): string {
  return stepName?.trim() || `Step ${stepIndex + 1}`;
}
