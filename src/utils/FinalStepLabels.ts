/**
 * User-facing wording for one execution of a workflow's `finalStep`.
 *
 * Each time the queue drains, the final step runs once more; each of those
 * runs is a "pass", numbered from 1. "Loop" is reserved for the whole
 * queue → final step → appended steps cycle, so it never labels a single run.
 * The CLI `--step final:N` selector, its JSON (`passes[]`, `pass`), the
 * terminal stream, history search, and the dashboard all use this wording.
 *
 * Internal identifiers (`loopIndex`, `loopCount`) keep their names; convert
 * with `loopIndex + 1` to get the pass number these helpers take.
 *
 * Dependency-free so the webview can import it through `@root/utils`.
 */

/** Title-case caption for one final-step pass, e.g. "Final Step Pass 2". */
export function formatFinalPassLabel(passNumber: number): string {
  return `Final Step Pass ${passNumber}`;
}

/**
 * Caption for the step an output belongs to: "Step 3" for a queue step,
 * "Final Step Pass 2" for a final-step pass. Both indexes are 0-based
 * (`stepIndex` / `loopIndex`).
 */
export function formatStepTargetLabel(
  isFinalStep: boolean,
  index: number
): string {
  return isFinalStep ? formatFinalPassLabel(index + 1) : `Step ${index + 1}`;
}

/** The same label for use mid-sentence, e.g. "final step pass 2". */
export function formatFinalPassPhrase(passNumber: number): string {
  return formatFinalPassLabel(passNumber).toLowerCase();
}

/** Short badge text for one final-step pass, e.g. "Pass 2". */
export function formatFinalPassBadge(passNumber: number): string {
  return `Pass ${passNumber}`;
}

/** Bare pass number or range for tight spaces, e.g. "2" or "1–3". */
export function formatFinalPassRangeCompact(
  first: number,
  last: number
): string {
  return first === last ? String(first) : `${first}–${last}`;
}

/** Badge text for a span of passes, e.g. "Pass 2" or "Passes 1–3". */
export function formatFinalPassRangeBadge(first: number, last: number): string {
  return first === last
    ? formatFinalPassBadge(first)
    : `Passes ${formatFinalPassRangeCompact(first, last)}`;
}
