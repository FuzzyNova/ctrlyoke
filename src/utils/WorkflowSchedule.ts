import type { WorkflowSchedule } from "../types/CtrlYokeTypes";
import { nextCronOccurrence, parseCronExpression } from "./CronSchedule";
import { LOCAL_CALENDAR, type ScheduleCalendar } from "./ScheduleCalendar";

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
 * reason. Datetimes are checked in `calendar`'s zone (see `nextScheduleOccurrence`).
 */
export function validateWorkflowSchedule(
  value: unknown,
  calendar: ScheduleCalendar = LOCAL_CALENDAR
): WorkflowSchedule | string {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "Schedule must be an object";
  const input = value as Record<string, unknown>;
  if (typeof input.enabled !== "boolean")
    return "Schedule enabled must be a boolean";
  if (typeof input.hostId !== "string" || !input.hostId.trim())
    return "Schedule hostId must be a non-empty string";
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
  if (hasAt && parseLocalDateTime(trigger.at, calendar) === null)
    return "Schedule at must be a valid local YYYY-MM-DDTHH:mm[:ss] datetime";
  if (hasCron) {
    if (typeof trigger.cron !== "string")
      return "Schedule cron must be a string";
    const parsed = parseCronExpression(trigger.cron);
    if (!parsed.ok) return parsed.error;
  }
  if (
    input.until !== undefined &&
    parseLocalDateTime(input.until, calendar) === null
  )
    return "Schedule until must be a valid local YYYY-MM-DDTHH:mm[:ss] datetime";
  if (hasAt && input.until !== undefined)
    return "Schedule until is only valid with a cron trigger";
  return value as WorkflowSchedule;
}

/**
 * Computes the next enabled schedule occurrence, bounded by `until`. Schedule
 * times are the host's wall clock: the host uses the default local calendar,
 * and a dashboard on another machine passes `scheduleCalendar(hostTimeZone)`.
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
