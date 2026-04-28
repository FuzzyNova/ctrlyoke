import { describe, expect, it, vi } from "vitest";
import type { MutableRefObject } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { syncCollapsiblePanel } from "@utils/panelSync";

function createPanelRef(collapsed: boolean): {
  panelRef: MutableRefObject<PanelImperativeHandle | null>;
  collapse: ReturnType<typeof vi.fn>;
  expand: ReturnType<typeof vi.fn>;
} {
  const collapse = vi.fn();
  const expand = vi.fn();

  return {
    panelRef: {
      current: {
        isCollapsed: () => collapsed,
        collapse,
        expand,
        getId: () => "test-panel",
        getSize: () => ({ asPercentage: 50, inPixels: 100 }),
        isExpanded: () => !collapsed,
        resize: vi.fn(),
      } as unknown as PanelImperativeHandle,
    },
    collapse,
    expand,
  };
}

describe("syncCollapsiblePanel", () => {
  it("collapses a panel that should be collapsed", () => {
    const { panelRef, collapse, expand } = createPanelRef(false);

    syncCollapsiblePanel(panelRef, true);

    expect(collapse).toHaveBeenCalledTimes(1);
    expect(expand).not.toHaveBeenCalled();
  });

  it("expands a panel that should be open", () => {
    const { panelRef, collapse, expand } = createPanelRef(true);

    syncCollapsiblePanel(panelRef, false);

    expect(expand).toHaveBeenCalledTimes(1);
    expect(collapse).not.toHaveBeenCalled();
  });

  it("does not expand a panel that is already open", () => {
    const { panelRef, collapse, expand } = createPanelRef(false);

    syncCollapsiblePanel(panelRef, false);

    expect(expand).not.toHaveBeenCalled();
    expect(collapse).not.toHaveBeenCalled();
  });

  it("does not collapse a panel that is already collapsed", () => {
    const { panelRef, collapse, expand } = createPanelRef(true);

    syncCollapsiblePanel(panelRef, true);

    expect(collapse).not.toHaveBeenCalled();
    expect(expand).not.toHaveBeenCalled();
  });
});
