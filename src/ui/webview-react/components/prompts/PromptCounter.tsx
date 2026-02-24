import React from "react";
import { useWorkflowStore } from "../../store/workflowStore";
import { EXECUTION_STATES } from "../../types/messages";

interface PromptCounterProps {
  className?: string;
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
}) => {
  const { prompts, totalSteps, executionState } = useWorkflowStore();

  // Calculate completed count based on prompt statuses
  const completedCount = prompts.filter((p) => p.status === "completed").length;

  // Determine if workflow is actively running
  const isRunning =
    executionState === EXECUTION_STATES.RUNNING ||
    executionState === EXECUTION_STATES.PAUSED;

  // Don't show anything if no prompts
  if (totalSteps === 0) {
    return null;
  }

  // During execution: Show "Completed N of M"
  if (isRunning && totalSteps > 0) {
    return (
      <span
        className={`text-xs text-description-fg ${className}`}
      >
        Completed {completedCount} of {totalSteps}
      </span>
    );
  }

  // Idle state: Just show count
  return (
    <span
      className={`text-xs text-description-fg ${className}`}
    >
      {totalSteps} {totalSteps === 1 ? "prompt" : "prompts"}
    </span>
  );
};
