/**
 * Mobile panel layout management hook.
 *
 * Manages refs, mount defaults, and sync effects for the mobile layout center
 * panels (output + editor). Prompts and settings are now drawers/overlays
 * controlled by uiStore mobile state, not react-resizable-panels.
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type {
  PanelImperativeHandle,
  GroupImperativeHandle,
} from "react-resizable-panels";
import { useUiStore } from "@store/uiStore";
import {
  centerPanelMountDefaults,
  syncCollapsiblePanel,
} from "@utils/panelSync";
import { isEditableElement } from "@utils/domFocus";
import { triggerPanelAnimation } from "@utils/panelAnimation";
import { useMediaQuery } from "@hooks/useMediaQuery";

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
  const lastMobileSizes = useRef({
    ...useUiStore.getState().lastMobileSizes,
  });

  // Stable mount defaults for each center panel.
  // Collapsed panels mount at "30px"; the open sibling gets undefined (flexGrow:1)
  // so ne(group) measures the real container height and collapsedSize% is correct.
  const mobileMountDefaults = useRef<{
    output: string | undefined;
    editor: string | undefined;
  }>(
    centerPanelMountDefaults(
      outputCollapsed,
      editorCollapsed,
      lastMobileSizes.current.editor
    )
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

  // ──────────────────────────────────────────────────────────────────────────
  // KEYBOARD-AWARE COLLAPSE: protect the output panel from the mobile keyboard
  // ──────────────────────────────────────────────────────────────────────────
  // The editor panel mounts with groupResizeBehavior="preserve-pixel-size", so
  // when the mobile keyboard shrinks the visual viewport, 100% of that
  // shrinkage lands on the output panel (the Group's only
  // preserve-relative-size panel) — none on the editor. That's the desired
  // tradeoff while typing in CodeMirror (editor stays put, output yields).
  // It's wrong when the focused, keyboard-triggering element lives INSIDE the
  // output panel itself (OutputFindBar's input, TerminalView's xterm
  // textarea): the output panel shrinks below PANEL_MIN_SIZE_CENTER and
  // auto-collapses, hiding the very element that had focus — which blurs it,
  // dismisses the keyboard, and leaves the panel stuck collapsed (collapse is
  // sticky; nothing re-expands it automatically).
  //
  // Fix: when focus lands on an editable element inside #output-section,
  // proactively collapse the editor panel instead, so the output panel keeps
  // its share of the viewport. Armed on `focusin` (not the later
  // keyboard-adjusted resize) so the collapse commits via the store-sync
  // effect above before the keyboard actually opens — the same timing
  // exploited by the iOS visual-viewport root pin in App.tsx.
  //
  // `isMobile` alone is just the (max-width: 639px) breakpoint (see
  // useMediaQuery.ts) — it also flips on a desktop browser window resized
  // narrow, where there is no on-screen keyboard and this collapse would be
  // pure regression. Gate on touch capability too (same
  // pointer:coarse + maxTouchPoints combo used by useMobileTerminalBar.ts) so
  // this only fires on devices that actually raise a virtual keyboard.
  const isCoarsePointer = useMediaQuery("(pointer: coarse)");
  const hasTouchCapability = useMemo(
    () => typeof navigator !== "undefined" && navigator.maxTouchPoints > 0,
    []
  );
  const forcedEditorCollapseRef = useRef(false);
  useEffect(() => {
    if (!isMobile || !isCoarsePointer || !hasTouchCapability) return;

    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !isEditableElement(target)) {
        return;
      }
      if (!target.closest("#output-section")) return;

      const state = useUiStore.getState();
      if (state.outputCollapsed || state.editorCollapsed) return;

      forcedEditorCollapseRef.current = true;
      triggerPanelAnimation();
      state.setEditorCollapsed(true);
    };

    const restoreIfForced = () => {
      if (!forcedEditorCollapseRef.current) return;
      forcedEditorCollapseRef.current = false;
      triggerPanelAnimation();
      useUiStore.getState().setEditorCollapsed(false);
    };

    const handleFocusOut = () => {
      // Defer: focusout fires before any new element takes focus, and touch
      // interactions inside the output section (e.g. repositioning the
      // terminal cursor) can blur+refocus the same/sibling element within the
      // same tick. Checking activeElement next frame avoids restoring the
      // editor for those transient blurs.
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (
          active instanceof HTMLElement &&
          isEditableElement(active) &&
          active.closest("#output-section")
        ) {
          return; // focus moved to another editable still inside the output section
        }
        restoreIfForced();
      });
    };

    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("focusout", handleFocusOut);
    return () => {
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("focusout", handleFocusOut);
      // Never leave the editor collapsed if this hook tears down mid-keyboard.
      restoreIfForced();
    };
  }, [isMobile, isCoarsePointer, hasTouchCapability]);

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
