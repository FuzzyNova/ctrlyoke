import React, { useState, useRef, useEffect, useCallback } from "react";

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
  const [isOpen, setIsOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

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

  // Focus management when dropdown opens
  useEffect(() => {
    if (isOpen && dropdownRef.current) {
      const firstEnabled = options.findIndex(
        (opt) => !opt.disabled && !opt.divider
      );
      setFocusedIndex(firstEnabled >= 0 ? firstEnabled : 0);
    }
  }, [isOpen, options]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isOpen) {
        if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
          e.preventDefault();
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
    setIsOpen(!isOpen);
  };

  // Button classes based on variant
  const baseButtonClass =
    "inline-flex items-center justify-center transition-colors focus:outline-none focus-visible:ring-1";
  const variantClass =
    variant === "primary"
      ? "bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)]"
      : "bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]";
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
    <div
      ref={containerRef}
      className={`relative inline-flex rounded ${className}`}
      onKeyDown={handleKeyDown}
    >
      {/* Main Button */}
      <button
        type="button"
        onClick={mainAction}
        disabled={disabled || mainDisabled}
        title={mainTitle}
        className={`${baseButtonClass} ${variantClass} px-3 py-1.5 text-sm font-medium rounded-l rounded-r-none border-r border-white/10 ${
          disabled || mainDisabled ? disabledClass : ""
        }`}
      >
        {mainLabel}
      </button>

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
        className={`${baseButtonClass} ${variantClass} px-2 py-1.5 rounded-r rounded-l-none ${
          disabled || dropdownDisabled ? disabledClass : ""
        } ${isOpen ? "bg-[var(--vscode-button-secondaryHoverBackground)]" : ""}`}
      >
        {badge && (
          <span className="text-[10px] font-semibold bg-[var(--vscode-badge-background)] text-[var(--vscode-badge-foreground)] rounded-full px-1.5 py-0.5 min-w-[16px] text-center mr-1">
            {badge}
          </span>
        )}
        {dropdownIcon || defaultChevron}
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div
          ref={dropdownRef}
          role="listbox"
          className="absolute top-full left-0 mt-1 min-w-[200px] bg-[var(--vscode-dropdown-background)] border border-[var(--vscode-dropdown-border)] rounded shadow-lg z-50 overflow-hidden"
        >
          {options.map((option, index) =>
            option.divider ? (
              <div
                key={`divider-${index}`}
                className="border-t border-[var(--vscode-dropdown-border)] my-1"
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
                    ? "opacity-50 cursor-not-allowed text-[var(--vscode-disabledForeground)]"
                    : "text-[var(--vscode-dropdown-foreground)] hover:bg-[var(--vscode-list-hoverBackground)] cursor-pointer"
                } ${focusedIndex === index ? "bg-[var(--vscode-list-focusBackground)]" : ""}`}
              >
                {option.icon && <span className="flex-shrink-0">{option.icon}</span>}
                <span className="flex-1">{option.label}</span>
                {option.shortcut && (
                  <kbd className="text-xs text-[var(--vscode-descriptionForeground)] bg-[var(--vscode-keybindingLabel-background,rgba(128,128,128,0.17))] px-1.5 py-0.5 rounded font-mono">
                    {option.shortcut}
                  </kbd>
                )}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
};
