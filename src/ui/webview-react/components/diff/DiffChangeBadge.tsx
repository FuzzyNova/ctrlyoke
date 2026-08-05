import React from "react";
import { DIFF_CHANGE_COLOR, DIFF_CHANGE_LABEL } from "./diffChangeType";
import type { DiffChangeType } from "@root/types/DashboardConstants";

export interface DiffChangeBadgeProps {
  changeType: DiffChangeType;
}

export const DiffChangeBadge: React.FC<DiffChangeBadgeProps> = ({
  changeType,
}) => (
  <span
    className={`shrink-0 rounded border border-panel-border px-1.5 py-0.5 text-xs font-medium ${DIFF_CHANGE_COLOR[changeType]}`}
  >
    {DIFF_CHANGE_LABEL[changeType]}
  </span>
);
