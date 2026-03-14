import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Panel,
  Group,
  Separator,
  PanelImperativeHandle,
  GroupImperativeHandle,
} from "react-resizable-panels";
import { useMessageHandler } from "@hooks/useMessageHandler";
import { useUndoRedoKeyHandler } from "@hooks/useUndoRedoKeyHandler";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { WebviewLog } from "@utils/logger";
import { useIsMobile } from "@hooks/useMediaQuery";
import { useUiStore } from "@store/uiStore";
import { MESSAGE_TYPES } from "@/types/messages";
// uiStore uses vscode.getState()/setState() as its persist storage (see uiStore.ts),
// so collapse states are restored synchronously before the first render.
import {
  PANEL_COLLAPSED_SIZE_DEFAULT,
  PANEL_COLLAPSED_SIZE_SIDEBAR,
  PANEL_EXPANDED_SIZE_SINGLE,
  PANEL_MIN_SIZE_SMALL,
  PANEL_MIN_SIZE_CENTER,
  PANEL_MAX_SIZE_SIDEBAR,
  PANEL_KEYS,
  SEPARATOR_HORIZONTAL,
  SEPARATOR_VERTICAL,
} from "./constants";
import {
  Header,
  PromptsPanel,
  OutputSection,
  EditorSection,
  SettingsPanel,
  CenterContentArea,
} from "./components/layout";

function App() {
  const vscode = useVsCodeApi();
  const isMobile = useIsMobile();
  // uiStore hydrates synchronously from vscode.getState() on store creation,
  // so the persisted collapse state is available on the first render.
  const [uiLayoutReady] = useState(true);

  // Panel imperative refs for programmatic collapse/expand
  const settingsRef = useRef<PanelImperativeHandle>(null);
  const promptsRef = useRef<PanelImperativeHandle>(null);
  const outputRef = useRef<PanelImperativeHandle>(null);
  const editorRef = useRef<PanelImperativeHandle>(null);
  // Vertical group ref for setLayout() API
  const verticalGroupRef = useRef<GroupImperativeHandle>(null);
  // Horizontal group ref for setLayout() API
  const horizontalGroupRef = useRef<GroupImperativeHandle>(null);
  // Gates onResize until useLayoutEffect has applied the persisted
  // collapsed/expanded state.  Reset to false whenever both panels are collapsed
  // (the vertical Group unmounts); the next mount re-gates until the first
  // useLayoutEffect re-syncs.
  const initializedRef = useRef(false);
  // Gate for horizontal group (prompts/settings) panels to prevent onResize from
  // updating state during mount before collapse/expand imperatives are applied
  const horizontalInitializedRef = useRef(false);
  // Track last expanded sizes per layout — restored when re-expanding, captured
  // during drag.  Grouped by layout to keep the 8 values organized.
  // Initialized from persisted store values so sizes survive VS Code restarts.
  const lastDesktopSizes = useRef({
    ...useUiStore.getState().lastDesktopSizes,
  });
  const lastMobileSizes = useRef({
    ...useUiStore.getState().lastMobileSizes,
  });
  // Flag: true when Group just remounted from both-collapsed, false after forced resize
  const needsForcedResize = useRef(false);
  // Flag: true during forced resize operation to prevent onResize from saving wrong values
  const isForcingResize = useRef(false);
  // Desktop mount defaults — used when desktop Group remounts (e.g. mobile → desktop).
  // Initialized from persisted sizes so the layout is restored on VS Code restart.
  const desktopMountDefaults = useRef({
    prompts: String(lastDesktopSizes.current.prompts),
    settings: String(lastDesktopSizes.current.settings),
  });
  const wasMobileRef = useRef(isMobile);
  // Gates mobile onResize until useLayoutEffect has synced persisted state
  const mobileInitializedRef = useRef(false);
  // Mobile mount defaults — initialized from persisted sizes; recomputed on
  // layout transition and on all-collapsed → some-open transition within mobile.
  const mobileMountDefaults = useRef({
    prompts: String(lastMobileSizes.current.prompts),
    output: String(lastMobileSizes.current.output),
    editor: String(lastMobileSizes.current.editor),
    settings: String(lastMobileSizes.current.settings),
  });

  const getMobilePanelSnapshot = () => ({
    isMobile,
    mobileInitialized: mobileInitializedRef.current,
    store: {
      promptsCollapsed,
      outputCollapsed,
      editorCollapsed,
      settingsCollapsed,
    },
    panelState: {
      prompts: {
        collapsed: mobilePromptsRef.current?.isCollapsed() ?? null,
        size: mobilePromptsRef.current?.getSize().asPercentage ?? null,
      },
      output: {
        collapsed: mobileOutputRef.current?.isCollapsed() ?? null,
        size: mobileOutputRef.current?.getSize().asPercentage ?? null,
      },
      editor: {
        collapsed: mobileEditorRef.current?.isCollapsed() ?? null,
        size: mobileEditorRef.current?.getSize().asPercentage ?? null,
      },
      settings: {
        collapsed: mobileSettingsRef.current?.isCollapsed() ?? null,
        size: mobileSettingsRef.current?.getSize().asPercentage ?? null,
      },
    },
    lastMobileSizes: { ...lastMobileSizes.current },
    mountDefaults: { ...mobileMountDefaults.current },
  });

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
  useUndoRedoKeyHandler();

  // Signal ready to extension
  useEffect(() => {
    vscode.postMessage({ type: MESSAGE_TYPES.READY });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // vscode is a stable singleton — never changes

  // Sync prompts/settings collapse state before paint.
  // Runs on initial desktop mount and when returning from mobile layout
  // (desktop panels remount fresh, ongoing useEffects won't re-run unless
  // their specific collapse state changed during mobile).
  // NOTE: desktopMountDefaults are set to PANEL_COLLAPSED_SIZE_SIDEBAR for
  // collapsed panels, so they mount at the correct visual size — collapse()
  // just sets the library's internal flag without needing to resize.
  useLayoutEffect(() => {
    if (!uiLayoutReady) return;
    if (isMobile) return;
    if (settingsCollapsed) settingsRef.current?.collapse();
    else settingsRef.current?.expand();
    if (promptsCollapsed) promptsRef.current?.collapse();
    else promptsRef.current?.expand();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile, uiLayoutReady]);

  // Horizontal gate management: open after mount onResize events have settled.
  // useEffect runs after child effects (including Panel mount onResize), so by
  // the time this fires, all spurious mount events have been gated.
  useEffect(() => {
    if (!uiLayoutReady) return;
    if (!isMobile) {
      horizontalInitializedRef.current = true;
    }
  }, [isMobile, uiLayoutReady]);

  // Ongoing store → panel sync
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

  // Sync store → panels imperatively.  Runs before paint so there is no visible
  // flash of the default 60/40 split before the persisted collapsed state is
  // applied.  Does NOT open the onResize gate — that is done in the useEffect
  // below, which runs after all child effects (including the Panel mount
  // onResize events) have fired.
  useLayoutEffect(() => {
    if (!uiLayoutReady) return;
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
          WebviewLog.error(
            `[LAYOUT] setLayout() failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      } else {
        WebviewLog.error("[LAYOUT] verticalGroupRef.current is null!");
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
  }, [outputCollapsed, editorCollapsed, isMobile, uiLayoutReady]);

  // Gate management: closed when both panels are collapsed (the Group
  // unmounts; next mount needs re-sync before onResize is trusted).  Opened
  // in useEffect (not useLayoutEffect) so that the Panel mount onResize
  // events — which fire in child useEffects — are still gated when they run.
  useEffect(() => {
    if (!uiLayoutReady) return;
    if (outputCollapsed && editorCollapsed) {
      initializedRef.current = false;
      // Clear forced resize flag when both collapse
      if (needsForcedResize.current) {
        needsForcedResize.current = false;
      }
    } else {
      initializedRef.current = true;
    }
  }, [outputCollapsed, editorCollapsed, isMobile, uiLayoutReady]);

  // Manage layout transitions between desktop and mobile.
  // Collapsed state is global (shared between layouts) — switching layouts
  // preserves whatever panels are currently collapsed/expanded.
  // Sizes are layout-specific (lastDesktopSizes / lastMobileSizes).
  {
    const isTransitioningToMobile = !wasMobileRef.current && isMobile;
    const isTransitioningToDesktop = wasMobileRef.current && !isMobile;

    if (isTransitioningToMobile) {
      // Recalculate mobile mount defaults based on current collapsed state
      // so panels mount at the correct size before collapse() is called.
      const collapsed = {
        prompts: promptsCollapsed,
        output: outputCollapsed,
        editor: editorCollapsed,
        settings: settingsCollapsed,
      };
      const keys = PANEL_KEYS;
      const openKeys = keys.filter((k) => !collapsed[k]);

      if (openKeys.length > 0) {
        const totalOpen =
          openKeys.reduce((s, k) => s + lastMobileSizes.current[k], 0) || 1;
        for (const k of keys) {
          mobileMountDefaults.current[k] = collapsed[k]
            ? PANEL_COLLAPSED_SIZE_DEFAULT
            : String(
                Math.round((lastMobileSizes.current[k] / totalOpen) * 100)
              );
        }
      }

      // Close gates so mount-time onResize events are ignored
      horizontalInitializedRef.current = false;
      mobileInitializedRef.current = false;
    }

    if (isTransitioningToDesktop) {
      // Horizontal group panels — mount collapsed panels at their collapsed
      // pixel size so collapse() in useLayoutEffect only sets the flag
      // without needing to resize from a large percentage.
      desktopMountDefaults.current.prompts = promptsCollapsed
        ? PANEL_COLLAPSED_SIZE_SIDEBAR
        : String(lastDesktopSizes.current.prompts);
      desktopMountDefaults.current.settings = settingsCollapsed
        ? PANEL_COLLAPSED_SIZE_SIDEBAR
        : String(lastDesktopSizes.current.settings);

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
      // Close gates so mount-time onResize events are ignored
      initializedRef.current = false;
      horizontalInitializedRef.current = false;
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
  // Tracks all-collapsed → some-open transition for mobile Group remount
  const mobileWasAllCollapsed = useRef(
    promptsCollapsed && outputCollapsed && editorCollapsed && settingsCollapsed
  );

  // Store → mobile panel sync (before paint to avoid flash)
  useLayoutEffect(() => {
    if (!uiLayoutReady) return;
    if (!isMobile) return;

    // Apply collapsed state first, then expand open panels. In mobile stacked
    // layout this prevents "collapse in place" gaps when a middle panel
    // collapses while neighboring panels are already collapsed.
    if (promptsCollapsed) mobilePromptsRef.current?.collapse();
    if (outputCollapsed) mobileOutputRef.current?.collapse();
    if (editorCollapsed) mobileEditorRef.current?.collapse();
    if (settingsCollapsed) mobileSettingsRef.current?.collapse();

    if (!promptsCollapsed) mobilePromptsRef.current?.expand();
    if (!outputCollapsed) mobileOutputRef.current?.expand();
    if (!editorCollapsed) mobileEditorRef.current?.expand();
    if (!settingsCollapsed) mobileSettingsRef.current?.expand();

    // Guard against a react-resizable-panels edge case in mobile where
    // collapsing editor (with output open and settings collapsed) can leave
    // output at its previous size until the next interaction.
    if (editorCollapsed && !outputCollapsed && settingsCollapsed) {
      WebviewLog.warn(
        "[MOBILE][SYNC] editor collapsed + output open + settings collapsed; forcing output expand",
        getMobilePanelSnapshot()
      );
      mobileOutputRef.current?.expand();

      const editorActuallyCollapsed =
        mobileEditorRef.current?.isCollapsed() ?? false;

      if (!editorActuallyCollapsed && mobileGroupRef.current) {
        const promptsSize =
          mobilePromptsRef.current?.getSize().asPercentage ??
          lastMobileSizes.current.prompts;
        const outputSize =
          mobileOutputRef.current?.getSize().asPercentage ??
          lastMobileSizes.current.output;
        const editorSize =
          mobileEditorRef.current?.getSize().asPercentage ??
          lastMobileSizes.current.editor;
        const settingsSize =
          mobileSettingsRef.current?.getSize().asPercentage ??
          lastMobileSizes.current.settings;

        const collapsedReference =
          (promptsCollapsed ? promptsSize : undefined) ??
          (settingsCollapsed ? settingsSize : undefined) ??
          2.5;
        const targetEditorSize = Math.max(0.5, collapsedReference);
        const reclaimed = Math.max(0, editorSize - targetEditorSize);
        const nextOutputSize = outputSize + reclaimed;

        const fallbackLayout = {
          "mobile-prompts-panel": promptsSize,
          "mobile-output-panel": nextOutputSize,
          "mobile-editor-panel": targetEditorSize,
          "mobile-settings-panel": settingsSize,
        };

        WebviewLog.warn(
          "[MOBILE][SYNC] editor still not collapsed after imperative collapse(); applying fallback setLayout",
          {
            before: {
              promptsSize,
              outputSize,
              editorSize,
              settingsSize,
              collapsedReference,
            },
            fallbackLayout,
          }
        );

        try {
          mobileGroupRef.current.setLayout(fallbackLayout);
        } catch (error) {
          WebviewLog.error(
            `[MOBILE][SYNC] fallback setLayout failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }

    // Symmetric guard: expanding editor (while output is open) can also be
    // ignored by the panel library. If store says editor should be open but
    // panel is still collapsed, force a layout that restores editor toward its
    // previous open size.
    if (!editorCollapsed && !outputCollapsed) {
      const editorActuallyCollapsed =
        mobileEditorRef.current?.isCollapsed() ?? false;

      if (editorActuallyCollapsed && mobileGroupRef.current) {
        const promptsSize =
          mobilePromptsRef.current?.getSize().asPercentage ??
          (promptsCollapsed ? 2.5 : lastMobileSizes.current.prompts);
        const settingsSize =
          mobileSettingsRef.current?.getSize().asPercentage ??
          (settingsCollapsed ? 2.5 : lastMobileSizes.current.settings);
        const reserved = promptsSize + settingsSize;
        const available = Math.max(1, 100 - reserved);

        const minOpenSize = Number.parseFloat(PANEL_MIN_SIZE_SMALL) || 10;
        const desiredEditorSize = Math.max(
          minOpenSize,
          lastMobileSizes.current.editor
        );
        const targetEditorSize = Math.min(desiredEditorSize, available - 1);
        const targetOutputSize = Math.max(1, available - targetEditorSize);

        const fallbackLayout = {
          "mobile-prompts-panel": promptsSize,
          "mobile-output-panel": targetOutputSize,
          "mobile-editor-panel": targetEditorSize,
          "mobile-settings-panel": settingsSize,
        };

        WebviewLog.warn(
          "[MOBILE][SYNC] editor still collapsed after imperative expand(); applying fallback setLayout",
          {
            before: {
              promptsSize,
              settingsSize,
              available,
              desiredEditorSize,
              lastMobileSizes: { ...lastMobileSizes.current },
            },
            fallbackLayout,
          }
        );

        try {
          mobileGroupRef.current.setLayout(fallbackLayout);
        } catch (error) {
          WebviewLog.error(
            `[MOBILE][SYNC] expand fallback setLayout failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    uiLayoutReady,
    isMobile,
    promptsCollapsed,
    outputCollapsed,
    editorCollapsed,
    settingsCollapsed,
    // getMobilePanelSnapshot is intentionally omitted — it only reads refs and
    // its logged state is already covered by the deps above
  ]);

  // Mobile gate management: close when all collapsed, open after sync
  useEffect(() => {
    if (!uiLayoutReady) return;
    if (!isMobile) return;
    const allCollapsed =
      promptsCollapsed &&
      outputCollapsed &&
      editorCollapsed &&
      settingsCollapsed;
    mobileInitializedRef.current = !allCollapsed;
  }, [
    uiLayoutReady,
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
      const keys = PANEL_KEYS;
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
      <div className="h-screen w-full flex flex-col bg-editor-bg text-foreground border-l border-r">
        <Header />

        {allMobileCollapsed ? (
          /* All collapsed: stack 4 horizontal PanelBars vertically */
          <div className="flex flex-col flex-1 relative bg-editor-bg">
            {/* Background logo when all panels collapsed */}
            {(() => {
              const logoUrl = document.body.getAttribute("data-logo-uri") || "";
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
                <PromptsPanel panelBarOrientation="horizontal" allowUndoActions />
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
                if (!mobileInitializedRef.current || !uiLayoutReady) return;
                const isCollapsed =
                  mobilePromptsRef.current?.isCollapsed() ?? false;
                const size =
                  mobilePromptsRef.current?.getSize().asPercentage ?? null;
                if (!isCollapsed && size != null) {
                  lastMobileSizes.current.prompts = size;
                  useUiStore.getState().setLastMobileSizes({ prompts: size });
                }
                if (isCollapsed !== promptsCollapsed) {
                  setPromptsCollapsed(isCollapsed);
                }
              }}
            >
              <PromptsPanel panelBarOrientation="horizontal" allowUndoActions />
            </Panel>

            <Separator className={SEPARATOR_HORIZONTAL} />

            <Panel
              panelRef={mobileOutputRef}
              defaultSize={mobileMountDefaults.current.output}
              collapsible
              collapsedSize={PANEL_COLLAPSED_SIZE_DEFAULT}
              minSize={PANEL_MIN_SIZE_SMALL}
              id="mobile-output-panel"
              onResize={() => {
                if (!mobileInitializedRef.current || !uiLayoutReady) return;
                const isCollapsed =
                  mobileOutputRef.current?.isCollapsed() ?? false;
                const size =
                  mobileOutputRef.current?.getSize().asPercentage ?? null;
                if (!isCollapsed && size != null) {
                  lastMobileSizes.current.output = size;
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
              panelRef={mobileEditorRef}
              defaultSize={mobileMountDefaults.current.editor}
              collapsible
              collapsedSize={PANEL_COLLAPSED_SIZE_DEFAULT}
              minSize={PANEL_MIN_SIZE_SMALL}
              id="mobile-editor-panel"
              onResize={() => {
                if (!mobileInitializedRef.current || !uiLayoutReady) return;
                const isCollapsed =
                  mobileEditorRef.current?.isCollapsed() ?? false;
                const size =
                  mobileEditorRef.current?.getSize().asPercentage ?? null;
                if (!isCollapsed && size != null) {
                  lastMobileSizes.current.editor = size;
                  useUiStore.getState().setLastMobileSizes({ editor: size });
                }
                if (isCollapsed !== editorCollapsed) {
                  setEditorCollapsed(isCollapsed);
                }
              }}
            >
              <EditorSection />
            </Panel>

            <Separator className={SEPARATOR_HORIZONTAL} />

            <Panel
              panelRef={mobileSettingsRef}
              defaultSize={mobileMountDefaults.current.settings}
              collapsible
              collapsedSize={PANEL_COLLAPSED_SIZE_DEFAULT}
              minSize={PANEL_MIN_SIZE_SMALL}
              id="mobile-settings-panel"
              onResize={() => {
                if (!mobileInitializedRef.current || !uiLayoutReady) return;
                const isCollapsed =
                  mobileSettingsRef.current?.isCollapsed() ?? false;
                const size =
                  mobileSettingsRef.current?.getSize().asPercentage ?? null;
                if (!isCollapsed && size != null) {
                  lastMobileSizes.current.settings = size;
                  useUiStore.getState().setLastMobileSizes({ settings: size });
                }
                if (isCollapsed !== settingsCollapsed) {
                  setSettingsCollapsed(isCollapsed);
                }
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
    <div className="h-screen w-full flex flex-col bg-editor-bg text-foreground">
      <Header />

      {/* Main layout: Prompts (left) | Output/Editor (center) | Settings (right) */}
      <Group
        groupRef={horizontalGroupRef}
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
            if (!horizontalInitializedRef.current || !uiLayoutReady) return;
            const isCollapsed = promptsRef.current?.isCollapsed() ?? false;
            if (!isCollapsed) {
              const size = promptsRef.current?.getSize().asPercentage;
              if (size != null) {
                lastDesktopSizes.current.prompts = size;
                useUiStore.getState().setLastDesktopSizes({ prompts: size });
              }
            }
            if (isCollapsed !== promptsCollapsed) {
              setPromptsCollapsed(isCollapsed);
            }
          }}
        >
          <PromptsPanel allowUndoActions />
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
          {(() => {
            const bothCollapsed = outputCollapsed && editorCollapsed;
            return bothCollapsed;
          })() ? (
            <CenterContentArea />
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
                  if (!initializedRef.current || !uiLayoutReady) {
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
                    const newSize =
                      currentSize ?? lastDesktopSizes.current.output;
                    lastDesktopSizes.current.output = newSize;
                    useUiStore
                      .getState()
                      .setLastDesktopSizes({ output: newSize });
                  }
                  setOutputCollapsed(outputCollapsed);
                }}
              >
                <OutputSection />
              </Panel>

              <Separator className={SEPARATOR_HORIZONTAL} />

              <Panel
                panelRef={editorRef}
                defaultSize={mountDefaultEditor.current}
                collapsible
                collapsedSize={PANEL_COLLAPSED_SIZE_DEFAULT}
                minSize={PANEL_MIN_SIZE_CENTER}
                id="editor-panel"
                onResize={() => {
                  if (!initializedRef.current || !uiLayoutReady) {
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
                    const newSize =
                      currentSize ?? lastDesktopSizes.current.editor;
                    lastDesktopSizes.current.editor = newSize;
                    useUiStore
                      .getState()
                      .setLastDesktopSizes({ editor: newSize });
                  }
                  setEditorCollapsed(editorCollapsed);
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
          panelRef={settingsRef}
          defaultSize={desktopMountDefaults.current.settings}
          collapsible
          collapsedSize={PANEL_COLLAPSED_SIZE_SIDEBAR}
          minSize={PANEL_MIN_SIZE_CENTER}
          maxSize={PANEL_MAX_SIZE_SIDEBAR}
          id="settings-panel"
          onResize={() => {
            if (!horizontalInitializedRef.current || !uiLayoutReady) return;
            const isCollapsed = settingsRef.current?.isCollapsed() ?? false;
            if (!isCollapsed) {
              const size = settingsRef.current?.getSize().asPercentage;
              if (size != null) {
                lastDesktopSizes.current.settings = size;
                useUiStore.getState().setLastDesktopSizes({ settings: size });
              }
            }
            if (isCollapsed !== settingsCollapsed) {
              setSettingsCollapsed(isCollapsed);
            }
          }}
        >
          <SettingsPanel />
        </Panel>
      </Group>
    </div>
  );
}

export default App;
