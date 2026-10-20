import {
  FINAL_STEP_PHASES,
  OUTPUT_ROW_KINDS,
} from "@root/types/DashboardConstants";
import { formatFinalPassLabel } from "@root/utils/FinalStepLabels";
import type { OutputRenderRow } from "./outputRows";
import { formatDuration, formatTimestamp } from "./time";

/** Sub-second operations would read "0s" through `formatDuration`. */
function formatElapsed(durationMs: number): string {
  return durationMs < 1000
    ? `${Math.max(0, Math.round(durationMs))}ms`
    : formatDuration(durationMs);
}

/**
 * Hover metadata for a row: when it started, how long the operation took, and
 * which step it belongs to. Rendered as a native `title` so it adds no height
 * and leaves the row-height estimates untouched. Undefined when the row has no
 * timing to show.
 */
export function describeRowTiming(row: OutputRenderRow): string | undefined {
  if (row.rowKind !== OUTPUT_ROW_KINDS.STRUCTURED_EVENT) return undefined;
  const { timestamp, completedTimestamp } = row.event;
  if (timestamp === undefined) return undefined;

  const lines = [`Started: ${formatTimestamp(timestamp)}`];
  if (completedTimestamp !== undefined) {
    lines.push(`Took: ${formatElapsed(completedTimestamp - timestamp)}`);
  }
  lines.push(
    row.target.kind === FINAL_STEP_PHASES.FINAL_STEP
      ? formatFinalPassLabel(row.target.index + 1)
      : `Step ${row.target.index + 1}`
  );
  return lines.join("\n");
}
