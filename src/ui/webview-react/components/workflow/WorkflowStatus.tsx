import React from "react";

type ExecutionState = "idle" | "running" | "paused" | "completed" | "error";

interface WorkflowStatusProps {
  workflowName: string | null;
  executionState: ExecutionState;
  className?: string;
}

export const WorkflowStatus: React.FC<WorkflowStatusProps> = ({
  workflowName,
  executionState,
  className = "",
}) => {
  const getStateColor = (state: ExecutionState) => {
    switch (state) {
      case "running":
        return "text-blue-600 dark:text-blue-400";
      case "paused":
        return "text-yellow-600 dark:text-yellow-400";
      case "completed":
        return "text-green-600 dark:text-green-400";
      case "error":
        return "text-red-600 dark:text-red-400";
      default:
        return "text-gray-600 dark:text-gray-400";
    }
  };

  const getStateIcon = (state: ExecutionState) => {
    switch (state) {
      case "running":
        return (
          <svg
            className="w-4 h-4 animate-spin"
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
      case "paused":
        return (
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
              d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        );
      case "completed":
        return (
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
              d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        );
      case "error":
        return (
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
              d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        );
      default:
        return null;
    }
  };

  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <div className="flex-1 min-w-0">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate">
          {workflowName || "No workflow loaded"}
        </h2>
      </div>
      {executionState !== "idle" && (
        <div
          className={`flex items-center gap-2 ${getStateColor(executionState)}`}
        >
          {getStateIcon(executionState)}
          <span className="text-sm font-medium capitalize">
            {executionState}
          </span>
        </div>
      )}
    </div>
  );
};
