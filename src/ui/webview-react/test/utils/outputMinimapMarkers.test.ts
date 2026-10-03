import { describe, expect, it } from "vitest";
import {
  OUTPUT_MINIMAP_GROUP_MIN_PX,
  OUTPUT_MINIMAP_GROUP_WINDOW_PX,
  OUTPUT_MINIMAP_MARKER_EDGE_INSET_PX,
  groupOutputMinimapMarkers,
  type OutputMinimapMarkerGroup,
  type OutputMinimapMarkerSource,
} from "@utils/outputMinimapMarkers";

function makeSteps(fractions: readonly number[]): OutputMinimapMarkerSource[] {
  return fractions.map((scrollFraction, index) => ({
    key: `queue:${index}`,
    scrollFraction,
  }));
}

function evenlySpaced(count: number): OutputMinimapMarkerSource[] {
  return makeSteps(Array.from({ length: count }, (_, i) => i / count));
}

function trueRailPx(fraction: number, railHeightPx: number): number {
  return Math.min(
    Math.max(fraction * railHeightPx, OUTPUT_MINIMAP_MARKER_EDGE_INSET_PX),
    railHeightPx - OUTPUT_MINIMAP_MARKER_EDGE_INSET_PX
  );
}

function expectMarkersInvariant(
  groups: OutputMinimapMarkerGroup<OutputMinimapMarkerSource>[],
  stepCount: number,
  railHeightPx: number
) {
  expect(groups.reduce((n, group) => n + group.members.length, 0)).toBe(
    stepCount
  );
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    // Every marker stays on the rail — the 40-step bug pushed them above it,
    // over the output header.
    expect(group.topPx).toBeGreaterThanOrEqual(0);
    expect(group.bottomPx).toBeLessThanOrEqual(railHeightPx);
    expect(group.bottomPx).toBeGreaterThan(group.topPx);
    // Never moved: the marker covers every member's true position.
    for (const step of group.members) {
      const px = trueRailPx(step.scrollFraction, railHeightPx);
      expect(px).toBeGreaterThanOrEqual(group.topPx - 0.5);
      expect(px).toBeLessThanOrEqual(group.bottomPx + 0.5);
    }
    // Neighbouring markers never overlap, so no click lands on the wrong one.
    if (i > 0) {
      expect(group.topPx).toBeGreaterThanOrEqual(groups[i - 1].bottomPx);
    }
  }
}

describe("groupOutputMinimapMarkers", () => {
  it("gives well-spaced steps one marker each, centered on their true position", () => {
    const groups = groupOutputMinimapMarkers(makeSteps([0.1, 0.9]), 200);

    expect(groups.map((group) => group.members.length)).toEqual([1, 1]);
    expect(groups.map((g) => (g.topPx + g.bottomPx) / 2)).toEqual([20, 180]);
  });

  it("shares one fatter marker between steps too close to tell apart", () => {
    const groups = groupOutputMinimapMarkers(makeSteps([0.5, 0.505]), 200);

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("queue:0");
    expect(groups[0].members.map((step) => step.key)).toEqual([
      "queue:0",
      "queue:1",
    ]);
    expect(groups[0].bottomPx - groups[0].topPx).toBeGreaterThanOrEqual(
      OUTPUT_MINIMAP_GROUP_MIN_PX
    );
  });

  it("orders members by rail position, whatever order the steps arrive in", () => {
    const groups = groupOutputMinimapMarkers(makeSteps([0.8, 0.2]), 200);

    expect(groups.map((group) => group.key)).toEqual(["queue:1", "queue:0"]);
  });

  it("keeps a 40-step run on a 300px rail without grouping or leaving the rail", () => {
    const groups = groupOutputMinimapMarkers(evenlySpaced(40), 300);

    expect(groups).toHaveLength(40);
    expectMarkersInvariant(groups, 40, 300);
  });

  it("groups a 400-step run on a 300px rail without leaving the rail", () => {
    const groups = groupOutputMinimapMarkers(evenlySpaced(400), 300);

    expect(groups.length).toBeLessThan(400);
    expectMarkersInvariant(groups, 400, 300);
  });

  it("bounds the marker count by rail height for a 10,000-step run", () => {
    const groups = groupOutputMinimapMarkers(evenlySpaced(10_000), 300);

    expect(groups.length).toBeLessThanOrEqual(
      Math.ceil(300 / OUTPUT_MINIMAP_GROUP_WINDOW_PX) + 1
    );
    expectMarkersInvariant(groups, 10_000, 300);
  });

  it("keeps steps piled at the rail's bottom edge on the rail", () => {
    const groups = groupOutputMinimapMarkers(
      makeSteps(Array.from({ length: 50 }, (_, i) => 0.95 + i * 0.001)),
      60
    );

    expectMarkersInvariant(groups, 50, 60);
  });

  it("returns one marker per step while the rail is unmeasured", () => {
    const groups = groupOutputMinimapMarkers(makeSteps([0.5, 0.5]), 0);

    expect(groups.map((group) => group.members.length)).toEqual([1, 1]);
  });
});
