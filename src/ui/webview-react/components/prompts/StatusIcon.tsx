import React from "react";
import { STEP_STATUS, type StepStatus } from "../../types/messages";
import { getStatusColorClass } from "@utils/status";
import { Icon } from "../shared/Icon";

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
          colorClass: getStatusColorClass(STEP_STATUS.PENDING),
        };
      case STEP_STATUS.SENT:
        return {
          icon: "codicon-arrow-up",
          colorClass: getStatusColorClass(STEP_STATUS.SENT),
        };
      case STEP_STATUS.RUNNING:
        return {
          icon: "codicon-play",
          colorClass: getStatusColorClass(STEP_STATUS.RUNNING),
        };
      case STEP_STATUS.COMPLETED:
        return {
          icon: "codicon-pass",
          colorClass: getStatusColorClass(STEP_STATUS.COMPLETED),
        };
      case STEP_STATUS.FAILED:
        return {
          icon: "codicon-error",
          colorClass: getStatusColorClass(STEP_STATUS.FAILED),
        };
      case STEP_STATUS.CANCELLED:
        return {
          icon: "codicon-circle-slash",
          colorClass: getStatusColorClass(STEP_STATUS.CANCELLED),
        };
      case STEP_STATUS.SKIPPED:
        return {
          icon: "codicon-debug-step-over",
          colorClass: getStatusColorClass(STEP_STATUS.SKIPPED),
        };
      default:
        return {
          icon: "codicon-circle-outline",
          colorClass: getStatusColorClass(STEP_STATUS.PENDING),
        };
    }
  };

  const { icon, colorClass } = getIconConfig();

  return (
    <Icon
      name={icon}
      className={`${colorClass} text-sm ${className}`}
      aria-label={disabled ? "disabled" : status}
    />
  );
};
