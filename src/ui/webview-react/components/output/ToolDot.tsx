import React from "react";
import {
  TOOL_RESULT_STATUSES,
  type ToolResultStatus,
} from "@root/types/DashboardConstants";

const DOT_COLORS: Record<ToolResultStatus, string> = {
  [TOOL_RESULT_STATUSES.PENDING]: "text-editor-fg",
  [TOOL_RESULT_STATUSES.SUCCESS]: "text-indicator-success",
  [TOOL_RESULT_STATUSES.ERROR]: "text-indicator-error",
};

/** Coloured ● bullet that reflects the operation status. */
export const ToolDot: React.FC<{ status: ToolResultStatus }> = ({ status }) => (
  <span className={DOT_COLORS[status]}>●</span>
);
