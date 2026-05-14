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
import { centerPanelMountDefaults, syncCollapsiblePanel } from "@utils/panelSync";
import { DEFAULT_MOBILE_SIZES } from "../constants";

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

  // Size persistence — initialized from store so sizes survive VS Code restarts.
  // Migrate legacy editor values: pre-pixel-based storage used percentages (< 100),
  // so any stored value < 100 is treated as a stale percentage and reset to the default px.
  const storedMobileSizes = useUiStore.getState().lastMobileSizes;
  const lastMobileSizes = useRef({
    ...storedMobileSizes,
    editor:
      storedMobileSizes.editor >= 100
        ? storedMobileSizes.editor
        : DEFAULT_MOBILE_SIZES.editor,
  });

  // Stable mount defaults for each center panel.
  // Collapsed panels mount at "30px"; the open sibling gets undefined (flexGrow:1)
  // so ne(group) measures the real container height and collapsedSize% is correct.
  const mobileMountDefaults = useRef<{
    output: string | undefined;
    editor: string | undefined;
  }>(
    centerPanelMountDefaults(outputCollapsed, editorCollapsed, lastMobileSizes.current.editor)
  );

  // Tracks all-collapsed → some-open transition; App.tsx updates this during
  // render to recompute mobileMountDefaults before the Group remounts.
  const mobileWasAllCollapsed = useRef(outputCollapsed && editorCollapsed);

  // ──────────────────────────────────────────────────────────────────────────
  // MOBILE PANEL SYNC
  // ──────────────────────────────────────────────────────────────────────────

  // Store → mobile panel sync (before paint to avoid flash).
  useLayoutEffect(() => {
    if (!uiLayoutReady) return;
    if (!isMobile) return;

    syncCollapsiblePanel(mobileOutputRef, outputCollapsed);
    syncCollapsiblePanel(mobileEditorRef, editorCollapsed);
  }, [uiLayoutReady, isMobile, outputCollapsed, editorCollapsed]);

  // Mobile gate management: closed when both panels collapse, opened after sync.
  useEffect(() => {
    if (!uiLayoutReady) return;
    if (!isMobile) return;
    mobileInitializedRef.current = !(outputCollapsed && editorCollapsed);
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
  };
}
