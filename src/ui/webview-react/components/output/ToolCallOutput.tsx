import React from "react";

interface ToolCallOutputProps {
  toolName: string;
  args?: Record<string, any>;
  result?: string;
  status?: "pending" | "running" | "completed" | "failed";
  className?: string;
}

export const ToolCallOutput: React.FC<ToolCallOutputProps> = ({
  toolName,
  args,
  result,
  status = "completed",
  className = "",
}) => {
  const getStatusIcon = () => {
    switch (status) {
      case "running":
        return (
          <svg
            className="w-4 h-4 text-blue-500 animate-spin"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
        );
      case "completed":
        return (
          <svg
            className="w-4 h-4 text-green-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5 13l4 4L19 7"
            />
          </svg>
        );
      case "failed":
        return (
          <svg
            className="w-4 h-4 text-red-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        );
      default:
        return (
          <svg
            className="w-4 h-4 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        );
    }
  };

  return (
    <div
      className={`border border-gray-200 dark:border-gray-700 rounded-md p-3 ${className}`}
    >
      <div className="flex items-start gap-2">
        {getStatusIcon()}
        <div className="flex-1">
          <div className="font-medium text-sm text-gray-900 dark:text-gray-100">
            {toolName}
          </div>
          {args && Object.keys(args).length > 0 && (
            <div className="mt-2 font-mono text-xs text-gray-600 dark:text-gray-400">
              <pre className="whitespace-pre-wrap">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}
          {result && (
            <div className="mt-2 text-sm text-gray-700 dark:text-gray-300">
              {result}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
