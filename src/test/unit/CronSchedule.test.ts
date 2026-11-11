import * as assert from "assert";
import { setup, suite, teardown, test } from "mocha";
import { nextCronOccurrence, parseCronExpression } from "../../utils/CronSchedule";
import { nextScheduleOccurrence, validateWorkflowSchedule } from "../../utils/WorkflowSchedule";

suite("CronSchedule", () => {
  const originalTimezone = process.env.TZ;
  setup(() => { process.env.TZ = "America/New_York"; });
  teardown(() => {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  });
  test("accepts lists, ranges, steps and Sunday 0/7", () => {
    for (const expression of ["1,3,5 * * * *", "0-30/5 * * * *", "*/15 * * * 0", "0 0 * * 7"]) assert.strictEqual(parseCronExpression(expression).ok, true);
  });
  test("uses the day-of-month/day-of-week OR rule", () => {
    const parsed = parseCronExpression("0 0 1 * 1");
    assert.strictEqual(parsed.ok, true);
  });
  test("rejects names, macros, bad bounds, empty fields and wrong field counts", () => {
    for (const value of ["@daily", "0 0 * JAN *", "60 * * * *", "0 0 32 * *", "0 0 * * 8", "1,,2 * * * *", "* * * *"]) assert.strictEqual(parseCronExpression(value).ok, false, value);
  });
  test("crosses month and year boundaries", () => {
    const after = new Date(2025, 11, 31, 23, 59, 0).getTime();
    const next = nextCronOccurrence("0 0 1 1 *", after);
    assert.strictEqual(new Date(next!).getFullYear(), 2026);
    assert.strictEqual(new Date(next!).getMonth(), 0);
  });
  test("validates and computes until and past at schedules", () => {
    const at = new Date(2025, 0, 1, 9, 0).getTime();
    const once = { enabled: true, hostId: "host", trigger: { at: "2025-01-01T09:00" } };
    assert.notStrictEqual(typeof validateWorkflowSchedule(once), "string");
    assert.strictEqual(nextScheduleOccurrence(once, at), null);
    const recurring = { enabled: true, hostId: "host", trigger: { cron: "0 10 * * *" }, until: "2025-01-01T09:30" };
    assert.strictEqual(nextScheduleOccurrence(recurring, at), null);
  });
  test("skips non-matching days quickly and returns null for impossible dates", () => {
    const after = new Date(2026, 0, 2).getTime();
    const started = Date.now();
    assert.strictEqual(nextCronOccurrence("0 0 31 2 *", after), null);
    const yearly = nextCronOccurrence("0 0 1 1 *", after);
    assert.strictEqual(new Date(yearly!).getFullYear(), 2027);
    assert.ok(Date.now() - started < 5_000, "the day-skipping search should not scan every minute");
  });
  test("dom/dow OR rule matches either restricted field", () => {
    // 2026-01-05 is a Monday, before the 15th.
    const after = new Date(2026, 0, 3, 12, 0).getTime();
    const next = new Date(nextCronOccurrence("0 9 15 * 1", after)!);
    assert.strictEqual(next.getDate(), 5);
    assert.strictEqual(next.getHours(), 9);
  });
  test("spring gap fires at first valid minute and fall duplicate fires once", () => {
    const springAfter = new Date(2025, 2, 9, 1, 59).getTime();
    const spring = nextCronOccurrence("30 2 * * *", springAfter);
    assert.strictEqual(new Date(spring!).getHours(), 3);
    assert.strictEqual(new Date(spring!).getMinutes(), 0);
    const fallFirst = new Date(2025, 10, 2, 1, 30).getTime();
    const fall = nextCronOccurrence("30 1 * * *", fallFirst);
    assert.ok(fall! > fallFirst + 30 * 60_000);
    assert.strictEqual(new Date(fall!).getDate(), 3);
  });
});
