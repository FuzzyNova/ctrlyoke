import React from "react";
import {
  WORKFLOW_TOKEN_COVERAGE,
  type WorkflowTokenCoverage,
} from "@root/types/DashboardConstants";
import type { WorkflowTokenTotals } from "@root/types/CtrlYokeTypes";
import {
  formatAccessibleTokenTotal,
  formatTokenTotal,
} from "@root/utils/TokenFormatting";

function isPartialCoverage(coverage: WorkflowTokenCoverage): boolean {
  return coverage === WORKFLOW_TOKEN_COVERAGE.PARTIAL;
}

/** Returns the full phrase used in the row's accessible name. */
export function workflowTokenTotalsAccessibleLabel(
  totals: WorkflowTokenTotals | undefined
): string | undefined {
  if (!totals) return undefined;
  const label = formatAccessibleTokenTotal(totals.total, totals.coverage);
  return label || undefined;
}

/** Builds the usage tooltip shared by all workflow and run rows. */
export function workflowTokenTotalsTooltip(
  totals: WorkflowTokenTotals | undefined
): string | undefined {
  const accessibleLabel = workflowTokenTotalsAccessibleLabel(totals);
  if (!totals || !accessibleLabel) return undefined;

  const coverage = isPartialCoverage(totals.coverage)
    ? "partial coverage; this is a lower bound"
    : "complete coverage";
  const lifecycle = totals.isFinal ? "final total" : "still increasing";
  return `${accessibleLabel}; ${coverage}; ${lifecycle}.`;
}

interface WorkflowTokenUsageProps {
  totals?: WorkflowTokenTotals;
}

/** Shared compact run-total display for workflow and run-summary rows. */
export const WorkflowTokenUsage: React.FC<WorkflowTokenUsageProps> = ({
  totals,
}) => {
  if (!totals) return null;

  const label = formatTokenTotal(totals.total, totals.coverage);
  const accessibleLabel = workflowTokenTotalsAccessibleLabel(totals);
  const tooltip = workflowTokenTotalsTooltip(totals);
  if (!label || !accessibleLabel || !tooltip) return null;

  return (
    <span
      data-testid="workflow-token-usage"
      aria-label={accessibleLabel}
      title={tooltip}
      className="whitespace-nowrap font-mono text-xs text-description-fg"
    >
      {label}
    </span>
  );
};
