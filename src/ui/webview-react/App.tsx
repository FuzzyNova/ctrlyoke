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
import { useUiStore } from "@store/uiStore";
import { MESSAGE_TYPES } from "@/types/messages";
import {
  Header,
  PromptsPanel,
  OutputSection,
  EditorSection,
  SettingsPanel,
} from "./components/layout";

function App() {
  const vscode = useVsCodeApi();

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
  // Track last expanded sizes (restored when re-expanding, captured during drag)
  const lastOutputSize = useRef(60);
  const lastEditorSize = useRef(40);
  // Flag: true when Group just remounted from both-collapsed, false after forced resize
  const needsForcedResize = useRef(false);
  // Flag: true during forced resize operation to prevent onResize from saving wrong values
  const isForcingResize = useRef(false);

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
      ? "30px"
      : editorCollapsed
        ? "95"
        : String(lastOutputSize.current)
  );
  const mountDefaultEditor = useRef(
    editorCollapsed
      ? "30px"
      : outputCollapsed
        ? "95"
        : String(lastEditorSize.current)
  );

  // Message handlers with full implementations
  useMessageHandler();

  // Signal ready to extension
  useEffect(() => {
    vscode.postMessage({ type: MESSAGE_TYPES.READY });
  }, []);

  // Initial collapse sync — runs before first paint to avoid flash
  useLayoutEffect(() => {
    if (settingsCollapsed) settingsRef.current?.collapse();
    if (promptsCollapsed) promptsRef.current?.collapse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        const outputSize = Math.round(lastOutputSize.current);
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
  }, [outputCollapsed, editorCollapsed]);

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
  }, [outputCollapsed, editorCollapsed]);

  // Update mount defaults only when the Group is about to remount
  // (both-collapsed → one-open).  While the Group stays alive defaultSize
  // must remain constant so the library does not re-initialise and clobber
  // imperative collapse()/expand() calls.
  {
    const bothCollapsed = outputCollapsed && editorCollapsed;
    if (wasBothCollapsed.current && !bothCollapsed) {
      mountDefaultOutput.current = outputCollapsed
        ? "30px"
        : editorCollapsed
          ? "95"
          : String(lastOutputSize.current);
      mountDefaultEditor.current = editorCollapsed
        ? "30px"
        : outputCollapsed
          ? "95"
          : String(lastEditorSize.current);
      // Group is remounting - next both-open transition needs forced resize
      needsForcedResize.current = true;
    }
    wasBothCollapsed.current = bothCollapsed;
  }

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
          defaultSize="20"
          collapsible
          collapsedSize="32px"
          minSize="10"
          maxSize="40"
          id="prompts-panel"
          onResize={() => {
            setPromptsCollapsed(promptsRef.current?.isCollapsed() ?? false);
          }}
        >
          <PromptsPanel />
        </Panel>

        <Separator className="w-1 bg-[var(--vscode-panel-border)] hover:bg-[var(--vscode-focusBorder)] cursor-col-resize transition-colors" />

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
                collapsedSize="30px"
                minSize="15"
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
                    lastOutputSize.current =
                      currentSize ?? lastOutputSize.current;
                  }
                  setOutputCollapsed(outputCollapsed);
                }}
              >
                <OutputSection />
              </Panel>

              <Separator className="h-1 bg-[var(--vscode-panel-border)] hover:bg-[var(--vscode-focusBorder)] cursor-row-resize transition-colors" />

              <Panel
                panelRef={editorRef}
                defaultSize={mountDefaultEditor.current}
                collapsible
                collapsedSize="30px"
                minSize="15"
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
                    lastEditorSize.current =
                      currentSize ?? lastEditorSize.current;
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

        <Separator className="w-1 bg-[var(--vscode-panel-border)] hover:bg-[var(--vscode-focusBorder)] cursor-col-resize transition-colors" />

        {/* Settings Panel (Right - collapsible) */}
        <Panel
          panelRef={settingsRef}
          defaultSize="20"
          collapsible
          collapsedSize="32px"
          minSize="15"
          maxSize="40"
          id="settings-panel"
          onResize={() => {
            setSettingsCollapsed(settingsRef.current?.isCollapsed() ?? false);
          }}
        >
          <SettingsPanel />
        </Panel>
      </Group>
    </div>
  );
}

export default App;
