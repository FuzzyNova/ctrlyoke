import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatDuration,
  formatFutureTime,
  formatRelativeTime,
  formatRelativeTimeVerbose,
  formatTime,
  getTimestamp,
} from "@utils/time";

describe("getTimestamp", () => {
  it("returns a number close to Date.now()", () => {
    const before = Date.now();
    const ts = getTimestamp();
    const after = Date.now();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

describe("formatTime", () => {
  it("returns a non-empty string for a valid timestamp", () => {
    const result = formatTime(Date.now());
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });
});

describe("formatDuration", () => {
  it("renders seconds only for < 1 minute", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(1_000)).toBe("1s");
    expect(formatDuration(0)).toBe("0s");
  });

  it("renders minutes only when no remaining seconds", () => {
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(120_000)).toBe("2m");
  });

  it("renders minutes and seconds", () => {
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(125_000)).toBe("2m 5s");
  });

  it("renders hours only when no remaining minutes", () => {
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(7_200_000)).toBe("2h");
  });

  it("renders hours and minutes", () => {
    expect(formatDuration(5_400_000)).toBe("1h 30m");
    expect(formatDuration(9_000_000)).toBe("2h 30m");
  });
});

describe("formatRelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "just now" for < 1 minute ago', () => {
    const ts = Date.now() - 30_000;
    expect(formatRelativeTime(ts)).toBe("just now");
  });

  it("returns minutes for 1–59 minutes ago", () => {
    expect(formatRelativeTime(Date.now() - 60_000)).toBe("1 min");
    expect(formatRelativeTime(Date.now() - 2_700_000)).toBe("45 min");
  });

  it("returns hours for 1–23 hours ago", () => {
    expect(formatRelativeTime(Date.now() - 3_600_000)).toBe("1 hr");
    expect(formatRelativeTime(Date.now() - 7_200_000)).toBe("2 hr");
  });

  it("returns days for >= 1 day ago", () => {
    expect(formatRelativeTime(Date.now() - 86_400_000)).toBe("1 day");
    expect(formatRelativeTime(Date.now() - 172_800_000)).toBe("2 days");
  });
});

describe("formatFutureTime", () => {
  // Local-time constructors (not an ISO/UTC string) so the day-boundary math
  // lines up with the test runner's own timezone the same way it would at
  // runtime — matching the day of `now` is the whole point of the function.
  const reference = new Date(2024, 0, 1, 12, 0, 0).getTime(); // Mon Jan 1, 2024, noon

  function fiveThirtyPmOn(year: number, month: number, day: number): number {
    return new Date(year, month, day, 17, 30, 0).getTime();
  }

  it("labels a reset later the same day as 'today'", () => {
    expect(formatFutureTime(fiveThirtyPmOn(2024, 0, 1), reference)).toMatch(
      / today$/
    );
  });

  it("labels a reset on the next calendar day as 'tomorrow'", () => {
    expect(formatFutureTime(fiveThirtyPmOn(2024, 0, 2), reference)).toMatch(
      / tomorrow$/
    );
  });

  it("labels a reset 2-6 days out with the short weekday name", () => {
    // Jan 4, 2024 is a Thursday.
    expect(formatFutureTime(fiveThirtyPmOn(2024, 0, 4), reference)).toMatch(
      / Thu$/
    );
  });

  it("labels a reset a week or more out with a numeric date", () => {
    expect(formatFutureTime(fiveThirtyPmOn(2024, 0, 9), reference)).toMatch(
      / 1\/9$/
    );
  });

  it("includes a time portion before the day label", () => {
    const result = formatFutureTime(fiveThirtyPmOn(2024, 0, 1), reference);
    expect(result.startsWith("today")).toBe(false);
    expect(result.length).toBeGreaterThan(" today".length);
  });
});

describe("formatRelativeTimeVerbose", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns undefined for undefined input", () => {
    expect(formatRelativeTimeVerbose(undefined)).toBeUndefined();
  });

  it('returns "Just now" for < 1 minute ago', () => {
    expect(formatRelativeTimeVerbose(Date.now() - 30_000)).toBe("Just now");
  });

  it("returns singular/plural minutes", () => {
    expect(formatRelativeTimeVerbose(Date.now() - 60_000)).toBe("1 minute ago");
    expect(formatRelativeTimeVerbose(Date.now() - 120_000)).toBe(
      "2 minutes ago"
    );
  });

  it("returns singular/plural hours", () => {
    expect(formatRelativeTimeVerbose(Date.now() - 3_600_000)).toBe(
      "1 hour ago"
    );
    expect(formatRelativeTimeVerbose(Date.now() - 7_200_000)).toBe(
      "2 hours ago"
    );
  });

  it('returns "Yesterday" for 1 day ago', () => {
    expect(formatRelativeTimeVerbose(Date.now() - 86_400_000)).toBe(
      "Yesterday"
    );
  });

  it("returns plural days for > 1 day ago", () => {
    expect(formatRelativeTimeVerbose(Date.now() - 172_800_000)).toBe(
      "2 days ago"
    );
  });
});
