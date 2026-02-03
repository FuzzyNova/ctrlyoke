import React from "react";
import { StatusIcon } from "./StatusIcon";

interface PromptItemProps {
  prompt: {
    id?: string;
    prompt: string;
    status:
      | "pending"
      | "sent"
      | "running"
      | "completed"
      | "failed"
      | "cancelled";
    retryCount?: number;
  };
  index: number;
  isCurrent?: boolean;
  onClick?: () => void;
}

export const PromptItem: React.FC<PromptItemProps> = ({
  prompt,
  index,
  isCurrent = false,
  onClick,
}) => {
  const getPromptPreview = (text: string, maxLength: number = 80) => {
    const singleLine = text.replace(/\s+/g, " ").trim();
    return singleLine.length > maxLength
      ? singleLine.substring(0, maxLength) + "..."
      : singleLine;
  };

  return (
    <div
      onClick={onClick}
      className={`flex items-start gap-3 p-3 rounded-md transition-colors cursor-pointer ${
        isCurrent
          ? "bg-blue-50 dark:bg-blue-900 dark:bg-opacity-20 border-l-4 border-blue-500"
          : "hover:bg-gray-50 dark:hover:bg-gray-800"
      }`}
    >
      {/* Status Icon */}
      <StatusIcon status={prompt.status} />

      {/* Prompt Details */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
            {prompt.id || `Prompt ${index + 1}`}
          </span>
          {prompt.retryCount !== undefined && prompt.retryCount > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-orange-100 dark:bg-orange-900 text-orange-700 dark:text-orange-300">
              Retry {prompt.retryCount}
            </span>
          )}
        </div>
        <p className="text-sm text-gray-700 dark:text-gray-300">
          {getPromptPreview(prompt.prompt)}
        </p>
      </div>
    </div>
  );
};
