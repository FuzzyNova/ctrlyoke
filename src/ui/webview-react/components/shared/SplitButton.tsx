import React, { useState, useRef, useEffect, useCallback } from "react";
import { useIsMobile } from "@hooks/useMediaQuery";
import { HEADER_BUTTON_SIZES } from "@/constants";

export interface SplitButtonOption {
  label: string;
  value: string;
  onClick: () => void;
  icon?: React.ReactNode;
  shortcut?: string;
  disabled?: boolean;
  divider?: boolean;
}

export interface SplitButtonProps {
  /** Label for the main button */
  mainLabel: React.ReactNode;
  /** Action when main button is clicked */
  mainAction: () => void;
  /** Dropdown menu options */
  options: SplitButtonOption[];
  /** Button style variant */
  variant?: "primary" | "secondary";
  /** Whether the entire split button is disabled */
  disabled?: boolean;
  /** Whether only the main button is disabled (dropdown still works) */
  mainDisabled?: boolean;
  /** Whether only the dropdown is disabled */
  dropdownDisabled?: boolean;
  /** Title/tooltip for main button */
  mainTitle?: string;
  /** Title/tooltip for dropdown button */
  dropdownTitle?: string;
  /** Additional className for the container */
  className?: string;
  /** Icon to show in dropdown button (default: chevron-down) */
  dropdownIcon?: React.ReactNode;
  /** Badge content to show in dropdown button */
  badge?: React.ReactNode;
  /** Aria label for dropdown button */
  dropdownAriaLabel?: string;
}

export const SplitButton: React.FC<SplitButtonProps> = ({
  mainLabel,
  mainAction,
  options,
  variant = "primary",
  disabled = false,
  mainDisabled = false,
  dropdownDisabled = false,
  mainTitle,
  dropdownTitle,
  className = "",
  dropdownIcon,
  badge,
  dropdownAriaLabel = "More options",
}) => {
  const isMobile = useIsMobile();
  const btnSizes = isMobile
    ? HEADER_BUTTON_SIZES.touch
    : HEADER_BUTTON_SIZES.default;
  const [isOpen, setIsOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Track whether the dropdown was opened via keyboard so we only
  // auto-focus the first item for keyboard navigation (not mouse clicks).
  const openedWithKeyboardRef = useRef(false);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
        setFocusedIndex(-1);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  // Focus management when dropdown opens - only auto-highlight first item
  // when opened via keyboard (arrow/enter), not on mouse click.
  useEffect(() => {
    if (isOpen && dropdownRef.current && openedWithKeyboardRef.current) {
      const firstEnabled = options.findIndex(
        (opt) => !opt.disabled && !opt.divider
      );
      setFocusedIndex(firstEnabled >= 0 ? firstEnabled : -1);
    }
  }, [isOpen, options]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isOpen) {
        if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openedWithKeyboardRef.current = true;
          setIsOpen(true);
        }
        return;
      }

      const enabledOptions = options
        .map((opt, idx) => ({ opt, idx }))
        .filter(({ opt }) => !opt.disabled && !opt.divider);

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          {
            const currentPos = enabledOptions.findIndex(
              ({ idx }) => idx === focusedIndex
            );
            const nextPos = (currentPos + 1) % enabledOptions.length;
            setFocusedIndex(enabledOptions[nextPos].idx);
          }
          break;

        case "ArrowUp":
          e.preventDefault();
          {
            const currentPos = enabledOptions.findIndex(
              ({ idx }) => idx === focusedIndex
            );
            const prevPos =
              (currentPos - 1 + enabledOptions.length) % enabledOptions.length;
            setFocusedIndex(enabledOptions[prevPos].idx);
          }
          break;

        case "Enter":
        case " ":
          e.preventDefault();
          if (focusedIndex >= 0 && !options[focusedIndex]?.disabled) {
            options[focusedIndex].onClick();
            setIsOpen(false);
            setFocusedIndex(-1);
            triggerRef.current?.focus();
          }
          break;

        case "Escape":
          e.preventDefault();
          setIsOpen(false);
          setFocusedIndex(-1);
          triggerRef.current?.focus();
          break;

        case "Tab":
          setIsOpen(false);
          setFocusedIndex(-1);
          break;
      }
    },
    [isOpen, options, focusedIndex]
  );

  const handleOptionClick = (option: SplitButtonOption) => {
    if (option.disabled) return;
    option.onClick();
    setIsOpen(false);
    setFocusedIndex(-1);
  };

  const toggleDropdown = (e: React.MouseEvent) => {
    e.stopPropagation();
    openedWithKeyboardRef.current = false;
    if (!isOpen) {
      setFocusedIndex(-1);
    }
    setIsOpen(!isOpen);
  };

  // Button classes based on variant
  const baseButtonClass =
    "inline-flex items-center justify-center transition-colors focus:outline-none focus-visible:ring-1";
  const variantClass =
    variant === "primary"
      ? "bg-btn-bg text-btn-fg hover:bg-btn-hover"
      : "bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover";
  // Separator outer div: background matches button so padding area is invisible,
  // text color set so the inner div's bg-current inherits the right foreground.
  // Mirrors VS Code's formula: transparent(buttonForeground, 0.4)
  const separatorClass =
    variant === "primary"
      ? "bg-btn-bg text-btn-fg"
      : "bg-btn-secondary-bg text-btn-secondary-fg";
  const disabledClass = "opacity-50 cursor-not-allowed";

  const defaultChevron = (
    <svg
      className="w-3 h-3"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M19 9l-7 7-7-7"
      />
    </svg>
  );

  return (
    /* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- keyboard handler manages split button group navigation across child controls */
    <div
      ref={containerRef}
      role="group"
      aria-label={typeof mainLabel === "string" ? mainLabel : undefined}
      className={`relative inline-flex rounded border border-btn-border ${btnSizes.groupContainer} ${className}`}
      onKeyDown={handleKeyDown}
    >
      {/* Main Button */}
      <button
        type="button"
        onClick={mainAction}
        disabled={disabled || mainDisabled}
        title={mainTitle}
        className={`${baseButtonClass} ${variantClass} ${btnSizes.splitButtonMain} font-medium rounded-l rounded-r-none ${
          disabled || mainDisabled ? disabledClass : ""
        }`}
      >
        {mainLabel}
      </button>

      {/* Separator — mirrors VS Code's monaco-button-dropdown-separator:
          outer div fills with button background (padding creates the inset),
          inner 1px div is the visible hairline using --vscode-button-separator */}
      <div className={`${separatorClass} ${btnSizes.separatorPy} flex-shrink-0`}>
        <div className="w-px h-full bg-current opacity-40" />
      </div>

      {/* Dropdown Trigger */}
      <button
        ref={triggerRef}
        type="button"
        onClick={toggleDropdown}
        disabled={disabled || dropdownDisabled}
        title={dropdownTitle}
        aria-label={dropdownAriaLabel}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        className={`${baseButtonClass} ${variantClass} ${btnSizes.splitButtonDropdown} rounded-r rounded-l-none ${
          disabled || dropdownDisabled ? disabledClass : ""
        } ${isOpen ? "bg-btn-secondary-hover" : ""}`}
      >
        {badge && (
          <span className="text-xxs font-semibold bg-badge-bg text-badge-fg rounded-full px-1.5 py-0.5 min-w-[16px] text-center mr-1">
            {badge}
          </span>
        )}
        {dropdownIcon || defaultChevron}
      </button>

      {/* Dropdown Menu */}
      <div
        ref={dropdownRef}
        role="listbox"
        className={`absolute top-full left-0 mt-1 min-w-[200px] bg-dropdown-bg border border-dropdown-border rounded shadow-lg z-50 overflow-hidden transition-all duration-150 origin-top ${isOpen ? "opacity-100 translate-y-0 visible" : "opacity-0 -translate-y-1 invisible pointer-events-none"}`}
      >
        {options.map((option, index) =>
          option.divider ? (
            <div
              key={`divider-${index}`}
              className="border-t border-dropdown-border my-1"
            />
          ) : (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={focusedIndex === index}
              onClick={() => handleOptionClick(option)}
              disabled={option.disabled}
              className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center justify-between gap-2 ${
                option.disabled
                  ? "opacity-50 cursor-not-allowed text-disabled-fg"
                  : "text-dropdown-fg hover:bg-list-hover-bg hover:text-list-highlight-fg cursor-pointer"
              } ${focusedIndex === index ? "bg-dropdown-selected-bg text-list-active-fg" : ""}`}
            >
              {option.icon && (
                <span className="flex-shrink-0">{option.icon}</span>
              )}
              <span className="flex-1">{option.label}</span>
              {option.shortcut && (
                <kbd className="text-xs text-description-fg bg-keybinding-bg px-1.5 py-0.5 rounded font-mono">
                  {option.shortcut}
                </kbd>
              )}
            </button>
          )
        )}
      </div>
    </div>
  );
};
