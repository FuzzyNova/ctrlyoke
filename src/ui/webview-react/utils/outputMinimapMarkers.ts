/**
 * Step-marker layout for the output minimap rail.
 *
 * A marker never moves away from where its step really is. Steps whose true
 * rail positions land too close together to tell apart (or to click apart)
 * share one marker instead of being nudged along the rail — nudging was what
 * let a 40-step run push its markers off the top of the rail and over the
 * output header, and it misplaced every marker it touched long before that.
 *
 * The number of markers is therefore bounded by the rail's height, not by the
 * step count: a 10,000-step run renders at most about
 * `railHeightPx / OUTPUT_MINIMAP_GROUP_WINDOW_PX` markers.
 */

/** Painted (and clickable) height of a single step's pill, in rail pixels. */
export const OUTPUT_MINIMAP_PILL_PX = 4;
/**
 * Minimum painted height of a marker holding several steps, so a group whose
 * members sit on almost the same pixel still reads as fatter than one pill.
 */
export const OUTPUT_MINIMAP_GROUP_MIN_PX = 7;
/**
 * Steps whose true positions fall within this many rail pixels of a group's
 * first step share that group's marker. Bounds a group's own span, so a dense
 * run splits into many short groups instead of chaining into one marker that
 * covers the whole rail.
 */
export const OUTPUT_MINIMAP_GROUP_WINDOW_PX = 6;
/** Keeps a marker at the rail's very top/bottom fully on the rail. */
export const OUTPUT_MINIMAP_MARKER_EDGE_INSET_PX = 3;
/** Painted gap left between two neighbouring markers' extents. */
const MARKER_SEPARATION_PX = 1;

export interface OutputMinimapMarkerSource {
  key: string;
  /** 0–1 fraction of the shared content height where the step starts. */
  scrollFraction: number;
}

export interface OutputMinimapMarkerGroup<T extends OutputMinimapMarkerSource> {
  /** The first member's key — stable while that step leads the group. */
  key: string;
  /** Members in rail order (ties keep their input order). */
  members: readonly T[];
  /**
   * Rail-pixel extent the marker paints and accepts clicks over. Always
   * covers every member's true position, and never overlaps a neighbour's.
   * Both are 0 while the rail is unmeasured.
   */
  topPx: number;
  bottomPx: number;
}

interface MarkerWindow<T> {
  members: T[];
  /** Unclamped position of the first member — what grouping measures from. */
  startPx: number;
  /** Edge-clamped positions of the first/last member — what painting uses. */
  firstPx: number;
  lastPx: number;
  topPx: number;
  bottomPx: number;
}

function clampToRailPx(px: number, railHeightPx: number): number {
  return Math.min(
    Math.max(px, OUTPUT_MINIMAP_MARKER_EDGE_INSET_PX),
    railHeightPx - OUTPUT_MINIMAP_MARKER_EDGE_INSET_PX
  );
}

export function groupOutputMinimapMarkers<T extends OutputMinimapMarkerSource>(
  steps: readonly T[],
  railHeightPx: number
): OutputMinimapMarkerGroup<T>[] {
  if (steps.length === 0) return [];
  // Unmeasured rail: nothing to group against. One marker per step, placed by
  // percentage at render time.
  if (railHeightPx <= 0) {
    return steps.map((step) => ({
      key: step.key,
      members: [step],
      topPx: 0,
      bottomPx: 0,
    }));
  }

  const positioned = steps
    .map((step, index) => ({
      step,
      index,
      px: Number.isFinite(step.scrollFraction)
        ? step.scrollFraction * railHeightPx
        : 0,
    }))
    .sort((a, b) => a.px - b.px || a.index - b.index);

  // Group on true positions; the edge inset only decides where a marker is
  // painted; it must not merge a run's first step into its second.

  const windows: MarkerWindow<T>[] = [];
  for (const { step, px } of positioned) {
    const current = windows[windows.length - 1];
    const paintPx = clampToRailPx(px, railHeightPx);
    if (current && px - current.startPx < OUTPUT_MINIMAP_GROUP_WINDOW_PX) {
      current.members.push(step);
      current.lastPx = paintPx;
    } else {
      windows.push({
        members: [step],
        startPx: px,
        firstPx: paintPx,
        lastPx: paintPx,
        topPx: 0,
        bottomPx: 0,
      });
    }
  }

  for (const window of windows) {
    const minHeight =
      window.members.length > 1
        ? OUTPUT_MINIMAP_GROUP_MIN_PX
        : OUTPUT_MINIMAP_PILL_PX;
    const halfHeight =
      Math.max(
        minHeight,
        window.lastPx - window.firstPx + OUTPUT_MINIMAP_PILL_PX
      ) / 2;
    const centerPx = (window.firstPx + window.lastPx) / 2;
    window.topPx = centerPx - halfHeight;
    window.bottomPx = centerPx + halfHeight;
  }

  // Neighbouring windows' painted extents can still overlap (padding around a
  // true position, a group's minimum height). Split the contested space at
  // the midpoint between the two closest members, so each marker keeps its
  // own members' true positions and no click lands on the wrong marker.
  for (let i = 1; i < windows.length; i++) {
    const prev = windows[i - 1];
    const next = windows[i];
    if (next.topPx >= prev.bottomPx + MARKER_SEPARATION_PX) continue;
    const midPx = (prev.lastPx + next.firstPx) / 2;
    prev.bottomPx = Math.min(prev.bottomPx, midPx - MARKER_SEPARATION_PX / 2);
    next.topPx = Math.max(next.topPx, midPx + MARKER_SEPARATION_PX / 2);
  }

  return windows.map((window) => {
    const topPx = Math.max(0, window.topPx);
    return {
      key: window.members[0].key,
      members: window.members,
      topPx,
      bottomPx: Math.max(topPx + 1, Math.min(railHeightPx, window.bottomPx)),
    };
  });
}
