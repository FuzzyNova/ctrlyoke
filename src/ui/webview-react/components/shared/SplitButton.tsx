import { BUTTON_VARIANTS, KEYBOARD_KEYS } from "@root/types/DashboardConstants";
import React, { useState, useRef, useEffect, useCallback } from "react";
import { useIsMobile } from "@hooks/useMediaQuery";
import { useLongPress } from "@hooks/useLongPress";
import { HEADER_BUTTON_SIZES } from "@/constants";

/**
 * Appended to the main button's tooltip when the chevron trigger is collapsed
 * away, so the only remaining way into the menu is still discoverable.
 */
const MENU_GESTURE_HINT = "Right-click or press and hold for more options";

export interface SplitButtonOption {
  label: string;
  value: string;
  /** The optional opener is supplied by SplitButton for focus restoration. */
  onClick: (opener?: HTMLButtonElement | null) => void;
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
  variant?: (typeof BUTTON_VARIANTS)[keyof typeof BUTTON_VARIANTS];
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
  /**
   * Collapse the control to its main button alone: the separator and chevron
   * trigger are not rendered, and the menu is reached by right-click, press
   * and hold, `ArrowDown`, or the platform context-menu key. Use it where the
   * ~26px the chevron costs matters more than its click affordance — a narrow
   * header row or editor footer. Those gestures work at *every* width, so the
   * chevron teaches the menu exists where there is room and the same gesture
   * keeps working where there is not.
   *
   * The caller decides, because a split button is content-sized and so cannot
   * measure the space it is competing for; measure the row that holds it
   * (`useElementNarrow`) or the viewport (`useIsMobile`) instead.
   */
  hideMenuButton?: boolean;
}

export const SplitButton: React.FC<SplitButtonProps> = ({
  mainLabel,
  mainAction,
  options,
  variant = BUTTON_VARIANTS.PRIMARY,
  disabled = false,
  mainDisabled = false,
  dropdownDisabled = false,
  mainTitle,
  dropdownTitle,
  className = "",
  dropdownIcon,
  badge,
  dropdownAriaLabel = "More options",
  hideMenuButton = false,
}) => {
  const isMobile = useIsMobile();
  const btnSizes = isMobile
    ? HEADER_BUTTON_SIZES.touch
    : HEADER_BUTTON_SIZES.default;
  const [isOpen, setIsOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Track whether the dropdown was opened via keyboard so we only
  // auto-focus the first item for keyboard navigation (not mouse clicks).
  const openedWithKeyboardRef = useRef(false);
  // A long press fires while the finger is still down; the browser then
  // synthesises a click on lift, which would run the main action on top of the
  // menu that same press just opened.
  const suppressNextClickRef = useRef(false);

  const menuDisabled = disabled || dropdownDisabled;
  // Whichever button currently opens the menu: the focus-restoration opener
  // handed to option callbacks, and where focus returns on Escape.
  const getMenuAnchor = useCallback(
    () => (hideMenuButton ? mainRef.current : triggerRef.current),
    [hideMenuButton]
  );

  // Browsers dispatch no pointer events on a disabled control, so in collapsed
  // mode a disabled main action would take its own menu down with it. Keep the
  // button enabled and refuse the action instead.
  const collapsedMainOnlyDisabled =
    hideMenuButton && mainDisabled && !disabled && !dropdownDisabled;
  const mainActionDisabled = disabled || mainDisabled;
  const mainButtonDisabled = mainActionDisabled && !collapsedMainOnlyDisabled;

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
        if (menuDisabled) return;
        // Enter/Space belong to whichever button has focus — intercepting them
        // group-wide swallowed the main button's own activation, since
        // preventDefault on keydown cancels the synthesised click. ArrowDown is
        // the group-wide "open the menu" key, and is the only way in from the
        // main button once the chevron is collapsed away.
        const fromTrigger = e.target === triggerRef.current;
        const opensMenu =
          e.key === KEYBOARD_KEYS.ARROW_DOWN ||
          (fromTrigger && (e.key === KEYBOARD_KEYS.ENTER || e.key === " "));
        if (!opensMenu) return;
        e.preventDefault();
        openedWithKeyboardRef.current = true;
        setIsOpen(true);
        return;
      }

      const enabledOptions = options
        .map((opt, idx) => ({ opt, idx }))
        .filter(({ opt }) => !opt.disabled && !opt.divider);

      switch (e.key) {
        case KEYBOARD_KEYS.ARROW_DOWN:
          e.preventDefault();
          {
            const currentPos = enabledOptions.findIndex(
              ({ idx }) => idx === focusedIndex
            );
            const nextPos = (currentPos + 1) % enabledOptions.length;
            setFocusedIndex(enabledOptions[nextPos].idx);
          }
          break;

        case KEYBOARD_KEYS.ARROW_UP:
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

        case KEYBOARD_KEYS.ENTER:
        case " ":
          e.preventDefault();
          if (focusedIndex >= 0 && !options[focusedIndex]?.disabled) {
            options[focusedIndex].onClick(getMenuAnchor());
            setIsOpen(false);
            setFocusedIndex(-1);
            getMenuAnchor()?.focus();
          }
          break;

        case KEYBOARD_KEYS.ESCAPE:
          e.preventDefault();
          setIsOpen(false);
          setFocusedIndex(-1);
          getMenuAnchor()?.focus();
          break;

        case KEYBOARD_KEYS.TAB:
          setIsOpen(false);
          setFocusedIndex(-1);
          break;
      }
    },
    [isOpen, options, focusedIndex, menuDisabled, getMenuAnchor]
  );

  const handleOptionClick = (option: SplitButtonOption) => {
    if (option.disabled) return;
    option.onClick(getMenuAnchor());
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

  /** Right-click / press-and-hold entry point — always opens, never toggles. */
  const openMenuFromGesture = useCallback(() => {
    if (menuDisabled) return;
    openedWithKeyboardRef.current = false;
    setFocusedIndex(-1);
    setIsOpen(true);
  }, [menuDisabled]);

  const handleLongPress = useCallback(() => {
    suppressNextClickRef.current = true;
    openMenuFromGesture();
  }, [openMenuFromGesture]);

  const longPressHandlers = useLongPress(menuDisabled ? null : handleLongPress);

  const handleContextMenu = (e: React.MouseEvent) => {
    if (menuDisabled) return;
    // Also covers the keyboard context-menu gesture (Menu key / Shift+F10),
    // which browsers deliver as a contextmenu event.
    e.preventDefault();
    e.stopPropagation();
    openMenuFromGesture();
  };

  const handleMainClick = () => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    // A deliberate click on the main button while its own menu is open should
    // dismiss the menu rather than leave it hanging over the result.
    setIsOpen(false);
    if (mainActionDisabled) return;
    mainAction();
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    // A fresh gesture: whatever the previous one suppressed is spent.
    suppressNextClickRef.current = false;
    longPressHandlers.onTouchStart(e);
  };

  // Button classes based on variant
  const baseButtonClass =
    "inline-flex items-center justify-center transition-colors focus:outline-none focus-visible:ring-1";
  const variantClass =
    variant === BUTTON_VARIANTS.PRIMARY
      ? "bg-btn-bg text-btn-fg hover:bg-btn-hover"
      : "bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover";
  // Separator outer div: background matches button so padding area is invisible,
  // text color set so the inner div's bg-current inherits the right foreground.
  // Mirrors VS Code's formula: transparent(buttonForeground, 0.4)
  const separatorClass =
    variant === BUTTON_VARIANTS.PRIMARY
      ? "bg-btn-bg text-btn-fg"
      : "bg-btn-secondary-bg text-btn-secondary-fg";
  const disabledClass = "opacity-50 cursor-not-allowed";

  const badgeElement = badge ? (
    <span className="text-xxs font-semibold bg-badge-bg text-badge-fg rounded-full px-1.5 py-0.5 min-w-[16px] text-center mr-1">
      {badge}
    </span>
  ) : null;

  const collapsedTitle = mainTitle
    ? `${mainTitle}
${MENU_GESTURE_HINT}`
    : MENU_GESTURE_HINT;

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
      className={`relative inline-flex flex-shrink-0 ${className}`}
      onKeyDown={handleKeyDown}
    >
      {/* Keep the button surface clipped by the shared border. The popup is a
          sibling so it can escape that clip without making the corner radius
          depend on the buttons' own backgrounds — and so the right-click and
          press-and-hold handlers below cover the button surface only, leaving
          an already-open menu to close normally rather than re-opening. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- gesture augmentation of the native buttons inside; keyboard parity is the group's onKeyDown plus the platform context-menu key, which arrives as contextmenu */}
      <div
        className={`fp-button-group cy-no-select ${btnSizes.groupContainer}`}
        onContextMenu={handleContextMenu}
        onTouchStart={handleTouchStart}
        onTouchMove={longPressHandlers.onTouchMove}
        onTouchEnd={longPressHandlers.onTouchEnd}
        onTouchCancel={longPressHandlers.onTouchCancel}
      >
        {/* Main Button */}
        <button
          ref={mainRef}
          type="button"
          onClick={handleMainClick}
          disabled={mainButtonDisabled}
          aria-disabled={mainActionDisabled || undefined}
          title={hideMenuButton ? collapsedTitle : mainTitle}
          aria-haspopup={hideMenuButton ? "listbox" : undefined}
          aria-expanded={hideMenuButton ? isOpen : undefined}
          className={`${baseButtonClass} ${variantClass} ${btnSizes.splitButtonMain} font-medium rounded-none ${
            hideMenuButton ? "relative gap-1" : ""
          } ${mainActionDisabled ? disabledClass : ""}`}
        >
          {mainLabel}
          {hideMenuButton && badgeElement}
          {/* Flyout marker: the standard toolbar hint that a hidden menu is
              attached. Absolutely positioned so it costs no layout width —
              which is the entire point of collapsing the chevron away. */}
          {hideMenuButton && (
            <span
              aria-hidden="true"
              data-testid="split-button-flyout-marker"
              className="pointer-events-none absolute bottom-[2px] right-[2px] h-0 w-0 border-b-4 border-l-4 border-b-current border-l-transparent opacity-70"
            />
          )}
        </button>

        {!hideMenuButton && (
          <>
            {/* Separator — mirrors VS Code's monaco-button-dropdown-separator:
                outer div fills with button background (padding creates the inset),
                inner 1px div is the visible hairline using --vscode-button-separator */}
            <div
              className={`${separatorClass} ${btnSizes.separatorPy} flex-shrink-0`}
            >
              <div className="w-px h-full bg-current opacity-40" />
            </div>

            {/* Dropdown Trigger */}
            <button
              ref={triggerRef}
              type="button"
              onClick={toggleDropdown}
              disabled={menuDisabled}
              title={dropdownTitle}
              aria-label={dropdownAriaLabel}
              aria-haspopup="listbox"
              aria-expanded={isOpen}
              className={`${baseButtonClass} ${variantClass} ${btnSizes.splitButtonDropdown} rounded-none ${
                menuDisabled ? disabledClass : ""
              } ${isOpen ? "bg-btn-secondary-hover" : ""}`}
            >
              {badgeElement}
              {dropdownIcon || defaultChevron}
            </button>
          </>
        )}
      </div>

      {/* Dropdown Menu */}
      <div
        ref={dropdownRef}
        role="listbox"
        className={`absolute top-full left-0 mt-1 min-w-[200px] bg-dropdown-bg border border-dropdown-border rounded shadow-lg z-floating overflow-hidden transition-all duration-150 origin-top ${isOpen ? "opacity-100 translate-y-0 visible" : "opacity-0 -translate-y-1 invisible pointer-events-none"}`}
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
              className={`fp-dropdown-row w-full text-left px-3 py-2 text-sm transition-colors flex items-center justify-between gap-2 ${
                option.disabled
                  ? "opacity-50 cursor-not-allowed text-disabled-fg"
                  : "text-dropdown-fg hover:bg-list-hover-bg hover:text-list-highlight-fg cursor-pointer"
              } ${focusedIndex === index ? "bg-dropdown-selected-bg text-list-active-fg fp-dropdown-row-selected" : ""}`}
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
