import React, { useRef } from "react";
import { createPortal } from "react-dom";
import { useClickOutside } from "@hooks/useClickOutside";
import { useAnchoredPopupPosition } from "@hooks/useAnchoredPopupPosition";
import { usePickerShortcutRequest } from "@hooks/usePickerShortcutRequest";
import { useUiStore } from "@store/uiStore";
import type { PickerShortcutTarget } from "@root/types/DashboardConstants";
import { withPickerShortcutHint } from "@utils/platform";

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
  disabledReason?: string;
  /**
   * The Alt+Shift picker shortcut for this picker. Its press opens the popup;
   * the select inside it (given the same target) then claims the request.
   */
  shortcutTarget?: PickerShortcutTarget;
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
  disabledReason,
  shortcutTarget,
}) => {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  usePickerShortcutRequest(
    shortcutTarget ? [shortcutTarget] : undefined,
    (request) => {
      if (disabled) {
        useUiStore.getState().clearPickerShortcutRequest(request.nonce);
      } else if (!isOpen) {
        onToggle();
      }
    }
  );
  const buttonTitle = withPickerShortcutHint(title, shortcutTarget);

  const [popupPos] = useAnchoredPopupPosition(
    buttonRef,
    isOpen,
    "top",
    popupMinWidth,
    popupMaxWidth
  );

  useClickOutside([buttonRef, popupRef], isOpen, onClose);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={disabled ? undefined : onToggle}
        disabled={disabled}
        title={disabled ? (disabledReason ?? title) : buttonTitle}
        aria-label={title}
        className={`px-2 py-1 text-xs rounded-sm flex items-center gap-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
          isOverride || isOpen
            ? "bg-btn-secondary-bg text-btn-secondary-fg cy-dropdown-row-selected"
            : "hover:bg-list-hover-bg text-foreground cy-dropdown-row"
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
            className="cy-dropdown-popup fixed bg-dropdown-bg border border-dropdown-border z-popover flex flex-col"
            style={{
              bottom: popupPos.bottom,
              left: popupPos.left,
              minWidth: popupPos.minWidth,
              maxWidth: popupPos.maxWidth,
              maxHeight: popupPos.maxHeight,
            }}
          >
            {heading && (
              <div className="flex items-center px-3 py-2 border-b border-dropdown-border bg-editor-bg shrink-0">
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
