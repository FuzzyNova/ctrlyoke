import type { MutableRefObject } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

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
