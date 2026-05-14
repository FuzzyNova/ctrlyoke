import type { MutableRefObject } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { PANEL_COLLAPSED_SIZE_DEFAULT } from "../constants";

/**
 * Computes stable defaultSize values for the output/editor center panel pair.
 * Output fills remaining space (undefined = flexGrow:1) when not collapsed.
 * Editor mounts at its last pixel size when both panels are open.
 * Handles all collapse combinations: both open, one collapsed, both collapsed.
 */
export function centerPanelMountDefaults(
  outputCollapsed: boolean,
  editorCollapsed: boolean,
  editorPx: number
): { output: string | undefined; editor: string | undefined } {
  return {
    output: outputCollapsed ? PANEL_COLLAPSED_SIZE_DEFAULT : undefined,
    editor: editorCollapsed
      ? PANEL_COLLAPSED_SIZE_DEFAULT
      : outputCollapsed
        ? undefined
        : `${editorPx}px`,
  };
}

/**
 * Synchronizes a collapsible panel to the requested state without issuing
 * redundant imperative calls. This matters for the two-panel center layout:
 * calling expand() on a panel that already mounted open can disturb the
 * sibling panel's collapsed state when the Group remounts.
 */
export function syncCollapsiblePanel(
  panelRef: MutableRefObject<PanelImperativeHandle | null>,
  shouldBeCollapsed: boolean
): void {
  const panel = panelRef.current;
  if (!panel) return;

  const isCollapsed = panel.isCollapsed();

  if (shouldBeCollapsed) {
    if (!isCollapsed) {
      panel.collapse();
    }
    return;
  }

  if (isCollapsed) {
    panel.expand();
  }
}
