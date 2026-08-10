import React from "react";
import {
  WORKFLOW_TOKEN_COVERAGE,
  type WorkflowTokenCoverage,
} from "@root/types/DashboardConstants";
import type { WorkflowTokenTotals } from "@root/types/CtrlYokeTypes";
import {
  formatAccessibleTokenTotal,
  formatCostLabel,
  formatCostTooltip,
  formatTokenTotal,
} from "@root/utils/TokenFormatting";
import { useSettingsStore } from "@store/settingsStore";

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

/**
 * Whether `<WorkflowTokenUsage totals={totals} />` will render visible
 * content. Callers that lay out a fixed-slot `usage` prop (e.g.
 * `WorkflowRowLayout`'s stacked meta line, which joins its parts with a
 * separator) must check this *before* deciding whether to pass the slot at
 * all — the rendered `<WorkflowTokenUsage />` element itself is always a
 * non-null React node even when the component internally renders `null`, so
 * a presence check against the element reads as "has content" when it isn't.
 */
export function hasWorkflowTokenUsage(
  totals: WorkflowTokenTotals | undefined
): boolean {
  return !!totals && !!formatTokenTotal(totals.total, totals.coverage);
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
  const cost = formatCostTooltip(
    totals.costUsd,
    totals.costSources,
    totals.costPartial === true
  );
  return `${accessibleLabel}; ${coverage}; ${lifecycle}.${cost ? ` ${cost}` : ""}`;
}

interface WorkflowTokenUsageProps {
  totals?: WorkflowTokenTotals;
  /**
   * "inline" (default) joins the token total and cost on one line, used by
   * workflow/run rows. "stacked" renders them as two short lines instead —
   * for spots too narrow for the inline string but tall enough for two
   * compact lines, e.g. the output header.
   */
  layout?: "inline" | "stacked";
}

/** Shared compact run-total display for workflow and run-summary rows. */
export const WorkflowTokenUsage: React.FC<WorkflowTokenUsageProps> = ({
  totals,
  layout = "inline",
}) => {
  const hideCost = useSettingsStore(
    (state) => state.fullGlobalSettings?.settings.ui.hideCost === true
  );
  if (!totals) return null;

  const label = formatTokenTotal(totals.total, totals.coverage);
  const accessibleLabel = workflowTokenTotalsAccessibleLabel(totals);
  const tooltip = hideCost
    ? workflowTokenTotalsTooltip({ ...totals, costUsd: undefined })
    : workflowTokenTotalsTooltip(totals);
  if (!label || !accessibleLabel || !tooltip) return null;

  const costLabel =
    !hideCost && totals.costUsd !== undefined
      ? formatCostLabel(totals.costUsd, totals.costPartial === true)
      : undefined;

  if (layout === "stacked") {
    return (
      <span
        data-testid="workflow-token-usage"
        aria-label={accessibleLabel}
        title={tooltip}
        className="flex flex-col items-center leading-none font-mono text-xxs text-description-fg"
      >
        <span>{label}</span>
        {costLabel && <span>{costLabel}</span>}
      </span>
    );
  }

  return (
    <span
      data-testid="workflow-token-usage"
      aria-label={accessibleLabel}
      title={tooltip}
      className="whitespace-nowrap font-mono text-xs text-description-fg"
    >
      {label}
      {costLabel ? ` · ${costLabel}` : ""}
    </span>
  );
};
