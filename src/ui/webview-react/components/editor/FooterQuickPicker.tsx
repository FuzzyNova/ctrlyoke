import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useClickOutside } from "@hooks/useClickOutside";
import { constrainPopupToViewport, parsePixelProp } from "@utils/dropdownUtils";

interface FooterQuickPickerProps {
  /** Icon-only mode (narrow, < 380px) */
  isNarrow: boolean;
  /** Show value label alongside icon (wide, >= 560px) */
  showLabel: boolean;
  /** Icon to display — a codicon element or any React node (e.g. HarnessIcon) */
  icon: React.ReactNode;
  /** Text shown next to icon in wide mode — the current override value or "Inherit" */
  valueLabel: string;
  /** Optional compact badge shown after valueLabel in wide mode only (e.g. a usage percentage). */
  badgeLabel?: string;
  /** Whether the value is an override (not default) — used for active styling */
  isOverride: boolean;
  /** Whether this picker's popup is currently open */
  isOpen: boolean;
  /** Toggle open/close */
  onToggle: () => void;
  /** Close this picker */
  onClose: () => void;
  /** Popup content */
  children: React.ReactNode;
  /** Accessible label for the trigger button */
  title: string;
  /** Optional heading shown in the popup title bar */
  heading?: string;
  /** Optional min-width for the popup panel (default: 200px) */
  popupMinWidth?: string;
  /** Optional max-width for the popup panel */
  popupMaxWidth?: string;
  /** When true, button and popup are disabled (CLI watch mode) */
  disabled?: boolean;
}

/**
 * FooterQuickPicker — generic trigger button + upward popup shell.
 *
 * The popup is rendered via a portal at document.body with position:fixed so
 * it escapes any overflow:hidden ancestors and is never clipped.
 *
 * Used by HarnessQuickPicker, ModelQuickPicker, AgentQuickPicker, and
 * SkillsQuickPicker to provide quick inline access to prompt properties
 * directly from the EditorFooter without opening PropertiesDrawer.
 */
export const FooterQuickPicker: React.FC<FooterQuickPickerProps> = ({
  isNarrow,
  showLabel,
  icon,
  valueLabel,
  badgeLabel,
  isOverride,
  isOpen,
  onToggle,
  onClose,
  children,
  title,
  heading,
  popupMinWidth = "200px",
  popupMaxWidth,
  disabled = false,
}) => {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [popupPos, setPopupPos] = useState<{
    bottom: number;
    left: number;
    maxHeight: number;
    minWidth?: number;
    maxWidth: number;
  } | null>(null);

  const updatePosition = useCallback(() => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const requestedMinWidth = parsePixelProp(popupMinWidth);
      const requestedMaxWidth = parsePixelProp(popupMaxWidth);
      const constrained = constrainPopupToViewport({
        left: rect.left,
        minWidth: requestedMinWidth,
        maxWidth: requestedMaxWidth,
        preferredWidth: requestedMaxWidth ?? requestedMinWidth,
      });
      setPopupPos({
        bottom: window.innerHeight - rect.top + 4,
        left: constrained.left,
        maxHeight: rect.top - 4,
        minWidth: constrained.minWidth,
        maxWidth: constrained.maxWidth,
      });
    }
  }, [popupMaxWidth, popupMinWidth]);

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

  useClickOutside([buttonRef, popupRef], isOpen, onClose);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={disabled ? undefined : onToggle}
        disabled={disabled}
        title={title}
        className={`px-2 py-1 text-xs rounded flex items-center gap-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
          isOverride || isOpen
            ? "bg-btn-secondary-bg text-btn-secondary-fg fp-dropdown-row-selected"
            : "hover:bg-list-hover-bg text-foreground fp-dropdown-row"
        }`}
      >
        {icon}
        {!isNarrow && showLabel && (
          <span
            className={`max-w-[80px] truncate ${
              isOverride
                ? "text-focus-border font-medium"
                : "text-description-fg"
            }`}
          >
            {valueLabel}
          </span>
        )}
        {!isNarrow && showLabel && badgeLabel && (
          <span className="text-[10px] text-description-fg opacity-80">
            {badgeLabel}
          </span>
        )}
      </button>

      {isOpen &&
        !disabled &&
        popupPos &&
        createPortal(
          <div
            ref={popupRef}
            className="fp-dropdown-popup fixed bg-dropdown-bg border border-dropdown-border z-popover flex flex-col"
            style={{
              bottom: popupPos.bottom,
              left: popupPos.left,
              minWidth: popupPos.minWidth,
              maxWidth: popupPos.maxWidth,
              maxHeight: popupPos.maxHeight,
            }}
          >
            {heading && (
              <div className="flex items-center px-3 py-2 border-b border-dropdown-border bg-editor-bg flex-shrink-0">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">
                  {heading}
                </h3>
              </div>
            )}
            {children}
          </div>,
          document.body
        )}
    </>
  );
};
