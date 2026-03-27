import React, { useEffect, useRef } from "react";

interface FooterQuickPickerProps {
  /** Icon-only mode (narrow, < 380px) */
  isNarrow: boolean;
  /** Show value label alongside icon (wide, >= 560px) */
  showLabel: boolean;
  /** Codicon class name for the button icon, e.g. "codicon-server" */
  icon: string;
  /** Text shown next to icon in wide mode — the current override value or "Default" */
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
  /** When true, button and popup are disabled (CLI watch mode) */
  disabled?: boolean;
}

/**
 * FooterQuickPicker — generic trigger button + upward popup shell.
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
  disabled = false,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
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
    <div className="relative" ref={containerRef}>
      <button
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
        <i className={`codicon ${icon}`} />
        {!isNarrow && showLabel && (
          <span
            className={`max-w-[80px] truncate ${
              isOverride ? "text-focus-border font-medium" : "text-description-fg"
            }`}
          >
            {valueLabel}
          </span>
        )}
        {!isNarrow && (
          <i
            className={`codicon ${isOpen ? "codicon-chevron-down" : "codicon-chevron-up"} text-[10px]`}
          />
        )}
      </button>

      {isOpen && !disabled && (
        <div
          className="absolute bottom-full left-0 mb-1 bg-dropdown-bg border border-dropdown-border rounded shadow-lg z-[200]"
          style={{ minWidth: popupMinWidth }}
        >
          {children}
        </div>
      )}
    </div>
  );
};
