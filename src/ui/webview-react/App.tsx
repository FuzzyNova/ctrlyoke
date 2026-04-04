import { useEffect, useRef, useState } from "react";
import { Panel, Group, Separator } from "react-resizable-panels";
import { useMessageHandler } from "@hooks/useMessageHandler";
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
  PromptsPanel,
  OutputSection,
  EditorSection,
  WorkflowPropertiesPanel,
  CenterContentArea,
  MobilePromptsSidebar,
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
  const promptsCollapsed = useUiStore((s) => s.promptsCollapsed);
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

  // Track isMobile to detect layout transitions in render body below
  const wasMobileRef = useRef(isMobile);

  // Message handlers with full implementations
  useMessageHandler();
  useUndoRedoKeyHandler();

  // Signal ready to extension
  useEffect(() => {
    vscode.postMessage({ type: MESSAGE_TYPES.READY });
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
      desktop.desktopMountDefaults.current.prompts = promptsCollapsed
        ? PANEL_COLLAPSED_SIZE_SIDEBAR
        : String(desktop.lastDesktopSizes.current.prompts);
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
      <div className="h-screen w-full flex flex-col bg-editor-bg text-foreground border-l border-r">
        <Header
          onToggleMobilePrompts={toggleMobilePrompts}
          onToggleMobileSettings={toggleMobileSettings}
        />

        {/* Main area — relative container for absolute overlays */}
        <div className="flex-1 relative overflow-hidden flex">

          {/* Sidebar prompts — flex sibling, takes 72px, pushes center right */}
          {mobilePromptsOpen && mobilePromptsMode === "sidebar" && (
            <div className="w-[72px] flex-shrink-0 h-full border-r border-panel-border bg-sidebar-bg overflow-y-auto">
              <MobilePromptsSidebar />
            </div>
          )}

          {/* Center content: output + editor vertical split */}
          <div className="flex-1 flex flex-col min-w-0">
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
                        WebkitMaskImage: logoUrl
                          ? `url('${logoUrl}')`
                          : "none",
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
                  <OutputSection />
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
          </div>

          {/* Full-width prompts overlay */}
          {mobilePromptsOpen && mobilePromptsMode === "fullwidth" && (
            <>
              {/* Backdrop — tap outside returns to sidebar mode */}
              <div
                className="absolute inset-0 z-20"
                onClick={() => setMobilePromptsMode("sidebar")}
              />
              <div className="absolute inset-0 z-30 bg-editor-bg flex flex-col">
                <PromptsPanel
                  onRequestSidebar={() => setMobilePromptsMode("sidebar")}
                  onRequestClose={closeMobilePrompts}
                />
              </div>
            </>
          )}

          {/* Settings overlay drawer */}
          {mobileSettingsOpen && (
            <>
              {/* Backdrop — tap outside closes */}
              <div
                className="absolute inset-0 z-30"
                onClick={closeMobileSettings}
              />
              <div className="absolute inset-0 z-40 bg-editor-bg flex flex-col">
                <WorkflowPropertiesPanel onRequestClose={closeMobileSettings} />
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // ============================================================================
  // DESKTOP LAYOUT — horizontal three-column layout
  // ============================================================================

  return (
    <div className="h-screen w-full flex flex-col bg-editor-bg text-foreground">
      <Header />

      {/* Main layout: Prompts (left) | Output/Editor (center) | Settings (right) */}
      <Group
        groupRef={desktop.horizontalGroupRef}
        orientation="horizontal"
        className="flex-1"
        id="flightpath-main-layout"
      >
        {/* Prompts Panel (Left - collapsible) */}
        <Panel
          panelRef={desktop.promptsRef}
          defaultSize={desktop.desktopMountDefaults.current.prompts}
          collapsible
          collapsedSize={PANEL_COLLAPSED_SIZE_SIDEBAR}
          minSize={PANEL_MIN_SIZE_SIDEBAR}
          maxSize={PANEL_MAX_SIZE_SIDEBAR}
          id="prompts-panel"
          onResize={() => {
            if (!desktop.horizontalInitializedRef.current || !uiLayoutReady)
              return;
            const isCollapsed =
              desktop.promptsRef.current?.isCollapsed() ?? false;
            if (!isCollapsed) {
              const size = desktop.promptsRef.current?.getSize().asPercentage;
              if (size != null) {
                desktop.lastDesktopSizes.current.prompts = size;
                useUiStore.getState().setLastDesktopSizes({ prompts: size });
              }
            }
            if (isCollapsed !== promptsCollapsed) {
              setPromptsCollapsed(isCollapsed);
            }
          }}
        >
          <PromptsPanel />
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
                  if (!desktop.initializedRef.current || !uiLayoutReady) return;
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
                  if (!desktop.initializedRef.current || !uiLayoutReady) return;
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
              const size = desktop.settingsRef.current?.getSize().asPercentage;
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
    </div>
  );
}

export default App;
