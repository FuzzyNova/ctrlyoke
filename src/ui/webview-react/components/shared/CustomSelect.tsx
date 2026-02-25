import React, { useState, useEffect, useRef } from "react";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface CustomSelectProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  className?: string;
}

/**
 * Custom styled select dropdown that matches the VS Code theme.
 * Replaces native <select> elements whose browser-rendered popup cannot be
 * themed with CSS custom properties.
 */
export const CustomSelect: React.FC<CustomSelectProps> = ({
  id,
  value,
  onChange,
  options,
  disabled = false,
  className = "",
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((o) => o.value === value);

  const handleSelect = (optValue: string) => {
    onChange(optValue);
    setIsOpen(false);
  };

  const handleToggle = () => {
    if (!disabled) {
      setIsOpen((prev) => !prev);
    }
  };

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
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  return (
    <div
      className={`relative inline-block w-full ${className}`}
      ref={containerRef}
    >
      <button
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

      {isOpen && (
        <div className="absolute top-full left-0 right-0 mt-0 bg-dropdown-bg border border-dropdown-border z-50 shadow-lg">
          {options.map((option) => {
            const isSelected = value === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => !option.disabled && handleSelect(option.value)}
                disabled={option.disabled}
                className={`w-full px-2 py-1.5 text-xs text-left flex items-center focus:outline-none border-none ${
                  isSelected
                    ? "bg-dropdown-selected-bg text-list-active-fg"
                    : "hover:bg-list-hover-bg hover:text-list-highlight-fg"
                } ${
                  option.disabled
                    ? "opacity-50 cursor-not-allowed"
                    : "cursor-pointer"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
