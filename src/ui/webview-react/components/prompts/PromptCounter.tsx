import React from "react";

interface PromptCounterProps {
  completed: number;
  total: number;
  className?: string;
}

export const PromptCounter: React.FC<PromptCounterProps> = ({
  completed,
  total,
  className = "",
}) => {
  return (
    <div
      className={`inline-flex items-center gap-2 px-3 py-1 bg-gray-100 dark:bg-gray-800 rounded-full ${className}`}
    >
      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
        Completed {completed} of {total}
      </span>
      {total > 0 && (
        <span className="text-xs text-gray-500 dark:text-gray-400">
          ({Math.round((completed / total) * 100)}%)
        </span>
      )}
    </div>
  );
};
