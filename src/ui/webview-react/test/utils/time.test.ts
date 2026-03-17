import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatDuration,
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
    expect(formatRelativeTimeVerbose(Date.now() - 120_000)).toBe("2 minutes ago");
  });

  it("returns singular/plural hours", () => {
    expect(formatRelativeTimeVerbose(Date.now() - 3_600_000)).toBe("1 hour ago");
    expect(formatRelativeTimeVerbose(Date.now() - 7_200_000)).toBe("2 hours ago");
  });

  it('returns "Yesterday" for 1 day ago', () => {
    expect(formatRelativeTimeVerbose(Date.now() - 86_400_000)).toBe("Yesterday");
  });

  it("returns plural days for > 1 day ago", () => {
    expect(formatRelativeTimeVerbose(Date.now() - 172_800_000)).toBe("2 days ago");
  });
});
