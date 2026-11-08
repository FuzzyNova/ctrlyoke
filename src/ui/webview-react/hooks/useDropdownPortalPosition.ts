import { useCallback, useEffect, useState } from "react";
import type { RefObject } from "react";
import { parsePropMaxHeight, type PopupPosition } from "@utils/dropdownUtils";

/**
 * Vertical bounds of the area the user can actually see, in layout-viewport
 * coordinates: the visual viewport when available (it excludes the iOS
 * on-screen keyboard), else the whole window.
 */
function visibleViewportBounds(): { top: number; bottom: number } {
  const vv = window.visualViewport;
  if (!vv) return { top: 0, bottom: window.innerHeight };
  const top = Math.max(0, vv.offsetTop);
  return {
    top,
    bottom: Math.min(window.innerHeight, top + vv.height),
  };
}

/**
 * Computes and tracks the fixed-position coordinates for a dropdown portal.
 *
 * - Measures the trigger button via getBoundingClientRect() on open.
 * - Flips above the button when insufficient space below (< 80 px).
 * - Re-measures on resize and capture-phase scroll events.
 * - Resets to null on close so stale coordinates never flash on next open.
 *
 * @param buttonRef          Ref attached to the trigger button element.
 * @param isOpen             Whether the dropdown is currently open.
 * @param dropdownMaxHeight  CSS max-height string (e.g. "60vh", "300px"). Defaults to "60vh".
 * @returns                  Computed position, or null when closed / not yet measured.
 */
export function useDropdownPortalPosition(
  buttonRef: RefObject<HTMLButtonElement | null>,
  isOpen: boolean,
  dropdownMaxHeight: string = "60vh"
): PopupPosition | null {
  const [popupPos, setPopupPos] = useState<PopupPosition | null>(null);

  const updatePosition = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    // Measure free space against the *visible* area. On iOS the layout
    // viewport (window.innerHeight) keeps its full height while the
    // on-screen keyboard is up, so a popup "fitting below" would render
    // behind the keyboard. The fixed `top`/`bottom` offsets themselves stay
    // in layout-viewport coordinates, which is what position:fixed uses.
    const visible = visibleViewportBounds();
    const spaceBelow = visible.bottom - rect.bottom - 4;
    const propMaxH = parsePropMaxHeight(dropdownMaxHeight);
    if (spaceBelow >= 80) {
      setPopupPos({
        top: rect.bottom + 4,
        left: rect.left,
        width: rect.width,
        maxHeight: Math.min(propMaxH, spaceBelow),
      });
    } else {
      const spaceAbove = rect.top - visible.top - 4;
      setPopupPos({
        bottom: window.innerHeight - rect.top + 4,
        left: rect.left,
        width: rect.width,
        maxHeight: Math.min(propMaxH, spaceAbove),
      });
    }
  }, [buttonRef, dropdownMaxHeight]);

  // Compute/update position whenever the popup opens or the window moves.
  // Reset to null on close so stale coordinates never flash on next open.
  useEffect(() => {
    if (isOpen) {
      updatePosition();
      // The iOS keyboard resizes only the visual viewport, not the window.
      const visualViewport = window.visualViewport;
      window.addEventListener("resize", updatePosition);
      window.addEventListener("scroll", updatePosition, true);
      visualViewport?.addEventListener("resize", updatePosition);
      return () => {
        window.removeEventListener("resize", updatePosition);
        window.removeEventListener("scroll", updatePosition, true);
        visualViewport?.removeEventListener("resize", updatePosition);
      };
    } else {
      setPopupPos(null);
    }
  }, [isOpen, updatePosition]);

  return popupPos;
}
