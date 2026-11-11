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
  | { ok: true; value: ParsedCronExpression }
  | { ok: false; error: string };

const FIELD_RANGES = [
  [0, 59], [0, 23], [1, 31], [1, 12], [0, 7],
] as const;

function parseField(text: string, min: number, max: number, sunday = false): Set<number> | null {
  if (!text) return null;
  const values = new Set<number>();
  for (const part of text.split(",")) {
    if (!part) return null;
    const [base, stepText, extra] = part.split("/");
    if (extra !== undefined || (stepText !== undefined && !/^\d+$/.test(stepText))) return null;
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
    if (start < min || start > max || end < min || end > max || start > end) return null;
    for (let value = start; value <= end; value += step) values.add(sunday && value === 7 ? 0 : value);
  }
  return values.size ? values : null;
}

/** Parses and validates the supported five-field cron grammar (numeric fields only). */
export function parseCronExpression(expression: string): CronParseResult {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return { ok: false, error: "Cron expression must have exactly five fields" };
  const parsed = fields.map((field, i) => parseField(field, FIELD_RANGES[i][0], FIELD_RANGES[i][1], i === 4));
  const failed = parsed.findIndex((field) => field === null);
  if (failed >= 0) return { ok: false, error: `Invalid cron field ${failed + 1}` };
  return {
    ok: true,
    value: {
      minute: parsed[0]!, hour: parsed[1]!, dayOfMonth: parsed[2]!, month: parsed[3]!, dayOfWeek: parsed[4]!,
      dayOfMonthRestricted: fields[2] !== "*", dayOfWeekRestricted: fields[4] !== "*",
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
export function nextCronOccurrence(expression: string, afterMs: number): number | null {
  const result = parseCronExpression(expression);
  if (!result.ok || !Number.isFinite(afterMs)) return null;
  const cron = result.value;
  const end = afterMs + SEARCH_HORIZON_MS;
  const cursor = new Date(afterMs);
  cursor.setSeconds(0, 0);
  let previousDate: Date | undefined = new Date(cursor);
  cursor.setMinutes(cursor.getMinutes() + 1);
  let previousWallKey: string | undefined = `${previousDate.getFullYear()}-${previousDate.getMonth()}-${previousDate.getDate()}-${previousDate.getHours()}-${previousDate.getMinutes()}`;
  while (cursor.getTime() <= end) {
    const wallKey = `${cursor.getFullYear()}-${cursor.getMonth()}-${cursor.getDate()}-${cursor.getHours()}-${cursor.getMinutes()}`;
    if (wallKey !== previousWallKey && cron.month.has(cursor.getMonth() + 1) && cron.hour.has(cursor.getHours()) && cron.minute.has(cursor.getMinutes()) && matchesDay(cron, cursor)) return cursor.getTime();
    // A forward DST jump skips wall-clock minutes. A cron time inside the gap fires at the transition.
    if (previousDate) {
      const beforeMinute = previousDate.getHours() * 60 + previousDate.getMinutes();
      const afterMinute = cursor.getHours() * 60 + cursor.getMinutes();
      if (afterMinute > beforeMinute + 1 && cron.month.has(cursor.getMonth() + 1) && matchesDay(cron, cursor)) {
        for (let minute = beforeMinute + 1; minute < afterMinute; minute++) {
          if (cron.hour.has(Math.floor(minute / 60)) && cron.minute.has(minute % 60)) return cursor.getTime();
        }
      }
    }
    previousWallKey = wallKey;
    previousDate = new Date(cursor);
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}
