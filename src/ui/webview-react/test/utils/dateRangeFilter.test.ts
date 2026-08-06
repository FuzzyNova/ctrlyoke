import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDateEndMs,
  getDatePresetRange,
  getDateStartMs,
} from "@utils/dateRangeFilter";

describe("getDatePresetRange", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 1, 15, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the last seven days", () => {
    expect(getDatePresetRange("last7")).toEqual({
      from: "2024-02-09",
      to: "2024-02-15",
    });
  });

  it("returns the last thirty days", () => {
    expect(getDatePresetRange("last30")).toEqual({
      from: "2024-01-17",
      to: "2024-02-15",
    });
  });

  it("returns the previous calendar month", () => {
    expect(getDatePresetRange("lastMonth")).toEqual({
      from: "2024-01-01",
      to: "2024-01-31",
    });
  });
});

describe("date range epoch conversions", () => {
  it("uses the start and end of the selected dates", () => {
    expect(getDateStartMs("2024-02-15")).toBe(
      new Date("2024-02-15T00:00:00").getTime()
    );
    expect(getDateEndMs("2024-02-15")).toBe(
      new Date("2024-02-15T23:59:59.999").getTime()
    );
  });

  it("returns null for empty or malformed dates", () => {
    expect(getDateStartMs("")).toBeNull();
    expect(getDateEndMs("")).toBeNull();
    expect(getDateStartMs("not-a-date")).toBeNull();
    expect(getDateEndMs("not-a-date")).toBeNull();
  });
});
