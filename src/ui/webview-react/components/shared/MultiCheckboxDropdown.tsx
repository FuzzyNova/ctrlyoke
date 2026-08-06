import React, { useEffect, useState, useRef } from "react";
import { useDropdownPortalPosition } from "@hooks/useDropdownPortalPosition";
import { useClickOutside } from "@hooks/useClickOutside";
import { useHideableOptions } from "@hooks/useHideableOptions";
import { DropdownPortal } from "./DropdownPortal";
import { DropdownHiddenToggle } from "./DropdownHiddenToggle";
import { constrainPopupToViewport } from "@utils/dropdownUtils";
import {
  dropdownBorderClass,
  dropdownWarningClass,
} from "@utils/dropdownValidation";
import type { HideableProps } from "./CustomSelect";

const DEFAULT_NON_HIDEABLE = ["default", ""];

interface MultiCheckboxDropdownOption {
  value: string;
  label: string;
  description?: string;
  group?: string;
}

export interface MultiCheckboxDropdownProps extends HideableProps {
  id: string;
  selectedValues: string[];
  onChange: (values: string[]) => void;
  options: MultiCheckboxDropdownOption[];
  placeholder?: string;
  buttonLabel?: string;
  className?: string;
  /** Max height of the open dropdown panel. Defaults to "60vh". */
  dropdownMaxHeight?: string;
  /**
   * Minimum popup width in pixels, for option/group labels wider than the
   * trigger button (which sizes to its own short button label). Omit to keep
   * the popup matching the trigger's width exactly, as before.
   */
  dropdownMinWidth?: number;
  /** Soft validation message for values unavailable in the current workspace. */
  warning?: string;
}

/**
 * MultiCheckboxDropdown - Multi-select dropdown with checkbox items.
 *
 * Used by WorkflowPropertiesPanel (workflow-level skills) and PropertiesDrawer (prompt-level skills).
 * The popup is rendered via a portal at document.body with position:fixed so
 * it escapes any overflow:hidden ancestors and is never clipped.
 *
 * When `namespace` is supplied, each row gains a hover-only eye-closed button.
 * Hiding a currently-checked value auto-unchecks it (no hidden-checked state).
 */
export const MultiCheckboxDropdown: React.FC<MultiCheckboxDropdownProps> = ({
  id,
  selectedValues,
  onChange,
  options,
  placeholder = "Select...",
  buttonLabel: buttonLabelOverride,
  className = "w-full",
  namespace,
  hiddenValues = [],
  onHideOption,
  onUnhideOption,
  nonHideableValues,
  dropdownMaxHeight = "60vh",
  dropdownMinWidth,
  warning,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const nonHideable = nonHideableValues ?? DEFAULT_NON_HIDEABLE;
  const {
    hideEnabled,
    visible: visibleOptions,
    hidden: hiddenOptions,
  } = useHideableOptions(options, (o) => o.value, hiddenValues, namespace);

  const rawPos = useDropdownPortalPosition(buttonRef, isOpen, dropdownMaxHeight);
  const popupPos =
    rawPos && dropdownMinWidth
      ? (() => {
          const constrained = constrainPopupToViewport({
            left: rawPos.left,
            width: rawPos.width,
            minWidth: Math.max(rawPos.width ?? 0, dropdownMinWidth),
            preferredWidth: dropdownMinWidth,
          });
          return {
            top: rawPos.top,
            bottom: rawPos.bottom,
            left: constrained.left,
            width: constrained.width,
            minWidth: constrained.minWidth,
            maxWidth: constrained.maxWidth,
            maxHeight: rawPos.maxHeight,
          };
        })()
      : rawPos;
  useClickOutside([buttonRef, popupRef], isOpen, () => {
    setIsOpen(false);
    setShowHidden(false);
  });

  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;

      event.stopPropagation();
      setIsOpen(false);
      setShowHidden(false);
    };

    // Capture Escape before document-level drawer/dropdown listeners see it.
    document.addEventListener("keydown", handleEscape, true);
    return () => document.removeEventListener("keydown", handleEscape, true);
  }, [isOpen]);

  const toggleValue = (value: string) => {
    if (selectedValues.includes(value)) {
      onChange(selectedValues.filter((v) => v !== value));
    } else {
      onChange([...selectedValues, value]);
    }
  };

  const handleHide = (value: string) => {
    // Auto-uncheck if currently selected
    if (selectedValues.includes(value)) {
      onChange(selectedValues.filter((v) => v !== value));
    }
    onHideOption?.(value);
  };

  // Unhide + check simultaneously when clicking a hidden row
  const handleUnhideAndCheck = (value: string) => {
    onUnhideOption?.(value);
    if (!selectedValues.includes(value)) {
      onChange([...selectedValues, value]);
    }
  };

  const canHide = (value: string) =>
    hideEnabled && !nonHideable.includes(value);

  const renderVisibleOption = (option: MultiCheckboxDropdownOption) => {
    const isSelected = selectedValues.includes(option.value);
    return (
      <div
        key={option.value}
        className={`group w-full flex items-start focus:outline-none border-none cursor-pointer ${
          isSelected
            ? "bg-dropdown-selected-bg text-list-active-fg fp-dropdown-row-selected"
            : "hover:bg-list-hover-bg hover:text-list-highlight-fg fp-dropdown-row"
        }`}
      >
        <button
          type="button"
          onClick={() => toggleValue(option.value)}
          className="flex-1 min-w-0 px-2 py-1.5 text-xs text-left flex items-start gap-2 focus:outline-none border-none bg-transparent cursor-pointer"
        >
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => {}}
            aria-hidden={true}
            className="mt-0.5 w-3 h-3 flex-shrink-0 accent-focus-border cursor-pointer"
            tabIndex={-1}
          />
          <span className="flex flex-col min-w-0">
            <span className="font-medium truncate">{option.label}</span>
            {option.description && (
              <span className="text-xxs text-description-fg truncate">
                {option.description}
              </span>
            )}
          </span>
        </button>
        {/* Eye-closed hide button — hover-only */}
        {canHide(option.value) && (
          <button
            type="button"
            title="Hide this option"
            aria-label="Hide this option"
            onClick={(e) => {
              e.stopPropagation();
              handleHide(option.value);
            }}
            className="flex-shrink-0 self-center px-1.5 py-1.5 opacity-0 group-hover:opacity-100 focus:opacity-100 text-description-fg hover:text-foreground focus:outline-none border-none bg-transparent transition-opacity"
          >
            <i className="codicon codicon-eye-closed text-xs" />
          </button>
        )}
      </div>
    );
  };

  const ungroupedOptions = visibleOptions.filter(
    (option) => option.group === undefined
  );
  const groupedOptions: Array<{
    group: string;
    options: MultiCheckboxDropdownOption[];
  }> = [];
  const groupsByName = new Map<string, (typeof groupedOptions)[number]>();
  for (const option of visibleOptions) {
    if (option.group === undefined) continue;
    let group = groupsByName.get(option.group);
    if (!group) {
      group = { group: option.group, options: [] };
      groupsByName.set(option.group, group);
      groupedOptions.push(group);
    }
    group.options.push(option);
  }

  // "Select all" / "select none" header — toggles every visible option
  // (ungrouped and grouped alike), mirroring the per-group toggle below.
  const allVisibleValues = visibleOptions.map((option) => option.value);
  const allSelectedCount = allVisibleValues.filter((value) =>
    selectedValues.includes(value)
  ).length;
  const isAllSelected =
    allVisibleValues.length > 0 && allSelectedCount === allVisibleValues.length;
  const isAllPartiallySelected = allSelectedCount > 0 && !isAllSelected;

  const toggleAll = () => {
    if (isAllSelected) {
      onChange(
        selectedValues.filter((value) => !allVisibleValues.includes(value))
      );
    } else {
      onChange([
        ...selectedValues,
        ...allVisibleValues.filter((value) => !selectedValues.includes(value)),
      ]);
    }
  };

  // Build button label from visible (non-hidden) selected values only
  const visibleSelected = selectedValues.filter(
    (v) => !hiddenValues.includes(v)
  );
  const buttonLabel =
    buttonLabelOverride ??
    (visibleSelected.length === 0
      ? placeholder
      : visibleSelected.length === 1
        ? (options.find((option) => option.value === visibleSelected[0])
            ?.label ?? visibleSelected[0])
        : visibleSelected.length === 2
          ? visibleSelected
              .map(
                (value) =>
                  options.find((option) => option.value === value)?.label ??
                  value
              )
              .join(", ")
          : `${visibleSelected
              .slice(0, 2)
              .map(
                (value) =>
                  options.find((option) => option.value === value)?.label ??
                  value
              )
              .join(", ")} +${visibleSelected.length - 2}`);

  return (
    <div className={`relative inline-block ${className}`}>
      <button
        ref={buttonRef}
        id={id}
        type="button"
        onClick={() =>
          setIsOpen((prev) => {
            if (prev) setShowHidden(false);
            return !prev;
          })
        }
        className={`fp-select-trigger fp-dropdown-row ${dropdownBorderClass(warning)}`}
      >
        <span className="truncate">
          {visibleSelected.length === 0 ? (
            <span className="text-description-fg">{placeholder}</span>
          ) : (
            buttonLabel
          )}
        </span>
        <i
          className={`codicon codicon-chevron-${isOpen ? "up" : "down"} text-xxs flex-shrink-0 ml-1`}
        />
      </button>
      {warning && (
        <span
          className={`text-xxs mt-0.5 block ${dropdownWarningClass(warning)}`}
        >
          {warning}
        </span>
      )}

      <DropdownPortal isOpen={isOpen} popupPos={popupPos} ref={popupRef}>
        {/* Show hidden toggle — at top when expanding upward (end-cap is the visual end) */}
        {popupPos?.bottom !== undefined && hideEnabled && (
          <DropdownHiddenToggle
            hiddenCount={hiddenOptions.length}
            showHidden={showHidden}
            onToggle={() => setShowHidden((s) => !s)}
            dividerSide="bottom"
          />
        )}

        {/* Scrollable options area */}
        <div className="overflow-y-auto min-h-0 flex-1">
          {visibleOptions.length > 1 && (
            <button
              type="button"
              role="checkbox"
              aria-checked={
                isAllPartiallySelected
                  ? "mixed"
                  : isAllSelected
                    ? "true"
                    : "false"
              }
              aria-label={`All (${allSelectedCount}/${allVisibleValues.length})`}
              onClick={toggleAll}
              className="sticky top-0 z-20 flex h-7 w-full flex-shrink-0 items-center gap-2 border-b border-dropdown-border bg-dropdown-bg px-2 text-left text-xs cursor-pointer"
            >
              <input
                type="checkbox"
                checked={isAllSelected}
                ref={(element) => {
                  if (element) {
                    element.indeterminate = isAllPartiallySelected;
                  }
                }}
                onChange={() => {}}
                aria-hidden={true}
                tabIndex={-1}
                className="w-3 h-3 flex-shrink-0 accent-focus-border cursor-pointer"
              />
              <span className="font-medium truncate flex-1">All</span>
              <span className="text-xxs text-description-fg flex-shrink-0">
                {allSelectedCount}/{allVisibleValues.length}
              </span>
            </button>
          )}

          {visibleOptions.length === 0 && !hideEnabled ? (
            <div className="px-3 py-2 text-xs text-description-fg">
              No skills available
            </div>
          ) : visibleOptions.some((option) => option.group !== undefined) ? (
            <>
              {ungroupedOptions.map(renderVisibleOption)}
              {groupedOptions.map((group) => {
                const groupValues = group.options.map((option) => option.value);
                const selectedCount = groupValues.filter((value) =>
                  selectedValues.includes(value)
                ).length;
                const isFullySelected = selectedCount === groupValues.length;
                const isPartiallySelected =
                  selectedCount > 0 && !isFullySelected;

                const toggleGroup = () => {
                  if (isFullySelected) {
                    onChange(
                      selectedValues.filter(
                        (value) => !groupValues.includes(value)
                      )
                    );
                  } else {
                    onChange([
                      ...selectedValues,
                      ...groupValues.filter(
                        (value) => !selectedValues.includes(value)
                      ),
                    ]);
                  }
                };

                return (
                  <React.Fragment key={group.group}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={
                        isPartiallySelected
                          ? "mixed"
                          : isFullySelected
                            ? "true"
                            : "false"
                      }
                      aria-label={`${group.group} (${selectedCount}/${groupValues.length})`}
                      onClick={toggleGroup}
                      className="sticky top-7 z-10 flex h-7 w-full items-center gap-2 border-b border-dropdown-border bg-dropdown-bg px-2 text-left text-xs cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={isFullySelected}
                        ref={(element) => {
                          if (element) {
                            element.indeterminate = isPartiallySelected;
                          }
                        }}
                        onChange={() => {}}
                        aria-hidden={true}
                        tabIndex={-1}
                        className="w-3 h-3 flex-shrink-0 accent-focus-border cursor-pointer"
                      />
                      <span className="font-medium truncate flex-1">
                        {group.group}
                      </span>
                      <span className="text-xxs text-description-fg flex-shrink-0">
                        {selectedCount}/{groupValues.length}
                      </span>
                    </button>
                    {group.options.map(renderVisibleOption)}
                  </React.Fragment>
                );
              })}
            </>
          ) : (
            visibleOptions.map(renderVisibleOption)
          )}

          {/* Hidden section (inside scroll area) */}
          {hideEnabled && showHidden && hiddenOptions.length > 0 && (
            <>
              <div className="border-t border-dropdown-border my-0" />
              {hiddenOptions.map((option) => {
                const isSelected = selectedValues.includes(option.value);
                return (
                  <div
                    key={option.value}
                    className="group w-full flex items-start opacity-60 italic hover:bg-list-hover-bg cursor-pointer fp-dropdown-row"
                  >
                    {/* Eye icon at far left — unhide action */}
                    <button
                      type="button"
                      title="Unhide this option"
                      aria-label="Unhide this option"
                      onClick={(e) => {
                        e.stopPropagation();
                        onUnhideOption?.(option.value);
                      }}
                      className="flex-shrink-0 self-center px-1.5 py-1.5 text-description-fg hover:text-foreground focus:outline-none border-none bg-transparent"
                    >
                      <i className="codicon codicon-eye text-xs" />
                    </button>
                    {/* Clicking checkbox or label: unhide + check */}
                    <button
                      type="button"
                      onClick={() => handleUnhideAndCheck(option.value)}
                      className="flex-1 min-w-0 pr-2 py-1.5 text-xs text-left flex items-start gap-2 focus:outline-none border-none bg-transparent cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => {}}
                        aria-hidden={true}
                        className="mt-0.5 w-3 h-3 flex-shrink-0 accent-focus-border cursor-pointer"
                        tabIndex={-1}
                      />
                      <span className="flex flex-col min-w-0">
                        <span className="font-medium truncate text-description-fg">
                          {option.label}
                        </span>
                        {option.description && (
                          <span className="text-xxs text-description-fg truncate">
                            {option.description}
                          </span>
                        )}
                      </span>
                    </button>
                  </div>
                );
              })}
            </>
          )}
        </div>

        {/* Show hidden toggle — at bottom when expanding downward */}
        {popupPos?.top !== undefined && hideEnabled && (
          <DropdownHiddenToggle
            hiddenCount={hiddenOptions.length}
            showHidden={showHidden}
            onToggle={() => setShowHidden((s) => !s)}
          />
        )}
      </DropdownPortal>
    </div>
  );
};
