import React, { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/**
 * Optional props that enable the per-item hide/show feature.
 * When `namespace` is not provided the component renders exactly as before.
 */
export interface HideableProps {
  /** Enables the hide feature. Omit to render exactly as before. */
  namespace?: string;
  /** Hidden values for this namespace — read from uiStore at the call site. */
  hiddenValues?: string[];
  /** Called when the user clicks the eye-closed (hide) button on a visible row. */
  onHideOption?: (value: string) => void;
  /** Called when the user clicks the eye (unhide) button on a hidden row. */
  onUnhideOption?: (value: string) => void;
  /**
   * Values that never get a hide button (sentinel / structural options).
   * Defaults to ["default", ""] when omitted.
   */
  nonHideableValues?: string[];
}

interface CustomSelectProps extends HideableProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  className?: string;
  /** Max height of the open dropdown panel. Defaults to "60vh". */
  dropdownMaxHeight?: string;
  /** When true, renders the list inline without a trigger button. Used in FooterQuickPicker. */
  inline?: boolean;
}

const DEFAULT_NON_HIDEABLE = ["default", ""];

/**
 * Custom styled select dropdown that matches the VS Code theme.
 * Replaces native <select> elements whose browser-rendered popup cannot be
 * themed with CSS custom properties.
 *
 * The popup is rendered via a portal at document.body with position:fixed so
 * it escapes any overflow:hidden ancestors and is never clipped.
 *
 * When `namespace` is supplied, each row gains a hover-only eye-closed button
 * that lets users hide individual options. Hidden options are collected in a
 * collapsible "Show hidden" footer section at the bottom of the open dropdown.
 */
export const CustomSelect: React.FC<CustomSelectProps> = ({
  id,
  value,
  onChange,
  options,
  disabled = false,
  className = "",
  namespace,
  hiddenValues = [],
  onHideOption,
  onUnhideOption,
  nonHideableValues,
  dropdownMaxHeight = "60vh",
  inline = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [popupPos, setPopupPos] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    width: number;
  } | null>(null);

  const hideEnabled = namespace !== undefined;
  const nonHideable = nonHideableValues ?? DEFAULT_NON_HIDEABLE;

  const selectedOption = options.find((o) => o.value === value);

  // Split options into visible and hidden lists
  const visibleOptions = hideEnabled
    ? options.filter((o) => !hiddenValues.includes(o.value))
    : options;
  const hiddenOptions = hideEnabled
    ? options.filter((o) => hiddenValues.includes(o.value))
    : [];

  const handleSelect = (optValue: string) => {
    onChange(optValue);
    setIsOpen(false);
    setShowHidden(false);
  };

  // Clicking a hidden row label: select AND unhide
  const handleSelectHidden = (optValue: string) => {
    onUnhideOption?.(optValue);
    onChange(optValue);
    setIsOpen(false);
    setShowHidden(false);
  };

  const handleToggle = () => {
    if (!disabled) {
      setIsOpen((prev) => {
        if (prev) setShowHidden(false); // reset when closing
        return !prev;
      });
    }
  };

  const updatePosition = useCallback(() => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom - 4;
      if (spaceBelow >= 80) {
        setPopupPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
      } else {
        setPopupPos({ bottom: window.innerHeight - rect.top + 4, left: rect.left, width: rect.width });
      }
    }
  }, []);

  // Compute/update position whenever the popup opens or the window moves
  useEffect(() => {
    if (isOpen) {
      updatePosition();
      window.addEventListener("resize", updatePosition);
      window.addEventListener("scroll", updatePosition, true);
      return () => {
        window.removeEventListener("resize", updatePosition);
        window.removeEventListener("scroll", updatePosition, true);
      };
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
        setIsOpen(false);
        setShowHidden(false);
      }
    };

    if (!inline && isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen, inline]);

  const canHide = (option: SelectOption) =>
    hideEnabled &&
    !nonHideable.includes(option.value) &&
    option.value !== value && // never hide the currently-selected value
    !option.disabled;

  // ── Shared parts ─────────────────────────────────────────────────────────
  const scrollableList = (
    <div className="overflow-y-auto min-h-0 flex-1">
      {/* Visible options */}
      {visibleOptions.map((option) => {
        const isSelected = value === option.value;
        return (
          <div
            key={option.value}
            className={`group w-full flex items-center focus:outline-none border-none ${
              isSelected
                ? "bg-dropdown-selected-bg text-list-active-fg"
                : option.disabled
                  ? "opacity-50 cursor-not-allowed"
                  : "hover:bg-list-hover-bg hover:text-list-highlight-fg cursor-pointer"
            }`}
          >
            <button
              type="button"
              onClick={() => !option.disabled && handleSelect(option.value)}
              disabled={option.disabled}
              className="flex-1 min-w-0 px-2 py-1.5 text-xs text-left focus:outline-none border-none bg-transparent cursor-inherit disabled:cursor-not-allowed"
            >
              {option.label}
            </button>
            {/* Eye-closed hide button — hover-only, excluded on selected/non-hideable/disabled */}
            {canHide(option) && (
              <button
                type="button"
                title="Hide this option"
                onClick={(e) => {
                  e.stopPropagation();
                  onHideOption?.(option.value);
                }}
                className="flex-shrink-0 px-1.5 py-1.5 opacity-0 group-hover:opacity-100 focus:opacity-100 text-description-fg hover:text-foreground focus:outline-none border-none bg-transparent transition-opacity"
              >
                <i className="codicon codicon-eye-closed text-[11px]" />
              </button>
            )}
          </div>
        );
      })}

      {/* Separator + hidden section (inside scroll area) */}
      {hideEnabled && showHidden && hiddenOptions.length > 0 && (
        <>
          <div className="border-t border-dropdown-border my-0" />
          {hiddenOptions.map((option) => (
            <div
              key={option.value}
              className="group w-full flex items-center opacity-60 italic hover:bg-list-hover-bg cursor-pointer"
            >
              {/* Eye icon at far left — primary unhide action */}
              <button
                type="button"
                title="Unhide this option"
                onClick={(e) => {
                  e.stopPropagation();
                  onUnhideOption?.(option.value);
                }}
                className="flex-shrink-0 px-1.5 py-1.5 text-description-fg hover:text-foreground focus:outline-none border-none bg-transparent"
              >
                <i className="codicon codicon-eye text-[11px]" />
              </button>
              {/* Clicking label: select AND unhide */}
              <button
                type="button"
                onClick={() => handleSelectHidden(option.value)}
                className="flex-1 min-w-0 pr-2 py-1.5 text-xs text-left text-description-fg focus:outline-none border-none bg-transparent cursor-pointer"
              >
                {option.label}
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  );

  const toggleBar = (atTop: boolean) =>
    hideEnabled ? (
      <div
        className={`${atTop ? "border-b" : "border-t"} border-dropdown-border bg-editor-bg flex-shrink-0`}
      >
        <button
          type="button"
          disabled={hiddenOptions.length === 0}
          onClick={() => setShowHidden((s) => !s)}
          className="w-full px-2 py-1.5 text-xs text-center text-description-fg disabled:opacity-40 hover:enabled:bg-list-hover-bg focus:outline-none border-none bg-transparent transition-colors"
        >
          {showHidden
            ? "Hide hidden"
            : hiddenOptions.length > 0
              ? `Show hidden (${hiddenOptions.length})`
              : "Show hidden"}
        </button>
      </div>
    ) : null;

  // ── Inline mode (FooterQuickPicker — drop-up, toggle bar at top) ──────────
  if (inline) {
    return (
      <div
        className={`flex flex-col w-full ${className}`}
        style={{ maxHeight: dropdownMaxHeight }}
      >
        {toggleBar(true)}
        {scrollableList}
      </div>
    );
  }

  // ── Trigger + dropdown mode ───────────────────────────────────────────────
  return (
    <div className={`relative inline-block w-full ${className}`}>
      <button
        ref={buttonRef}
        id={id}
        type="button"
        disabled={disabled}
        onClick={handleToggle}
        className="w-full px-2 py-1 text-xs bg-dropdown-bg text-dropdown-fg border border-dropdown-border rounded focus:outline-none focus:border-focus-border text-left flex items-center justify-between h-7 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <span className="truncate">{selectedOption?.label ?? value}</span>
        <i
          className={`codicon codicon-chevron-${isOpen ? "up" : "down"} text-[10px] flex-shrink-0 ml-1`}
        />
      </button>

      {isOpen && !disabled && popupPos &&
        createPortal(
          <div
            ref={popupRef}
            className="fixed bg-dropdown-bg border border-dropdown-border z-[9999] shadow-lg flex flex-col"
            style={{
              top: popupPos.top,
              bottom: popupPos.bottom,
              left: popupPos.left,
              width: popupPos.width,
              maxHeight: dropdownMaxHeight,
            }}
          >
            {scrollableList}
            {toggleBar(false)}
          </div>,
          document.body
        )}
    </div>
  );
};
