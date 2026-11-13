/**
 * Wall-clock calendars for the schedule helpers. A schedule's times are wall
 * clock times on the host, so the host evaluates them with the native `Date`
 * local-time API. A dashboard in a browser on another machine must evaluate
 * them in the host's IANA time zone instead, which `zonedCalendar` provides
 * with the same semantics as native `Date` local time. Webview-safe: no Node
 * imports.
 */

/** The local-time subset of `Date` the schedule helpers use. `Date` itself satisfies it. */
export interface CalendarDate {
  getTime(): number;
  setTime(ms: number): number;
  getFullYear(): number;
  getMonth(): number;
  getDate(): number;
  getDay(): number;
  getHours(): number;
  getMinutes(): number;
  getSeconds(): number;
  setMinutes(minutes: number, seconds?: number, ms?: number): number;
  setDate(date: number): number;
  setHours(
    hours: number,
    minutes?: number,
    seconds?: number,
    ms?: number
  ): number;
}

/** Creates `CalendarDate`s for one time zone. */
export interface ScheduleCalendar {
  /** The instant `ms`, read in this calendar's zone. */
  fromEpoch(ms: number): CalendarDate;
  /** A wall-clock time in this calendar's zone, resolved like `new Date(y, mo, d, h, mi, s)`. */
  fromFields(
    year: number,
    month: number,
    date: number,
    hours: number,
    minutes: number,
    seconds: number
  ): CalendarDate;
}

/** The process's own local time zone, via native `Date`. What the host schedules with. */
export const LOCAL_CALENDAR: ScheduleCalendar = {
  fromEpoch: (ms) => new Date(ms),
  fromFields: (year, month, date, hours, minutes, seconds) =>
    new Date(year, month, date, hours, minutes, seconds, 0),
};

/** This process's IANA time zone; honours `TZ` in Node. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const MS_PER_DAY = 86_400_000;

interface WallFields {
  year: number;
  month: number;
  date: number;
  hours: number;
  minutes: number;
  seconds: number;
  ms: number;
}

/** Bounds `ZoneReader`'s cache; a cron search touches a few thousand minutes. */
const ZONE_READER_CACHE_LIMIT = 4096;

/** Reads wall-clock fields of instants in one IANA zone. */
class ZoneReader {
  private readonly format: Intl.DateTimeFormat;
  /** `formatToParts` dominates a zoned cron search, and its probes repeat. */
  private readonly cache = new Map<number, WallFields>();

  constructor(timeZone: string) {
    this.format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
  }

  fields(ms: number): WallFields {
    const cached = this.cache.get(ms);
    if (cached) return cached;
    const parts: Record<string, number> = {};
    for (const part of this.format.formatToParts(ms)) {
      if (part.type !== "literal") parts[part.type] = Number(part.value);
    }
    const fields: WallFields = {
      year: parts.year,
      month: parts.month - 1,
      date: parts.day,
      hours: parts.hour,
      minutes: parts.minute,
      seconds: parts.second,
      ms: ((ms % 1000) + 1000) % 1000,
    };
    if (this.cache.size >= ZONE_READER_CACHE_LIMIT) this.cache.clear();
    this.cache.set(ms, fields);
    return fields;
  }

  /** The zone's offset from UTC at instant `ms`, in milliseconds. */
  offset(ms: number): number {
    return wallAsUtc(this.fields(ms)) - ms;
  }

  /**
   * The instant of a wall-clock time, given as UTC-encoded milliseconds,
   * resolved the way `Date` resolves local time: an ambiguous (fall-back)
   * time takes the earlier instant, and a skipped (spring-forward) time is
   * read with the offset in force before the transition, so it lands after it.
   */
  instant(wall: number): number {
    const before = this.offset(wall - MS_PER_DAY);
    const after = this.offset(wall + MS_PER_DAY);
    const candidates = [wall - before, wall - after].filter(
      (ms) => this.offset(ms) === wall - ms
    );
    return candidates.length > 0 ? Math.min(...candidates) : wall - before;
  }
}

function wallAsUtc(fields: WallFields): number {
  return Date.UTC(
    fields.year,
    fields.month,
    fields.date,
    fields.hours,
    fields.minutes,
    fields.seconds,
    fields.ms
  );
}

/** A `CalendarDate` in an IANA zone, mirroring native `Date`'s local-time methods. */
class ZonedDate implements CalendarDate {
  constructor(
    private readonly zone: ZoneReader,
    private ms: number
  ) {}

  private get fields(): WallFields {
    return this.zone.fields(this.ms);
  }

  private setWall(patch: Partial<WallFields>): number {
    this.ms = this.zone.instant(wallAsUtc({ ...this.fields, ...patch }));
    return this.ms;
  }

  getTime(): number {
    return this.ms;
  }
  setTime(ms: number): number {
    this.ms = ms;
    return ms;
  }
  getFullYear(): number {
    return this.fields.year;
  }
  getMonth(): number {
    return this.fields.month;
  }
  getDate(): number {
    return this.fields.date;
  }
  getDay(): number {
    const { year, month, date } = this.fields;
    return new Date(Date.UTC(year, month, date)).getUTCDay();
  }
  getHours(): number {
    return this.fields.hours;
  }
  getMinutes(): number {
    return this.fields.minutes;
  }
  getSeconds(): number {
    return this.fields.seconds;
  }
  setMinutes(minutes: number, seconds?: number, ms?: number): number {
    return this.setWall({
      minutes,
      ...(seconds === undefined ? {} : { seconds }),
      ...(ms === undefined ? {} : { ms }),
    });
  }
  setDate(date: number): number {
    return this.setWall({ date });
  }
  setHours(
    hours: number,
    minutes?: number,
    seconds?: number,
    ms?: number
  ): number {
    return this.setWall({
      hours,
      ...(minutes === undefined ? {} : { minutes }),
      ...(seconds === undefined ? {} : { seconds }),
      ...(ms === undefined ? {} : { ms }),
    });
  }
}

const zonedCalendars = new Map<string, ScheduleCalendar>();

/**
 * The calendar for `timeZone` (an IANA name). Returns `LOCAL_CALENDAR` when
 * the zone is absent, is this process's own zone, or is not recognised, so
 * the common case keeps using native `Date`.
 */
export function scheduleCalendar(timeZone?: string): ScheduleCalendar {
  if (!timeZone || timeZone === localTimeZone()) return LOCAL_CALENDAR;
  const cached = zonedCalendars.get(timeZone);
  if (cached) return cached;
  let zone: ZoneReader;
  try {
    zone = new ZoneReader(timeZone);
  } catch {
    return LOCAL_CALENDAR;
  }
  const calendar: ScheduleCalendar = {
    fromEpoch: (ms) => new ZonedDate(zone, ms),
    fromFields: (year, month, date, hours, minutes, seconds) =>
      new ZonedDate(
        zone,
        zone.instant(Date.UTC(year, month, date, hours, minutes, seconds, 0))
      ),
  };
  zonedCalendars.set(timeZone, calendar);
  return calendar;
}

/**
 * Formats a schedule instant for display. When the host's zone differs from
 * this process's, the time is shown in the host's zone and names it, because
 * that is the zone the user typed the schedule in.
 */
export function formatScheduleTime(ms: number, timeZone?: string): string {
  if (scheduleCalendar(timeZone) === LOCAL_CALENDAR) {
    return new Date(ms).toLocaleString();
  }
  return new Date(ms).toLocaleString(undefined, {
    timeZone,
    timeZoneName: "short",
  });
}
