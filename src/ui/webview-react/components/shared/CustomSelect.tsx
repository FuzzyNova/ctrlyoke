import React, { useId, useState, useRef } from "react";
import { useDropdownPortalPosition } from "@hooks/useDropdownPortalPosition";
import { useClickOutside } from "@hooks/useClickOutside";
import { useHideableOptions } from "@hooks/useHideableOptions";
import { DropdownPortal } from "./DropdownPortal";
import { DropdownHiddenToggle } from "./DropdownHiddenToggle";
import {
  dropdownBorderClass,
  dropdownWarningClass,
  dropdownWarningIcon,
  type ValidationSeverity,
} from "@utils/dropdownValidation";
import { Icon } from "./Icon";
import type { SelectOption as SharedSelectOption } from "@root/types/SelectOption";
import {
  schemaAriaLabel,
  schemaOptionTitle,
  schemaTitle,
} from "@utils/schemaPropertyLabels";

interface CustomSelectOption extends SharedSelectOption {
  /** Optional className override for the description text (defaults to muted). */
  descriptionClassName?: string;
}

export type { SelectOption } from "@root/types/SelectOption";

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
  options: CustomSelectOption[];
  disabled?: boolean;
  className?: string;
  triggerAriaLabel?: string;
  ariaRequired?: boolean;
  onBlur?: () => void;
  triggerTitle?: string;
  /** Schema property represented by this select. */
  schemaPath?: string;
  /** Max height of the open dropdown panel. Defaults to "60vh". */
  dropdownMaxHeight?: string;
  /** When true, renders the list inline without a trigger button. Used in FooterQuickPicker. */
  inline?: boolean;
  /** Validation message for a value unavailable in the current workspace. */
  warning?: string;
  /**
   * How `warning` is painted. Defaults to the soft yellow treatment; pass
   * "error" for a combination that cannot run at all (see
   * dev/implemented/DROPDOWN_VALIDATION_STYLING_PLAN.md).
   */
  warningSeverity?: ValidationSeverity;
  /** Id of the message that explains the warning to assistive technology. */
  warningId?: string;
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
  ariaRequired,
  onBlur,
  triggerTitle,
  schemaPath,
  namespace,
  hiddenValues = [],
  onHideOption,
  onUnhideOption,
  nonHideableValues,
  dropdownMaxHeight = "60vh",
  inline = false,
  warning,
  warningSeverity,
  warningId,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const reactId = useId();
  const listboxId = id
    ? `${id}-listbox`
    : `custom-select-listbox-${reactId.replace(/:/g, "")}`;
  const [showHidden, setShowHidden] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const nonHideable = nonHideableValues ?? DEFAULT_NON_HIDEABLE;

  const selectedOption = options.find((o) => o.value === value);
  const triggerLabel = triggerAriaLabel ?? selectedOption?.label ?? value;
  const optionSchemaPath = (option: CustomSelectOption) =>
    option.schemaPath ?? schemaPath;
  const optionTitle = (option: CustomSelectOption) => {
    const path = optionSchemaPath(option);
    if (!schemaPath || !path) {
      return schemaOptionTitle(option.label, option.description);
    }
    return schemaOptionTitle(
      option.label,
      option.description,
      path,
      option.pseudo ?? option.value
    );
  };
  const optionAriaLabel = (option: CustomSelectOption) => {
    const path = optionSchemaPath(option);
    if (!schemaPath || !path) return undefined;
    return schemaAriaLabel(option.label, path, option.pseudo ?? option.value);
  };

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

  const canHide = (option: CustomSelectOption) =>
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
            className={`group w-full flex items-center focus:outline-hidden border-none ${
              isSelected
                ? "bg-dropdown-selected-bg text-list-active-fg cy-dropdown-row-selected"
                : option.disabled
                  ? "opacity-50 cursor-not-allowed"
                  : "hover:bg-list-hover-bg hover:text-list-highlight-fg cursor-pointer cy-dropdown-row"
            }`}
          >
            <button
              type="button"
              onClick={() => !option.disabled && handleSelect(option.value)}
              disabled={option.disabled}
              aria-label={optionAriaLabel(option)}
              title={optionTitle(option)}
              className="flex-1 min-w-0 px-2 py-1.5 text-xs text-left focus:outline-hidden border-none bg-transparent cursor-inherit disabled:cursor-not-allowed"
            >
              <span className="flex flex-col min-w-0">
                <span className="truncate">{option.label}</span>
                {option.description && (
                  <span
                    className={`text-xxs truncate ${option.descriptionClassName ?? "text-description-fg"}`}
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
                className="shrink-0 px-1.5 py-1.5 opacity-0 group-hover:opacity-100 focus:opacity-100 text-description-fg hover:text-foreground focus:outline-hidden border-none bg-transparent transition-opacity"
              >
                <Icon name="eye-closed" className="text-xs" />
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
              className="group w-full flex items-center opacity-60 italic hover:bg-list-hover-bg cursor-pointer cy-dropdown-row"
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
                className="shrink-0 px-1.5 py-1.5 text-description-fg hover:text-foreground focus:outline-hidden border-none bg-transparent"
              >
                <Icon name="eye" className="text-xs" />
              </button>
              {/* Clicking label: select AND unhide */}
              <button
                type="button"
                onClick={() => handleSelectHidden(option.value)}
                aria-label={optionAriaLabel(option)}
                title={optionTitle(option)}
                className="flex-1 min-w-0 pr-2 py-1.5 text-xs text-left text-description-fg focus:outline-hidden border-none bg-transparent cursor-pointer"
              >
                <span className="flex flex-col min-w-0">
                  <span className="truncate">{option.label}</span>
                  {option.description && (
                    <span
                      className={`text-xxs truncate ${option.descriptionClassName ?? ""}`}
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
        aria-controls={listboxId}
        onBlur={onBlur}
        aria-label={
          schemaPath
            ? schemaAriaLabel(
                `${triggerLabel}${ariaRequired ? " (required)" : ""}`,
                schemaPath
              )
            : ariaRequired
              ? `${triggerAriaLabel ?? triggerLabel} (required)`
              : triggerAriaLabel
        }
        aria-describedby={warning ? warningId : undefined}
        title={
          schemaPath
            ? schemaTitle(schemaPath, undefined, triggerTitle)
            : triggerTitle
        }
        className={`cy-select-trigger cy-dropdown-row ${dropdownBorderClass(
          warning,
          warningSeverity
        )}`}
      >
        <span className="truncate">{selectedOption?.label ?? value}</span>
        <Icon
          name={`chevron-${isOpen ? "up" : "down"}`}
          className="text-xxs shrink-0 ml-1"
        />
      </button>
      {warning && (
        <span
          id={warningId}
          className={`text-xxs mt-0.5 flex items-start gap-1 ${dropdownWarningClass(
            warning,
            warningSeverity
          )}`}
        >
          <Icon
            name={dropdownWarningIcon(warningSeverity)}
            className="mt-px shrink-0"
          />
          {warning}
        </span>
      )}

      {!disabled && (
        <DropdownPortal
          isOpen={isOpen}
          popupPos={popupPos}
          ref={popupRef}
          id={listboxId}
          role="listbox"
        >
          {scrollableList}
          {toggleBar()}
        </DropdownPortal>
      )}
    </div>
  );
};
