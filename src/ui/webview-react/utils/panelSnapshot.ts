import type { MutableRefObject } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { WebviewLog } from "@utils/logger";

interface PanelSnapshot {
  collapsed: boolean | null;
  sizePct: number | null;
  sizePx: number | null;
}

/**
 * Reads panel state for debug logging without letting transient library timing
 * issues crash the webview during mount/remount.
 */
export function readPanelSnapshot(
  panelRef: MutableRefObject<PanelImperativeHandle | null>,
  label: string
): PanelSnapshot {
  const panel = panelRef.current;
  if (!panel) {
    return {
      collapsed: null,
      sizePct: null,
      sizePx: null,
    };
  }

  try {
    const size = panel.getSize();
    return {
      collapsed: panel.isCollapsed(),
      sizePct: size.asPercentage,
      sizePx: size.inPixels,
    };
  } catch (error) {
    WebviewLog.warn(
      `[LAYOUT][snapshot] Failed to read panel state for ${label}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return {
      collapsed: null,
      sizePct: null,
      sizePx: null,
    };
  }
}
