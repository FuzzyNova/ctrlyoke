import React from "react";

type StepStatus =
  | "pending"
  | "sent"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

interface StatusIconProps {
  status: StepStatus;
  className?: string;
}

export const StatusIcon: React.FC<StatusIconProps> = ({
  status,
  className = "",
}) => {
  const getIcon = () => {
    switch (status) {
      case "pending":
        return (
          <svg
            className={`w-5 h-5 text-gray-400 ${className}`}
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
      case "sent":
        return (
          <svg
            className={`w-5 h-5 text-blue-500 ${className}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
            />
          </svg>
        );
      case "running":
        return (
          <svg
            className={`w-5 h-5 text-blue-600 animate-spin ${className}`}
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
            className={`w-5 h-5 text-green-500 ${className}`}
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
      case "failed":
        return (
          <svg
            className={`w-5 h-5 text-red-500 ${className}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        );
      case "cancelled":
        return (
          <svg
            className={`w-5 h-5 text-gray-500 ${className}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
            />
          </svg>
        );
      default:
        return null;
    }
  };

  return <div className="flex-shrink-0">{getIcon()}</div>;
};
