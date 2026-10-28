import {
  FINAL_STEP_PHASES,
  OUTPUT_ROW_KINDS,
} from "@root/types/DashboardConstants";
import { formatFinalPassLabel } from "@root/utils/FinalStepLabels";
import { getHarnessModelDisplayName } from "@root/utils/ModelConstants";
import { getHarnessDisplayName } from "../types/messages";
import type { CliHeaderRow, OutputRenderRow } from "./outputRows";
import {
  formatExecutionBadge,
  formatScriptConditionLabel,
} from "./outputUtils";
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
 * timing to show. A step header describes the whole step instead (see
 * `describeCliHeader`).
 */
export function describeRowTiming(row: OutputRenderRow): string | undefined {
  if (row.rowKind === OUTPUT_ROW_KINDS.CLI_HEADER) {
    return describeCliHeader(row);
  }
  let timestamp: number | undefined;
  let completedTimestamp: number | undefined;
  if (row.rowKind === OUTPUT_ROW_KINDS.STRUCTURED_EVENT) {
    ({ timestamp, completedTimestamp } = row.event);
  } else if (row.rowKind === OUTPUT_ROW_KINDS.PLAIN_RESPONSE) {
    timestamp = row.timestampMs;
  }
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

/**
 * Everything a step header shows, whatever the header itself has room for: a
 * narrow pane drops the timestamp, shortens the change link and clips the
 * harness/model, so this tooltip is where all of it stays readable.
 */
function describeCliHeader(row: CliHeaderRow): string {
  const { output } = row;
  const lines: string[] = [];
  if (output.timestampMs) {
    lines.push(`Started: ${formatTimestamp(output.timestampMs)}`);
  }
  const title =
    formatScriptConditionLabel(output.source, row.attemptIndex) ??
    row.stepName?.trim();
  lines.push(title ? `${row.stepLabel} · ${title}` : row.stepLabel);
  const executionBadge = formatExecutionBadge(row.runIndex, row.attemptIndex);
  if (executionBadge) lines.push(executionBadge);

  const { harness, model } = output.structured?.metadata ?? {};
  if (harness) lines.push(`Harness: ${getHarnessDisplayName(harness)}`);
  if (model) {
    const modelLabel = harness
      ? getHarnessModelDisplayName(harness, model)
      : model;
    lines.push(
      `Model: ${modelLabel === model ? model : `${modelLabel} (${model})`}`
    );
  }

  const changes = row.promptUndo?.summary;
  if (changes && changes.total > 0) lines.push(changes.title);
  return lines.join("\n");
}
