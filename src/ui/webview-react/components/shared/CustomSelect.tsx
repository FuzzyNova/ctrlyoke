import React, { useState, useRef } from "react";
import { useDropdownPortalPosition } from "@hooks/useDropdownPortalPosition";
import { useClickOutside } from "@hooks/useClickOutside";
import { useHideableOptions } from "@hooks/useHideableOptions";
import { DropdownPortal } from "./DropdownPortal";
import { DropdownHiddenToggle } from "./DropdownHiddenToggle";

export interface SelectOption {
  value: string;
  label: string;
  /** Optional muted secondary text rendered below the label in the menu. */
  description?: string;
  disabled?: boolean;
}

const OPTION_DESCRIPTION_MAX_LENGTH = 120;

function truncateOptionDescription(description: string): string {
  if (description.length <= OPTION_DESCRIPTION_MAX_LENGTH) {
    return description;
  }
  return `${description.slice(0, OPTION_DESCRIPTION_MAX_LENGTH - 3).trimEnd()}...`;
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
  triggerAriaLabel?: string;
  triggerTitle?: string;
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
  triggerAriaLabel,
  triggerTitle,
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

  const nonHideable = nonHideableValues ?? DEFAULT_NON_HIDEABLE;

  const selectedOption = options.find((o) => o.value === value);

  // Split options into visible and hidden lists
  const {
    hideEnabled,
    visible: visibleOptions,
    hidden: hiddenOptions,
  } = useHideableOptions(options, (o) => o.value, hiddenValues, namespace);

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

  const popupPos = useDropdownPortalPosition(
    buttonRef,
    isOpen,
    dropdownMaxHeight
  );
  useClickOutside(
    [buttonRef, popupRef],
    isOpen,
    () => {
      setIsOpen(false);
      setShowHidden(false);
    },
    !inline
  );

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
                ? "bg-dropdown-selected-bg text-list-active-fg fp-dropdown-row-selected"
                : option.disabled
                  ? "opacity-50 cursor-not-allowed"
                  : "hover:bg-list-hover-bg hover:text-list-highlight-fg cursor-pointer fp-dropdown-row"
            }`}
          >
            <button
              type="button"
              onClick={() => !option.disabled && handleSelect(option.value)}
              disabled={option.disabled}
              className="flex-1 min-w-0 px-2 py-1.5 text-xs text-left focus:outline-none border-none bg-transparent cursor-inherit disabled:cursor-not-allowed"
            >
              <span className="flex flex-col min-w-0">
                <span className="truncate">{option.label}</span>
                {option.description && (
                  <span
                    title={option.description}
                    className="text-xxs text-description-fg truncate"
                  >
                    {truncateOptionDescription(option.description)}
                  </span>
                )}
              </span>
            </button>
            {/* Eye-closed hide button — hover-only, excluded on selected/non-hideable/disabled */}
            {canHide(option) && (
              <button
                type="button"
                title="Hide this option"
                aria-label="Hide this option"
                onClick={(e) => {
                  e.stopPropagation();
                  onHideOption?.(option.value);
                }}
                className="flex-shrink-0 px-1.5 py-1.5 opacity-0 group-hover:opacity-100 focus:opacity-100 text-description-fg hover:text-foreground focus:outline-none border-none bg-transparent transition-opacity"
              >
                <i className="codicon codicon-eye-closed text-xs" />
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
              className="group w-full flex items-center opacity-60 italic hover:bg-list-hover-bg cursor-pointer fp-dropdown-row"
            >
              {/* Eye icon at far left — primary unhide action */}
              <button
                type="button"
                title="Unhide this option"
                aria-label="Unhide this option"
                onClick={(e) => {
                  e.stopPropagation();
                  onUnhideOption?.(option.value);
                }}
                className="flex-shrink-0 px-1.5 py-1.5 text-description-fg hover:text-foreground focus:outline-none border-none bg-transparent"
              >
                <i className="codicon codicon-eye text-xs" />
              </button>
              {/* Clicking label: select AND unhide */}
              <button
                type="button"
                onClick={() => handleSelectHidden(option.value)}
                className="flex-1 min-w-0 pr-2 py-1.5 text-xs text-left text-description-fg focus:outline-none border-none bg-transparent cursor-pointer"
              >
                <span className="flex flex-col min-w-0">
                  <span className="truncate">{option.label}</span>
                  {option.description && (
                    <span
                      title={option.description}
                      className="text-xxs truncate"
                    >
                      {truncateOptionDescription(option.description)}
                    </span>
                  )}
                </span>
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  );

  const toggleBar = () =>
    hideEnabled ? (
      <DropdownHiddenToggle
        hiddenCount={hiddenOptions.length}
        showHidden={showHidden}
        onToggle={() => setShowHidden((s) => !s)}
      />
    ) : null;

  // ── Inline mode (FooterQuickPicker) ───────────────────────────────────────
  if (inline) {
    return (
      <div className={`flex flex-col flex-1 min-h-0 w-full ${className}`}>
        {scrollableList}
        {toggleBar()}
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
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={triggerAriaLabel}
        title={triggerTitle}
        className="fp-select-trigger fp-dropdown-row"
      >
        <span className="truncate">{selectedOption?.label ?? value}</span>
        <i
          className={`codicon codicon-chevron-${isOpen ? "up" : "down"} text-xxs flex-shrink-0 ml-1`}
        />
      </button>

      {!disabled && (
        <DropdownPortal isOpen={isOpen} popupPos={popupPos} ref={popupRef}>
          {scrollableList}
          {toggleBar()}
        </DropdownPortal>
      )}
    </div>
  );
};
