import * as assert from "assert";
import { setup, suite, teardown, test } from "mocha";
import { nextCronOccurrence } from "../../utils/CronSchedule";
import {
  formatScheduleTime,
  LOCAL_CALENDAR,
  scheduleCalendar,
} from "../../utils/ScheduleCalendar";
import {
  nextScheduleOccurrence,
  validateWorkflowSchedule,
} from "../../utils/WorkflowSchedule";

/**
 * A zoned calendar must give exactly what native `Date` gives when the
 * process itself runs in that zone, so the dashboard's preview matches what
 * the host fires. Each case is computed both ways and compared.
 */
suite("ScheduleCalendar", () => {
  const originalTimezone = process.env.TZ;
  /** The process zone the zoned results are computed from; differs from every host zone below. */
  const BROWSER_ZONE = "Pacific/Honolulu";
  setup(() => {
    process.env.TZ = BROWSER_ZONE;
  });
  teardown(() => {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  });

  /** Runs `compute` with a zoned calendar from the browser zone, then natively in `zone`. */
  function both<T>(
    zone: string,
    compute: (calendar: typeof LOCAL_CALENDAR) => T
  ): { zoned: T; native: T } {
    process.env.TZ = BROWSER_ZONE;
    const calendar = scheduleCalendar(zone);
    assert.notStrictEqual(calendar, LOCAL_CALENDAR);
    const zoned = compute(calendar);
    process.env.TZ = zone;
    const native = compute(LOCAL_CALENDAR);
    process.env.TZ = BROWSER_ZONE;
    return { zoned, native };
  }

  // US and EU transitions, a southern-hemisphere zone, a 30-minute DST shift,
  // and a zone with no DST.
  const HOST_ZONES = [
    "America/New_York",
    "Europe/London",
    "Australia/Sydney",
    "Australia/Lord_Howe",
    "Asia/Kolkata",
  ];
  const EXPRESSIONS = [
    "*/7 * * * *",
    "30 2 * * *",
    "30 1 * * *",
    "0 9 * * 1-5",
    "15 0 1 * *",
    "0 0 29 2 *",
  ];
  // Hourly probes across days that contain each zone's 2026 transitions.
  const AFTER_TIMES: number[] = [];
  for (const day of [
    "2026-03-08",
    "2026-03-29",
    "2026-04-05",
    "2026-10-04",
    "2026-10-25",
    "2026-11-01",
  ]) {
    for (let hour = 0; hour < 24; hour += 1) {
      AFTER_TIMES.push(Date.parse(`${day}T00:00:00Z`) + hour * 3_600_000);
    }
  }

  test("cron occurrences match native Date in the host's zone", () => {
    for (const zone of HOST_ZONES) {
      for (const expression of EXPRESSIONS) {
        const { zoned, native } = both(zone, (calendar) =>
          AFTER_TIMES.map((after) =>
            nextCronOccurrence(expression, after, calendar)
          )
        );
        assert.deepStrictEqual(zoned, native, `${zone} ${expression}`);
      }
    }
  });

  test("one-shot and until datetimes resolve and validate like native Date", () => {
    const wallTimes = [
      "2026-03-08T02:30", // US spring gap
      "2026-11-01T01:30", // US fall-back repeat
      "2026-03-29T01:30", // EU spring gap
      "2026-10-25T01:30", // EU fall-back repeat
      "2026-10-04T02:15", // Lord Howe / Sydney spring gap
      "2026-04-05T01:45", // Lord Howe fall-back repeat
      "2026-02-30T09:00", // never valid
      "2026-07-14T09:00",
    ];
    const after = Date.parse("2026-01-01T00:00:00Z");
    for (const zone of HOST_ZONES) {
      const { zoned, native } = both(zone, (calendar) =>
        wallTimes.map((at) => {
          const schedule = {
            enabled: true,
            hostId: "host",
            trigger: { at },
          };
          const validation = validateWorkflowSchedule(schedule, calendar);
          return typeof validation === "string"
            ? validation
            : nextScheduleOccurrence(schedule, after, calendar);
        })
      );
      assert.deepStrictEqual(zoned, native, zone);
    }
  });

  test("a once time is computed in the host's zone, not the browser's", () => {
    const schedule = {
      enabled: true,
      hostId: "host",
      trigger: { at: "2026-12-01T09:00" },
    };
    const after = Date.parse("2026-11-13T00:00:00Z");
    assert.strictEqual(
      nextScheduleOccurrence(
        schedule,
        after,
        scheduleCalendar("America/New_York")
      ),
      Date.parse("2026-12-01T14:00:00Z")
    );
    // Future in the browser's zone (09:00 Honolulu = 19:00Z) but past for a
    // host in Tokyo (09:00 JST = 00:00Z), so it never runs there.
    const late = Date.parse("2026-12-01T10:00:00Z");
    assert.ok(nextScheduleOccurrence(schedule, late) !== null);
    assert.strictEqual(
      nextScheduleOccurrence(schedule, late, scheduleCalendar("Asia/Tokyo")),
      null
    );
  });

  test("uses native Date for an absent, local or unknown zone", () => {
    assert.strictEqual(scheduleCalendar(undefined), LOCAL_CALENDAR);
    assert.strictEqual(scheduleCalendar(BROWSER_ZONE), LOCAL_CALENDAR);
    assert.strictEqual(scheduleCalendar("Not/AZone"), LOCAL_CALENDAR);
  });

  test("names the host's zone only when it differs from the local one", () => {
    const ms = Date.parse("2026-12-01T14:00:00Z");
    assert.strictEqual(
      formatScheduleTime(ms, BROWSER_ZONE),
      new Date(ms).toLocaleString()
    );
    const hosted = formatScheduleTime(ms, "America/New_York");
    assert.notStrictEqual(hosted, new Date(ms).toLocaleString());
    assert.ok(/9:00/.test(hosted), hosted);
  });
});
