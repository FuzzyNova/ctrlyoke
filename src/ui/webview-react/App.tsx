import { useEffect, useRef, useState } from "react";
import { Panel, Group, Separator } from "react-resizable-panels";
import {
  useMessageHandler,
  captureAndSendThemeVars,
} from "@hooks/useMessageHandler";
import { useUndoRedoKeyHandler } from "@hooks/useUndoRedoKeyHandler";
import { useVsCodeApi, isStandalone } from "@hooks/useVsCodeApi";
import { useIsMobile } from "@hooks/useMediaQuery";
import { useDesktopLayout } from "@hooks/useDesktopLayout";
import { useMobileLayout } from "@hooks/useMobileLayout";
import { useUiStore } from "@store/uiStore";
import { useSettingsStore } from "@store/settingsStore";
import { clearNotificationBadgeCount } from "@utils/browserNotifications";
import { centerPanelMountDefaults } from "@utils/panelSync";
import { WebviewLog } from "@utils/logger";
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
  WorkflowStepsPanel,
  OutputSection,
  EditorSection,
  WorkflowPropertiesPanel,
  CenterContentArea,
  PromptChipRail,
  GlobalSettingsDrawer,
  StartupOverlay,
} from "./components/layout";
import { WorkspaceViewerModal } from "./components/workspace-viewer/WorkspaceViewerModal";

function App() {
  const vscode = useVsCodeApi();
  const isMobile = useIsMobile();
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

  // ── Editor auto-expand refs ─────────────────────────────────────────────────
  // How many pixels above the user's base size the editor is currently
  // auto-expanded (0 = at base, never persisted).
  const editorAutoExpandPxRef = useRef(0);
  // Signed overflow as of the last doc-change event. Used to detect the
  // 0→>0 transition that enters auto-expand mode.  Updated on doc events and
  // on geometry events that create overflow (e.g. user drags panel smaller).
  const prevDocSignedOverflowRef = useRef(0);

  // Stable handler ref — re-assigned each render so it always closes over the
  // latest isMobile / collapsed state without re-registering the listener.
  const overflowHandlerRef = useRef<(e: Event) => void>(() => {});
  overflowHandlerRef.current = (e: Event) => {
    const { signedOverflow, cause } = (
      e as CustomEvent<{ signedOverflow: number; cause: "doc" | "geometry" }>
    ).detail;

    const autoExpand =
      useSettingsStore.getState().globalSettings.autoExpandEditorWhenTyping;
    WebviewLog.debug(
      `[FP-AE] handler received cause=${cause} signedOverflow=${signedOverflow} autoExpand=${autoExpand} isMobile=${isMobile}`
    );
    if (autoExpand === false) return;

    if (cause === "geometry") {
      if (signedOverflow > 0) {
        prevDocSignedOverflowRef.current = signedOverflow;
      }
      WebviewLog.debug(
        `[FP-AE] geometry event — skipping (prevDoc now=${prevDocSignedOverflowRef.current})`
      );
      return;
    }

    // ── doc event ────────────────────────────────────────────────────────────
    const A = editorAutoExpandPxRef.current;
    const prevDoc = prevDocSignedOverflowRef.current;
    prevDocSignedOverflowRef.current = signedOverflow;

    const shouldEnter = A === 0 && prevDoc <= 0 && signedOverflow > 0;
    WebviewLog.debug(
      `[FP-AE] doc event A=${A} prevDoc=${prevDoc} signedOverflow=${signedOverflow} shouldEnter=${shouldEnter} outputCollapsed=${outputCollapsed} editorCollapsed=${editorCollapsed}`
    );
    if (!shouldEnter && A === 0) {
      WebviewLog.debug(`[FP-AE] early exit — not in mode and no entry`);
      return;
    }

    if (isMobile) {
      // ── Mobile ─────────────────────────────────────────────────────────────
      if (outputCollapsed || editorCollapsed) return;
      const mobileOutputRef = mobile.mobileOutputRef;
      const mobileEditorRef = mobile.mobileEditorRef;
      const mobileCenterGroupRef = mobile.mobileCenterGroupRef;
      if (
        !mobileCenterGroupRef.current ||
        !mobileOutputRef.current ||
        !mobileEditorRef.current
      )
        return;

      const outputPx = mobileOutputRef.current.getSize().inPixels ?? 0;
      const editorPx = mobileEditorRef.current.getSize().inPixels ?? 0;
      const totalPx = outputPx + editorPx;
      if (totalPx <= 0) return;

      const basePx = mobile.lastMobileSizes.current.editor;
      const maxAutoExpand = Math.max(0, totalPx * 0.6 - basePx);
      const targetA = Math.max(0, Math.min(A + signedOverflow, maxAutoExpand));
      if (Math.abs(targetA - A) < 1) return;

      const targetEditorPx = basePx + targetA;
      const editorPct = Number(((targetEditorPx / totalPx) * 100).toFixed(3));
      const outputPct = Number((100 - editorPct).toFixed(3));

      // Set BEFORE setLayout so onResize sees the new value immediately,
      // regardless of whether setLayout fires onResize synchronously or async.
      editorAutoExpandPxRef.current = targetA;
      try {
        mobileCenterGroupRef.current.setLayout({
          "mobile-output-panel": outputPct,
          "mobile-editor-panel": editorPct,
        });
      } catch {
        // ignore setLayout errors during unstable states
      }
    } else {
      // ── Desktop ────────────────────────────────────────────────────────────
      if (outputCollapsed || editorCollapsed) {
        WebviewLog.debug(
          `[FP-AE] desktop skip — outputCollapsed=${outputCollapsed} editorCollapsed=${editorCollapsed}`
        );
        return;
      }
      if (
        !desktop.verticalGroupRef.current ||
        !desktop.outputRef.current ||
        !desktop.editorRef.current
      ) {
        WebviewLog.debug(`[FP-AE] desktop skip — refs not ready`);
        return;
      }

      const outputPx = desktop.outputRef.current.getSize().inPixels ?? 0;
      const editorPx = desktop.editorRef.current.getSize().inPixels ?? 0;
      const totalPx = outputPx + editorPx;
      if (totalPx <= 0) {
        WebviewLog.debug(`[FP-AE] desktop skip — totalPx=${totalPx}`);
        return;
      }

      const basePx = desktop.lastDesktopSizes.current.editor;
      const maxAutoExpand = Math.max(0, totalPx * 0.6 - basePx);
      const targetA = Math.max(0, Math.min(A + signedOverflow, maxAutoExpand));
      WebviewLog.debug(
        `[FP-AE] desktop calc basePx=${basePx} editorPx=${editorPx} totalPx=${totalPx} maxAutoExpand=${maxAutoExpand} targetA=${targetA} currentA=${A}`
      );

      if (Math.abs(targetA - A) < 1) {
        WebviewLog.debug(
          `[FP-AE] desktop skip — no meaningful change (targetA=${targetA} A=${A})`
        );
        return;
      }

      const targetEditorPx = basePx + targetA;
      const editorPct = Number(((targetEditorPx / totalPx) * 100).toFixed(3));
      const outputPct = Number((100 - editorPct).toFixed(3));

      WebviewLog.debug(
        `[FP-AE] desktop setLayout editorPct=${editorPct} outputPct=${outputPct} targetEditorPx=${targetEditorPx}`
      );
      editorAutoExpandPxRef.current = targetA;
      try {
        desktop.verticalGroupRef.current.setLayout({
          "output-panel": outputPct,
          "editor-panel": editorPct,
        });
      } catch (err) {
        WebviewLog.debug(`[FP-AE] desktop setLayout error`, err);
        editorAutoExpandPxRef.current = A; // revert on error
      }
    }
  };

  // Register the stable event listener once
  useEffect(() => {
    const listener = (e: Event) => overflowHandlerRef.current(e);
    window.addEventListener("fp-editor-overflow-change", listener);
    return () =>
      window.removeEventListener("fp-editor-overflow-change", listener);
  }, []);

  // Mobile overlay closing animation state.
  // When true, the overlay stays mounted but plays a slide-out animation.
  // The real store action fires after onAnimationEnd.
  const [promptsOverlayClosing, setPromptsOverlayClosing] = useState(false);
  const [settingsOverlayClosing, setSettingsOverlayClosing] = useState(false);
  const promptsAfterClose = useRef<(() => void) | null>(null);
  const settingsAfterClose = useRef<(() => void) | null>(null);

  // Sidebar chip rail closing animation state — same pattern as the fullwidth overlay.
  // sidebarAfterClose fires after the collapse animation completes (width 32→0).
  const sidebarShouldShow = mobileStepsOpen && mobileStepsMode === "sidebar";
  const [sidebarChipClosing, setSidebarChipClosing] = useState(false);
  const sidebarAfterClose = useRef<(() => void) | null>(null);

  const handlePromptsRequestSidebar = () => {
    promptsAfterClose.current = () => setMobileStepsMode("sidebar");
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
    sidebarAfterClose.current = () => setMobileStepsMode("fullwidth");
    setSidebarChipClosing(true);
  };

  // Header toggle handlers — route through close animation when panels are already open.
  // Calling toggleMobileSteps/toggleMobileWorkflowProps directly skips the animation path.
  const handleToggleMobileSteps = () => {
    if (mobileStepsOpen && mobileStepsMode === "fullwidth") {
      promptsAfterClose.current = () => closeMobileSteps();
      setPromptsOverlayClosing(true);
    } else if (mobileStepsOpen && mobileStepsMode === "sidebar") {
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

  // Signal ready to extension
  useEffect(() => {
    const { activeWorkflowWorkingFilePath } = useUiStore.getState();
    vscode.postMessage({
      type: MESSAGE_TYPES.READY,
      preferredWorkingFilePath: activeWorkflowWorkingFilePath,
    });
    // In standalone (browser) mode the server is the authoritative source of theme
    // vars. Sending THEME_VARS_CAPTURED from the browser strips --fp-color-theme-kind
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
      "--fp-output-font-size",
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
      if (document.visibilityState === "visible") {
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
      <div className="h-dvh w-full flex flex-col bg-editor-bg text-foreground border-l border-r relative">
        <Header
          onToggleMobileSteps={handleToggleMobileSteps}
          onToggleMobileWorkflowProps={handleToggleMobileWorkflowProps}
        />

        {/* Main area — relative container for absolute overlays */}
        <div className="flex-1 relative overflow-hidden flex flex-col">
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
              <div className="relative z-10 flex flex-col flex-1">
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
              id="flightpath-mobile-layout"
            >
              <Panel
                panelRef={mobile.mobileOutputRef}
                defaultSize={mobile.mobileMountDefaults.current.output}
                collapsible
                collapsedSize={PANEL_COLLAPSED_SIZE_DEFAULT}
                minSize={PANEL_MIN_SIZE_CENTER}
                id="mobile-output-panel"
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
                          ? () => {
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
                    {((mobileStepsOpen && mobileStepsMode === "fullwidth") ||
                      promptsOverlayClosing) && (
                      <div
                        className={`absolute inset-0 z-20 bg-editor-bg flex flex-col ${promptsOverlayClosing ? "animate-slide-out-left" : "animate-slide-in-left"}`}
                        onAnimationEnd={
                          promptsOverlayClosing
                            ? () => {
                                setPromptsOverlayClosing(false);
                                promptsAfterClose.current?.();
                                promptsAfterClose.current = null;
                              }
                            : undefined
                        }
                      >
                        <WorkflowStepsPanel
                          onRequestSidebar={handlePromptsRequestSidebar}
                          onRequestClose={handlePromptsRequestClose}
                        />
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
                id="mobile-editor-panel"
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
                      const isAutoExpandResize =
                        editorAutoExpandPxRef.current > 0 &&
                        Math.abs(px - autoExpectedPx) < 3;
                      if (!isAutoExpandResize) {
                        mobile.lastMobileSizes.current.editor = px;
                        useUiStore
                          .getState()
                          .setLastMobileSizes({ editor: px });
                        editorAutoExpandPxRef.current = 0;
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
                <div
                  className="absolute inset-0 z-30"
                  role="button"
                  tabIndex={0}
                  aria-label="Close settings"
                  onClick={handleSettingsRequestClose}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ")
                      handleSettingsRequestClose();
                  }}
                />
              )}
              <div
                className={`absolute inset-0 z-40 bg-editor-bg flex flex-col ${settingsOverlayClosing ? "animate-slide-out-right" : "animate-slide-in-right"}`}
                onAnimationEnd={
                  settingsOverlayClosing
                    ? () => {
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

          {/* Global Settings Drawer — slides up from bottom, sits above all other content */}
          <GlobalSettingsDrawer />
        </div>

        {/* Startup overlay — covers full layout (header + content) until STARTUP_COMPLETE arrives */}
        <StartupOverlay />

        {/* Workspace viewer — fixed fullscreen overlay, standalone mode only */}
        <WorkspaceViewerModal />

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

      {/* Main layout: relative container enables GlobalSettingsDrawer overlay */}
      <div className="flex-1 relative overflow-hidden flex flex-col min-h-0">
        {/* Prompts (left) | Output/Editor (center) | Settings (right) */}
        <Group
          groupRef={desktop.horizontalGroupRef}
          orientation="horizontal"
          className="flex-1"
          id="flightpath-main-layout"
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
                const size = desktop.stepsRef.current?.getSize().inPixels;
                if (size != null) {
                  const px = Math.round(size);
                  desktop.lastDesktopSizes.current.steps = px;
                  useUiStore.getState().setLastDesktopSizes({ steps: px });
                }
              }
              if (isCollapsed !== promptsCollapsed) {
                setPromptsCollapsed(isCollapsed);
              }
            }}
          >
            <WorkflowStepsPanel />
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
                id="flightpath-vertical-layout"
              >
                <Panel
                  panelRef={desktop.outputRef}
                  defaultSize={desktop.mountDefaultOutput.current}
                  collapsible
                  collapsedSize={PANEL_COLLAPSED_SIZE_DEFAULT}
                  minSize={PANEL_MIN_SIZE_CENTER}
                  id="output-panel"
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
                      if (sizePct != null) {
                        desktop.lastDesktopSizes.current.output = sizePct;
                        useUiStore
                          .getState()
                          .setLastDesktopSizes({ output: sizePct });
                      }
                    }
                    if (!isRemountUnstable) {
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
                  id="editor-panel"
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
                        const isAutoExpandResize =
                          editorAutoExpandPxRef.current > 0 &&
                          Math.abs(px - autoExpectedPx) < 3;
                        WebviewLog.debug(
                          `[FP-AE] onResize px=${px} basePx=${basePx} autoExpectedPx=${autoExpectedPx} editorAutoExpandPx=${editorAutoExpandPxRef.current} isAutoExpandResize=${isAutoExpandResize}`
                        );
                        if (!isAutoExpandResize) {
                          desktop.lastDesktopSizes.current.editor = px;
                          useUiStore
                            .getState()
                            .setLastDesktopSizes({ editor: px });
                          editorAutoExpandPxRef.current = 0;
                          WebviewLog.debug(
                            `[FP-AE] onResize: saved as new base px=${px} reset autoExpand`
                          );
                        } else {
                          WebviewLog.debug(
                            `[FP-AE] onResize: auto-expand resize detected, skipping base update`
                          );
                        }
                      }
                    }
                    if (!isRemountUnstable) {
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
                const size = desktop.settingsRef.current?.getSize().inPixels;
                if (size != null) {
                  const px = Math.round(size);
                  desktop.lastDesktopSizes.current.settings = px;
                  useUiStore.getState().setLastDesktopSizes({ settings: px });
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

        {/* Global Settings Drawer — slides up from bottom, z-40 */}
        <GlobalSettingsDrawer />
      </div>

      {/* Startup overlay — covers full layout (header + content) until STARTUP_COMPLETE arrives */}
      <StartupOverlay />

      {/* Workspace viewer — fixed fullscreen overlay, standalone mode only */}
      <WorkspaceViewerModal />

      {/* iOS safe area spacer — see mobile layout comment above */}
      <div className="safe-area-spacer" aria-hidden="true" />
    </div>
  );
}

export default App;
