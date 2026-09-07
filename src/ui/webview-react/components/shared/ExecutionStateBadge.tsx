import React from "react";
import {
  getExecutionStateBadgeClass,
  getExecutionStateBadgeIcon,
} from "../../utils/status";
import { Icon } from "./Icon";

interface ExecutionStateBadgeProps {
  state: string;
  /**
   * Compact layouts render the state's codicon instead of its text. The icon
   * stays inside the coloured badge so the state is still readable at a
   * glance — an unwrapped icon inherits the row's foreground colour and loses
   * the only signal a narrow row has left.
   */
  isNarrow?: boolean;
  className?: string;
}

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
  className = "",
}) => (
  <span
    className={`inline-flex items-center rounded px-1.5 py-px text-xs font-semibold uppercase ${getExecutionStateBadgeClass(state)} ${className}`}
    title={isNarrow ? state : undefined}
    role="status"
  >
    {isNarrow ? <Icon name={getExecutionStateBadgeIcon(state)} /> : state}
  </span>
);
