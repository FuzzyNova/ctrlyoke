import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface FooterQuickPickerProps {
  /** Icon-only mode (narrow, < 380px) */
  isNarrow: boolean;
  /** Show value label alongside icon (wide, >= 560px) */
  showLabel: boolean;
  /** Icon to display — a codicon element or any React node (e.g. HarnessIcon) */
  icon: React.ReactNode;
  /** Text shown next to icon in wide mode — the current override value or "Inherit" */
  valueLabel: string;
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
  isOverride,
  isOpen,
  onToggle,
  onClose,
  children,
  title,
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
  } | null>(null);

  const updatePosition = useCallback(() => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setPopupPos({
        bottom: window.innerHeight - rect.top + 4,
        left: rect.left,
        maxHeight: rect.top - 4,
      });
    }
  }, []);

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

  // Close on click outside (must check both button and portaled popup)
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !buttonRef.current?.contains(target) &&
        !popupRef.current?.contains(target)
      ) {
        onClose();
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen, onClose]);

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
            ? "bg-btn-secondary-bg text-btn-secondary-fg"
            : "hover:bg-list-hover-bg text-foreground"
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
      </button>

      {isOpen &&
        !disabled &&
        popupPos &&
        createPortal(
          <div
            ref={popupRef}
            className="fixed bg-dropdown-bg border border-dropdown-border rounded shadow-lg z-[9999] flex flex-col overflow-hidden"
            style={{
              bottom: popupPos.bottom,
              left: popupPos.left,
              minWidth: popupMinWidth,
              maxWidth: popupMaxWidth,
              maxHeight: popupPos.maxHeight,
            }}
          >
            {children}
          </div>,
          document.body
        )}
    </>
  );
};
