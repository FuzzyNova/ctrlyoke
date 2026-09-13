import { forwardRef } from "react";
import type { AriaRole, ReactNode } from "react";
import { createPortal } from "react-dom";
import type { PopupPosition } from "@utils/dropdownUtils";

interface DropdownPortalProps {
  isOpen: boolean;
  popupPos: PopupPosition | null;
  children: ReactNode;
  id?: string;
  role?: AriaRole;
  /** Additional classes appended to the portal container. */
  className?: string;
}

/**
 * Portaled dropdown container that renders into document.body with position:fixed.
 *
 * Applies the shared `cy-dropdown-popup` class (rounded corners + themed shadow)
 * plus standard background, border, and z-index. Returns null when closed or
 * when the position has not yet been computed.
 *
 * Forward-ref so callers can attach a popupRef for outside-click detection.
 */
export const DropdownPortal = forwardRef<HTMLDivElement, DropdownPortalProps>(
  ({ isOpen, popupPos, children, id, role, className }, ref) => {
    if (!isOpen || !popupPos) return null;

    return createPortal(
      <div
        ref={ref}
        id={id}
        role={role}
        className={`cy-dropdown-popup fixed bg-dropdown-bg border border-dropdown-border z-popover flex flex-col${className ? ` ${className}` : ""}`}
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
