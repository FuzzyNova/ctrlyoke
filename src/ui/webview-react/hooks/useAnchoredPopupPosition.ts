import { useCallback, useEffect, useState } from "react";
import type { RefObject } from "react";
import {
  constrainPopupToViewport,
  parsePixelProp,
  type PopupPosition,
} from "@utils/dropdownUtils";

const POPUP_OFFSET_PX = 4;

export type AnchoredPopupPlacement = "top" | "bottom";

/**
 * Computes fixed-position coordinates for a popup anchored to an element.
 *
 * The returned tuple contains the current position and a callback that can
 * force a re-measure. Position is null while closed or before the anchor has
 * been measured.
 */
export function useAnchoredPopupPosition(
  anchorRef: RefObject<HTMLElement | null>,
  isOpen: boolean,
  placement: AnchoredPopupPlacement,
  minWidth?: string,
  maxWidth?: string,
  matchAnchorWidth = false
): [PopupPosition | null, () => void] {
  const [popupPos, setPopupPos] = useState<PopupPosition | null>(null);

  const updatePosition = useCallback(() => {
    if (!anchorRef.current) return;

    const rect = anchorRef.current.getBoundingClientRect();
    const requestedMinWidth = parsePixelProp(minWidth);
    const requestedMaxWidth = parsePixelProp(maxWidth);
    const constrained = constrainPopupToViewport({
      left: rect.left,
      width: matchAnchorWidth ? rect.width : undefined,
      minWidth: requestedMinWidth,
      maxWidth: requestedMaxWidth,
      preferredWidth: matchAnchorWidth
        ? Math.max(rect.width, requestedMinWidth ?? 0)
        : (requestedMaxWidth ?? requestedMinWidth),
    });

    const verticalPosition =
      placement === "top"
        ? {
            bottom: window.innerHeight - rect.top + POPUP_OFFSET_PX,
            maxHeight: rect.top - POPUP_OFFSET_PX,
          }
        : {
            top: rect.bottom + POPUP_OFFSET_PX,
            maxHeight: window.innerHeight - rect.bottom - POPUP_OFFSET_PX,
          };

    setPopupPos({
      ...verticalPosition,
      left: constrained.left,
      minWidth: constrained.minWidth,
      maxWidth: constrained.maxWidth,
      ...(constrained.width !== undefined ? { width: constrained.width } : {}),
    });
  }, [anchorRef, matchAnchorWidth, maxWidth, minWidth, placement]);

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

  return [isOpen ? popupPos : null, updatePosition];
}
