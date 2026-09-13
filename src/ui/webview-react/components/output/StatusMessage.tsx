import React from "react";
import { formatTime } from "@utils/outputUtils";
import type { StatusMessageSeverity } from "../../types/messages";

interface StatusMessageProps {
  message: React.ReactNode;
  severity?: StatusMessageSeverity;
  timestamp?: string;
  timestampMs?: number;
  className?: string;
}

const SEVERITY_STYLES = {
  info: {
    container: "bg-severity-info-bg border-l-severity-info",
    text: "text-severity-info",
  },
  warning: {
    container: "bg-severity-warning-bg border-l-severity-warning",
    text: "text-severity-warning",
  },
  error: {
    container: "bg-severity-error-bg border-l-severity-error",
    text: "text-severity-error",
  },
} as const;

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

  const styles = SEVERITY_STYLES[severity];

  return (
    <div
      className={`py-[var(--spacing-xs)] px-[var(--spacing-md)] my-[var(--spacing-xs)] border-l-[3px] rounded-sm text-[length:var(--cy-output-font-size-sm)] text-[var(--fg-primary)] flex items-start min-w-0 gap-[var(--spacing-sm)] ${styles.container} ${className}`}
    >
      {displayTime && (
        <span className="text-[var(--fg-secondary)] text-[length:var(--cy-output-font-size-xs)] shrink-0">
          [{displayTime}]
        </span>
      )}
      <span
        className={`font-medium min-w-0 break-words [overflow-wrap:anywhere] ${styles.text}`}
      >
        {message}
      </span>
    </div>
  );
};
