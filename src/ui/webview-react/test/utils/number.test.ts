import { describe, expect, it } from "vitest";
import { formatMagnitude } from "@utils/number";

describe("formatMagnitude", () => {
  it.each([
    [999, "999"],
    [1_000, "1.0K"],
    [12_345, "12.3K"],
    [999_999, "1000.0K"],
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
