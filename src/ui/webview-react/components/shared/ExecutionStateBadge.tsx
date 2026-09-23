import React from "react";
import {
  getExecutionStateBadgeClass,
  getExecutionStateBadgeIcon,
} from "../../utils/status";
import { Icon } from "./Icon";
import { EXECUTION_STATES } from "@root/types/DashboardConstants";

interface ExecutionStateBadgeProps {
  state: string;
  /**
   * Compact layouts render the state's codicon instead of its text. The icon
   * stays inside the coloured badge so the state is still readable at a
   * glance — an unwrapped icon inherits the row's foreground colour and loses
   * the only signal a narrow row has left.
   */
  isNarrow?: boolean;
  /**
   * The run was prepared but has executed nothing. Relabels only the IDLE
   * pill — any other state already says more than "not started" would.
   */
  unstarted?: boolean;
  className?: string;
}

const UNSTARTED_LABEL = "not started";

/**
 * ExecutionStateBadge - the uppercase state pill shared by the workflow
 * dropdown rows, the run panel rows, and the WorkflowStatus header.
 *
 * Single source for badge colour, casing, and narrow icon fallback so those
 * surfaces cannot drift apart.
 */
export const ExecutionStateBadge: React.FC<ExecutionStateBadgeProps> = ({
  state,
  isNarrow = false,
  unstarted = false,
  className = "",
}) => {
  const label =
    unstarted && state === EXECUTION_STATES.IDLE ? UNSTARTED_LABEL : state;
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-px text-xs font-semibold uppercase ${getExecutionStateBadgeClass(state)} ${className}`}
      title={isNarrow ? label : undefined}
      role="status"
    >
      {isNarrow ? <Icon name={getExecutionStateBadgeIcon(state)} /> : label}
    </span>
  );
};
