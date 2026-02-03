import React, { useState, useRef, useEffect } from "react";
import { Button } from "./Button";

interface SplitButtonOption {
  label: string;
  value: string;
  onClick: () => void;
}

interface SplitButtonProps {
  mainLabel: string;
  mainAction: () => void;
  options: SplitButtonOption[];
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
}

export const SplitButton: React.FC<SplitButtonProps> = ({
  mainLabel,
  mainAction,
  options,
  variant = "primary",
  disabled = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleOptionClick = (option: SplitButtonOption) => {
    option.onClick();
    setIsOpen(false);
  };

  return (
    <div className="relative inline-flex" ref={dropdownRef}>
      <Button
        variant={variant}
        onClick={mainAction}
        disabled={disabled}
        className="rounded-r-none border-r border-opacity-30"
      >
        {mainLabel}
      </Button>
      <Button
        variant={variant}
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled}
        className="rounded-l-none px-2"
        aria-label="More options"
      >
        <svg
          className="w-4 h-4"
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
      </Button>

      {isOpen && (
        <div className="absolute top-full mt-1 right-0 min-w-[200px] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg z-50">
          {options.map((option, index) => (
            <button
              key={option.value}
              onClick={() => handleOptionClick(option)}
              className={`w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors ${
                index === 0 ? "rounded-t-md" : ""
              } ${index === options.length - 1 ? "rounded-b-md" : ""}`}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
