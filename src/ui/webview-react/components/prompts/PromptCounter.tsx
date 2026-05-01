import React from "react";
import { useWorkflowStore } from "../../store/workflowStore";
import { STEP_STATUS } from "../../types/messages";
import { isWorkflowActive } from "../../utils/status";

interface PromptCounterProps {
  className?: string;
  narrow?: boolean;
}

/**
 * PromptCounter - Shows prompt progress during workflow execution
 *
 * Display modes:
 * - During execution: "N of M" format with optional percentage
 * - When idle: "N prompts" format or empty if no prompts
 */
export const PromptCounter: React.FC<PromptCounterProps> = ({
  className = "",
  narrow = false,
}) => {
  const { steps: prompts, totalSteps, executionState } = useWorkflowStore();

  // Calculate completed count based on prompt statuses
  const completedCount = prompts.filter(
    (p) => (p as any).status === STEP_STATUS.COMPLETED
  ).length;

  // Determine if workflow is active
  const isActive = isWorkflowActive(executionState);

  // Don't show anything if no prompts
  if (totalSteps === 0) {
    return null;
  }

  // During execution: Show "Completed N of M" (or "N/M" when narrow)
  if (isActive && totalSteps > 0) {
    return (
      <span className={`text-xs text-description-fg ${className}`}>
        {narrow
          ? `${completedCount}/${totalSteps}`
          : `Completed ${completedCount} of ${totalSteps}`}
      </span>
    );
  }

  // Idle state: Show count (or just the number when narrow)
  return (
    <span className={`text-xs text-description-fg ${className}`}>
      {narrow
        ? totalSteps
        : `${totalSteps} ${totalSteps === 1 ? "step" : "steps"}`}
    </span>
  );
};
