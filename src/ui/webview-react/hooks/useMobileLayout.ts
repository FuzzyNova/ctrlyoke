/**
 * Mobile panel layout management hook.
 *
 * Manages refs, mount defaults, and sync effects for the single-column mobile
 * layout (vertically stacked prompts/output/editor/settings). Isolated from
 * desktop concerns so App.tsx can focus on rendering and cross-layout
 * transitions.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import type { PanelImperativeHandle, GroupImperativeHandle } from "react-resizable-panels";
import { WebviewLog } from "@utils/logger";
import { useUiStore } from "@store/uiStore";

interface MobileLayoutParams {
  isMobile: boolean;
  uiLayoutReady: boolean;
  promptsCollapsed: boolean;
  outputCollapsed: boolean;
  editorCollapsed: boolean;
  settingsCollapsed: boolean;
}

/**
 * Creates and syncs all refs, mount defaults, and effects for the mobile
 * single-column layout. Returns refs and mutable tracking objects consumed
 * by App.tsx for JSX binding and cross-layout transition logic.
 */
export function useMobileLayout({
  isMobile,
  uiLayoutReady,
  promptsCollapsed,
  outputCollapsed,
  editorCollapsed,
  settingsCollapsed,
}: MobileLayoutParams) {
  // Mobile panel refs for JSX panelRef / groupRef props
  const mobilePromptsRef = useRef<PanelImperativeHandle>(null);
  const mobileOutputRef = useRef<PanelImperativeHandle>(null);
  const mobileEditorRef = useRef<PanelImperativeHandle>(null);
  const mobileSettingsRef = useRef<PanelImperativeHandle>(null);
  const mobileGroupRef = useRef<GroupImperativeHandle>(null);

  // Gate: closed when all panels collapse (Group unmounts), opened after sync
  const mobileInitializedRef = useRef(false);

  // Size persistence — initialized from store so sizes survive VS Code restarts
  const lastMobileSizes = useRef({ ...useUiStore.getState().lastMobileSizes });

  // Stable mount defaults for each panel
  const mobileMountDefaults = useRef({
    prompts: String(lastMobileSizes.current.prompts),
    output: String(lastMobileSizes.current.output),
    editor: String(lastMobileSizes.current.editor),
    settings: String(lastMobileSizes.current.settings),
  });

  // Tracks all-collapsed → some-open transition; App.tsx updates this during
  // render to recompute mobileMountDefaults before the Group remounts.
  const mobileWasAllCollapsed = useRef(
    promptsCollapsed && outputCollapsed && editorCollapsed && settingsCollapsed
  );

  // Debug snapshot — reads panel state at call time (used in error paths).
  // Reads collapse state from store directly to avoid capturing stale closures.
  const getMobilePanelSnapshot = () => {
    const store = useUiStore.getState();
    return {
      isMobile,
      mobileInitialized: mobileInitializedRef.current,
      store: {
        promptsCollapsed: store.promptsCollapsed,
        outputCollapsed: store.outputCollapsed,
        editorCollapsed: store.editorCollapsed,
        settingsCollapsed: store.settingsCollapsed,
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
    };
  };

  // ──────────────────────────────────────────────────────────────────────────
  // MOBILE PANEL SYNC
  // ──────────────────────────────────────────────────────────────────────────

  // Store → mobile panel sync (before paint to avoid flash). Applies collapsed
  // panels first, then expands open ones to prevent layout gaps when a middle
  // panel collapses while neighbouring panels are already collapsed.
  useLayoutEffect(() => {
    if (!uiLayoutReady) return;
    if (!isMobile) return;

    if (promptsCollapsed) mobilePromptsRef.current?.collapse();
    if (outputCollapsed) mobileOutputRef.current?.collapse();
    if (editorCollapsed) mobileEditorRef.current?.collapse();
    if (settingsCollapsed) mobileSettingsRef.current?.collapse();

    if (!promptsCollapsed) mobilePromptsRef.current?.expand();
    if (!outputCollapsed) mobileOutputRef.current?.expand();
    if (!editorCollapsed) mobileEditorRef.current?.expand();
    if (!settingsCollapsed) mobileSettingsRef.current?.expand();

    // Guard: editor collapsed + output open + settings collapsed edge case.
    // The panel library can ignore the imperative collapse() in this layout
    // combination, leaving output at a wrong size. Apply fallback setLayout.
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
            before: { promptsSize, outputSize, editorSize, settingsSize, collapsedReference },
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

    // Guard: expanding editor (while output is open) can also be ignored by
    // the panel library. If store says editor should be open but panel is still
    // collapsed, force a layout that restores editor toward its previous size.
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

        const minOpenSize = 10;
        const desiredEditorSize = Math.max(minOpenSize, lastMobileSizes.current.editor);
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
  }, [
    uiLayoutReady,
    isMobile,
    promptsCollapsed,
    outputCollapsed,
    editorCollapsed,
    settingsCollapsed,
  ]);

  // Mobile gate management: closed when all panels collapse, opened after sync.
  useEffect(() => {
    if (!uiLayoutReady) return;
    if (!isMobile) return;
    const allCollapsed =
      promptsCollapsed && outputCollapsed && editorCollapsed && settingsCollapsed;
    mobileInitializedRef.current = !allCollapsed;
  }, [uiLayoutReady, isMobile, promptsCollapsed, outputCollapsed, editorCollapsed, settingsCollapsed]);

  return {
    // Panel / group refs
    mobilePromptsRef,
    mobileOutputRef,
    mobileEditorRef,
    mobileSettingsRef,
    mobileGroupRef,
    // Mount defaults (stable refs for JSX defaultSize props)
    mobileMountDefaults,
    // Gate and tracking refs (mutated by App.tsx during layout transitions)
    mobileInitializedRef,
    mobileWasAllCollapsed,
    // Size tracking
    lastMobileSizes,
    // Debug helper
    getMobilePanelSnapshot,
  };
}
