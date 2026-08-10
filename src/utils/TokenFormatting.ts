import {
  WORKFLOW_TOKEN_COVERAGE,
  type WorkflowTokenCoverage,
} from "../types/DashboardConstants";

export interface TokenBreakdownValues {
  input: number | undefined;
  output: number | undefined;
  total: number | undefined;
  cached?: number;
  cacheCreated?: number;
}

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

/** Resolve an attempt total without discarding a provider-reported value. */
export function resolveTokenTotal(
  total: number | undefined,
  input: number | undefined,
  output: number | undefined
): number | undefined {
  if (total !== undefined) {
    return total;
  }

  if (input === undefined || output === undefined) {
    return undefined;
  }

  return input + output;
}

/** Format the input/output/cache composition of an attempt for tooltips. */
export function formatTokenBreakdown(values: TokenBreakdownValues): string {
  const input = formatTokenCount(values.input);
  const output = formatTokenCount(values.output);
  const total = formatTokenCount(
    resolveTokenTotal(values.total, values.input, values.output)
  );
  if (!input || !output || !total) {
    return "";
  }

  const details = [`Tokens: ${input} in / ${output} out / ${total} total`];
  const cached = formatTokenCount(values.cached);
  const cacheCreated = formatTokenCount(values.cacheCreated);
  if (cached) details.push(`${cached} cached`);
  if (cacheCreated) details.push(`${cacheCreated} cache-created`);
  return details.join(" | ");
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
