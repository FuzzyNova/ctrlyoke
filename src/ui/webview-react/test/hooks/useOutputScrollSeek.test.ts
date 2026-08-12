import { describe, expect, it } from "vitest";
import { getIdleOverscanForViewport } from "@hooks/useOutputScrollSeek";

describe("getIdleOverscanForViewport", () => {
  it("buffers about one viewport of tall rows on a narrow phone pane", () => {
    // Profiled iPhone pane: 586px tall, 321 rows across a 74,057px canvas
    // (~231px per row). Six rows of overscan buffered three-plus screens.
    expect(getIdleOverscanForViewport(586, 74057, 321)).toBe(3);
  });

  it("keeps the full buffer when rows are short relative to the pane", () => {
    expect(getIdleOverscanForViewport(1000, 30000, 600)).toBe(6);
  });

  it("never drops below a two-row buffer for very tall rows", () => {
    expect(getIdleOverscanForViewport(400, 100000, 50)).toBe(2);
  });

  it.each([
    ["no rows", 586, 0, 0],
    ["an unmeasured pane", 0, 74057, 321],
  ])(
    "falls back to the full buffer with %s",
    (_label, viewport, content, rowCount) => {
      expect(getIdleOverscanForViewport(viewport, content, rowCount)).toBe(6);
    }
  );
});
