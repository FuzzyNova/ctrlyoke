import { forwardRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import type { PopupPosition } from "@utils/dropdownUtils";

interface DropdownPortalProps {
  isOpen: boolean;
  popupPos: PopupPosition | null;
  children: ReactNode;
  /** Additional classes appended to the portal container. */
  className?: string;
}

/**
 * Portaled dropdown container that renders into document.body with position:fixed.
 *
 * Applies the shared `fp-dropdown-popup` class (rounded corners + themed shadow)
 * plus standard background, border, and z-index. Returns null when closed or
 * when the position has not yet been computed.
 *
 * Forward-ref so callers can attach a popupRef for outside-click detection.
 */
export const DropdownPortal = forwardRef<HTMLDivElement, DropdownPortalProps>(
  ({ isOpen, popupPos, children, className }, ref) => {
    if (!isOpen || !popupPos) return null;

    return createPortal(
      <div
        ref={ref}
        className={`fp-dropdown-popup fixed bg-dropdown-bg border border-dropdown-border z-[9999] flex flex-col${className ? ` ${className}` : ""}`}
        style={{
          top: popupPos.top,
          bottom: popupPos.bottom,
          left: popupPos.left,
          width: popupPos.width,
          minWidth: popupPos.minWidth,
          maxWidth: popupPos.maxWidth,
          maxHeight: popupPos.maxHeight,
        }}
      >
        {children}
      </div>,
      document.body
    );
  }
);
DropdownPortal.displayName = "DropdownPortal";
