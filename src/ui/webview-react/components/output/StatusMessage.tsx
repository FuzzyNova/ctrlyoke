import React from "react";

type StatusSeverity = "info" | "warning" | "error";

interface StatusMessageProps {
  message: string;
  severity?: StatusSeverity;
  timestamp?: number;
  className?: string;
}

export const StatusMessage: React.FC<StatusMessageProps> = ({
  message,
  severity = "info",
  timestamp,
  className = "",
}) => {
  const getSeverityStyles = () => {
    switch (severity) {
      case "error":
        return "bg-red-50 dark:bg-red-900 dark:bg-opacity-20 border-red-200 dark:border-red-800 text-red-800 dark:text-red-200";
      case "warning":
        return "bg-yellow-50 dark:bg-yellow-900 dark:bg-opacity-20 border-yellow-200 dark:border-yellow-800 text-yellow-800 dark:text-yellow-200";
      default:
        return "bg-blue-50 dark:bg-blue-900 dark:bg-opacity-20 border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-200";
    }
  };

  const getSeverityIcon = () => {
    switch (severity) {
      case "error":
        return (
          <svg
            className="w-5 h-5 flex-shrink-0"
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
              clipRule="evenodd"
            />
          </svg>
        );
      case "warning":
        return (
          <svg
            className="w-5 h-5 flex-shrink-0"
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path
              fillRule="evenodd"
              d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
              clipRule="evenodd"
            />
          </svg>
        );
      default:
        return (
          <svg
            className="w-5 h-5 flex-shrink-0"
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path
              fillRule="evenodd"
              d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
              clipRule="evenodd"
            />
          </svg>
        );
    }
  };

  const formatTimestamp = (ts: number) => {
    const date = new Date(ts);
    return date.toLocaleTimeString();
  };

  return (
    <div
      className={`flex items-start gap-3 p-3 border rounded-md ${getSeverityStyles()} ${className}`}
    >
      {getSeverityIcon()}
      <div className="flex-1 min-w-0">
        <p className="text-sm">{message}</p>
        {timestamp && (
          <p className="text-xs mt-1 opacity-75">
            {formatTimestamp(timestamp)}
          </p>
        )}
      </div>
    </div>
  );
};
