import React from "react";
import { useWorkflowStore } from "@store/workflowStore";
import { usePromptStatus } from "@hooks/index";
import { STEP_STATUS } from "@/types/messages";
import { isWorkflowActive } from "@utils/status";
import { useMultiSelectionCount } from "@store/editorStore";

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
  const getPromptStatus = usePromptStatus();
  const selectedCount = useMultiSelectionCount();

  if (selectedCount > 1) {
    return (
      <span className={`text-xs text-description-fg ${className}`}>
        {selectedCount} selected
      </span>
    );
  }

  const statusCounts = prompts.reduce(
    (counts, prompt, index) => {
      const status = getPromptStatus(prompt, index);
      counts[status] = (counts[status] ?? 0) + 1;
      return counts;
    },
    {
      [STEP_STATUS.COMPLETED]: 0,
      [STEP_STATUS.FAILED]: 0,
      [STEP_STATUS.SKIPPED]: 0,
      [STEP_STATUS.CANCELLED]: 0,
      [STEP_STATUS.RUNNING]: 0,
      [STEP_STATUS.SENT]: 0,
      [STEP_STATUS.PENDING]: 0,
    } as Record<string, number>
  );

  // Calculate completed count based on prompt statuses
  const completedCount = statusCounts[STEP_STATUS.COMPLETED];
  const tooltipParts = [
    `Completed: ${statusCounts[STEP_STATUS.COMPLETED]}`,
    `Failed: ${statusCounts[STEP_STATUS.FAILED]}`,
    `Skipped: ${statusCounts[STEP_STATUS.SKIPPED]}`,
    `Cancelled: ${statusCounts[STEP_STATUS.CANCELLED]}`,
    `Running: ${statusCounts[STEP_STATUS.RUNNING]}`,
    `Sent: ${statusCounts[STEP_STATUS.SENT]}`,
    `Pending: ${statusCounts[STEP_STATUS.PENDING]}`,
  ];
  const tooltip = tooltipParts.join(" | ");

  // Determine if workflow is active
  const isActive = isWorkflowActive(executionState);

  // Don't show anything if no prompts
  if (totalSteps === 0) {
    return null;
  }

  // During execution: Show "Completed N of M" (or "N/M" when narrow)
  if (isActive && totalSteps > 0) {
    return (
      <span
        className={`text-xs text-description-fg ${className}`}
        title={tooltip}
      >
        {narrow
          ? `${completedCount}/${totalSteps}`
          : `Completed ${completedCount} of ${totalSteps}`}
      </span>
    );
  }

  // Idle state: Show count (or just the number when narrow)
  return (
    <span
      className={`text-xs text-description-fg ${className}`}
      title={tooltip}
    >
      {narrow
        ? totalSteps
        : `${totalSteps} ${totalSteps === 1 ? "step" : "steps"}`}
    </span>
  );
};
