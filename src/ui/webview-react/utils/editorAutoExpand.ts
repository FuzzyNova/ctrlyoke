import type { MutableRefObject } from "react";
import type {
  GroupImperativeHandle,
  PanelImperativeHandle,
} from "react-resizable-panels";
import { triggerPanelAnimation } from "@utils/panelAnimation";

/**
 * Geometry for growing the editor panel beyond the size the user dragged it to.
 *
 * Two features move the same panel and so must agree on where it stops:
 * typing auto-expand (`CodeMirrorEditor` overflow events consumed by
 * `App.tsx`) and the prompt-properties drawer, which expands the editor so its
 * properties are visible on a short editor panel. Both resolve an absolute
 * editor height and apply it through the center split's percentage layout,
 * and neither ever exceeds `EDITOR_AUTO_EXPAND_MAX_FRACTION` of the split.
 */

/** CustomEvent `CodeMirrorEditor` emits when its content over/under-flows the editor viewport. */
export const EDITOR_OVERFLOW_EVENT = "cy-editor-overflow-change";

/** CustomEvent asking `CodeMirrorEditor` to re-measure after an ancestor panel resize. */
export const EDITOR_REMEASURE_EVENT = "cy-request-editor-remeasure";

/**
 * What produced an overflow reading. Only `DOC` may expand the panel —
 * a `GEOMETRY` reading is the panel's own resize coming back around, and
 * acting on it would undo a manual drag-smaller on the next frame.
 */
export const EDITOR_OVERFLOW_CAUSES = {
  DOC: "doc",
  GEOMETRY: "geometry",
} as const;
export type EditorOverflowCause =
  (typeof EDITOR_OVERFLOW_CAUSES)[keyof typeof EDITOR_OVERFLOW_CAUSES];

export interface EditorOverflowDetail {
  /** Content height minus viewport height: positive overflows, negative has slack. */
  signedOverflow: number;
  cause: EditorOverflowCause;
}

/**
 * Share of the combined output+editor height typing auto-expand may grow the
 * editor to. Also the ceiling on the drawer expansion below, so a long prompt
 * can still hold the panel taller than the drawer asks for.
 */
export const EDITOR_AUTO_EXPAND_MAX_FRACTION = 0.6;

/**
 * Share of that same height the properties drawer expands the editor to.
 * Deliberately short of the typing ceiling: enough to read the properties
 * without the drawer swallowing the output pane behind it.
 */
export const DRAWER_EXPANSION_FRACTION = 0.5;

/**
 * Duration and easing of the drawer's own slide — `transition-transform
 * duration-300` in `PropertiesDrawer.tsx`, plus Tailwind's default timing
 * function. The editor panel is resized over the same pair so the drawer
 * reads as pushing the panel open instead of following a snap; change them
 * together or the two halves visibly drift apart.
 */
export const DRAWER_EXPANSION_ANIMATION_MS = 300;
export const DRAWER_EXPANSION_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";

/**
 * How long after starting that animation a panel measurement is still the
 * transition's intermediate height rather than its destination. Panels report
 * their size from `offsetHeight` through a ResizeObserver, so every frame of
 * the animation reaches `onResize` and none of them is the real size.
 */
export const DRAWER_EXPANSION_SETTLE_MS = DRAWER_EXPANSION_ANIMATION_MS + 50;

/** Panel ids of the output/editor vertical split, per layout. */
export const CENTER_PANEL_IDS = {
  desktop: { output: "output-panel", editor: "editor-panel" },
  mobile: { output: "mobile-output-panel", editor: "mobile-editor-panel" },
} as const;

export type CenterPanelIds =
  (typeof CENTER_PANEL_IDS)[keyof typeof CENTER_PANEL_IDS];

/** Imperative handles needed to measure and resize one output/editor split. */
export interface CenterSplitHandles {
  groupRef: MutableRefObject<GroupImperativeHandle | null>;
  outputRef: MutableRefObject<PanelImperativeHandle | null>;
  editorRef: MutableRefObject<PanelImperativeHandle | null>;
  panelIds: CenterPanelIds;
}

export interface CenterSplitMeasurement {
  /** Current editor panel height in pixels. */
  editorPx: number;
  /** Combined output+editor height the two panels divide between them. */
  totalPx: number;
}

/**
 * Measures the live split, or returns null while the group/panels are
 * unmounted or not yet sized (mid-remount, or both panels collapsed).
 */
export function measureCenterSplit(
  handles: CenterSplitHandles
): CenterSplitMeasurement | null {
  const group = handles.groupRef.current;
  const output = handles.outputRef.current;
  const editor = handles.editorRef.current;
  if (!group || !output || !editor) return null;

  const outputPx = output.getSize().inPixels ?? 0;
  const editorPx = editor.getSize().inPixels ?? 0;
  const totalPx = outputPx + editorPx;
  if (totalPx <= 0) return null;

  return { editorPx, totalPx };
}

/** Never below `basePx` — a user who dragged the editor past the fraction keeps their size. */
function expansionHeightPx(
  totalPx: number,
  basePx: number,
  fraction: number
): number {
  return Math.max(basePx, totalPx * fraction);
}

/** Highest editor height typing auto-expansion may reach. */
export function editorAutoExpandCeilingPx(
  totalPx: number,
  basePx: number
): number {
  return expansionHeightPx(totalPx, basePx, EDITOR_AUTO_EXPAND_MAX_FRACTION);
}

/** Editor height the properties drawer expands to when it opens. */
export function drawerExpansionTargetPx(
  totalPx: number,
  basePx: number
): number {
  return expansionHeightPx(totalPx, basePx, DRAWER_EXPANSION_FRACTION);
}

/**
 * Clamps a desired editor height into the expansion band. `floorPx` wins over
 * `ceilingPx` so a caller holding the panel open (the properties drawer) is
 * not shrunk by a ceiling computed from a smaller container.
 */
export function clampEditorHeightPx(
  desiredPx: number,
  floorPx: number,
  ceilingPx: number
): number {
  return Math.max(floorPx, Math.min(desiredPx, Math.max(floorPx, ceilingPx)));
}

/** Percentage split for an absolute editor height, rounded as the panel library stores it. */
export function centerSplitPercentages(
  editorPx: number,
  totalPx: number
): { output: number; editor: number } {
  const editor = Number(((editorPx / totalPx) * 100).toFixed(3));
  return { editor, output: Number((100 - editor).toFixed(3)) };
}

/**
 * Resizes the split to an absolute editor height and asks CodeMirror to
 * re-measure against it. Returns false when the group rejected the layout
 * (it can be unstable mid-remount) so callers can roll their bookkeeping back.
 */
export function applyEditorHeightPx(
  handles: CenterSplitHandles,
  editorPx: number,
  totalPx: number
): boolean {
  const group = handles.groupRef.current;
  if (!group) return false;

  const pct = centerSplitPercentages(editorPx, totalPx);
  try {
    group.setLayout({
      [handles.panelIds.output]: pct.output,
      [handles.panelIds.editor]: pct.editor,
    });
  } catch {
    // The group can reject a layout while remounting — leave the panel alone.
    return false;
  }
  window.dispatchEvent(new CustomEvent(EDITOR_REMEASURE_EVENT));
  return true;
}

/**
 * `applyEditorHeightPx`, but transitioned over the drawer's own slide so the
 * two move as one. Without it the panel jumps to its new height before the
 * drawer has started sliding, which reads as two unrelated animations.
 */
export function animateEditorHeightPx(
  handles: CenterSplitHandles,
  editorPx: number,
  totalPx: number
): boolean {
  triggerPanelAnimation({
    durationMs: DRAWER_EXPANSION_ANIMATION_MS,
    easing: DRAWER_EXPANSION_EASING,
  });
  return applyEditorHeightPx(handles, editorPx, totalPx);
}
