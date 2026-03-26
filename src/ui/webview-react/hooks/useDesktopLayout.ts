/**
 * Desktop panel layout management hook.
 *
 * Manages refs, mount defaults, and sync effects for the three-column desktop
 * layout (prompts | center[output/editor] | settings). Isolated from mobile
 * concerns so App.tsx can focus on rendering and cross-layout transitions.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import type { PanelImperativeHandle, GroupImperativeHandle } from "react-resizable-panels";
import { WebviewLog } from "@utils/logger";
import { useUiStore } from "@store/uiStore";
import {
  PANEL_COLLAPSED_SIZE_DEFAULT,
  PANEL_EXPANDED_SIZE_SINGLE,
} from "../constants";

interface DesktopLayoutParams {
  isMobile: boolean;
  uiLayoutReady: boolean;
  settingsCollapsed: boolean;
  promptsCollapsed: boolean;
  outputCollapsed: boolean;
  editorCollapsed: boolean;
}

/**
 * Creates and syncs all refs, mount defaults, and effects for the desktop
 * three-column layout. Returns refs and mutable tracking objects consumed
 * by App.tsx for JSX binding and cross-layout transition logic.
 */
export function useDesktopLayout({
  isMobile,
  uiLayoutReady,
  settingsCollapsed,
  promptsCollapsed,
  outputCollapsed,
  editorCollapsed,
}: DesktopLayoutParams) {
  // Panel imperative refs for JSX panelRef / groupRef props
  const settingsRef = useRef<PanelImperativeHandle>(null);
  const promptsRef = useRef<PanelImperativeHandle>(null);
  const outputRef = useRef<PanelImperativeHandle>(null);
  const editorRef = useRef<PanelImperativeHandle>(null);
  const verticalGroupRef = useRef<GroupImperativeHandle>(null);
  const horizontalGroupRef = useRef<GroupImperativeHandle>(null);

  // Gate refs: block onResize store writes until after mount effects settle.
  // Reset by App.tsx whenever the layout changes (mobile↔desktop transition,
  // both-collapsed → one-open transition).
  const initializedRef = useRef(false);
  const horizontalInitializedRef = useRef(false);

  // Resize tracking
  const isForcingResize = useRef(false);
  const needsForcedResize = useRef(false);

  // Size persistence — initialized from store so sizes survive VS Code restarts
  const lastDesktopSizes = useRef({ ...useUiStore.getState().lastDesktopSizes });

  // Stable mount defaults — only recomputed by App.tsx on Group remount
  // transitions; keeping them constant while the Group is alive prevents the
  // library from re-initialising and clobbering imperative calls.
  const desktopMountDefaults = useRef({
    prompts: String(lastDesktopSizes.current.prompts),
    settings: String(lastDesktopSizes.current.settings),
  });
  const mountDefaultOutput = useRef(
    outputCollapsed
      ? PANEL_COLLAPSED_SIZE_DEFAULT
      : editorCollapsed
        ? PANEL_EXPANDED_SIZE_SINGLE
        : String(lastDesktopSizes.current.output)
  );
  const mountDefaultEditor = useRef(
    editorCollapsed
      ? PANEL_COLLAPSED_SIZE_DEFAULT
      : outputCollapsed
        ? PANEL_EXPANDED_SIZE_SINGLE
        : String(lastDesktopSizes.current.editor)
  );

  // Tracks both-collapsed → one-open transition; App.tsx updates this during
  // render to recompute mountDefault* before the Group remounts.
  const wasBothCollapsed = useRef(outputCollapsed && editorCollapsed);

  // ──────────────────────────────────────────────────────────────────────────
  // HORIZONTAL PANEL SYNC (prompts / settings)
  // ──────────────────────────────────────────────────────────────────────────

  // Sync collapse state before paint on initial desktop mount and on
  // mobile → desktop transition (panels remount fresh, ongoing effects won't
  // re-run unless their specific collapse state changed during mobile).
  useLayoutEffect(() => {
    if (!uiLayoutReady) return;
    if (isMobile) return;
    if (settingsCollapsed) settingsRef.current?.collapse();
    else settingsRef.current?.expand();
    if (promptsCollapsed) promptsRef.current?.collapse();
    else promptsRef.current?.expand();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile, uiLayoutReady]);

  // Open the horizontal onResize gate after mount events have settled.
  // useEffect runs after child effects (including Panel mount onResize), so
  // spurious mount events are still gated when this fires.
  useEffect(() => {
    if (!uiLayoutReady) return;
    if (!isMobile) {
      horizontalInitializedRef.current = true;
    }
  }, [isMobile, uiLayoutReady]);

  // Ongoing store → panel sync for settings and prompts collapse
  useEffect(() => {
    if (!uiLayoutReady) return;
    if (settingsCollapsed) settingsRef.current?.collapse();
    else settingsRef.current?.expand();
  }, [settingsCollapsed, uiLayoutReady]);

  useEffect(() => {
    if (!uiLayoutReady) return;
    if (promptsCollapsed) promptsRef.current?.collapse();
    else promptsRef.current?.expand();
  }, [promptsCollapsed, uiLayoutReady]);

  // ──────────────────────────────────────────────────────────────────────────
  // VERTICAL PANEL SYNC (output / editor)
  // ──────────────────────────────────────────────────────────────────────────

  // Sync before paint to avoid a visible collapse flash. Uses forced resize
  // (setLayout) when the vertical Group remounts so both panels are restored
  // to their persisted sizes atomically.
  useLayoutEffect(() => {
    if (!uiLayoutReady) return;
    const shouldForceResize =
      !outputCollapsed && !editorCollapsed && needsForcedResize.current;

    if (shouldForceResize) {
      isForcingResize.current = true;

      if (verticalGroupRef.current) {
        const outputSize = Math.round(lastDesktopSizes.current.output);
        const editorSize = 100 - outputSize;
        const layout = { "output-panel": outputSize, "editor-panel": editorSize };
        try {
          verticalGroupRef.current.setLayout(layout);
        } catch (error) {
          WebviewLog.error(
            `[LAYOUT] setLayout() failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      } else {
        WebviewLog.error("[LAYOUT] verticalGroupRef.current is null!");
      }

      needsForcedResize.current = false;
      setTimeout(() => {
        isForcingResize.current = false;
      }, 50);
    } else {
      if (outputRef.current) {
        if (outputCollapsed) outputRef.current.collapse();
        else outputRef.current.expand();
      }
      if (editorRef.current) {
        if (editorCollapsed) editorRef.current.collapse();
        else editorRef.current.expand();
      }
    }
  }, [outputCollapsed, editorCollapsed, isMobile, uiLayoutReady]);

  // Vertical gate management: closed when both panels collapse (Group unmounts;
  // next mount re-gates until useLayoutEffect re-syncs). Opened in useEffect
  // so Panel mount onResize events — which fire in child useEffects — are still
  // gated when they run.
  useEffect(() => {
    if (!uiLayoutReady) return;
    if (outputCollapsed && editorCollapsed) {
      initializedRef.current = false;
      if (needsForcedResize.current) {
        needsForcedResize.current = false;
      }
    } else {
      initializedRef.current = true;
    }
  }, [outputCollapsed, editorCollapsed, isMobile, uiLayoutReady]);

  return {
    // Panel / group refs
    settingsRef,
    promptsRef,
    outputRef,
    editorRef,
    verticalGroupRef,
    horizontalGroupRef,
    // Mount defaults (stable refs for JSX defaultSize props)
    mountDefaultOutput,
    mountDefaultEditor,
    desktopMountDefaults,
    // Gate and flag refs (mutated by App.tsx during layout transitions)
    initializedRef,
    horizontalInitializedRef,
    isForcingResize,
    needsForcedResize,
    wasBothCollapsed,
    // Size tracking
    lastDesktopSizes,
  };
}
