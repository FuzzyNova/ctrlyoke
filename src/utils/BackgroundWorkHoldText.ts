import type {
  BackgroundTaskSummary,
  BackgroundWorkHoldData,
} from "../types/CliOutputTypes";

/**
 * Single source for how a background-work hold is described to the user, shared
 * by the dashboard row, its height estimate, and the standalone CLI formatter.
 * Webview-safe: no Node or VS Code dependencies.
 */

/** Headline for an absorbed Stop, explaining why the step is still running. */
export function getBackgroundWorkHoldHeadline(
  data: Pick<BackgroundWorkHoldData, "pendingTasks" | "awaitingResumedTurn">
): string {
  const count = data.pendingTasks.length;
  if (count > 0) {
    return `Stop hook received — step kept running until ${
      count === 1
        ? "1 background task finishes"
        : `${count} background tasks finish`
    }`;
  }
  if (data.awaitingResumedTurn) {
    return "Stop hook received — step kept running until the harness finishes the turn its background task resumed";
  }
  return "Stop hook received — step kept running until background work finishes";
}

/** Notice shown when a headless session exits with background work pending. */
export function getBackgroundWorkAbandonedNotice(
  pendingTasks: readonly BackgroundTaskSummary[]
): string {
  const count = pendingTasks.length;
  const workLabel =
    count === 0
      ? "background work"
      : `${count} background task${count === 1 ? "" : "s"}`;
  const stopped = count > 1 ? "they were" : "it was";
  return `The step ended with ${workLabel} still running; ${stopped} stopped when the headless session ended.`;
}

/**
 * Label for a pending task: its best human-readable name, the launching tool
 * and provider task id when those add information, and the command line when
 * the name came from a description (so a hung process can still be identified).
 */
export function getBackgroundTaskLabel(task: BackgroundTaskSummary): {
  name: string;
  meta: string;
  command?: string;
} {
  const name =
    task.description ??
    task.command ??
    task.toolName ??
    task.taskId ??
    "Background task";
  const meta = [task.toolName, task.taskId]
    .filter((part): part is string => !!part && part !== name)
    .join(" · ");
  const command =
    task.command && task.command !== name ? task.command : undefined;
  return { name, meta, command };
}
