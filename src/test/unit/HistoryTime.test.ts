import * as assert from "assert";
import { suite, test } from "mocha";
import { parseHistoryTime } from "../../cli/HistoryTime";

suite("HistoryTime", () => {
  const now = Date.parse("2025-01-01T00:00:00.000Z");

  suite("parseHistoryTime", () => {
    test("parses the documented relative values", () => {
      assert.strictEqual(parseHistoryTime("7d", now), now - 7 * 86_400_000);
      assert.strictEqual(parseHistoryTime("24h", now), now - 24 * 3_600_000);
      assert.strictEqual(parseHistoryTime("30m", now), now - 30 * 60_000);
    });

    test("parses an ISO date", () => {
      assert.strictEqual(
        parseHistoryTime("2024-06-15", now),
        Date.parse("2024-06-15")
      );
    });

    test("uses the whole date for an end bound", () => {
      assert.strictEqual(
        parseHistoryTime("2024-06-15", now, "end"),
        Date.parse("2024-06-15T23:59:59.999Z")
      );
      assert.strictEqual(
        parseHistoryTime("2024-06-15", now, "start"),
        Date.parse("2024-06-15T00:00:00.000Z")
      );
    });

    test("parses offset-less date-times as UTC", () => {
      assert.strictEqual(
        parseHistoryTime("2024-06-15T12:30", now),
        Date.parse("2024-06-15T12:30:00Z")
      );
    });

    test("parses ISO date-times with Z and an offset", () => {
      assert.strictEqual(
        parseHistoryTime("2024-06-15T12:30:45Z", now),
        Date.parse("2024-06-15T12:30:45Z")
      );
      assert.strictEqual(
        parseHistoryTime("2024-06-15T12:30:45+02:00", now),
        Date.parse("2024-06-15T12:30:45+02:00")
      );
    });

    for (const value of ["7", "Monday 7", "1w", "2 days"]) {
      test(`rejects ${JSON.stringify(value)}`, () => {
        assert.throws(
          () => parseHistoryTime(value, now),
          (error: Error) =>
            error.message ===
            `Invalid history time "${value}"; use an ISO-8601 timestamp or a relative value such as 7d, 24h, or 30m`
        );
      });
    }

    for (const value of ["2026-02-30", "2026-04-31", "2024-02-30T12:00Z"]) {
      test(`rejects impossible calendar date ${JSON.stringify(value)}`, () => {
        assert.throws(
          () => parseHistoryTime(value, now),
          /Invalid history time/
        );
      });
    }
  });
});
