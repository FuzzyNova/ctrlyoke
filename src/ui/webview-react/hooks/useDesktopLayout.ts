/**
 * Desktop panel layout management hook.
 *
 * Manages refs, mount defaults, and sync effects for the three-column desktop
 * layout (prompts | center[output/editor] | settings). Isolated from mobile
 * concerns so App.tsx can focus on rendering and cross-layout transitions.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import type {
  PanelImperativeHandle,
  GroupImperativeHandle,
} from "react-resizable-panels";
import { WebviewLog } from "@utils/logger";
import { readPanelSnapshot } from "@utils/panelSnapshot";
import { syncCollapsiblePanel } from "@utils/panelSync";
import { useUiStore } from "@store/uiStore";
import { centerPanelMountDefaults } from "@utils/panelSync";
import {
  PANEL_COLLAPSED_SIZE_DEFAULT_PX,
  PANEL_COLLAPSED_SIZE_SIDEBAR,
  PANEL_MIN_SIZE_CENTER,
  PANEL_MIN_SIZE_CENTER_COLUMN,
  PANEL_MIN_SIZE_EDITOR_PX,
  PANEL_MIN_SIZE_SIDEBAR,
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
  const stepsRef = useRef<PanelImperativeHandle>(null);
  const outputRef = useRef<PanelImperativeHandle>(null);
  const editorRef = useRef<PanelImperativeHandle>(null);
  const verticalGroupRef = useRef<GroupImperativeHandle>(null);
  const horizontalGroupRef = useRef<GroupImperativeHandle>(null);

  // Gate refs: block onResize store writes until after mount effects settle.
  // Reset by App.tsx whenever the layout changes (mobile↔desktop transition,
  // both-collapsed → one-open transition).
  const initializedRef = useRef(false);
  const horizontalInitializedRef = useRef(false);

  // Previous collapse state of each side panel, used to detect the
  // collapsed→expanded transition that triggers sidebar mutual exclusion.
  const prevSettingsCollapsedRef = useRef(settingsCollapsed);
  const prevPromptsCollapsedRef = useRef(promptsCollapsed);

  // Resize tracking
  const isForcingResize = useRef(false);
  const needsForcedResize = useRef(outputCollapsed !== editorCollapsed);
  const needsExpandedLayoutRestore = useRef(
    outputCollapsed !== editorCollapsed
  );
  const remountSyncFrameRef = useRef<number | null>(null);
  const remountStableFramesRef = useRef(0);
  const remountPreviousTotalSizeRef = useRef<number | null>(null);

  // Size persistence — initialized from store so sizes survive VS Code restarts.
  const lastDesktopSizes = useRef({
    ...useUiStore.getState().lastDesktopSizes,
  });

  // Stable mount defaults — only recomputed by App.tsx on Group remount
  // transitions; keeping them constant while the Group is alive prevents the
  // library from re-initialising and clobbering imperative calls.
  // steps/settings/editor use pixel strings; output uses a percentage string.
  const desktopMountDefaults = useRef({
    steps: `${lastDesktopSizes.current.steps}px`,
    settings: `${lastDesktopSizes.current.settings}px`,
  });
  // undefined means "no defaultSize" → the Panel uses flexGrow:1, which gives
  // the group the full container height so collapsedSize % is computed correctly.
  const { output: initOutput, editor: initEditor } = centerPanelMountDefaults(
    outputCollapsed,
    editorCollapsed,
    lastDesktopSizes.current.editor
  );
  const mountDefaultOutput = useRef<string | undefined>(initOutput);
  const mountDefaultEditor = useRef<string | undefined>(initEditor);

  // Tracks both-collapsed → one-open transition; App.tsx updates this during
  // render to recompute mountDefault* before the Group remounts.
  const wasBothCollapsed = useRef(outputCollapsed && editorCollapsed);

  const getDesktopPanelSnapshot = () => {
    const store = useUiStore.getState();
    const steps = readPanelSnapshot(stepsRef, "desktop-steps");
    const settings = readPanelSnapshot(settingsRef, "desktop-settings");
    const output = readPanelSnapshot(outputRef, "desktop-output");
    const editor = readPanelSnapshot(editorRef, "desktop-editor");

    return {
      isMobile,
      initialized: initializedRef.current,
      horizontalInitialized: horizontalInitializedRef.current,
      isForcingResize: isForcingResize.current,
      needsForcedResize: needsForcedResize.current,
      store: {
        promptsCollapsed: store.stepsCollapsed,
        settingsCollapsed: store.settingsCollapsed,
        outputCollapsed: store.outputCollapsed,
        editorCollapsed: store.editorCollapsed,
      },
      panelState: {
        steps: {
          collapsed: steps.collapsed,
          sizePx: steps.sizePx,
        },
        settings: {
          collapsed: settings.collapsed,
          sizePx: settings.sizePx,
        },
        output: {
          collapsed: output.collapsed,
          sizePct: output.sizePct,
        },
        editor: {
          collapsed: editor.collapsed,
          sizePx: editor.sizePx,
        },
      },
      lastDesktopSizes: { ...lastDesktopSizes.current },
      mountDefaults: {
        steps: desktopMountDefaults.current.steps,
        settings: desktopMountDefaults.current.settings,
        output: mountDefaultOutput.current,
        editor: mountDefaultEditor.current,
      },
    };
  };

  const getHorizontalGroupTotalPx = () => {
    const groupElement = document.getElementById("flightpath-main-layout");
    return groupElement?.getBoundingClientRect().width ?? 0;
  };

  // Pixel width required to display both side panels (prompts + settings) and the
  // center column simultaneously, each at its minimum size. Below this threshold
  // the two side panels are mutually exclusive: expanding one collapses the
  // other. Without this, buildHorizontalLayout() is forced to request
  // sub-minimum widths for the side panels, which react-resizable-panels cannot
  // satisfy — it clamps each side back to its 192px minSize, over-constrains the
  // group, and strands the just-expanded panel at its collapsed width.
  const bothSidebarsMinWidthPx =
    2 * Number.parseInt(PANEL_MIN_SIZE_SIDEBAR, 10) +
    Number.parseInt(PANEL_MIN_SIZE_CENTER_COLUMN, 10);

  const canFitBothSidebars = () => {
    const totalPx = getHorizontalGroupTotalPx();
    // Treat an unmeasured group (totalPx === 0) as "fits" so we never collapse a
    // panel based on a missing measurement.
    return totalPx === 0 || totalPx >= bothSidebarsMinWidthPx;
  };

  const getHorizontalCollapsedPct = (totalPx: number) =>
    Number(
      (
        (Number.parseInt(PANEL_COLLAPSED_SIZE_SIDEBAR, 10) / totalPx) *
        100
      ).toFixed(3)
    );

  const getHorizontalCenterMinPct = (totalPx: number) =>
    Number(
      (
        (Number.parseInt(PANEL_MIN_SIZE_CENTER_COLUMN, 10) / totalPx) *
        100
      ).toFixed(3)
    );

  const buildHorizontalLayout = (totalPx: number) => {
    const collapsedPct = getHorizontalCollapsedPct(totalPx);
    const centerMinPct = getHorizontalCenterMinPct(totalPx);
    const maxSidePct = Math.max(0, 100 - centerMinPct);

    const stepsStoredPct = Number(
      ((lastDesktopSizes.current.steps / totalPx) * 100).toFixed(3)
    );
    const settingsStoredPct = Number(
      ((lastDesktopSizes.current.settings / totalPx) * 100).toFixed(3)
    );

    let stepsPct = promptsCollapsed ? collapsedPct : stepsStoredPct;
    let settingsPct = settingsCollapsed ? collapsedPct : settingsStoredPct;
    const maxExpandedStepsPct = promptsCollapsed
      ? collapsedPct
      : Math.max(0, maxSidePct - settingsPct);
    const maxExpandedSettingsPct = settingsCollapsed
      ? collapsedPct
      : Math.max(0, maxSidePct - stepsPct);

    if (!promptsCollapsed) {
      stepsPct = Math.min(stepsPct, maxExpandedStepsPct);
    }
    if (!settingsCollapsed) {
      settingsPct = Math.min(settingsPct, maxExpandedSettingsPct);
    }

    const totalSidePct = stepsPct + settingsPct;
    if (totalSidePct > maxSidePct && totalSidePct > 0) {
      const availableExpandedPct =
        maxSidePct -
        (promptsCollapsed ? collapsedPct : 0) -
        (settingsCollapsed ? collapsedPct : 0);
      const expandedTotalPct =
        (promptsCollapsed ? 0 : stepsPct) + (settingsCollapsed ? 0 : settingsPct);
      const scale =
        expandedTotalPct > 0
          ? Math.max(0, availableExpandedPct) / expandedTotalPct
          : 1;

      if (!promptsCollapsed) {
        stepsPct = Number((stepsPct * scale).toFixed(3));
      }
      if (!settingsCollapsed) {
        settingsPct = Number((settingsPct * scale).toFixed(3));
      }
    }

    const centerPct = Number((100 - stepsPct - settingsPct).toFixed(3));

    return {
      "prompts-panel": stepsPct,
      "center-content": centerPct,
      "settings-panel": settingsPct,
    };
  };

  const applyHorizontalLayoutSync = (reason: string) => {
    syncCollapsiblePanel(stepsRef, promptsCollapsed);
    syncCollapsiblePanel(settingsRef, settingsCollapsed);

    if (!horizontalGroupRef.current) {
      WebviewLog.error("[LAYOUT] horizontalGroupRef.current is null", {
        reason,
        snapshot: getDesktopPanelSnapshot(),
      });
      return;
    }

    const totalPx = getHorizontalGroupTotalPx();
    if (totalPx <= 0) {
      return;
    }

    const layout = buildHorizontalLayout(totalPx);

    try {
      horizontalGroupRef.current.setLayout(layout);
    } catch (error) {
      WebviewLog.error("[LAYOUT] setHorizontalLayout() failed", {
        reason,
        layout,
        totalPx,
        error: error instanceof Error ? error.message : String(error),
        snapshot: getDesktopPanelSnapshot(),
      });
    }
  };

  const cancelRemountSync = () => {
    if (remountSyncFrameRef.current != null) {
      window.cancelAnimationFrame(remountSyncFrameRef.current);
      remountSyncFrameRef.current = null;
    }
    remountStableFramesRef.current = 0;
    remountPreviousTotalSizeRef.current = null;
  };

  const getVerticalGroupTotalPx = () => {
    const outputPx = outputRef.current?.getSize().inPixels ?? 0;
    const editorPx = editorRef.current?.getSize().inPixels ?? 0;
    return outputPx + editorPx;
  };

  const getRestoredCenterLayout = (totalPx: number) => {
    const outputMinPct = Number(PANEL_MIN_SIZE_CENTER);
    const editorMinPct = Number(
      ((PANEL_MIN_SIZE_EDITOR_PX / totalPx) * 100).toFixed(3)
    );
    const editorMaxPct = Number((100 - outputMinPct).toFixed(3));
    const clampEditorPct = (pct: number) =>
      Math.min(editorMaxPct, Math.max(editorMinPct, pct));

    const editorPctFromStoredPx = Number(
      ((lastDesktopSizes.current.editor / totalPx) * 100).toFixed(3)
    );
    const editorPct =
      editorPctFromStoredPx >= editorMinPct &&
      editorPctFromStoredPx <= editorMaxPct
        ? editorPctFromStoredPx
        : clampEditorPct(100 - lastDesktopSizes.current.output);
    const outputPct = Number((100 - editorPct).toFixed(3));

    return {
      "output-panel": outputPct,
      "editor-panel": editorPct,
    };
  };

  const setLayoutFromStoredSizes = (reason: string) => {
    if (!verticalGroupRef.current) {
      WebviewLog.error("[LAYOUT] verticalGroupRef.current is null", {
        reason,
        snapshot: getDesktopPanelSnapshot(),
      });
      return;
    }

    const totalPx = getVerticalGroupTotalPx();
    if (totalPx <= 0) return;

    const layout = getRestoredCenterLayout(totalPx);

    try {
      verticalGroupRef.current.setLayout(layout);
    } catch (error) {
      WebviewLog.error("[LAYOUT] setLayout() failed", {
        reason,
        layout,
        error: error instanceof Error ? error.message : String(error),
        snapshot: getDesktopPanelSnapshot(),
      });
    }
  };

  const setSingleCollapsedPixelLayout = (reason: string) => {
    if (!verticalGroupRef.current) {
      WebviewLog.error("[LAYOUT] verticalGroupRef.current is null", {
        reason,
        snapshot: getDesktopPanelSnapshot(),
      });
      return false;
    }

    const totalPx = getVerticalGroupTotalPx();
    if (totalPx <= PANEL_COLLAPSED_SIZE_DEFAULT_PX) {
      return false;
    }

    const collapsedPct = Number(
      ((PANEL_COLLAPSED_SIZE_DEFAULT_PX / totalPx) * 100).toFixed(3)
    );
    if (!(collapsedPct > 0 && collapsedPct < 100)) {
      return false;
    }

    const expandedPct = Number((100 - collapsedPct).toFixed(3));
    const layout = outputCollapsed
      ? {
          "output-panel": collapsedPct,
          "editor-panel": expandedPct,
        }
      : {
          "output-panel": expandedPct,
          "editor-panel": collapsedPct,
        };

    try {
      verticalGroupRef.current.setLayout(layout);
      return true;
    } catch (error) {
      WebviewLog.error("[LAYOUT] setCollapsedLayout() failed", {
        reason,
        layout,
        totalPx,
        error: error instanceof Error ? error.message : String(error),
        snapshot: getDesktopPanelSnapshot(),
      });
      return false;
    }
  };

  const applySteadyVerticalSync = (reason: string) => {
    if (outputCollapsed && editorCollapsed) {
      return;
    }

    if (outputCollapsed || editorCollapsed) {
      syncCollapsiblePanel(outputRef, outputCollapsed);
      syncCollapsiblePanel(editorRef, editorCollapsed);
      return;
    }

    if (needsExpandedLayoutRestore.current) {
      setLayoutFromStoredSizes(reason);
      needsExpandedLayoutRestore.current = false;
      return;
    }

    syncCollapsiblePanel(outputRef, false);
    syncCollapsiblePanel(editorRef, false);
  };

  const applyRemountVerticalSync = (reason: string) => {
    if (outputCollapsed && editorCollapsed) {
      return;
    }

    if (outputCollapsed || editorCollapsed) {
      syncCollapsiblePanel(outputRef, outputCollapsed);
      syncCollapsiblePanel(editorRef, editorCollapsed);
      if (setSingleCollapsedPixelLayout(reason)) {
        return;
      }
      return;
    }

    setLayoutFromStoredSizes(reason);
  };

  const finishRemountSync = (reason: string) => {
    if (outputCollapsed !== editorCollapsed) {
      setSingleCollapsedPixelLayout(`${reason}-finalize`);
    }
    cancelRemountSync();
    needsForcedResize.current = false;
    needsExpandedLayoutRestore.current = outputCollapsed !== editorCollapsed;
    isForcingResize.current = false;
    initializedRef.current = !(outputCollapsed && editorCollapsed);
  };

  const startRemountSync = () => {
    cancelRemountSync();
    isForcingResize.current = true;
    initializedRef.current = false;

    let frameCount = 0;
    const tick = () => {
      frameCount += 1;
      applyRemountVerticalSync(`remount-frame-${frameCount}`);

      const totalPx = getVerticalGroupTotalPx();
      const previousTotalPx = remountPreviousTotalSizeRef.current;
      const isStableFrame =
        previousTotalPx != null && Math.abs(totalPx - previousTotalPx) < 1;

      remountPreviousTotalSizeRef.current = totalPx;
      remountStableFramesRef.current = isStableFrame
        ? remountStableFramesRef.current + 1
        : 0;

      if (remountStableFramesRef.current >= 2 || frameCount >= 24) {
        finishRemountSync(
          remountStableFramesRef.current >= 2 ? "stable" : "max-frames"
        );
        return;
      }

      remountSyncFrameRef.current = window.requestAnimationFrame(tick);
    };

    remountSyncFrameRef.current = window.requestAnimationFrame(tick);
  };

  // ──────────────────────────────────────────────────────────────────────────
  // HORIZONTAL PANEL SYNC (prompts / settings)
  // ──────────────────────────────────────────────────────────────────────────

  // Sync collapse state before paint on initial desktop mount and on
  // mobile → desktop transition (panels remount fresh, ongoing effects won't
  // re-run unless their specific collapse state changed during mobile).
  useLayoutEffect(() => {
    if (!uiLayoutReady) return;
    if (isMobile) return;
    // Resolve a persisted/restored both-expanded state that no longer fits
    // (e.g. the VS Code side panel was narrowed while both sidebars were open).
    // Collapse the settings panel so the layout is solvable; the resulting store
    // change re-runs the settings sync below.
    const store = useUiStore.getState();
    if (!store.stepsCollapsed && !store.settingsCollapsed && !canFitBothSidebars()) {
      store.setSettingsCollapsed(true);
      return;
    }
    applyHorizontalLayoutSync("desktop-mount");
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

  // Ongoing store → panel sync for settings and prompts collapse.
  //
  // Sidebar mutual exclusion: when a side panel is expanded but there isn't room
  // for both side panels plus the center column at their minimum widths, collapse
  // the opposite side panel rather than letting the layout over-constrain and
  // strand the just-expanded panel at its collapsed width. The store change
  // re-runs the sibling's sync effect, which applies the now-solvable layout.
  useEffect(() => {
    if (!uiLayoutReady) return;
    const justExpanded =
      prevSettingsCollapsedRef.current && !settingsCollapsed;
    prevSettingsCollapsedRef.current = settingsCollapsed;
    if (isMobile) return;
    if (
      justExpanded &&
      !useUiStore.getState().stepsCollapsed &&
      !canFitBothSidebars()
    ) {
      useUiStore.getState().setPromptsCollapsed(true);
      return;
    }
    applyHorizontalLayoutSync("settings-collapse-sync");
  }, [isMobile, settingsCollapsed, uiLayoutReady]);

  useEffect(() => {
    if (!uiLayoutReady) return;
    const justExpanded =
      prevPromptsCollapsedRef.current && !promptsCollapsed;
    prevPromptsCollapsedRef.current = promptsCollapsed;
    if (isMobile) return;
    if (
      justExpanded &&
      !useUiStore.getState().settingsCollapsed &&
      !canFitBothSidebars()
    ) {
      useUiStore.getState().setSettingsCollapsed(true);
      return;
    }
    applyHorizontalLayoutSync("steps-collapse-sync");
  }, [isMobile, promptsCollapsed, uiLayoutReady]);

  // ──────────────────────────────────────────────────────────────────────────
  // VERTICAL PANEL SYNC (output / editor)
  // ──────────────────────────────────────────────────────────────────────────

  // Sync before paint to avoid a visible collapse flash. Uses forced resize
  // (setLayout) when the vertical Group remounts so both panels are restored
  // to their persisted sizes atomically.
  useLayoutEffect(() => {
    if (!uiLayoutReady) return;
    const shouldStabilizeRemount = needsForcedResize.current;

    if (shouldStabilizeRemount) {
      applyRemountVerticalSync("remount-initial");
      startRemountSync();
      return;
    }

    applySteadyVerticalSync("steady");
  }, [outputCollapsed, editorCollapsed, isMobile, uiLayoutReady]);

  // Vertical gate management: closed when both panels collapse (Group unmounts;
  // next mount re-gates until useLayoutEffect re-syncs). Opened in useEffect
  // so Panel mount onResize events — which fire in child useEffects — are still
  // gated when they run.
  useEffect(() => {
    if (!uiLayoutReady) return;
    if (outputCollapsed && editorCollapsed) {
      cancelRemountSync();
      initializedRef.current = false;
      isForcingResize.current = false;
      needsForcedResize.current = false;
      needsExpandedLayoutRestore.current = false;
    } else {
      initializedRef.current =
        !needsForcedResize.current && !isForcingResize.current;
    }
  }, [outputCollapsed, editorCollapsed, isMobile, uiLayoutReady]);

  useEffect(() => cancelRemountSync, []);

  return {
    // Panel / group refs
    settingsRef,
    stepsRef,
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
