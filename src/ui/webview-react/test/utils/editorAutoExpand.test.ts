import { describe, expect, it, vi } from "vitest";
import type {
  GroupImperativeHandle,
  Layout,
  PanelImperativeHandle,
} from "react-resizable-panels";
import {
  applyEditorHeightPx,
  CENTER_PANEL_IDS,
  centerSplitPercentages,
  clampEditorHeightPx,
  editorAutoExpandCeilingPx,
  EDITOR_AUTO_EXPAND_MAX_FRACTION,
  EDITOR_REMEASURE_EVENT,
  measureCenterSplit,
  type CenterSplitHandles,
} from "@utils/editorAutoExpand";

function createPanel(inPixels: number): PanelImperativeHandle {
  return {
    collapse: vi.fn(),
    expand: vi.fn(),
    getSize: () => ({ asPercentage: 0, inPixels }),
    isCollapsed: () => false,
    resize: vi.fn(),
  };
}

function createSplit(
  outputPx: number,
  editorPx: number,
  setLayout: (layout: Layout) => Layout = (layout) => layout
): {
  handles: CenterSplitHandles;
  setLayout: (layout: Layout) => Layout;
} {
  const group: GroupImperativeHandle = {
    getLayout: () => ({}),
    setLayout,
  };
  return {
    handles: {
      groupRef: { current: group },
      outputRef: { current: createPanel(outputPx) },
      editorRef: { current: createPanel(editorPx) },
      panelIds: CENTER_PANEL_IDS.desktop,
    },
    setLayout,
  };
}

describe("editorAutoExpandCeilingPx", () => {
  it("caps expansion at the shared fraction of the output+editor height", () => {
    expect(editorAutoExpandCeilingPx(1000, 180)).toBe(
      1000 * EDITOR_AUTO_EXPAND_MAX_FRACTION
    );
  });

  it("never returns less than the user's own panel height", () => {
    // A user who dragged the editor past the fraction keeps their size.
    expect(editorAutoExpandCeilingPx(1000, 800)).toBe(800);
  });
});

describe("clampEditorHeightPx", () => {
  it("clamps a desired height into the expansion band", () => {
    expect(clampEditorHeightPx(400, 180, 600)).toBe(400);
    expect(clampEditorHeightPx(900, 180, 600)).toBe(600);
    expect(clampEditorHeightPx(100, 180, 600)).toBe(180);
  });

  it("lets the floor win over a smaller ceiling", () => {
    // The properties drawer holds the panel open at a floor the ceiling of a
    // shrunken container would otherwise pull back down.
    expect(clampEditorHeightPx(300, 600, 400)).toBe(600);
  });
});

describe("centerSplitPercentages", () => {
  it("splits the group into complementary percentages", () => {
    expect(centerSplitPercentages(600, 1000)).toEqual({
      editor: 60,
      output: 40,
    });
  });

  it("rounds to the precision the panel library stores", () => {
    const pct = centerSplitPercentages(1, 3);
    expect(pct.editor).toBe(33.333);
    expect(pct.editor + pct.output).toBe(100);
  });
});

describe("measureCenterSplit", () => {
  it("reports the editor height and the combined height", () => {
    const { handles } = createSplit(700, 300);
    expect(measureCenterSplit(handles)).toEqual({
      editorPx: 300,
      totalPx: 1000,
    });
  });

  it("returns null when a handle is not mounted", () => {
    const { handles } = createSplit(700, 300);
    handles.editorRef.current = null;
    expect(measureCenterSplit(handles)).toBeNull();
  });

  it("returns null when the split has no height yet", () => {
    const { handles } = createSplit(0, 0);
    expect(measureCenterSplit(handles)).toBeNull();
  });
});

describe("applyEditorHeightPx", () => {
  it("resizes the split by panel id and asks the editor to re-measure", () => {
    const setLayout = vi.fn((layout: Layout) => layout);
    const { handles } = createSplit(700, 300, setLayout);
    const remeasure = vi.fn();
    window.addEventListener(EDITOR_REMEASURE_EVENT, remeasure);

    try {
      expect(applyEditorHeightPx(handles, 600, 1000)).toBe(true);
    } finally {
      window.removeEventListener(EDITOR_REMEASURE_EVENT, remeasure);
    }

    expect(setLayout).toHaveBeenCalledWith({
      [CENTER_PANEL_IDS.desktop.output]: 40,
      [CENTER_PANEL_IDS.desktop.editor]: 60,
    });
    expect(remeasure).toHaveBeenCalledTimes(1);
  });

  it("reports failure when the group rejects the layout", () => {
    const { handles } = createSplit(700, 300, () => {
      throw new Error("group is remounting");
    });
    expect(applyEditorHeightPx(handles, 600, 1000)).toBe(false);
  });

  it("reports failure when the group is not mounted", () => {
    const { handles } = createSplit(700, 300);
    handles.groupRef.current = null;
    expect(applyEditorHeightPx(handles, 600, 1000)).toBe(false);
  });
});
