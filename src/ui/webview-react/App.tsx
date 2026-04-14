import { useEffect, useRef, useState } from "react";
import { Panel, Group, Separator } from "react-resizable-panels";
import {
  useMessageHandler,
  captureAndSendThemeVars,
} from "@hooks/useMessageHandler";
import { useUndoRedoKeyHandler } from "@hooks/useUndoRedoKeyHandler";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { useIsMobile } from "@hooks/useMediaQuery";
import { useDesktopLayout } from "@hooks/useDesktopLayout";
import { useMobileLayout } from "@hooks/useMobileLayout";
import { useUiStore } from "@store/uiStore";
import { terminalRegistry } from "./terminalRegistry";
import { MESSAGE_TYPES } from "@/types/messages";
// uiStore uses vscode.getState()/setState() as its persist storage (see uiStore.ts),
// so collapse states are restored synchronously before the first render.
import {
  PANEL_COLLAPSED_SIZE_DEFAULT,
  PANEL_COLLAPSED_SIZE_SIDEBAR,
  PANEL_EXPANDED_SIZE_SINGLE,
  PANEL_MIN_SIZE_CENTER,
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

function App() {
  const vscode = useVsCodeApi();
  const isMobile = useIsMobile();
  // uiStore hydrates synchronously from vscode.getState() on store creation,
  // so the persisted collapse state is available on the first render.
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

  // Header toggle handlers — route through close animation when panels are already open.
  // Calling toggleMobilePrompts/toggleMobileSettings directly skips the animation path.
  const handleToggleMobilePrompts = () => {
    if (mobilePromptsOpen && mobilePromptsMode === "fullwidth") {
      promptsAfterClose.current = () => closeMobilePrompts();
      setPromptsOverlayClosing(true);
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
    vscode.postMessage({ type: MESSAGE_TYPES.READY });
    // Capture VS Code theme variables on mount and send to extension for server theme forwarding
    captureAndSendThemeVars(vscode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // vscode is a stable singleton — never changes

  // Close mobile drawers when switching to desktop so they don't reappear
  // the next time the user returns to mobile.
  useEffect(() => {
    if (!isMobile) {
      closeMobilePrompts();
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

      if (openKeys.length > 0) {
        const totalOpen =
          openKeys.reduce((s, k) => s + mobile.lastMobileSizes.current[k], 0) ||
          1;
        for (const k of centerKeys) {
          mobile.mobileMountDefaults.current[k] = centerCollapsed[k]
            ? PANEL_COLLAPSED_SIZE_DEFAULT
            : String(
                Math.round(
                  (mobile.lastMobileSizes.current[k] / totalOpen) * 100
                )
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
        : String(desktop.lastDesktopSizes.current.steps);
      desktop.desktopMountDefaults.current.settings = settingsCollapsed
        ? PANEL_COLLAPSED_SIZE_SIDEBAR
        : String(desktop.lastDesktopSizes.current.settings);

      // Center vertical group panels
      desktop.mountDefaultOutput.current = outputCollapsed
        ? PANEL_COLLAPSED_SIZE_DEFAULT
        : editorCollapsed
          ? PANEL_EXPANDED_SIZE_SINGLE
          : String(desktop.lastDesktopSizes.current.output);
      desktop.mountDefaultEditor.current = editorCollapsed
        ? PANEL_COLLAPSED_SIZE_DEFAULT
        : outputCollapsed
          ? PANEL_EXPANDED_SIZE_SINGLE
          : String(desktop.lastDesktopSizes.current.editor);

      // Trigger forced resize for center group (if both open)
      if (!outputCollapsed && !editorCollapsed) {
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
          ? PANEL_EXPANDED_SIZE_SINGLE
          : String(desktop.lastDesktopSizes.current.output);
      desktop.mountDefaultEditor.current = editorCollapsed
        ? PANEL_COLLAPSED_SIZE_DEFAULT
        : outputCollapsed
          ? PANEL_EXPANDED_SIZE_SINGLE
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

  // Update mobile mount defaults when transitioning from all-collapsed → some-open.
  // Open center panels redistribute proportionally; collapsed panels stay at 30px.
  {
    if (mobile.mobileWasAllCollapsed.current && !allMobileCenterCollapsed) {
      const centerKeys = ["output", "editor"] as const;
      const collapsed = { output: outputCollapsed, editor: editorCollapsed };
      const openKeys = centerKeys.filter((k) => !collapsed[k]);
      const totalOpen =
        openKeys.reduce((s, k) => s + mobile.lastMobileSizes.current[k], 0) ||
        1;

      for (const k of centerKeys) {
        mobile.mobileMountDefaults.current[k] = collapsed[k]
          ? "30px"
          : String(
              Math.round((mobile.lastMobileSizes.current[k] / totalOpen) * 100)
            );
      }
    }
    mobile.mobileWasAllCollapsed.current = allMobileCenterCollapsed;
  }

  if (isMobile) {
    return (
      <div className="h-dvh w-full flex flex-col bg-editor-bg text-foreground border-l border-r">
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
                  if (!mobile.mobileInitializedRef.current || !uiLayoutReady)
                    return;
                  const isCollapsed =
                    mobile.mobileOutputRef.current?.isCollapsed() ?? false;
                  const size =
                    mobile.mobileOutputRef.current?.getSize().asPercentage ??
                    null;
                  if (!isCollapsed && size != null) {
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
                <div className="flex h-full">
                  {/* Sidebar chip rail — 32px flex sibling, pushes output right */}
                  {mobilePromptsOpen && mobilePromptsMode === "sidebar" && (
                    <div className="w-[32px] flex-shrink-0 h-full border-r border-panel-border bg-sidebar-bg">
                      <PromptChipRail
                        onExpand={() => setMobilePromptsMode("fullwidth")}
                      />
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
                  if (!mobile.mobileInitializedRef.current || !uiLayoutReady)
                    return;
                  const isCollapsed =
                    mobile.mobileEditorRef.current?.isCollapsed() ?? false;
                  const size =
                    mobile.mobileEditorRef.current?.getSize().asPercentage ??
                    null;
                  if (!isCollapsed && size != null) {
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

          {/* Startup overlay — covers full layout until STARTUP_COMPLETE arrives */}
          <StartupOverlay />
        </div>

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
    <div className="h-dvh w-full flex flex-col bg-editor-bg text-foreground">
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
                const size = desktop.stepsRef.current?.getSize().asPercentage;
                if (size != null) {
                  desktop.lastDesktopSizes.current.steps = size;
                  useUiStore.getState().setLastDesktopSizes({ steps: size });
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
          <Panel id="center-content">
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
                    if (!desktop.initializedRef.current || !uiLayoutReady)
                      return;
                    const isOutputCollapsed =
                      desktop.outputRef.current?.isCollapsed() ?? false;
                    const isEditorCollapsed =
                      desktop.editorRef.current?.isCollapsed() ?? false;
                    const currentSize =
                      desktop.outputRef.current?.getSize().asPercentage;

                    if (
                      !isOutputCollapsed &&
                      !isEditorCollapsed &&
                      !desktop.isForcingResize.current
                    ) {
                      const newSize =
                        currentSize ?? desktop.lastDesktopSizes.current.output;
                      desktop.lastDesktopSizes.current.output = newSize;
                      useUiStore
                        .getState()
                        .setLastDesktopSizes({ output: newSize });
                    }
                    setOutputCollapsed(isOutputCollapsed);
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
                    if (!desktop.initializedRef.current || !uiLayoutReady)
                      return;
                    const isEditorCollapsed =
                      desktop.editorRef.current?.isCollapsed() ?? false;
                    const isOutputCollapsed =
                      desktop.outputRef.current?.isCollapsed() ?? false;
                    const currentSize =
                      desktop.editorRef.current?.getSize().asPercentage;

                    if (
                      !isEditorCollapsed &&
                      !isOutputCollapsed &&
                      !desktop.isForcingResize.current
                    ) {
                      const newSize =
                        currentSize ?? desktop.lastDesktopSizes.current.editor;
                      desktop.lastDesktopSizes.current.editor = newSize;
                      useUiStore
                        .getState()
                        .setLastDesktopSizes({ editor: newSize });
                    }
                    setEditorCollapsed(isEditorCollapsed);
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
                const size =
                  desktop.settingsRef.current?.getSize().asPercentage;
                if (size != null) {
                  desktop.lastDesktopSizes.current.settings = size;
                  useUiStore.getState().setLastDesktopSizes({ settings: size });
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

        {/* Startup overlay — covers full layout until STARTUP_COMPLETE arrives */}
        <StartupOverlay />
      </div>

      {/* iOS safe area spacer — see mobile layout comment above */}
      <div className="safe-area-spacer" aria-hidden="true" />
    </div>
  );
}

export default App;
