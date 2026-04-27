/**
 * Mobile panel layout management hook.
 *
 * Manages refs, mount defaults, and sync effects for the mobile layout center
 * panels (output + editor). Prompts and settings are now drawers/overlays
 * controlled by uiStore mobile state, not react-resizable-panels.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import type {
  PanelImperativeHandle,
  GroupImperativeHandle,
} from "react-resizable-panels";
import { useUiStore } from "@store/uiStore";
import { syncCollapsiblePanel } from "@utils/panelSync";
import { readPanelSnapshot } from "@utils/panelSnapshot";
import { WebviewLog } from "@utils/logger";

interface MobileLayoutParams {
  isMobile: boolean;
  uiLayoutReady: boolean;
  outputCollapsed: boolean;
  editorCollapsed: boolean;
}

/**
 * Creates and syncs all refs, mount defaults, and effects for the mobile
 * center layout (output + editor vertical split). Returns refs and mutable
 * tracking objects consumed by App.tsx for JSX binding.
 */
export function useMobileLayout({
  isMobile,
  uiLayoutReady,
  outputCollapsed,
  editorCollapsed,
}: MobileLayoutParams) {
  // Mobile panel refs for JSX panelRef / groupRef props
  const mobileOutputRef = useRef<PanelImperativeHandle>(null);
  const mobileEditorRef = useRef<PanelImperativeHandle>(null);
  const mobileCenterGroupRef = useRef<GroupImperativeHandle>(null);

  // Gate: closed when both panels collapse (Group unmounts), opened after sync
  const mobileInitializedRef = useRef(false);

  // Size persistence — initialized from store so sizes survive VS Code restarts
  const lastMobileSizes = useRef({ ...useUiStore.getState().lastMobileSizes });

  // Stable mount defaults for each center panel
  const mobileMountDefaults = useRef({
    output: String(lastMobileSizes.current.output),
    editor: String(lastMobileSizes.current.editor),
  });

  // Tracks all-collapsed → some-open transition; App.tsx updates this during
  // render to recompute mobileMountDefaults before the Group remounts.
  const mobileWasAllCollapsed = useRef(outputCollapsed && editorCollapsed);

  // Debug snapshot — reads panel state at call time (used in error paths).
  const getMobilePanelSnapshot = () => {
    const store = useUiStore.getState();
    const output = readPanelSnapshot(mobileOutputRef, "mobile-output");
    const editor = readPanelSnapshot(mobileEditorRef, "mobile-editor");

    return {
      isMobile,
      mobileInitialized: mobileInitializedRef.current,
      store: {
        outputCollapsed: store.outputCollapsed,
        editorCollapsed: store.editorCollapsed,
        mobilePromptsOpen: store.mobilePromptsOpen,
        mobilePromptsMode: store.mobilePromptsMode,
        mobileSettingsOpen: store.mobileSettingsOpen,
      },
      panelState: {
        output: {
          collapsed: output.collapsed,
          size: output.sizePct,
        },
        editor: {
          collapsed: editor.collapsed,
          size: editor.sizePct,
        },
      },
      lastMobileSizes: { ...lastMobileSizes.current },
      mountDefaults: { ...mobileMountDefaults.current },
    };
  };

  // ──────────────────────────────────────────────────────────────────────────
  // MOBILE PANEL SYNC
  // ──────────────────────────────────────────────────────────────────────────

  // Store → mobile panel sync (before paint to avoid flash).
  useLayoutEffect(() => {
    if (!uiLayoutReady) return;
    if (!isMobile) return;

    syncCollapsiblePanel(mobileOutputRef, outputCollapsed);
    syncCollapsiblePanel(mobileEditorRef, editorCollapsed);
    WebviewLog.debug("[LAYOUT][mobile][center-sync]", {
      outputCollapsed,
      editorCollapsed,
      snapshot: getMobilePanelSnapshot(),
    });
  }, [uiLayoutReady, isMobile, outputCollapsed, editorCollapsed]);

  // Mobile gate management: closed when both panels collapse, opened after sync.
  useEffect(() => {
    if (!uiLayoutReady) return;
    if (!isMobile) return;
    mobileInitializedRef.current = !(outputCollapsed && editorCollapsed);
    WebviewLog.debug("[LAYOUT][mobile][center-gate]", {
      outputCollapsed,
      editorCollapsed,
      initialized: mobileInitializedRef.current,
      snapshot: getMobilePanelSnapshot(),
    });
  }, [uiLayoutReady, isMobile, outputCollapsed, editorCollapsed]);

  return {
    // Panel / group refs
    mobileOutputRef,
    mobileEditorRef,
    mobileCenterGroupRef,
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
