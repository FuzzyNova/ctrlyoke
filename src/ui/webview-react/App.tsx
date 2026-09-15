import {
  DOCUMENT_VISIBILITY_STATES,
  MOBILE_STEPS_MODES,
} from "@root/types/DashboardConstants";
import { useEffect, useRef, useState } from "react";
import { Panel, Group, Separator } from "react-resizable-panels";
import {
  useMessageHandler,
  captureAndSendThemeVars,
} from "@hooks/useMessageHandler";
import { useUndoRedoKeyHandler } from "@hooks/useUndoRedoKeyHandler";
import { useNewWorkflowKeyHandler } from "@hooks/useNewWorkflowKeyHandler";
import { useHistorySearchKeyHandler } from "@hooks/useHistorySearchKeyHandler";
import { useRunViewLoadWatchdog } from "@hooks/useRunViewLoadWatchdog";
import { useDuplicateWorkflowWatchdog } from "@hooks/useDuplicateWorkflowWatchdog";
import {
  useVsCodeApi,
  isStandalone,
  panelPageLoadId,
} from "@hooks/useVsCodeApi";
import { useIsMobile } from "@hooks/useMediaQuery";
import { useDesktopLayout } from "@hooks/useDesktopLayout";
import { useMobileLayout } from "@hooks/useMobileLayout";
import { useIosVisualViewportRootStyle } from "@hooks/useIosVisualViewportRootStyle";
import { useUiStore } from "@store/uiStore";
import { useSettingsStore } from "@store/settingsStore";
import { clearNotificationBadgeCount } from "@utils/browserNotifications";
import { centerPanelMountDefaults } from "@utils/panelSync";
import {
  animateEditorHeightPx,
  applyEditorHeightPx,
  CENTER_PANEL_IDS,
  clampEditorHeightPx,
  drawerExpansionTargetPx,
  DRAWER_EXPANSION_ANIMATION_MS,
  DRAWER_EXPANSION_SETTLE_MS,
  editorAutoExpandCeilingPx,
  EDITOR_OVERFLOW_CAUSES,
  EDITOR_OVERFLOW_EVENT,
  EDITOR_REMEASURE_EVENT,
  measureCenterSplit,
  type CenterSplitHandles,
  type EditorOverflowDetail,
} from "@utils/editorAutoExpand";
import { terminalRegistry } from "./terminalRegistry";
import { MESSAGE_TYPES } from "@/types/messages";
// uiStore uses vscode.getState()/setState() as its persist storage (see
// uiStore.ts) and is rehydrated from main.tsx before App mounts.
import {
  PANEL_COLLAPSED_SIZE_DEFAULT,
  PANEL_COLLAPSED_SIZE_SIDEBAR,
  PANEL_MIN_SIZE_CENTER,
  PANEL_MIN_SIZE_EDITOR,
  PANEL_MIN_SIZE_CENTER_COLUMN,
  PANEL_MIN_SIZE_SIDEBAR,
  PANEL_MAX_SIZE_SIDEBAR,
  SEPARATOR_HORIZONTAL,
  SEPARATOR_VERTICAL,
} from "./constants";
import {
  Header,
  HarnessPreflightPanel,
  WorkflowStepsPanel,
  OutputSection,
  EditorSection,
  WorkflowPropertiesPanel,
  CenterContentArea,
  PromptChipRail,
  GlobalSettingsDrawer,
  StartupOverlay,
  WorkflowSwitchOverlay,
} from "./components/layout";
import { WorkspaceViewerModal } from "./components/workspace-viewer/WorkspaceViewerModal";
import { ContentPreviewModal } from "./components/shared/ContentPreviewModal";
import { UxSnapshotButton } from "./components/dev/UxSnapshotButton";
import { useNavigationSync } from "./navigation/useNavigationSync";
import { getReadyPreferredViewAddress } from "./navigation/readyRoute";
import { HistorySearchDrawer } from "@components/search";
import { ToastViewport } from "@components/shared/ToastViewport";
import { BatchApprovalModal } from "@components/shared/BatchApprovalModal";
import { ChoiceModal } from "@components/shared/ChoiceModal";

function App() {
  const vscode = useVsCodeApi();
  const isMobile = useIsMobile();
  const iosVisualViewportRootStyle = useIosVisualViewportRootStyle(isMobile);
  // Record workflow / workspace-viewer navigations for the back/forward controls.
  useNavigationSync();
  // main.tsx rehydrates uiStore before App is imported, so the persisted
  // collapse state is available on the first render.
  const [uiLayoutReady] = useState(true);

  // Collapse state from store (source of truth)
  const settingsCollapsed = useUiStore((s) => s.settingsCollapsed);
  const setSettingsCollapsed = useUiStore((s) => s.setSettingsCollapsed);
  const promptsCollapsed = useUiStore((s) => s.stepsCollapsed);
  const setPromptsCollapsed = useUiStore((s) => s.setPromptsCollapsed);
  const outputCollapsed = useUiStore((s) => s.outputCollapsed);
  const setOutputCollapsed = useUiStore((s) => s.setOutputCollapsed);
  const editorCollapsed = useUiStore((s) => s.editorCollapsed);
  const setEditorCollapsed = useUiStore((s) => s.setEditorCollapsed);

  // Mobile drawer state
  const mobileStepsOpen = useUiStore((s) => s.mobileStepsOpen);
  const mobileStepsMode = useUiStore((s) => s.mobileStepsMode);
  const mobileWorkflowPropsOpen = useUiStore((s) => s.mobileWorkflowPropsOpen);
  const toggleMobileSteps = useUiStore((s) => s.toggleMobileSteps);
  const setMobileStepsMode = useUiStore((s) => s.setMobileStepsMode);
  const toggleMobileWorkflowProps = useUiStore(
    (s) => s.toggleMobileWorkflowProps
  );
  const closeMobileSteps = useUiStore((s) => s.closeMobileSteps);
  const closeMobileWorkflowProps = useUiStore(
    (s) => s.closeMobileWorkflowProps
  );

  const desktop = useDesktopLayout({
    isMobile,
    uiLayoutReady,
    settingsCollapsed,
    promptsCollapsed,
    outputCollapsed,
    editorCollapsed,
  });

  const mobile = useMobileLayout({
    isMobile,
    uiLayoutReady,
    outputCollapsed,
    editorCollapsed,
  });

  // ── Editor expansion refs ──────────────────────────────────────────────────────────
  // How many pixels above the user's base size the editor is currently
  // expanded (0 = at base, never persisted).
  const editorAutoExpandPxRef = useRef(0);
  // Signed overflow as of the last doc-change event. Used to detect the
  // 0→>0 transition that enters auto-expand mode.  Updated on doc events and
  // on geometry events that create overflow (e.g. user drags panel smaller).
  const prevDocSignedOverflowRef = useRef(0);
  // Set while the properties drawer is holding the editor open: `floorPx` is
  // the height it expanded to — a floor typing auto-expand must not shrink
  // below, or deleting text would collapse the drawer back out of view — and
  // `restorePx` is the measured height to hand back when the drawer closes.
  const drawerExpansionRef = useRef<{
    floorPx: number;
    restorePx: number;
  } | null>(null);
  // Timestamp the drawer's animated resize stops lying about its height.
  // Panels report their size from `offsetHeight` through a ResizeObserver, so
  // every frame of the transition reaches `onResize` — and persisting any of
  // those intermediate heights as the user's base size is how an animated
  // expansion would eat the height it was supposed to hand back.
  const expansionSettledAtRef = useRef(0);

  /** A resizable center split plus the sizes expansion decisions need. */
  type EditorExpansionContext = CenterSplitHandles & {
    /** The user's own (persisted) editor height — what expansion grows from. */
    basePx: number;
    editorPx: number;
    totalPx: number;
  };

  // Live geometry of whichever center split is mounted. Re-assigned each
  // render so the overflow listener and the drawer effect always see the
  // current layout without re-registering; returns null whenever the split
  // cannot be resized (a panel collapsed, refs not mounted, mid-remount).
  const editorExpansionContextRef = useRef<() => EditorExpansionContext | null>(
    () => null
  );
  editorExpansionContextRef.current = () => {
    if (outputCollapsed || editorCollapsed) return null;
    const handles: CenterSplitHandles = isMobile
      ? {
          groupRef: mobile.mobileCenterGroupRef,
          outputRef: mobile.mobileOutputRef,
          editorRef: mobile.mobileEditorRef,
          panelIds: CENTER_PANEL_IDS.mobile,
        }
      : {
          groupRef: desktop.verticalGroupRef,
          outputRef: desktop.outputRef,
          editorRef: desktop.editorRef,
          panelIds: CENTER_PANEL_IDS.desktop,
        };
    const measurement = measureCenterSplit(handles);
    if (!measurement) return null;
    return {
      ...handles,
      basePx: isMobile
        ? mobile.lastMobileSizes.current.editor
        : desktop.lastDesktopSizes.current.editor,
      ...measurement,
    };
  };

  // Stable handler ref — re-assigned each render so it always closes over the
  // latest isMobile / collapsed state without re-registering the listener.
  const overflowHandlerRef = useRef<(e: Event) => void>(() => {});
  overflowHandlerRef.current = (e: Event) => {
    const { signedOverflow, cause } = (e as CustomEvent<EditorOverflowDetail>)
      .detail;

    const autoExpand =
      useSettingsStore.getState().globalSettings.autoExpandEditorWhenTyping;
    if (autoExpand === false) return;

    if (cause === EDITOR_OVERFLOW_CAUSES.GEOMETRY) {
      if (signedOverflow > 0) {
        prevDocSignedOverflowRef.current = signedOverflow;
      }
      return;
    }

    // ── doc event ────────────────────────────────────────────────────────────
    const previousExpandPx = editorAutoExpandPxRef.current;
    const prevDoc = prevDocSignedOverflowRef.current;
    prevDocSignedOverflowRef.current = signedOverflow;

    const shouldEnter =
      previousExpandPx === 0 && prevDoc <= 0 && signedOverflow > 0;
    if (!shouldEnter && previousExpandPx === 0) return;

    const context = editorExpansionContextRef.current();
    if (!context) return;
    const { basePx, editorPx, totalPx } = context;

    // Anchor growth on the ACTUAL measured editor size, not
    // `basePx + previousExpandPx`. The accumulator drifts from reality
    // (percentage rounding via toFixed(3), minSize clamping,
    // preserve-pixel-size after window/group resizes), so an absolute
    // `basePx + A` snaps the panel to a slightly wrong size — leaving the
    // first/last line clipped behind the editor header/footer. Growing from
    // the measured size by exactly the overflow, then clamping, self-heals.
    const targetPx = clampEditorHeightPx(
      editorPx + signedOverflow,
      drawerExpansionRef.current?.floorPx ?? basePx,
      editorAutoExpandCeilingPx(totalPx, basePx)
    );
    if (Math.abs(targetPx - editorPx) < 1) return;

    // Set BEFORE applying so onResize sees the new value immediately,
    // regardless of whether setLayout fires onResize synchronously or async.
    editorAutoExpandPxRef.current = targetPx - basePx;
    if (!applyEditorHeightPx(context, targetPx, totalPx)) {
      editorAutoExpandPxRef.current = previousExpandPx; // revert on error
    }
  };

  // Register the stable event listener once
  useEffect(() => {
    const listener = (e: Event) => overflowHandlerRef.current(e);
    window.addEventListener(EDITOR_OVERFLOW_EVENT, listener);
    return () => window.removeEventListener(EDITOR_OVERFLOW_EVENT, listener);
  }, []);

  // ── Properties-drawer expansion ──────────────────────────────────────────────
  // The drawer covers the editor panel, so on a short panel it shows only a
  // sliver of the properties. Opening it grows the editor to
  // `DRAWER_EXPANSION_FRACTION` of the split over the drawer's own slide, so
  // the drawer reads as pushing the panel open; closing it hands the previous
  // height back. It never shrinks the panel — an editor already taller than
  // that is left exactly as it is.
  const propertiesDrawerOpen = useUiStore((s) => s.propertiesDrawerOpen);
  useEffect(() => {
    const context = editorExpansionContextRef.current();
    // A re-toggle inside the animation window measures a height that is
    // neither where the panel started nor where it is headed. The accumulator
    // is the trustworthy reading there, because it was set to the destination.
    const isMidAnimation = Date.now() < expansionSettledAtRef.current;

    // The panel is still mid-transition when `applyEditorHeightPx`'s own
    // remeasure fires, so ask CodeMirror for one more once it has landed.
    const scheduleSettledRemeasure = () => {
      const timer = window.setTimeout(
        () => window.dispatchEvent(new CustomEvent(EDITOR_REMEASURE_EVENT)),
        DRAWER_EXPANSION_ANIMATION_MS
      );
      return () => window.clearTimeout(timer);
    };

    if (propertiesDrawerOpen) {
      // Already holding the panel open — a re-render, not a fresh open.
      if (drawerExpansionRef.current) return;
      if (!context) return;
      const { basePx, editorPx, totalPx } = context;
      const currentPx = isMidAnimation
        ? basePx + editorAutoExpandPxRef.current
        : editorPx;
      const targetPx = Math.max(
        currentPx,
        drawerExpansionTargetPx(totalPx, basePx)
      );
      drawerExpansionRef.current = { floorPx: targetPx, restorePx: currentPx };
      if (!isMidAnimation && targetPx - editorPx < 1) return;

      const previousExpandPx = editorAutoExpandPxRef.current;
      editorAutoExpandPxRef.current = targetPx - basePx;
      expansionSettledAtRef.current = Date.now() + DRAWER_EXPANSION_SETTLE_MS;
      if (!animateEditorHeightPx(context, targetPx, totalPx)) {
        editorAutoExpandPxRef.current = previousExpandPx;
        drawerExpansionRef.current = null;
        expansionSettledAtRef.current = 0;
        return;
      }
      return scheduleSettledRemeasure();
    }

    const expansion = drawerExpansionRef.current;
    drawerExpansionRef.current = null;
    if (!expansion || !context) return;
    const { basePx, editorPx, totalPx } = context;
    const targetPx = clampEditorHeightPx(
      expansion.restorePx,
      basePx,
      editorAutoExpandCeilingPx(totalPx, basePx)
    );
    // Keep the accumulator exactly `targetPx - basePx` so the panel's own
    // onResize reads this as an expansion resize and leaves the user's
    // persisted base size alone.
    editorAutoExpandPxRef.current = targetPx - basePx;
    if (!isMidAnimation && Math.abs(targetPx - editorPx) < 1) return;
    expansionSettledAtRef.current = Date.now() + DRAWER_EXPANSION_SETTLE_MS;
    animateEditorHeightPx(context, targetPx, totalPx);
    return scheduleSettledRemeasure();
  }, [propertiesDrawerOpen]);

  // Mobile overlay closing animation state.
  // When true, the overlay stays mounted but plays a slide-out animation.
  // The real store action fires after onAnimationEnd.
  const [promptsOverlayClosing, setPromptsOverlayClosing] = useState(false);
  const [settingsOverlayClosing, setSettingsOverlayClosing] = useState(false);
  const promptsAfterClose = useRef<(() => void) | null>(null);
  const settingsAfterClose = useRef<(() => void) | null>(null);

  // Sidebar chip rail closing animation state — same pattern as the fullwidth overlay.
  // sidebarAfterClose fires after the collapse animation completes (width 32→0).
  const sidebarShouldShow =
    mobileStepsOpen && mobileStepsMode === MOBILE_STEPS_MODES.SIDEBAR;
  const [sidebarChipClosing, setSidebarChipClosing] = useState(false);
  const sidebarAfterClose = useRef<(() => void) | null>(null);

  const handlePromptsRequestSidebar = () => {
    promptsAfterClose.current = () =>
      setMobileStepsMode(MOBILE_STEPS_MODES.SIDEBAR);
    setPromptsOverlayClosing(true);
  };
  const handlePromptsRequestClose = () => {
    promptsAfterClose.current = () => closeMobileSteps();
    setPromptsOverlayClosing(true);
  };
  const handleSettingsRequestClose = () => {
    settingsAfterClose.current = () => closeMobileWorkflowProps();
    setSettingsOverlayClosing(true);
  };

  const handleSidebarExpand = () => {
    sidebarAfterClose.current = () =>
      setMobileStepsMode(MOBILE_STEPS_MODES.FULLWIDTH);
    setSidebarChipClosing(true);
  };

  // Header toggle handlers — route through close animation when panels are already open.
  // Calling toggleMobileSteps/toggleMobileWorkflowProps directly skips the animation path.
  const handleToggleMobileSteps = () => {
    if (mobileStepsOpen && mobileStepsMode === MOBILE_STEPS_MODES.FULLWIDTH) {
      promptsAfterClose.current = () => closeMobileSteps();
      setPromptsOverlayClosing(true);
    } else if (
      mobileStepsOpen &&
      mobileStepsMode === MOBILE_STEPS_MODES.SIDEBAR
    ) {
      sidebarAfterClose.current = () => closeMobileSteps();
      setSidebarChipClosing(true);
    } else {
      toggleMobileSteps();
    }
  };

  const handleToggleMobileWorkflowProps = () => {
    if (mobileWorkflowPropsOpen) {
      settingsAfterClose.current = () => closeMobileWorkflowProps();
      setSettingsOverlayClosing(true);
    } else {
      toggleMobileWorkflowProps();
    }
  };

  // Track isMobile to detect layout transitions in render body below
  const wasMobileRef = useRef(isMobile);
  // Message handlers with full implementations
  useMessageHandler();
  useUndoRedoKeyHandler();
  useNewWorkflowKeyHandler();
  useHistorySearchKeyHandler();
  // Bounds how long a run-view request may stay outstanding — a lost one
  // suppresses every server-initiated view update until it is retired.
  useRunViewLoadWatchdog();
  useDuplicateWorkflowWatchdog();

  // Signal ready to extension
  useEffect(() => {
    vscode.postMessage({
      type: MESSAGE_TYPES.READY,
      preferredViewAddress: getReadyPreferredViewAddress(),
      pageLoadId: panelPageLoadId,
    });
    // In standalone (browser) mode the server is the authoritative source of theme
    // vars. Sending THEME_VARS_CAPTURED from the browser strips --cy-color-theme-kind
    // (only --vscode-* props are captured here), corrupting cachedThemeVars on the
    // server and breaking body-class-based icon inversion for subsequent connections.
    if (!isStandalone) {
      captureAndSendThemeVars(vscode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // vscode is a stable singleton — never changes

  // Close the settings drawer when switching to desktop — it has no desktop
  // equivalent and would reappear on re-entry to mobile otherwise.
  // mobileStepsOpen is NOT reset here so the persisted preference is preserved:
  // if steps were open on mobile, they'll still be open when returning to mobile.
  useEffect(() => {
    if (!isMobile) {
      closeMobileWorkflowProps();
    }
  }, [isMobile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync output font size CSS variable to the document root so all output
  // area consumers (markdown-text prose, tool call output, etc.) pick it up.
  const outputFontSize = useUiStore((s) => s.outputFontSize);
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--cy-output-font-size",
      `${outputFontSize}px`
    );
  }, [outputFontSize]);

  // Sync terminal font size to all live xterm instances.
  const terminalFontSize = useUiStore((s) => s.terminalFontSize);
  useEffect(() => {
    terminalRegistry.updateFontSize(terminalFontSize);
  }, [terminalFontSize]);

  // Clear the PWA home screen badge when the user returns to the app.
  useEffect(() => {
    if (!isStandalone) return;
    const clearBadge = () => {
      if (document.visibilityState === DOCUMENT_VISIBILITY_STATES.VISIBLE) {
        void clearNotificationBadgeCount();
      }
    };
    document.addEventListener("visibilitychange", clearBadge);
    clearBadge(); // clear any stale badge from a prior session
    return () => document.removeEventListener("visibilitychange", clearBadge);
  }, []);

  // ============================================================================
  // LAYOUT TRANSITION LOGIC (runs synchronously during render)
  //
  // Updates mount defaults and gate flags before JSX references them.
  // Must run during render (not in effects) because defaultSize props must
  // be set before the Group mounts/remounts.
  // ============================================================================

  {
    const isTransitioningToMobile = !wasMobileRef.current && isMobile;
    const isTransitioningToDesktop = wasMobileRef.current && !isMobile;

    if (isTransitioningToMobile) {
      // Recalculate mobile mount defaults based on current collapsed state
      // so center panels mount at the correct size before collapse() is called.
      const { output, editor } = centerPanelMountDefaults(
        outputCollapsed,
        editorCollapsed,
        mobile.lastMobileSizes.current.editor
      );
      mobile.mobileMountDefaults.current.output = output;
      mobile.mobileMountDefaults.current.editor = editor;

      // Close gates so mount-time onResize events are ignored
      desktop.horizontalInitializedRef.current = false;
      mobile.mobileInitializedRef.current = false;
    }

    if (isTransitioningToDesktop) {
      // Horizontal group panels — mount collapsed panels at their collapsed
      // pixel size so collapse() in useLayoutEffect only sets the flag
      // without needing to resize from a large percentage.
      desktop.desktopMountDefaults.current.steps = promptsCollapsed
        ? PANEL_COLLAPSED_SIZE_SIDEBAR
        : `${desktop.lastDesktopSizes.current.steps}px`;
      desktop.desktopMountDefaults.current.settings = settingsCollapsed
        ? PANEL_COLLAPSED_SIZE_SIDEBAR
        : `${desktop.lastDesktopSizes.current.settings}px`;

      // Center vertical group panels
      {
        const { output, editor } = centerPanelMountDefaults(
          outputCollapsed,
          editorCollapsed,
          desktop.lastDesktopSizes.current.editor
        );
        desktop.mountDefaultOutput.current = output;
        desktop.mountDefaultEditor.current = editor;
      }

      // Trigger forced resize for center group (if both open)
      if (!outputCollapsed || !editorCollapsed) {
        desktop.needsForcedResize.current = true;
      }
      // Close gates so mount-time onResize events are ignored
      desktop.initializedRef.current = false;
      desktop.horizontalInitializedRef.current = false;
    }

    wasMobileRef.current = isMobile;
  }

  // Update desktop vertical Group mount defaults only when the Group is about
  // to remount (both-collapsed → one-open). While the Group stays alive,
  // defaultSize must remain constant so the library does not re-initialise and
  // clobber imperative collapse()/expand() calls.
  {
    const bothCollapsed = outputCollapsed && editorCollapsed;
    if (desktop.wasBothCollapsed.current && !bothCollapsed) {
      const { output, editor } = centerPanelMountDefaults(
        outputCollapsed,
        editorCollapsed,
        desktop.lastDesktopSizes.current.editor
      );
      desktop.mountDefaultOutput.current = output;
      desktop.mountDefaultEditor.current = editor;
      // Group is remounting — next both-open transition needs forced resize
      desktop.needsForcedResize.current = true;
    }
    desktop.wasBothCollapsed.current = bothCollapsed;
  }

  // ============================================================================
  // MOBILE LAYOUT — center panels (output + editor) + drawer overlays
  // ============================================================================

  const allMobileCenterCollapsed = outputCollapsed && editorCollapsed;

  // Update mobile mount defaults when transitioning from all-collapsed → some-open.
  // Editor mounts at its last pixel size; output fills remaining space.
  {
    if (mobile.mobileWasAllCollapsed.current && !allMobileCenterCollapsed) {
      const { output, editor } = centerPanelMountDefaults(
        outputCollapsed,
        editorCollapsed,
        mobile.lastMobileSizes.current.editor
      );
      mobile.mobileMountDefaults.current.output = output;
      mobile.mobileMountDefaults.current.editor = editor;
    }
    mobile.mobileWasAllCollapsed.current = allMobileCenterCollapsed;
  }

  if (isMobile) {
    return (
      <div
        className="h-dvh w-full flex flex-col bg-editor-bg text-foreground border-l border-r relative"
        style={iosVisualViewportRootStyle}
      >
        <Header
          onToggleMobileSteps={handleToggleMobileSteps}
          onToggleMobileWorkflowProps={handleToggleMobileWorkflowProps}
        />
        <HarnessPreflightPanel />

        {/* Main area — relative container for absolute overlays */}
        <main className="flex-1 relative overflow-hidden flex flex-col">
          {allMobileCenterCollapsed ? (
            /* Both collapsed: plain flex stack of the two collapsed bars */
            <div className="flex flex-col flex-1 relative bg-editor-bg">
              {(() => {
                const logoUrl =
                  document.body.getAttribute("data-logo-uri") || "";
                return (
                  <div
                    className="background-logo"
                    style={{
                      WebkitMaskImage: logoUrl ? `url('${logoUrl}')` : "none",
                      maskImage: logoUrl ? `url('${logoUrl}')` : "none",
                    }}
                    aria-hidden="true"
                  />
                );
              })()}
              <div className="relative flex flex-col flex-1">
                <div className="flex-none">
                  <OutputSection />
                </div>
                <div className="flex-none">
                  <EditorSection />
                </div>
              </div>
            </div>
          ) : (
            /* At least one center panel open: vertical resizable Group */
            <Group
              groupRef={mobile.mobileCenterGroupRef}
              orientation="vertical"
              className="flex-1"
              id="ctrlyoke-mobile-layout"
            >
              <Panel
                panelRef={mobile.mobileOutputRef}
                defaultSize={mobile.mobileMountDefaults.current.output}
                collapsible
                collapsedSize={PANEL_COLLAPSED_SIZE_DEFAULT}
                minSize={PANEL_MIN_SIZE_CENTER}
                id={CENTER_PANEL_IDS.mobile.output}
                onResize={() => {
                  if (!mobile.mobileInitializedRef.current || !uiLayoutReady) {
                    return;
                  }
                  const isCollapsed =
                    mobile.mobileOutputRef.current?.isCollapsed() ?? false;
                  const isEditorCollapsed =
                    mobile.mobileEditorRef.current?.isCollapsed() ??
                    editorCollapsed;
                  if (!isCollapsed && !isEditorCollapsed) {
                    const sizePct =
                      mobile.mobileOutputRef.current?.getSize().asPercentage;
                    if (sizePct != null) {
                      mobile.lastMobileSizes.current.output = sizePct;
                      useUiStore
                        .getState()
                        .setLastMobileSizes({ output: sizePct });
                    }
                  }
                  if (isCollapsed !== outputCollapsed) {
                    setOutputCollapsed(isCollapsed);
                  }
                }}
              >
                {/* Flex row so the sidebar PUSHES the output right rather than
                    overlaying it. Fullwidth overlay is absolute inside the
                    output area — scoped to the output panel, never the editor. */}
                <div className="flex h-full overflow-hidden">
                  {/* Sidebar chip rail — width-animated flex sibling so the output
                      panel is pushed/pulled by the layout, not a transform. */}
                  {(sidebarShouldShow || sidebarChipClosing) && (
                    <div
                      className={`flex-shrink-0 h-full border-r border-panel-border bg-sidebar-bg overflow-hidden ${sidebarChipClosing ? "animate-slide-out-sidebar" : "animate-slide-in-sidebar"}`}
                      onAnimationEnd={
                        sidebarChipClosing
                          ? (event) => {
                              if (event.currentTarget !== event.target) {
                                return;
                              }
                              setSidebarChipClosing(false);
                              sidebarAfterClose.current?.();
                              sidebarAfterClose.current = null;
                            }
                          : undefined
                      }
                    >
                      <div className="w-[32px] h-full">
                        <PromptChipRail onExpand={handleSidebarExpand} />
                      </div>
                    </div>
                  )}

                  {/* Output area: takes remaining space; fullwidth overlay is
                      absolute here so it cannot bleed into the editor panel */}
                  <div className="relative flex-1 min-w-0 h-full">
                    <OutputSection />

                    {/* Fullwidth steps — covers the output area only */}
                    {((mobileStepsOpen &&
                      mobileStepsMode === MOBILE_STEPS_MODES.FULLWIDTH) ||
                      promptsOverlayClosing) && (
                      <div
                        className={`absolute inset-0 z-header bg-editor-bg flex flex-col ${promptsOverlayClosing ? "animate-slide-out-left" : "animate-slide-in-left"}`}
                        onAnimationEnd={
                          promptsOverlayClosing
                            ? (event) => {
                                if (event.currentTarget !== event.target) {
                                  return;
                                }
                                setPromptsOverlayClosing(false);
                                promptsAfterClose.current?.();
                                promptsAfterClose.current = null;
                              }
                            : undefined
                        }
                      >
                        <nav className="h-full" aria-label="Workflow steps">
                          <WorkflowStepsPanel
                            onRequestSidebar={handlePromptsRequestSidebar}
                            onRequestClose={handlePromptsRequestClose}
                          />
                        </nav>
                      </div>
                    )}
                  </div>
                </div>
              </Panel>

              <Separator className={SEPARATOR_HORIZONTAL} />

              <Panel
                panelRef={mobile.mobileEditorRef}
                defaultSize={mobile.mobileMountDefaults.current.editor}
                groupResizeBehavior="preserve-pixel-size"
                collapsible
                collapsedSize={PANEL_COLLAPSED_SIZE_DEFAULT}
                minSize={PANEL_MIN_SIZE_EDITOR}
                id={CENTER_PANEL_IDS.mobile.editor}
                onResize={() => {
                  if (!mobile.mobileInitializedRef.current || !uiLayoutReady) {
                    return;
                  }
                  const isCollapsed =
                    mobile.mobileEditorRef.current?.isCollapsed() ?? false;
                  const isOutputCollapsed =
                    mobile.mobileOutputRef.current?.isCollapsed() ??
                    outputCollapsed;
                  if (!isCollapsed && !isOutputCollapsed) {
                    const sizePx =
                      mobile.mobileEditorRef.current?.getSize().inPixels;
                    if (sizePx != null) {
                      const px = Math.round(sizePx);
                      const basePx = mobile.lastMobileSizes.current.editor;
                      const autoExpectedPx =
                        basePx + editorAutoExpandPxRef.current;
                      const isExpansionResize =
                        Date.now() < expansionSettledAtRef.current ||
                        (editorAutoExpandPxRef.current > 0 &&
                          Math.abs(px - autoExpectedPx) < 3);
                      if (!isExpansionResize) {
                        mobile.lastMobileSizes.current.editor = px;
                        useUiStore
                          .getState()
                          .setLastMobileSizes({ editor: px });
                        editorAutoExpandPxRef.current = 0;
                        // The user chose this height: stop holding the panel
                        // open for the drawer and stop restoring on close.
                        drawerExpansionRef.current = null;
                      }
                    }
                  }
                  if (isCollapsed !== editorCollapsed) {
                    setEditorCollapsed(isCollapsed);
                  }
                }}
              >
                <EditorSection />
              </Panel>
            </Group>
          )}

          {/* Settings overlay drawer */}
          {(mobileWorkflowPropsOpen || settingsOverlayClosing) && (
            <>
              {/* Backdrop — tap outside closes (hidden while closing) */}
              {!settingsOverlayClosing && (
                <button
                  type="button"
                  className="absolute inset-0 z-overlay appearance-none border-0 bg-transparent p-0"
                  aria-label="Close settings"
                  onClick={handleSettingsRequestClose}
                />
              )}
              <div
                className={`absolute inset-0 z-drawer bg-editor-bg flex flex-col ${settingsOverlayClosing ? "animate-slide-out-right" : "animate-slide-in-right"}`}
                onAnimationEnd={
                  settingsOverlayClosing
                    ? (event) => {
                        if (event.currentTarget !== event.target) {
                          return;
                        }
                        setSettingsOverlayClosing(false);
                        settingsAfterClose.current?.();
                        settingsAfterClose.current = null;
                      }
                    : undefined
                }
              >
                <WorkflowPropertiesPanel
                  onRequestClose={handleSettingsRequestClose}
                />
              </div>
            </>
          )}

          {/* Global drawers - scoped below the header inside the main content area */}
          <GlobalSettingsDrawer />
          <HistorySearchDrawer />

          {/* Workflow switch overlay — covers panels (not the header) while an
              addressed cross-lineage switch is loading its snapshot */}
          <WorkflowSwitchOverlay />
        </main>

        {/* Startup overlay — covers full layout (header + content) until STARTUP_COMPLETE arrives */}
        <StartupOverlay />

        {/* Workspace viewer — fixed fullscreen overlay, standalone mode only */}
        <WorkspaceViewerModal />

        {/* Content preview modal — git diff / prior-context XML */}
        <ContentPreviewModal />

        {/* Dev-only floating UX snapshot capture button */}
        <UxSnapshotButton />

        <ToastViewport />

        <BatchApprovalModal />
        <ChoiceModal />

        {/* iOS safe area spacer — lifts all content above the home indicator.
            height = env(safe-area-inset-bottom), 0px on non-iOS / desktop.
            Placing it here (flex sibling of the main content area) means every
            element inside — panels, overlays, footers — automatically clears the
            home indicator without per-component padding. */}
        <div className="safe-area-spacer" aria-hidden="true" />
      </div>
    );
  }

  // ============================================================================
  // DESKTOP LAYOUT — horizontal three-column layout
  // ============================================================================

  return (
    <div className="h-dvh w-full flex flex-col bg-editor-bg text-foreground relative">
      <Header />
      <HarnessPreflightPanel />

      {/* Main layout: relative container enables GlobalSettingsDrawer overlay */}
      <main className="flex-1 relative overflow-hidden flex flex-col min-h-0">
        {/* Prompts (left) | Output/Editor (center) | Settings (right) */}
        <Group
          groupRef={desktop.horizontalGroupRef}
          orientation="horizontal"
          className="flex-1"
          id="ctrlyoke-main-layout"
        >
          {/* Prompts Panel (Left - collapsible) */}
          <Panel
            panelRef={desktop.stepsRef}
            defaultSize={desktop.desktopMountDefaults.current.steps}
            groupResizeBehavior="preserve-pixel-size"
            collapsible
            collapsedSize={PANEL_COLLAPSED_SIZE_SIDEBAR}
            minSize={PANEL_MIN_SIZE_SIDEBAR}
            maxSize={PANEL_MAX_SIZE_SIDEBAR}
            id="prompts-panel"
            onResize={() => {
              if (!desktop.horizontalInitializedRef.current || !uiLayoutReady)
                return;
              const isCollapsed =
                desktop.stepsRef.current?.isCollapsed() ?? false;
              if (!isCollapsed) {
                const sizePx = desktop.stepsRef.current?.getSize().inPixels;
                if (sizePx != null) {
                  const px = Math.round(sizePx);
                  if (desktop.lastDesktopSizes.current.steps !== px) {
                    desktop.lastDesktopSizes.current.steps = px;
                    useUiStore.getState().setLastDesktopSizes({ steps: px });
                  }
                }
              }
              if (isCollapsed !== promptsCollapsed) {
                setPromptsCollapsed(isCollapsed);
              }
            }}
          >
            <nav className="h-full" aria-label="Workflow steps">
              <WorkflowStepsPanel />
            </nav>
          </Panel>

          <Separator className={SEPARATOR_VERTICAL} />

          {/* Center content — Output (top) / Editor (bottom), both independently
            collapsible.  When both are collapsed the vertical Group unmounts and
            we render a plain flex stack of the two collapsed bars — the library
            can't keep two panels at collapsedSize (5 % each) without a third
            panel or maxSize tricks, both of which break imperative expand().
            When at least one panel is open the Group is active and the user can
            drag the separator freely. */}
          <Panel id="center-content" minSize={PANEL_MIN_SIZE_CENTER_COLUMN}>
            {outputCollapsed && editorCollapsed ? (
              <CenterContentArea />
            ) : (
              <Group
                groupRef={desktop.verticalGroupRef}
                orientation="vertical"
                className="h-full"
                id="ctrlyoke-vertical-layout"
              >
                <Panel
                  panelRef={desktop.outputRef}
                  defaultSize={desktop.mountDefaultOutput.current}
                  collapsible
                  collapsedSize={PANEL_COLLAPSED_SIZE_DEFAULT}
                  minSize={PANEL_MIN_SIZE_CENTER}
                  id={CENTER_PANEL_IDS.desktop.output}
                  onResize={() => {
                    const isRemountUnstable =
                      desktop.needsForcedResize.current ||
                      desktop.isForcingResize.current;
                    const isOutputCollapsed =
                      desktop.outputRef.current?.isCollapsed() ?? false;
                    if (!desktop.initializedRef.current || !uiLayoutReady)
                      return;
                    const isEditorCollapsed =
                      desktop.editorRef.current?.isCollapsed() ??
                      editorCollapsed;
                    if (
                      !isRemountUnstable &&
                      !isOutputCollapsed &&
                      !isEditorCollapsed
                    ) {
                      const sizePct =
                        desktop.outputRef.current?.getSize().asPercentage;
                      if (
                        sizePct != null &&
                        Math.abs(
                          desktop.lastDesktopSizes.current.output - sizePct
                        ) >= 0.001
                      ) {
                        desktop.lastDesktopSizes.current.output = sizePct;
                        useUiStore
                          .getState()
                          .setLastDesktopSizes({ output: sizePct });
                      }
                    }
                    if (
                      !isRemountUnstable &&
                      isOutputCollapsed !== outputCollapsed
                    ) {
                      setOutputCollapsed(isOutputCollapsed);
                    }
                  }}
                >
                  <OutputSection />
                </Panel>

                <Separator className={SEPARATOR_HORIZONTAL} />

                <Panel
                  panelRef={desktop.editorRef}
                  defaultSize={desktop.mountDefaultEditor.current}
                  groupResizeBehavior="preserve-pixel-size"
                  collapsible
                  collapsedSize={PANEL_COLLAPSED_SIZE_DEFAULT}
                  minSize={PANEL_MIN_SIZE_EDITOR}
                  id={CENTER_PANEL_IDS.desktop.editor}
                  onResize={() => {
                    const isRemountUnstable =
                      desktop.needsForcedResize.current ||
                      desktop.isForcingResize.current;
                    const isEditorCollapsed =
                      desktop.editorRef.current?.isCollapsed() ?? false;
                    if (!desktop.initializedRef.current || !uiLayoutReady)
                      return;
                    const isOutputCollapsed =
                      desktop.outputRef.current?.isCollapsed() ??
                      outputCollapsed;
                    if (
                      !isRemountUnstable &&
                      !isEditorCollapsed &&
                      !isOutputCollapsed
                    ) {
                      const sizePx =
                        desktop.editorRef.current?.getSize().inPixels;
                      if (sizePx != null) {
                        const px = Math.round(sizePx);
                        const basePx = desktop.lastDesktopSizes.current.editor;
                        const autoExpectedPx =
                          basePx + editorAutoExpandPxRef.current;
                        const isExpansionResize =
                          Date.now() < expansionSettledAtRef.current ||
                          (editorAutoExpandPxRef.current > 0 &&
                            Math.abs(px - autoExpectedPx) < 3);
                        if (
                          !isExpansionResize &&
                          desktop.lastDesktopSizes.current.editor !== px
                        ) {
                          desktop.lastDesktopSizes.current.editor = px;
                          useUiStore
                            .getState()
                            .setLastDesktopSizes({ editor: px });
                          editorAutoExpandPxRef.current = 0;
                          // The user chose this height: stop holding the panel
                          // open for the drawer and stop restoring on close.
                          drawerExpansionRef.current = null;
                        }
                      }
                    }
                    if (
                      !isRemountUnstable &&
                      isEditorCollapsed !== editorCollapsed
                    ) {
                      setEditorCollapsed(isEditorCollapsed);
                    }
                  }}
                >
                  <EditorSection />
                </Panel>
              </Group>
            )}
          </Panel>

          <Separator className={SEPARATOR_VERTICAL} />

          {/* Settings Panel (Right - collapsible) */}
          <Panel
            panelRef={desktop.settingsRef}
            defaultSize={desktop.desktopMountDefaults.current.settings}
            groupResizeBehavior="preserve-pixel-size"
            collapsible
            collapsedSize={PANEL_COLLAPSED_SIZE_SIDEBAR}
            minSize={PANEL_MIN_SIZE_SIDEBAR}
            maxSize={PANEL_MAX_SIZE_SIDEBAR}
            id="settings-panel"
            onResize={() => {
              if (!desktop.horizontalInitializedRef.current || !uiLayoutReady)
                return;
              const isCollapsed =
                desktop.settingsRef.current?.isCollapsed() ?? false;
              if (!isCollapsed) {
                const sizePx = desktop.settingsRef.current?.getSize().inPixels;
                if (sizePx != null) {
                  const px = Math.round(sizePx);
                  if (desktop.lastDesktopSizes.current.settings !== px) {
                    desktop.lastDesktopSizes.current.settings = px;
                    useUiStore.getState().setLastDesktopSizes({
                      settings: px,
                    });
                  }
                }
              }
              if (isCollapsed !== settingsCollapsed) {
                setSettingsCollapsed(isCollapsed);
              }
            }}
          >
            <WorkflowPropertiesPanel />
          </Panel>
        </Group>

        {/* Global drawers - scoped below the header inside the main content area */}
        <GlobalSettingsDrawer />
        <HistorySearchDrawer />

        {/* Workflow switch overlay — covers panels (not the header) while an
            addressed cross-lineage switch is loading its snapshot */}
        <WorkflowSwitchOverlay />
      </main>

      {/* Startup overlay — covers full layout (header + content) until STARTUP_COMPLETE arrives */}
      <StartupOverlay />

      {/* Workspace viewer — fixed fullscreen overlay, standalone mode only */}
      <WorkspaceViewerModal />

      {/* Content preview modal — git diff / prior-context XML */}
      <ContentPreviewModal />

      {/* Dev-only floating UX snapshot capture button */}
      <UxSnapshotButton />

      <ToastViewport />

      <BatchApprovalModal />
      <ChoiceModal />

      {/* iOS safe area spacer — see mobile layout comment above */}
      <div className="safe-area-spacer" aria-hidden="true" />
    </div>
  );
}

export default App;
