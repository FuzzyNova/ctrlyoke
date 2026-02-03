import React, { useState } from "react";

interface CollapsibleProps {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  defaultExpanded?: boolean;
  className?: string;
  onToggle?: (isOpen: boolean) => void;
}

export const Collapsible: React.FC<CollapsibleProps> = ({
  title,
  children,
  defaultExpanded = false,
  defaultOpen = false,
  className = "",
  onToggle,
}) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded || defaultOpen);

  const handleToggle = () => {
    const newState = !isExpanded;
    setIsExpanded(newState);
    if (onToggle) {
      onToggle(newState);
    }
  };

  return (
    <div
      className={`border border-gray-200 dark:border-gray-700 rounded-md ${className}`}
    >
      <button
        onClick={handleToggle}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
      >
        <span className="font-medium text-gray-900 dark:text-gray-100">
          {title}
        </span>
        <svg
          className={`w-5 h-5 text-gray-500 transition-transform ${
            isExpanded ? "transform rotate-180" : ""
          }`}
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
      </button>

      {isExpanded && (
        <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700">
          {children}
        </div>
      )}
    </div>
  );
};
