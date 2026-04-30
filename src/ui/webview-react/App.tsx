import { useEffect, useRef, useState } from "react";
import { Panel, Group, Separator, type Layout } from "react-resizable-panels";
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
import { clearNotificationBadgeCount } from "@utils/browserNotifications";
import { terminalRegistry } from "./terminalRegistry";
import { MESSAGE_TYPES } from "@/types/messages";
// uiStore uses vscode.getState()/setState() as its persist storage (see
// uiStore.ts) and is rehydrated from main.tsx before App mounts.
import {
  PANEL_COLLAPSED_SIZE_DEFAULT,
  PANEL_COLLAPSED_SIZE_SIDEBAR,
  PANEL_MIN_SIZE_CENTER,
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

  const persistDesktopCenterLayout = (layout: Layout) => {
    const isRemountUnstable =
      desktop.needsForcedResize.current || desktop.isForcingResize.current;
    const panelOutputCollapsed =
      desktop.outputRef.current?.isCollapsed() ?? outputCollapsed;
    const panelEditorCollapsed =
      desktop.editorRef.current?.isCollapsed() ?? editorCollapsed;
    const outputSize = layout["output-panel"];
    const editorSize = layout["editor-panel"];

    if (
      isRemountUnstable ||
      outputCollapsed ||
      editorCollapsed ||
      panelOutputCollapsed ||
      panelEditorCollapsed ||
      typeof outputSize !== "number" ||
      typeof editorSize !== "number" ||
      outputSize <= centerMinSizePct ||
      editorSize <= centerMinSizePct
    ) {
      return;
    }

    desktop.lastDesktopSizes.current.output = outputSize;
    desktop.lastDesktopSizes.current.editor = editorSize;
    useUiStore.getState().setLastDesktopSizes({
      output: outputSize,
      editor: editorSize,
    });
  };

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
  const mobilePromptsOpen = useUiStore((s) => s.mobilePromptsOpen);
  const mobilePromptsMode = useUiStore((s) => s.mobilePromptsMode);
  const mobileSettingsOpen = useUiStore((s) => s.mobileSettingsOpen);
  const toggleMobilePrompts = useUiStore((s) => s.toggleMobilePrompts);
  const setMobilePromptsMode = useUiStore((s) => s.setMobilePromptsMode);
  const toggleMobileSettings = useUiStore((s) => s.toggleMobileSettings);
  const closeMobilePrompts = useUiStore((s) => s.closeMobilePrompts);
  const closeMobileSettings = useUiStore((s) => s.closeMobileSettings);

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
    mobilePromptsOpen && mobilePromptsMode === "sidebar";
  const [sidebarChipClosing, setSidebarChipClosing] = useState(false);
  const sidebarAfterClose = useRef<(() => void) | null>(null);

  const handlePromptsRequestSidebar = () => {
    promptsAfterClose.current = () => setMobilePromptsMode("sidebar");
    setPromptsOverlayClosing(true);
  };
  const handlePromptsRequestClose = () => {
    promptsAfterClose.current = () => closeMobilePrompts();
    setPromptsOverlayClosing(true);
  };
  const handleSettingsRequestClose = () => {
    settingsAfterClose.current = () => closeMobileSettings();
    setSettingsOverlayClosing(true);
  };

  const handleSidebarExpand = () => {
    sidebarAfterClose.current = () => setMobilePromptsMode("fullwidth");
    setSidebarChipClosing(true);
  };

  // Header toggle handlers — route through close animation when panels are already open.
  // Calling toggleMobilePrompts/toggleMobileSettings directly skips the animation path.
  const handleToggleMobilePrompts = () => {
    if (mobilePromptsOpen && mobilePromptsMode === "fullwidth") {
      promptsAfterClose.current = () => closeMobilePrompts();
      setPromptsOverlayClosing(true);
    } else if (mobilePromptsOpen && mobilePromptsMode === "sidebar") {
      sidebarAfterClose.current = () => closeMobilePrompts();
      setSidebarChipClosing(true);
    } else {
      toggleMobilePrompts();
    }
  };

  const handleToggleMobileSettings = () => {
    if (mobileSettingsOpen) {
      settingsAfterClose.current = () => closeMobileSettings();
      setSettingsOverlayClosing(true);
    } else {
      toggleMobileSettings();
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
  // mobilePromptsOpen is NOT reset here so the persisted preference is preserved:
  // if steps were open on mobile, they'll still be open when returning to mobile.
  useEffect(() => {
    if (!isMobile) {
      closeMobileSettings();
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
      const centerCollapsed = {
        output: outputCollapsed,
        editor: editorCollapsed,
      };
      const centerKeys = ["output", "editor"] as const;
      const openKeys = centerKeys.filter((k) => !centerCollapsed[k]);

      if (openKeys.length === 1) {
        // One collapsed, one open: collapsed gets pixel size, open gets undefined (flexGrow:1)
        for (const k of centerKeys) {
          mobile.mobileMountDefaults.current[k] = centerCollapsed[k]
            ? PANEL_COLLAPSED_SIZE_DEFAULT
            : undefined;
        }
      } else if (openKeys.length === 2) {
        const totalOpen =
          openKeys.reduce((s, k) => s + mobile.lastMobileSizes.current[k], 0) ||
          1;
        for (const k of centerKeys) {
          mobile.mobileMountDefaults.current[k] = String(
            Math.round((mobile.lastMobileSizes.current[k] / totalOpen) * 100)
          );
        }
      }

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
      desktop.mountDefaultOutput.current = outputCollapsed
        ? PANEL_COLLAPSED_SIZE_DEFAULT
        : editorCollapsed
          ? undefined
          : String(desktop.lastDesktopSizes.current.output);
      desktop.mountDefaultEditor.current = editorCollapsed
        ? PANEL_COLLAPSED_SIZE_DEFAULT
        : outputCollapsed
          ? undefined
          : String(desktop.lastDesktopSizes.current.editor);

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
      desktop.mountDefaultOutput.current = outputCollapsed
        ? PANEL_COLLAPSED_SIZE_DEFAULT
        : editorCollapsed
          ? undefined
          : String(desktop.lastDesktopSizes.current.output);
      desktop.mountDefaultEditor.current = editorCollapsed
        ? PANEL_COLLAPSED_SIZE_DEFAULT
        : outputCollapsed
          ? undefined
          : String(desktop.lastDesktopSizes.current.editor);
      // Group is remounting — next both-open transition needs forced resize
      desktop.needsForcedResize.current = true;
    }
    desktop.wasBothCollapsed.current = bothCollapsed;
  }

  // ============================================================================
  // MOBILE LAYOUT — center panels (output + editor) + drawer overlays
  // ============================================================================

  const allMobileCenterCollapsed = outputCollapsed && editorCollapsed;
  const centerMinSizePct = Number(PANEL_MIN_SIZE_CENTER);

  // Update mobile mount defaults when transitioning from all-collapsed → some-open.
  // Open center panels redistribute proportionally; collapsed panels stay at 30px.
  {
    if (mobile.mobileWasAllCollapsed.current && !allMobileCenterCollapsed) {
      const centerKeys = ["output", "editor"] as const;
      const collapsed = { output: outputCollapsed, editor: editorCollapsed };
      const openKeys = centerKeys.filter((k) => !collapsed[k]);

      if (openKeys.length === 1) {
        // One collapsed, one open: collapsed gets pixel size, open gets undefined (flexGrow:1)
        for (const k of centerKeys) {
          mobile.mobileMountDefaults.current[k] = collapsed[k]
            ? PANEL_COLLAPSED_SIZE_DEFAULT
            : undefined;
        }
      } else {
        const totalOpen =
          openKeys.reduce((s, k) => s + mobile.lastMobileSizes.current[k], 0) ||
          1;
        for (const k of centerKeys) {
          mobile.mobileMountDefaults.current[k] = String(
            Math.round((mobile.lastMobileSizes.current[k] / totalOpen) * 100)
          );
        }
      }
    }
    mobile.mobileWasAllCollapsed.current = allMobileCenterCollapsed;
  }

  if (isMobile) {
    return (
      <div className="h-dvh w-full flex flex-col bg-editor-bg text-foreground border-l border-r relative">
        <Header
          onToggleMobilePrompts={handleToggleMobilePrompts}
          onToggleMobileSettings={handleToggleMobileSettings}
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
                  const gateOpen =
                    mobile.mobileInitializedRef.current && uiLayoutReady;
                  if (!mobile.mobileInitializedRef.current || !uiLayoutReady) {
                    return;
                  }
                  const isCollapsed =
                    mobile.mobileOutputRef.current?.isCollapsed() ?? false;
                  const size =
                    mobile.mobileOutputRef.current?.getSize().asPercentage ??
                    null;
                  const editorSize =
                    mobile.mobileEditorRef.current?.getSize().asPercentage ??
                    null;
                  if (!gateOpen) {
                    return;
                  }
                  if (
                    !outputCollapsed &&
                    !editorCollapsed &&
                    !isCollapsed &&
                    size != null &&
                    editorSize != null &&
                    size > centerMinSizePct &&
                    editorSize > centerMinSizePct
                  ) {
                    mobile.lastMobileSizes.current.output = size;
                    useUiStore.getState().setLastMobileSizes({ output: size });
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
                    {((mobilePromptsOpen &&
                      mobilePromptsMode === "fullwidth") ||
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
                collapsible
                collapsedSize={PANEL_COLLAPSED_SIZE_DEFAULT}
                minSize={PANEL_MIN_SIZE_CENTER}
                id="mobile-editor-panel"
                onResize={() => {
                  const gateOpen =
                    mobile.mobileInitializedRef.current && uiLayoutReady;
                  if (!mobile.mobileInitializedRef.current || !uiLayoutReady) {
                    return;
                  }
                  const isCollapsed =
                    mobile.mobileEditorRef.current?.isCollapsed() ?? false;
                  const size =
                    mobile.mobileEditorRef.current?.getSize().asPercentage ??
                    null;
                  const outputSize =
                    mobile.mobileOutputRef.current?.getSize().asPercentage ??
                    null;
                  if (!gateOpen) {
                    return;
                  }
                  if (
                    !outputCollapsed &&
                    !editorCollapsed &&
                    !isCollapsed &&
                    size != null &&
                    outputSize != null &&
                    size > centerMinSizePct &&
                    outputSize > centerMinSizePct
                  ) {
                    mobile.lastMobileSizes.current.editor = size;
                    useUiStore.getState().setLastMobileSizes({ editor: size });
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
          {(mobileSettingsOpen || settingsOverlayClosing) && (
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
                onLayoutChanged={(layout: Layout) => {
                  persistDesktopCenterLayout(layout);
                }}
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
                  collapsible
                  collapsedSize={PANEL_COLLAPSED_SIZE_DEFAULT}
                  minSize={PANEL_MIN_SIZE_CENTER}
                  id="editor-panel"
                  onResize={() => {
                    const isRemountUnstable =
                      desktop.needsForcedResize.current ||
                      desktop.isForcingResize.current;
                    const isEditorCollapsed =
                      desktop.editorRef.current?.isCollapsed() ?? false;
                    if (!desktop.initializedRef.current || !uiLayoutReady)
                      return;
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
