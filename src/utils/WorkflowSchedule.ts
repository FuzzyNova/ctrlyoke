import type { WorkflowSchedule } from "../types/CtrlYokeTypes";
import { nextCronOccurrence, parseCronExpression } from "./CronSchedule";
import {
  LOCAL_CALENDAR,
  scheduleCalendar,
  type ScheduleCalendar,
} from "./ScheduleCalendar";

/**
 * The calendar to read `schedule`'s wall-clock times in on a machine that
 * may not own it: the owner's recorded zone, else `fallbackTimeZone` (the
 * viewing host's zone; this process's when omitted).
 */
export function ownerScheduleCalendar(
  schedule: Pick<WorkflowSchedule, "timeZone">,
  fallbackTimeZone?: string
): ScheduleCalendar {
  return scheduleCalendar(schedule.timeZone ?? fallbackTimeZone);
}

/**
 * Parses a wall-clock `YYYY-MM-DDTHH:mm[:ss]` in `calendar`'s zone. A time
 * that does not exist there (an invalid date, or one inside a DST gap) is null.
 */
function parseLocalDateTime(
  value: unknown,
  calendar: ScheduleCalendar
): number | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)
  )
    return null;
  const [date, time] = value.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute, second = 0] = time.split(":").map(Number);
  const parsed = calendar.fromFields(
    year,
    month - 1,
    day,
    hour,
    minute,
    second
  );
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day ||
    parsed.getHours() !== hour ||
    parsed.getMinutes() !== minute ||
    parsed.getSeconds() !== second
  )
    return null;
  return parsed.getTime();
}

/**
 * Validates an untrusted persisted schedule and returns a typed value or a
 * reason. Datetimes are checked in `calendar`'s zone, by default the
 * schedule's own `timeZone`: a one-shot that exists on its owner's clock
 * may fall in a DST gap on the machine reading it.
 */
export function validateWorkflowSchedule(
  value: unknown,
  calendar?: ScheduleCalendar
): WorkflowSchedule | string {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "Schedule must be an object";
  const input = value as Record<string, unknown>;
  if (typeof input.enabled !== "boolean")
    return "Schedule enabled must be a boolean";
  if (typeof input.hostId !== "string" || !input.hostId.trim())
    return "Schedule hostId must be a non-empty string";
  if (
    input.timeZone !== undefined &&
    (typeof input.timeZone !== "string" || !input.timeZone.trim())
  )
    return "Schedule timeZone must be a non-empty string";
  const zoned =
    calendar ??
    ownerScheduleCalendar({ timeZone: input.timeZone as string | undefined });
  if (
    !input.trigger ||
    typeof input.trigger !== "object" ||
    Array.isArray(input.trigger)
  )
    return "Schedule trigger must be an object";
  const trigger = input.trigger as Record<string, unknown>;
  const hasAt = Object.prototype.hasOwnProperty.call(trigger, "at");
  const hasCron = Object.prototype.hasOwnProperty.call(trigger, "cron");
  if (hasAt === hasCron || Object.keys(trigger).length !== 1)
    return "Schedule trigger must contain exactly one of at or cron";
  if (hasAt && parseLocalDateTime(trigger.at, zoned) === null)
    return "Schedule at must be a valid local YYYY-MM-DDTHH:mm[:ss] datetime";
  if (hasCron) {
    if (typeof trigger.cron !== "string")
      return "Schedule cron must be a string";
    const parsed = parseCronExpression(trigger.cron);
    if (!parsed.ok) return parsed.error;
  }
  if (
    input.until !== undefined &&
    parseLocalDateTime(input.until, zoned) === null
  )
    return "Schedule until must be a valid local YYYY-MM-DDTHH:mm[:ss] datetime";
  if (hasAt && input.until !== undefined)
    return "Schedule until is only valid with a cron trigger";
  return value as WorkflowSchedule;
}

/**
 * Computes the next enabled schedule occurrence, bounded by `until`. Pass
 * `ownerScheduleCalendar(schedule, fallbackTimeZone)` to evaluate recorded
 * schedules in their owner's zone; the default remains the process-local
 * calendar for callers without a schedule zone.
 */
export function nextScheduleOccurrence(
  schedule: WorkflowSchedule,
  afterMs: number,
  calendar: ScheduleCalendar = LOCAL_CALENDAR
): number | null {
  if (!schedule.enabled || !Number.isFinite(afterMs)) return null;
  let occurrence: number | null;
  if ("at" in schedule.trigger) {
    occurrence = parseLocalDateTime(schedule.trigger.at, calendar);
    if (occurrence === null || occurrence <= afterMs) return null;
  } else {
    occurrence = nextCronOccurrence(schedule.trigger.cron, afterMs, calendar);
  }
  if (occurrence === null) return null;
  const until =
    schedule.until === undefined
      ? null
      : parseLocalDateTime(schedule.until, calendar);
  return until !== null && occurrence > until ? null : occurrence;
}
