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
    <div className={`border rounded-md ${className}`}>
      <button
        onClick={handleToggle}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-list-hover-bg transition-colors"
      >
        <span className="font-medium text-foreground">{title}</span>
        <svg
          className={`w-5 h-5 text-description-fg transition-transform ${
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

      {isExpanded && <div className="px-4 py-3 border-t">{children}</div>}
    </div>
  );
};
