import React from "react";
import { formatTime } from "@utils/outputUtils";

type StatusSeverity = "info" | "warning" | "error";

interface StatusMessageProps {
  message: string;
  severity?: StatusSeverity;
  timestamp?: string;
  timestampMs?: number;
  className?: string;
}

/**
 * StatusMessage Component
 *
 * Displays info/warning/error messages with proper icons and colors.
 * Uses VS Code theme variables for consistent styling.
 */
export const StatusMessage: React.FC<StatusMessageProps> = ({
  message,
  severity = "info",
  timestamp,
  timestampMs,
  className = "",
}) => {
  // Compute timestamp display
  const displayTime =
    timestamp || (timestampMs ? formatTime(timestampMs) : null);

  // Severity-based styling classes
  const getSeverityClass = (): string => {
    switch (severity) {
      case "error":
        return "status-error";
      case "warning":
        return "status-warning";
      default:
        return "status-info";
    }
  };

  return (
    <div className={`status-message ${getSeverityClass()} ${className}`}>
      {displayTime && <span className="status-time">[{displayTime}]</span>}
      <span className="status-text">{message}</span>
    </div>
  );
};
