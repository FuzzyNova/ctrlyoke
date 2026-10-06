import { describe, expect, it } from "vitest";
import {
  BOTH_SIDEBARS_MIN_WIDTH_PX,
  buildSidebarLayout,
  SIDEBAR_LAYOUT_PANEL_IDS,
} from "@utils/sidebarLayout";

const IDS = SIDEBAR_LAYOUT_PANEL_IDS;
const toPx = (pct: number, totalPx: number) => (pct / 100) * totalPx;

describe("buildSidebarLayout", () => {
  it("uses the stored widths when everything fits", () => {
    const layout = buildSidebarLayout({
      totalPx: 1600,
      stepsCollapsed: false,
      settingsCollapsed: false,
      stepsStoredPx: 300,
      settingsStoredPx: 320,
    });
    expect(toPx(layout[IDS.steps]!, 1600)).toBeCloseTo(300, 0);
    expect(toPx(layout[IDS.settings]!, 1600)).toBeCloseTo(320, 0);
    expect(
      layout[IDS.steps]! + layout[IDS.center]! + layout[IDS.settings]!
    ).toBeCloseTo(100, 2);
  });

  // Regression: the old clamp shrank each sidebar against the *other's*
  // stored width, handing an expanding settings panel ~100px — below its
  // 192px minSize, which the library snaps back to the collapsed 32px.
  it("never gives an expanded sidebar less than its minimum width in a tight group", () => {
    const totalPx = BOTH_SIDEBARS_MIN_WIDTH_PX + 16;
    const layout = buildSidebarLayout({
      totalPx,
      stepsCollapsed: false,
      settingsCollapsed: false,
      stepsStoredPx: 300,
      settingsStoredPx: 300,
    });
    expect(toPx(layout[IDS.steps]!, totalPx)).toBeGreaterThanOrEqual(191.9);
    expect(toPx(layout[IDS.settings]!, totalPx)).toBeGreaterThanOrEqual(191.9);
    expect(toPx(layout[IDS.center]!, totalPx)).toBeGreaterThanOrEqual(359.9);
  });

  it("shrinks each sidebar in proportion to its slack above the minimum", () => {
    // 900 total, center min 360 → 540 for sidebars; stored 400 + 300 overflow by 160.
    const layout = buildSidebarLayout({
      totalPx: 900,
      stepsCollapsed: false,
      settingsCollapsed: false,
      stepsStoredPx: 400,
      settingsStoredPx: 300,
    });
    // Slack 208 and 108 → shrink 160 * 208/316 and 160 * 108/316.
    expect(toPx(layout[IDS.steps]!, 900)).toBeCloseTo(400 - 105.3, 0);
    expect(toPx(layout[IDS.settings]!, 900)).toBeCloseTo(300 - 54.7, 0);
  });

  it("heals a persisted width below the minimum instead of collapsing the panel", () => {
    const layout = buildSidebarLayout({
      totalPx: 1200,
      stepsCollapsed: true,
      settingsCollapsed: false,
      stepsStoredPx: 300,
      settingsStoredPx: 40,
    });
    expect(toPx(layout[IDS.steps]!, 1200)).toBeCloseTo(32, 0);
    expect(toPx(layout[IDS.settings]!, 1200)).toBeCloseTo(192, 0);
  });

  it("caps a stored width at the maximum", () => {
    const layout = buildSidebarLayout({
      totalPx: 2000,
      stepsCollapsed: true,
      settingsCollapsed: false,
      stepsStoredPx: 300,
      settingsStoredPx: 900,
    });
    expect(toPx(layout[IDS.settings]!, 2000)).toBeCloseTo(480, 0);
  });
});
