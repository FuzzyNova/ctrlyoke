import React from "react";
import { STEP_STATUS, type StepStatus } from "../../types/messages";

interface StatusIconProps {
  status: StepStatus;
  disabled?: boolean;
  className?: string;
}

/**
 * StatusIcon - Renders codicon icons for prompt status states
 *
 * Uses VS Code's codicon font for proper theme integration.
 * Color classes use CSS variables for VS Code theme compatibility.
 */
export const StatusIcon: React.FC<StatusIconProps> = ({
  status,
  disabled = false,
  className = "",
}) => {
  // Map status to codicon class name and color
  const getIconConfig = (): { icon: string; colorClass: string } => {
    if (disabled) {
      return {
        icon: "codicon-circle-slash",
        colorClass: "text-disabled-fg",
      };
    }
    switch (status) {
      case STEP_STATUS.PENDING:
        return {
          icon: "codicon-circle-outline",
          colorClass: "text-description-fg",
        };
      case STEP_STATUS.SENT:
        return {
          icon: "codicon-arrow-up",
          colorClass: "text-charts-blue",
        };
      case STEP_STATUS.RUNNING:
        return {
          icon: "codicon-play",
          colorClass: "text-charts-blue",
        };
      case STEP_STATUS.COMPLETED:
        return {
          icon: "codicon-pass",
          colorClass: "text-indicator-success",
        };
      case STEP_STATUS.FAILED:
        return {
          icon: "codicon-error",
          colorClass: "text-indicator-error",
        };
      case STEP_STATUS.CANCELLED:
        return {
          icon: "codicon-circle-slash",
          colorClass: "text-description-fg",
        };
      case STEP_STATUS.SKIPPED:
        return {
          icon: "codicon-debug-step-over",
          colorClass: "text-description-fg",
        };
      default:
        return {
          icon: "codicon-circle-outline",
          colorClass: "text-description-fg",
        };
    }
  };

  const { icon, colorClass } = getIconConfig();

  return (
    <i
      className={`codicon ${icon} ${colorClass} text-sm ${className}`}
      aria-label={disabled ? "disabled" : status}
    />
  );
};
