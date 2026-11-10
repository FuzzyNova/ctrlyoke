import React from "react";
import { STEP_STATUS, type StepStatus } from "../../types/messages";
import { getStatusColorClass, getStatusIconClass } from "@utils/status";
import { Icon } from "../shared/Icon";

interface StatusIconProps {
  status: StepStatus;
  disabled?: boolean;
  className?: string;
  /**
   * Pulse the icon (same `animate-pulse-custom` keyframes as
   * `ExecutingStepHighlight`) while running. Opt-in per call site — a
   * parallel group's members lose their individual highlight border in favor
   * of one surrounding the whole group, so their running icon needs to carry
   * more of the "this is active" signal on its own.
   */
  animate?: boolean;
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
  animate = false,
}) => {
  // Map status to codicon class name and color
  const getIconConfig = (): { icon: string; colorClass: string } => {
    if (disabled) {
      return {
        icon: "codicon-circle-slash",
        colorClass: "text-disabled-fg",
      };
    }
    return {
      icon: getStatusIconClass(status),
      colorClass: getStatusColorClass(status),
    };
  };

  const { icon, colorClass } = getIconConfig();
  const pulseClass =
    animate && !disabled && status === STEP_STATUS.RUNNING
      ? "animate-pulse-custom"
      : "";

  return (
    <Icon
      name={icon}
      className={`${colorClass} text-sm ${pulseClass} ${className}`}
      aria-label={disabled ? "disabled" : status}
    />
  );
};
