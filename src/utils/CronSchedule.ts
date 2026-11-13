/** A parsed five-field cron expression, with each field represented as allowed values. */
export interface ParsedCronExpression {
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dayOfMonth: ReadonlySet<number>;
  month: ReadonlySet<number>;
  dayOfWeek: ReadonlySet<number>;
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

export type CronParseResult =
  { ok: true; value: ParsedCronExpression } | { ok: false; error: string };

const FIELD_RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;

function parseField(
  text: string,
  min: number,
  max: number,
  sunday = false
): Set<number> | null {
  if (!text) return null;
  const values = new Set<number>();
  for (const part of text.split(",")) {
    if (!part) return null;
    const [base, stepText, extra] = part.split("/");
    if (
      extra !== undefined ||
      (stepText !== undefined && !/^\d+$/.test(stepText))
    )
      return null;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isSafeInteger(step) || step < 1) return null;
    let start: number;
    let end: number;
    if (base === "*") {
      start = min;
      end = max;
    } else if (/^\d+$/.test(base)) {
      start = Number(base);
      end = stepText === undefined ? start : max;
    } else {
      const range = /^(\d+)-(\d+)$/.exec(base);
      if (!range) return null;
      start = Number(range[1]);
      end = Number(range[2]);
    }
    if (start < min || start > max || end < min || end > max || start > end)
      return null;
    for (let value = start; value <= end; value += step)
      values.add(sunday && value === 7 ? 0 : value);
  }
  return values.size ? values : null;
}

/** Parses and validates the supported five-field cron grammar (numeric fields only). */
export function parseCronExpression(expression: string): CronParseResult {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5)
    return {
      ok: false,
      error: "Cron expression must have exactly five fields",
    };
  const parsed = fields.map((field, i) =>
    parseField(field, FIELD_RANGES[i][0], FIELD_RANGES[i][1], i === 4)
  );
  const failed = parsed.findIndex((field) => field === null);
  if (failed >= 0)
    return { ok: false, error: `Invalid cron field ${failed + 1}` };
  return {
    ok: true,
    value: {
      minute: parsed[0]!,
      hour: parsed[1]!,
      dayOfMonth: parsed[2]!,
      month: parsed[3]!,
      dayOfWeek: parsed[4]!,
      dayOfMonthRestricted: fields[2] !== "*",
      dayOfWeekRestricted: fields[4] !== "*",
    },
  };
}

const SEARCH_HORIZON_MS = 5 * 366 * 24 * 60 * 60 * 1000;
function matchesDay(cron: ParsedCronExpression, date: Date): boolean {
  const dom = cron.dayOfMonth.has(date.getDate());
  const dow = cron.dayOfWeek.has(date.getDay());
  if (cron.dayOfMonthRestricted && cron.dayOfWeekRestricted) return dom || dow;
  return dom && dow;
}

/** Returns the next matching local wall-clock minute after `afterMs`, within five years. */
export function nextCronOccurrence(
  expression: string,
  afterMs: number
): number | null {
  const result = parseCronExpression(expression);
  if (!result.ok || !Number.isFinite(afterMs)) return null;
  const cron = result.value;
  const end = afterMs + SEARCH_HORIZON_MS;
  // Truncate in absolute time: local setters choose the earlier copy of an
  // ambiguous fall-back minute and can move this cursor backwards.
  const cursor = new Date(Math.floor(afterMs / 60_000) * 60_000);
  // Wall-clock minute-of-day of the previous cursor position on the same date;
  // -1 after a jump to the start of a new day, so a DST gap at midnight is still seen.
  let previousMinuteOfDay = cursor.getHours() * 60 + cursor.getMinutes();
  let previousDay = cursor.getDate();
  // Local-time setters step past a repeated (fall-back) hour, so each wall time is seen once.
  const truncatedAfter = cursor.getTime();
  cursor.setMinutes(cursor.getMinutes() + 1);
  while (cursor.getTime() <= afterMs || cursor.getTime() <= truncatedAfter)
    cursor.setTime(cursor.getTime() + 60_000);
  while (cursor.getTime() <= end) {
    if (cursor.getDate() !== previousDay) previousMinuteOfDay = -1;
    if (!cron.month.has(cursor.getMonth() + 1) || !matchesDay(cron, cursor)) {
      // Nothing on this date can match: jump to the start of the next day.
      previousDay = cursor.getDate();
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    const minuteOfDay = cursor.getHours() * 60 + cursor.getMinutes();
    if (
      cron.hour.has(cursor.getHours()) &&
      cron.minute.has(cursor.getMinutes())
    ) {
      if (cursor.getTime() > afterMs) return cursor.getTime();
      // A local-time setter elsewhere in the search can revisit the earlier
      // copy of an ambiguous minute. Walk absolute minutes until strictly past
      // the caller's instant, preserving the one-run-per-wall-time behavior.
      cursor.setTime(cursor.getTime() + 60_000);
      previousMinuteOfDay = minuteOfDay;
      previousDay = cursor.getDate();
      continue;
    }
    // A forward DST jump skips wall-clock minutes. A cron time inside the gap fires at the transition.
    for (let minute = previousMinuteOfDay + 1; minute < minuteOfDay; minute++) {
      if (
        cron.hour.has(Math.floor(minute / 60)) &&
        cron.minute.has(minute % 60)
      ) {
        if (cursor.getTime() > afterMs) return cursor.getTime();
      }
    }
    previousMinuteOfDay = minuteOfDay;
    previousDay = cursor.getDate();
    const previousTimestamp = cursor.getTime();
    cursor.setMinutes(cursor.getMinutes() + 1);
    while (cursor.getTime() <= afterMs || cursor.getTime() <= previousTimestamp)
      cursor.setTime(cursor.getTime() + 60_000);
  }
  return null;
}
