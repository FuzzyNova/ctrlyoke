import * as assert from "assert";
import {
  normalizeUsageTimestamp,
  UNIX_SECONDS_THRESHOLD,
} from "../../core/harness/shared/usage/UsageTimestampUtils";

suite("UsageTimestampUtils", () => {
  test("converts Unix seconds to epoch milliseconds", () => {
    assert.strictEqual(
      normalizeUsageTimestamp(1_700_000_000),
      1_700_000_000_000
    );
  });

  test("preserves epoch milliseconds at the boundary", () => {
    assert.strictEqual(
      normalizeUsageTimestamp(UNIX_SECONDS_THRESHOLD),
      UNIX_SECONDS_THRESHOLD
    );
  });

  test("converts ISO timestamps to epoch milliseconds", () => {
    assert.strictEqual(
      normalizeUsageTimestamp("2026-08-09T12:34:56.789Z"),
      Date.parse("2026-08-09T12:34:56.789Z")
    );
  });

  test("rejects malformed timestamps", () => {
    assert.strictEqual(normalizeUsageTimestamp("not-a-timestamp"), undefined);
    assert.strictEqual(normalizeUsageTimestamp(Number.NaN), undefined);
  });
});
