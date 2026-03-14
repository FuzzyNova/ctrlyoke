import React, { useState, useEffect, useRef } from "react";
import type { HideableProps } from "./CustomSelect";

const DEFAULT_NON_HIDEABLE = ["default", ""];

export interface MultiCheckboxDropdownProps extends HideableProps {
  id: string;
  selectedValues: string[];
  onChange: (values: string[]) => void;
  options: Array<{ value: string; label: string; description?: string }>;
  placeholder?: string;
  /** Max height of the open dropdown panel. Defaults to "60vh". */
  dropdownMaxHeight?: string;
}

/**
 * MultiCheckboxDropdown - Multi-select dropdown with checkbox items.
 *
 * Used by SettingsDrawer (workflow-level skills) and PropertiesDrawer (prompt-level skills).
 * Closes on outside click. Uses the same Tailwind tokens as HarnessDropdown.
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
  namespace,
  hiddenValues = [],
  onHideOption,
  onUnhideOption,
  nonHideableValues,
  dropdownMaxHeight = "60vh",
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const hideEnabled = namespace !== undefined;
  const nonHideable = nonHideableValues ?? DEFAULT_NON_HIDEABLE;

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
        setShowHidden(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
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

  // Split into visible and hidden
  const visibleOptions = hideEnabled
    ? options.filter((o) => !hiddenValues.includes(o.value))
    : options;
  const hiddenOptions = hideEnabled
    ? options.filter((o) => hiddenValues.includes(o.value))
    : [];

  // Build button label from visible (non-hidden) selected values only
  const visibleSelected = selectedValues.filter(
    (v) => !hiddenValues.includes(v)
  );
  const buttonLabel =
    visibleSelected.length === 0
      ? placeholder
      : visibleSelected.length === 1
        ? visibleSelected[0]
        : visibleSelected.length === 2
          ? visibleSelected.join(", ")
          : `${visibleSelected.slice(0, 2).join(", ")} +${visibleSelected.length - 2}`;

  return (
    <div className="relative inline-block w-full" ref={containerRef}>
      <button
        id={id}
        type="button"
        onClick={() =>
          setIsOpen((prev) => {
            if (prev) setShowHidden(false);
            return !prev;
          })
        }
        className="w-full px-2 py-1 text-xs bg-dropdown-bg text-dropdown-fg border border-dropdown-border rounded focus:outline-none focus:border-focus-border text-left flex items-center justify-between h-7"
      >
        <span className="truncate">
          {visibleSelected.length === 0 ? (
            <span className="text-description-fg">{placeholder}</span>
          ) : (
            buttonLabel
          )}
        </span>
        <i
          className={`codicon codicon-chevron-${isOpen ? "up" : "down"} text-[10px] flex-shrink-0 ml-1`}
        />
      </button>

      <div
        className={`absolute top-full left-0 right-0 mt-0 bg-dropdown-bg border border-dropdown-border z-50 shadow-lg transition-all duration-150 origin-top flex flex-col ${isOpen ? "opacity-100 translate-y-0 visible" : "opacity-0 -translate-y-1 invisible pointer-events-none"}`}
        style={{ maxHeight: dropdownMaxHeight }}
      >
        {/* Scrollable options area */}
        <div className="overflow-y-auto min-h-0 flex-1">
          {visibleOptions.length === 0 && !hideEnabled ? (
            <div className="px-3 py-2 text-xs text-description-fg">
              No skills available
            </div>
          ) : (
            visibleOptions.map((option) => {
              const isSelected = selectedValues.includes(option.value);
              return (
                <div
                  key={option.value}
                  className={`group w-full flex items-start focus:outline-none border-none cursor-pointer ${
                    isSelected
                      ? "bg-dropdown-selected-bg text-list-active-fg"
                      : "hover:bg-list-hover-bg hover:text-list-highlight-fg"
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
                      className="mt-0.5 w-3 h-3 flex-shrink-0 accent-focus-border cursor-pointer"
                      tabIndex={-1}
                    />
                    <span className="flex flex-col min-w-0">
                      <span className="font-medium truncate">
                        {option.label}
                      </span>
                      {option.description && (
                        <span className="text-[10px] text-description-fg truncate">
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
                      onClick={(e) => {
                        e.stopPropagation();
                        handleHide(option.value);
                      }}
                      className="flex-shrink-0 self-center px-1.5 py-1.5 opacity-0 group-hover:opacity-100 focus:opacity-100 text-description-fg hover:text-foreground focus:outline-none border-none bg-transparent transition-opacity"
                    >
                      <i className="codicon codicon-eye-closed text-[11px]" />
                    </button>
                  )}
                </div>
              );
            })
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
                    className="group w-full flex items-start opacity-60 italic hover:bg-list-hover-bg cursor-pointer"
                  >
                    {/* Eye icon at far left — unhide action */}
                    <button
                      type="button"
                      title="Unhide this option"
                      onClick={(e) => {
                        e.stopPropagation();
                        onUnhideOption?.(option.value);
                      }}
                      className="flex-shrink-0 self-center px-1.5 py-1.5 text-description-fg hover:text-foreground focus:outline-none border-none bg-transparent"
                    >
                      <i className="codicon codicon-eye text-[11px]" />
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
                        className="mt-0.5 w-3 h-3 flex-shrink-0 accent-focus-border cursor-pointer"
                        tabIndex={-1}
                      />
                      <span className="flex flex-col min-w-0">
                        <span className="font-medium truncate text-description-fg">
                          {option.label}
                        </span>
                        {option.description && (
                          <span className="text-[10px] text-description-fg truncate">
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

        {/* Footer toggle — pinned at bottom, outside scroll area */}
        {hideEnabled && (
          <div className="border-t border-dropdown-border bg-editor-bg flex-shrink-0">
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
        )}
      </div>
    </div>
  );
};
