import type { WorkflowSchedule } from "@root/types/CtrlYokeTypes";
import { nextScheduleOccurrence } from "@root/utils/WorkflowSchedule";
import { WORKFLOW_SCHEDULE_LABELS } from "../constants";

/** The lineage fields the Scheduled section reads. */
export interface ScheduledLineageFields {
  schedule?: WorkflowSchedule;
  scheduleNextRunAt?: number;
}

/**
 * When the lineage's schedule will fire next, or `null` once it never will
 * again (a one-shot that already fired, or a recurrence past its `until`).
 *
 * The host's `scheduleNextRunAt` wins while it is still in the future. It is
 * absent for a paused schedule, for one armed on another machine, and briefly
 * after a save, so the time is computed from the trigger in those cases. A
 * paused schedule is evaluated as if enabled: it keeps its place in the
 * Scheduled section while resuming it could still fire.
 */
export function upcomingScheduleRunAt(
  lineage: ScheduledLineageFields,
  now: number
): number | null {
  const { schedule, scheduleNextRunAt } = lineage;
  if (!schedule) return null;
  if (scheduleNextRunAt !== undefined && scheduleNextRunAt > now) {
    return scheduleNextRunAt;
  }
  return nextScheduleOccurrence({ ...schedule, enabled: true }, now);
}

/**
 * The next-run label every schedule surface shows (row text, clock button
 * title, context menu): "Paused", "Next run: <time>", or "None" once the
 * schedule can never fire again. `undefined` when there is no schedule.
 */
export function upcomingScheduleRunLabel(
  lineage: ScheduledLineageFields,
  now: number
): string | undefined {
  const { schedule } = lineage;
  if (!schedule) return undefined;
  if (!schedule.enabled) return WORKFLOW_SCHEDULE_LABELS.pausedNextRun;
  // Guards a malformed schedule from an older or hand-edited lineage file.
  const nextRunAt = schedule.trigger
    ? upcomingScheduleRunAt(lineage, now)
    : null;
  return nextRunAt === null
    ? WORKFLOW_SCHEDULE_LABELS.noNextRun
    : `${WORKFLOW_SCHEDULE_LABELS.nextRun}: ${new Date(nextRunAt).toLocaleString()}`;
}
