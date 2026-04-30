import { useCallback, useEffect, useState } from "react";
import type { RefObject } from "react";
import { parsePropMaxHeight, type PopupPosition } from "@utils/dropdownUtils";

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
    const spaceBelow = window.innerHeight - rect.bottom - 4;
    const propMaxH = parsePropMaxHeight(dropdownMaxHeight);
    if (spaceBelow >= 80) {
      setPopupPos({
        top: rect.bottom + 4,
        left: rect.left,
        width: rect.width,
        maxHeight: Math.min(propMaxH, spaceBelow),
      });
    } else {
      const spaceAbove = rect.top - 4;
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
      window.addEventListener("resize", updatePosition);
      window.addEventListener("scroll", updatePosition, true);
      return () => {
        window.removeEventListener("resize", updatePosition);
        window.removeEventListener("scroll", updatePosition, true);
      };
    } else {
      setPopupPos(null);
    }
  }, [isOpen, updatePosition]);

  return popupPos;
}
