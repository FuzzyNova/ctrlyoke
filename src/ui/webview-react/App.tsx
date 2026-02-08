import { useEffect, useLayoutEffect, useRef } from "react";
import {
  Panel,
  Group,
  Separator,
  PanelImperativeHandle,
  GroupImperativeHandle,
} from "react-resizable-panels";
import { useMessageHandler } from "@hooks/useMessageHandler";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { useIsMobile } from "@hooks/useMediaQuery";
import { useUiStore } from "@store/uiStore";
import { MESSAGE_TYPES } from "@/types/messages";
import {
  PANEL_COLLAPSED_SIZE_DEFAULT,
  PANEL_COLLAPSED_SIZE_SIDEBAR,
  PANEL_EXPANDED_SIZE_SINGLE,
  PANEL_MIN_SIZE_SMALL,
  PANEL_MIN_SIZE_CENTER,
  PANEL_MAX_SIZE_SIDEBAR,
  DEFAULT_DESKTOP_SIZES,
  DEFAULT_MOBILE_SIZES,
} from "./constants";
import {
  Header,
  PromptsPanel,
  OutputSection,
  EditorSection,
  SettingsPanel,
} from "./components/layout";

function App() {
  const vscode = useVsCodeApi();
  const isMobile = useIsMobile();

  // Panel imperative refs for programmatic collapse/expand
  const settingsRef = useRef<PanelImperativeHandle>(null);
  const promptsRef = useRef<PanelImperativeHandle>(null);
  const outputRef = useRef<PanelImperativeHandle>(null);
  const editorRef = useRef<PanelImperativeHandle>(null);
  // Vertical group ref for setLayout() API
  const verticalGroupRef = useRef<GroupImperativeHandle>(null);
  // Gates onResize until useLayoutEffect has applied the persisted
  // collapsed/expanded state.  Reset to false whenever both panels are collapsed
  // (the vertical Group unmounts); the next mount re-gates until the first
  // useLayoutEffect re-syncs.
  const initializedRef = useRef(false);
  // Track last expanded sizes per layout — restored when re-expanding, captured
  // during drag.  Grouped by layout to keep the 8 values organized.
  const lastDesktopSizes = useRef({ ...DEFAULT_DESKTOP_SIZES });
  const lastMobileSizes = useRef({ ...DEFAULT_MOBILE_SIZES });
  // Flag: true when Group just remounted from both-collapsed, false after forced resize
  const needsForcedResize = useRef(false);
  // Flag: true during forced resize operation to prevent onResize from saving wrong values
  const isForcingResize = useRef(false);
  // Desktop mount defaults — used when desktop Group remounts (e.g. mobile → desktop).
  // Updated from saved sizes to restore the user's layout after mobile detour.
  const desktopMountDefaults = useRef({
    prompts: String(DEFAULT_DESKTOP_SIZES.prompts),
    settings: String(DEFAULT_DESKTOP_SIZES.settings),
  });
  const wasMobileRef = useRef(isMobile);

  // Collapse state from store (source of truth)
  const settingsCollapsed = useUiStore((s) => s.settingsCollapsed);
  const setSettingsCollapsed = useUiStore((s) => s.setSettingsCollapsed);
  const promptsCollapsed = useUiStore((s) => s.promptsCollapsed);
  const setPromptsCollapsed = useUiStore((s) => s.setPromptsCollapsed);
  const outputCollapsed = useUiStore((s) => s.outputCollapsed);
  const setOutputCollapsed = useUiStore((s) => s.setOutputCollapsed);
  const editorCollapsed = useUiStore((s) => s.editorCollapsed);
  const setEditorCollapsed = useUiStore((s) => s.setEditorCollapsed);

  // Stable mount defaults — only recomputed on the both-collapsed → one-open
  // transition (i.e. when the vertical Group remounts).  Keeping defaultSize
  // constant while the Group is already mounted prevents the library from
  // re-initialising and overriding imperative collapse()/expand() calls.
  const wasBothCollapsed = useRef(outputCollapsed && editorCollapsed);
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

  // Message handlers with full implementations
  useMessageHandler();

  // Signal ready to extension
  useEffect(() => {
    vscode.postMessage({ type: MESSAGE_TYPES.READY });
  }, []);

  // Sync prompts/settings collapse state before paint.
  // Runs on initial desktop mount and when returning from mobile layout
  // (desktop panels remount fresh, ongoing useEffects won't re-run unless
  // their specific collapse state changed during mobile).
  useLayoutEffect(() => {
    if (isMobile) return;
    if (settingsCollapsed) settingsRef.current?.collapse();
    else settingsRef.current?.expand();
    if (promptsCollapsed) promptsRef.current?.collapse();
    else promptsRef.current?.expand();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile]);

  // Ongoing store → panel sync
  useEffect(() => {
    if (settingsCollapsed) settingsRef.current?.collapse();
    else settingsRef.current?.expand();
  }, [settingsCollapsed]);

  useEffect(() => {
    if (promptsCollapsed) promptsRef.current?.collapse();
    else promptsRef.current?.expand();
  }, [promptsCollapsed]);

  // Sync store → panels imperatively.  Runs before paint so there is no visible
  // flash of the default 60/40 split before the persisted collapsed state is
  // applied.  Does NOT open the onResize gate — that is done in the useEffect
  // below, which runs after all child effects (including the Panel mount
  // onResize events) have fired.
  useLayoutEffect(() => {
    const shouldForceResize =
      !outputCollapsed && !editorCollapsed && needsForcedResize.current;

    if (shouldForceResize) {
      // Force resize: use setLayout() to atomically expand and resize both panels
      isForcingResize.current = true;

      if (verticalGroupRef.current) {
        // Round to integers and ensure they sum to 100
        const outputSize = Math.round(lastDesktopSizes.current.output);
        const editorSize = 100 - outputSize;

        // setLayout expects an object with panel IDs as keys
        const layout = {
          "output-panel": outputSize,
          "editor-panel": editorSize,
        };

        try {
          verticalGroupRef.current.setLayout(layout);
        } catch (error) {
          console.error("[LAYOUT] ❌ setLayout() failed:", error);
        }
      } else {
        console.error("[LAYOUT] ❌ verticalGroupRef.current is null!");
      }

      needsForcedResize.current = false;

      // Clear flag after a brief delay to allow onResize events to process
      setTimeout(() => {
        isForcingResize.current = false;
      }, 50);
    } else {
      // Normal collapse/expand
      if (outputRef.current) {
        if (outputCollapsed) {
          outputRef.current.collapse();
        } else {
          outputRef.current.expand();
        }
      }

      if (editorRef.current) {
        if (editorCollapsed) {
          editorRef.current.collapse();
        } else {
          editorRef.current.expand();
        }
      }
    }
  }, [outputCollapsed, editorCollapsed, isMobile]);

  // Gate management: closed when both panels are collapsed (the Group
  // unmounts; next mount needs re-sync before onResize is trusted).  Opened
  // in useEffect (not useLayoutEffect) so that the Panel mount onResize
  // events — which fire in child useEffects — are still gated when they run.
  useEffect(() => {
    if (outputCollapsed && editorCollapsed) {
      initializedRef.current = false;
      // Clear forced resize flag when both collapse
      if (needsForcedResize.current) {
        needsForcedResize.current = false;
      }
    } else {
      initializedRef.current = true;
    }
  }, [outputCollapsed, editorCollapsed, isMobile]);

  // Update ALL desktop mount defaults when returning from mobile layout.
  // The desktop Groups remount fresh, so defaultSize must reflect saved sizes.
  {
    if (wasMobileRef.current && !isMobile) {
      // Horizontal group panels
      desktopMountDefaults.current.prompts = String(
        lastDesktopSizes.current.prompts
      );
      desktopMountDefaults.current.settings = String(
        lastDesktopSizes.current.settings
      );

      // Center vertical group panels
      mountDefaultOutput.current = outputCollapsed
        ? PANEL_COLLAPSED_SIZE_DEFAULT
        : editorCollapsed
          ? PANEL_EXPANDED_SIZE_SINGLE
          : String(lastDesktopSizes.current.output);
      mountDefaultEditor.current = editorCollapsed
        ? PANEL_COLLAPSED_SIZE_DEFAULT
        : outputCollapsed
          ? PANEL_EXPANDED_SIZE_SINGLE
          : String(lastDesktopSizes.current.editor);

      // Trigger forced resize for center group (if both open)
      if (!outputCollapsed && !editorCollapsed) {
        needsForcedResize.current = true;
      }
      // Close gate so mount-time onResize events are ignored
      initializedRef.current = false;
    }
    wasMobileRef.current = isMobile;
  }

  // Update mount defaults only when the Group is about to remount
  // (both-collapsed → one-open).  While the Group stays alive defaultSize
  // must remain constant so the library does not re-initialise and clobber
  // imperative collapse()/expand() calls.
  {
    const bothCollapsed = outputCollapsed && editorCollapsed;
    if (wasBothCollapsed.current && !bothCollapsed) {
      mountDefaultOutput.current = outputCollapsed
        ? PANEL_COLLAPSED_SIZE_DEFAULT
        : editorCollapsed
          ? PANEL_EXPANDED_SIZE_SINGLE
          : String(lastDesktopSizes.current.output);
      mountDefaultEditor.current = editorCollapsed
        ? PANEL_COLLAPSED_SIZE_DEFAULT
        : outputCollapsed
          ? PANEL_EXPANDED_SIZE_SINGLE
          : String(lastDesktopSizes.current.editor);
      // Group is remounting - next both-open transition needs forced resize
      needsForcedResize.current = true;
    }
    wasBothCollapsed.current = bothCollapsed;
  }

  // ============================================================================
  // MOBILE LAYOUT — vertical stacking of all 4 panels
  // ============================================================================

  // Mobile-specific refs (separate Group with different panel IDs)
  const mobilePromptsRef = useRef<PanelImperativeHandle>(null);
  const mobileOutputRef = useRef<PanelImperativeHandle>(null);
  const mobileEditorRef = useRef<PanelImperativeHandle>(null);
  const mobileSettingsRef = useRef<PanelImperativeHandle>(null);
  const mobileGroupRef = useRef<GroupImperativeHandle>(null);
  // Gates onResize until first useLayoutEffect has synced persisted state
  const mobileInitializedRef = useRef(false);
  // Mobile mount defaults — recomputed only on the all-collapsed → some-open
  // transition (Group remount).  Open panels share space proportionally based
  // on their last saved sizes; collapsed panels get a fixed 30px bar.
  const mobileWasAllCollapsed = useRef(
    promptsCollapsed && outputCollapsed && editorCollapsed && settingsCollapsed
  );
  const mobileMountDefaults = useRef({
    prompts: String(DEFAULT_MOBILE_SIZES.prompts),
    output: String(DEFAULT_MOBILE_SIZES.output),
    editor: String(DEFAULT_MOBILE_SIZES.editor),
    settings: String(DEFAULT_MOBILE_SIZES.settings),
  });

  // Store → mobile panel sync (before paint to avoid flash)
  useLayoutEffect(() => {
    if (!isMobile) return;
    if (promptsCollapsed) mobilePromptsRef.current?.collapse();
    else mobilePromptsRef.current?.expand();
    if (outputCollapsed) mobileOutputRef.current?.collapse();
    else mobileOutputRef.current?.expand();
    if (editorCollapsed) mobileEditorRef.current?.collapse();
    else mobileEditorRef.current?.expand();
    if (settingsCollapsed) mobileSettingsRef.current?.collapse();
    else mobileSettingsRef.current?.expand();
  }, [
    isMobile,
    promptsCollapsed,
    outputCollapsed,
    editorCollapsed,
    settingsCollapsed,
  ]);

  // Mobile gate management: close when all collapsed, open after sync
  useEffect(() => {
    if (!isMobile) return;
    const allCollapsed =
      promptsCollapsed &&
      outputCollapsed &&
      editorCollapsed &&
      settingsCollapsed;
    mobileInitializedRef.current = !allCollapsed;
  }, [
    isMobile,
    promptsCollapsed,
    outputCollapsed,
    editorCollapsed,
    settingsCollapsed,
  ]);

  const allMobileCollapsed =
    promptsCollapsed && outputCollapsed && editorCollapsed && settingsCollapsed;

  // Update mobile mount defaults when transitioning from all-collapsed → some-open.
  // Open panels redistribute proportionally; collapsed panels stay at 30px.
  {
    if (mobileWasAllCollapsed.current && !allMobileCollapsed) {
      const collapsed = {
        prompts: promptsCollapsed,
        output: outputCollapsed,
        editor: editorCollapsed,
        settings: settingsCollapsed,
      };
      const keys = ["prompts", "output", "editor", "settings"] as const;
      const openKeys = keys.filter((k) => !collapsed[k]);
      const totalOpen =
        openKeys.reduce((s, k) => s + lastMobileSizes.current[k], 0) || 1;

      for (const k of keys) {
        mobileMountDefaults.current[k] = collapsed[k]
          ? "30px"
          : String(Math.round((lastMobileSizes.current[k] / totalOpen) * 100));
      }
    }
    mobileWasAllCollapsed.current = allMobileCollapsed;
  }

  if (isMobile) {
    return (
      <div className="h-screen w-full flex flex-col bg-[var(--vscode-editor-background)] text-[var(--vscode-foreground)]">
        <Header />

        {allMobileCollapsed ? (
          /* All collapsed: stack 4 horizontal PanelBars vertically */
          <div className="flex flex-col flex-1 bg-[var(--vscode-editor-background)]">
            <div className="flex-none">
              <PromptsPanel panelBarOrientation="horizontal" />
            </div>
            <div className="flex-none">
              <OutputSection />
            </div>
            <div className="flex-none">
              <EditorSection />
            </div>
            <div className="flex-none">
              <SettingsPanel panelBarOrientation="horizontal" />
            </div>
          </div>
        ) : (
          /* At least one panel open: vertical resizable Group */
          <Group
            groupRef={mobileGroupRef}
            orientation="vertical"
            className="flex-1"
            id="flightpath-mobile-layout"
          >
            <Panel
              panelRef={mobilePromptsRef}
              defaultSize={mobileMountDefaults.current.prompts}
              collapsible
              collapsedSize={PANEL_COLLAPSED_SIZE_DEFAULT}
              minSize={PANEL_MIN_SIZE_SMALL}
              id="mobile-prompts-panel"
              onResize={() => {
                if (!mobileInitializedRef.current) return;
                const isCollapsed =
                  mobilePromptsRef.current?.isCollapsed() ?? false;
                if (!isCollapsed) {
                  const size = mobilePromptsRef.current?.getSize().asPercentage;
                  if (size != null) lastMobileSizes.current.prompts = size;
                }
                setPromptsCollapsed(isCollapsed);
              }}
            >
              <PromptsPanel panelBarOrientation="horizontal" />
            </Panel>

            <Separator className="h-0.5 bg-[var(--vscode-panel-border)] hover:bg-[var(--vscode-focusBorder)] cursor-row-resize transition-colors" />

            <Panel
              panelRef={mobileOutputRef}
              defaultSize={mobileMountDefaults.current.output}
              collapsible
              collapsedSize={PANEL_COLLAPSED_SIZE_DEFAULT}
              minSize={PANEL_MIN_SIZE_SMALL}
              id="mobile-output-panel"
              onResize={() => {
                if (!mobileInitializedRef.current) return;
                const isCollapsed =
                  mobileOutputRef.current?.isCollapsed() ?? false;
                if (!isCollapsed) {
                  const size = mobileOutputRef.current?.getSize().asPercentage;
                  if (size != null) lastMobileSizes.current.output = size;
                }
                setOutputCollapsed(isCollapsed);
              }}
            >
              <OutputSection />
            </Panel>

            <Separator className="h-0.5 bg-[var(--vscode-panel-border)] hover:bg-[var(--vscode-focusBorder)] cursor-row-resize transition-colors" />

            <Panel
              panelRef={mobileEditorRef}
              defaultSize={mobileMountDefaults.current.editor}
              collapsible
              collapsedSize={PANEL_COLLAPSED_SIZE_DEFAULT}
              minSize={PANEL_MIN_SIZE_SMALL}
              id="mobile-editor-panel"
              onResize={() => {
                if (!mobileInitializedRef.current) return;
                const isCollapsed =
                  mobileEditorRef.current?.isCollapsed() ?? false;
                if (!isCollapsed) {
                  const size = mobileEditorRef.current?.getSize().asPercentage;
                  if (size != null) lastMobileSizes.current.editor = size;
                }
                setEditorCollapsed(isCollapsed);
              }}
            >
              <EditorSection />
            </Panel>

            <Separator className="h-0.5 bg-[var(--vscode-panel-border)] hover:bg-[var(--vscode-focusBorder)] cursor-row-resize transition-colors" />

            <Panel
              panelRef={mobileSettingsRef}
              defaultSize={mobileMountDefaults.current.settings}
              collapsible
              collapsedSize={PANEL_COLLAPSED_SIZE_DEFAULT}
              minSize={PANEL_MIN_SIZE_SMALL}
              id="mobile-settings-panel"
              onResize={() => {
                if (!mobileInitializedRef.current) return;
                const isCollapsed =
                  mobileSettingsRef.current?.isCollapsed() ?? false;
                if (!isCollapsed) {
                  const size =
                    mobileSettingsRef.current?.getSize().asPercentage;
                  if (size != null) lastMobileSizes.current.settings = size;
                }
                setSettingsCollapsed(isCollapsed);
              }}
            >
              <SettingsPanel panelBarOrientation="horizontal" />
            </Panel>
          </Group>
        )}
      </div>
    );
  }

  // ============================================================================
  // DESKTOP LAYOUT — horizontal three-column layout (unchanged)
  // ============================================================================

  return (
    <div className="h-screen w-full flex flex-col bg-[var(--vscode-editor-background)] text-[var(--vscode-foreground)]">
      <Header />

      {/* Main layout: Prompts (left) | Output/Editor (center) | Settings (right) */}
      <Group
        orientation="horizontal"
        className="flex-1"
        id="flightpath-main-layout"
      >
        {/* Prompts Panel (Left - collapsible) */}
        <Panel
          panelRef={promptsRef}
          defaultSize={desktopMountDefaults.current.prompts}
          collapsible
          collapsedSize={PANEL_COLLAPSED_SIZE_SIDEBAR}
          minSize={PANEL_MIN_SIZE_SMALL}
          maxSize={PANEL_MAX_SIZE_SIDEBAR}
          id="prompts-panel"
          onResize={() => {
            const isCollapsed = promptsRef.current?.isCollapsed() ?? false;
            if (!isCollapsed) {
              const size = promptsRef.current?.getSize().asPercentage;
              if (size != null) lastDesktopSizes.current.prompts = size;
            }
            setPromptsCollapsed(isCollapsed);
          }}
        >
          <PromptsPanel />
        </Panel>

        <Separator className="w-0.5 bg-[var(--vscode-panel-border)] hover:bg-[var(--vscode-focusBorder)] cursor-col-resize transition-colors" />

        {/* Center content — Output (top) / Editor (bottom), both independently
            collapsible.  When both are collapsed the vertical Group unmounts and
            we render a plain flex stack of the two collapsed bars — the library
            can't keep two panels at collapsedSize (5 % each) without a third
            panel or maxSize tricks, both of which break imperative expand().
            When at least one panel is open the Group is active and the user can
            drag the separator freely. */}
        <Panel id="center-content">
          {(() => {
            const bothCollapsed = outputCollapsed && editorCollapsed;
            return bothCollapsed;
          })() ? (
            <div className="flex flex-col h-full bg-[var(--vscode-editor-background)]">
              <div className="flex-none">
                <OutputSection />
              </div>
              <div className="flex-none">
                <EditorSection />
              </div>
            </div>
          ) : (
            <Group
              groupRef={verticalGroupRef}
              orientation="vertical"
              className="h-full"
              id="flightpath-vertical-layout"
            >
              <Panel
                panelRef={outputRef}
                defaultSize={mountDefaultOutput.current}
                collapsible
                collapsedSize={PANEL_COLLAPSED_SIZE_DEFAULT}
                minSize={PANEL_MIN_SIZE_CENTER}
                id="output-panel"
                onResize={() => {
                  if (!initializedRef.current) {
                    return;
                  }
                  const outputCollapsed =
                    outputRef.current?.isCollapsed() ?? false;
                  const editorCollapsed =
                    editorRef.current?.isCollapsed() ?? false;
                  const currentSize = outputRef.current?.getSize().asPercentage;

                  if (
                    !outputCollapsed &&
                    !editorCollapsed &&
                    !isForcingResize.current
                  ) {
                    lastDesktopSizes.current.output =
                      currentSize ?? lastDesktopSizes.current.output;
                  }
                  setOutputCollapsed(outputCollapsed);
                }}
              >
                <OutputSection />
              </Panel>

              <Separator className="h-0.5 bg-[var(--vscode-panel-border)] hover:bg-[var(--vscode-focusBorder)] cursor-row-resize transition-colors" />

              <Panel
                panelRef={editorRef}
                defaultSize={mountDefaultEditor.current}
                collapsible
                collapsedSize={PANEL_COLLAPSED_SIZE_DEFAULT}
                minSize={PANEL_MIN_SIZE_CENTER}
                id="editor-panel"
                onResize={() => {
                  if (!initializedRef.current) {
                    return;
                  }
                  const editorCollapsed =
                    editorRef.current?.isCollapsed() ?? false;
                  const outputCollapsed =
                    outputRef.current?.isCollapsed() ?? false;
                  const currentSize = editorRef.current?.getSize().asPercentage;

                  if (
                    !editorCollapsed &&
                    !outputCollapsed &&
                    !isForcingResize.current
                  ) {
                    lastDesktopSizes.current.editor =
                      currentSize ?? lastDesktopSizes.current.editor;
                  } else if (isForcingResize.current) {
                  }
                  setEditorCollapsed(editorCollapsed);
                }}
              >
                <EditorSection />
              </Panel>
            </Group>
          )}
        </Panel>

        <Separator className="w-0.5 bg-[var(--vscode-panel-border)] hover:bg-[var(--vscode-focusBorder)] cursor-col-resize transition-colors" />

        {/* Settings Panel (Right - collapsible) */}
        <Panel
          panelRef={settingsRef}
          defaultSize={desktopMountDefaults.current.settings}
          collapsible
          collapsedSize={PANEL_COLLAPSED_SIZE_SIDEBAR}
          minSize={PANEL_MIN_SIZE_CENTER}
          maxSize={PANEL_MAX_SIZE_SIDEBAR}
          id="settings-panel"
          onResize={() => {
            const isCollapsed = settingsRef.current?.isCollapsed() ?? false;
            if (!isCollapsed) {
              const size = settingsRef.current?.getSize().asPercentage;
              if (size != null) lastDesktopSizes.current.settings = size;
            }
            setSettingsCollapsed(isCollapsed);
          }}
        >
          <SettingsPanel />
        </Panel>
      </Group>
    </div>
  );
}

export default App;
