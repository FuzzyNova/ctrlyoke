import React, { useState, useEffect, useRef } from "react";

export interface MultiCheckboxDropdownProps {
  id: string;
  selectedValues: string[];
  onChange: (values: string[]) => void;
  options: Array<{ value: string; label: string; description?: string }>;
  placeholder?: string;
}

/**
 * MultiCheckboxDropdown - Multi-select dropdown with checkbox items.
 *
 * Used by SettingsDrawer (workflow-level skills) and PropertiesDrawer (prompt-level skills).
 * Closes on outside click. Uses the same Tailwind tokens as HarnessDropdown.
 */
export const MultiCheckboxDropdown: React.FC<MultiCheckboxDropdownProps> = ({
  id,
  selectedValues,
  onChange,
  options,
  placeholder = "Select...",
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const toggleValue = (value: string) => {
    if (selectedValues.includes(value)) {
      onChange(selectedValues.filter((v) => v !== value));
    } else {
      onChange([...selectedValues, value]);
    }
  };

  // Build button label
  const buttonLabel =
    selectedValues.length === 0
      ? placeholder
      : selectedValues.length === 1
        ? selectedValues[0]
        : selectedValues.length === 2
          ? selectedValues.join(", ")
          : `${selectedValues.slice(0, 2).join(", ")} +${selectedValues.length - 2}`;

  return (
    <div className="relative inline-block w-full" ref={containerRef}>
      <button
        id={id}
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-2 py-1 text-xs bg-dropdown-bg text-dropdown-fg border border-dropdown-border rounded focus:outline-none focus:border-focus-border text-left flex items-center justify-between h-7"
      >
        <span className="truncate">
          {selectedValues.length === 0 ? (
            <span className="text-description-fg">{placeholder}</span>
          ) : (
            buttonLabel
          )}
        </span>
        <i
          className={`codicon codicon-chevron-${isOpen ? "up" : "down"} text-[10px] flex-shrink-0 ml-1`}
        />
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 right-0 mt-0 bg-dropdown-bg border border-dropdown-border z-50 shadow-lg max-h-48 overflow-y-auto">
          {options.length === 0 ? (
            <div className="px-3 py-2 text-xs text-description-fg">
              No skills available
            </div>
          ) : (
            options.map((option) => {
              const isSelected = selectedValues.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => toggleValue(option.value)}
                  className={`w-full px-2 py-1.5 text-xs text-left flex items-start gap-2 focus:outline-none border-none cursor-pointer ${
                    isSelected
                      ? "bg-dropdown-selected-bg text-list-active-fg"
                      : "hover:bg-list-hover-bg hover:text-list-highlight-fg"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => {}}
                    className="mt-0.5 w-3 h-3 flex-shrink-0 accent-focus-border cursor-pointer"
                    tabIndex={-1}
                  />
                  <span className="flex flex-col min-w-0">
                    <span className="font-medium truncate">{option.label}</span>
                    {option.description && (
                      <span className="text-[10px] text-description-fg truncate">
                        {option.description}
                      </span>
                    )}
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};
