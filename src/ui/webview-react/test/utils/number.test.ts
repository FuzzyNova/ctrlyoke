import { describe, expect, it } from "vitest";
import { formatBytes, formatMagnitude } from "@utils/number";

describe("formatMagnitude", () => {
  it.each([
    [999, "999"],
    [1_000, "1.0K"],
    [12_345, "12.3K"],
    [999_949, "999.9K"],
    [999_950, "1.0M"],
    [999_999, "1.0M"],
    [1_000_000, "1.0M"],
    [1_234_567, "1.2M"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatMagnitude(value)).toBe(expected);
  });

  it("leaves negative and non-finite values in their string form", () => {
    expect(formatMagnitude(-1_000)).toBe("-1000");
    expect(formatMagnitude(Number.NaN)).toBe("NaN");
    expect(formatMagnitude(Number.POSITIVE_INFINITY)).toBe("Infinity");
  });
});

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [1_023, "1023 B"],
    [1_024, "1 KB"],
    [1_556, "1.5 KB"],
    [12 * 1_024, "12 KB"],
    [1_024 * 1_024 - 1, "1 MB"],
    [3.25 * 1_024 * 1_024, "3.3 MB"],
    [5 * 1_024 ** 4, "5 TB"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatBytes(value)).toBe(expected);
  });
});
