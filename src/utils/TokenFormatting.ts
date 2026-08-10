import {
  WORKFLOW_TOKEN_COVERAGE,
  type WorkflowTokenCoverage,
} from "../types/DashboardConstants";

function normalizeTokenCount(tokens: number | undefined): number | undefined {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens < 0) {
    return undefined;
  }

  return Math.round(tokens);
}

function formatUnitValue(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

/** Format a known token count compactly for visual labels. */
export function formatTokenCount(tokens: number | undefined): string {
  const normalized = normalizeTokenCount(tokens);
  if (normalized === undefined) {
    return "";
  }

  if (normalized >= 1_000_000) {
    return `${formatUnitValue(normalized / 1_000_000)}M`;
  }

  if (normalized >= 1_000) {
    return `${formatUnitValue(normalized / 1_000)}k`;
  }

  return String(normalized);
}

/**
 * Format an observed total, using a lower-bound marker for partial coverage.
 * Unknown totals are absent rather than rendered as zero.
 */
export function formatTokenTotal(
  total: number | undefined,
  coverage: WorkflowTokenCoverage = WORKFLOW_TOKEN_COVERAGE.COMPLETE
): string {
  const formatted = formatTokenCount(total);
  if (!formatted) {
    return "";
  }

  return coverage === WORKFLOW_TOKEN_COVERAGE.PARTIAL
    ? `≥${formatted}`
    : formatted;
}

/** Format an observed total for assistive technology. */
export function formatAccessibleTokenTotal(
  total: number | undefined,
  coverage: WorkflowTokenCoverage = WORKFLOW_TOKEN_COVERAGE.COMPLETE
): string {
  const normalized = normalizeTokenCount(total);
  if (normalized === undefined) {
    return "";
  }

  const formatted = normalized.toLocaleString("en-US");
  return coverage === WORKFLOW_TOKEN_COVERAGE.PARTIAL
    ? `at least ${formatted} observed tokens`
    : `${formatted} total tokens`;
}
