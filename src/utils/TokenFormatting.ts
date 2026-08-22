import {
  WORKFLOW_TOKEN_COVERAGE,
  ATTEMPT_COST_SOURCES,
  ATTEMPT_COST_NOTE_CODES,
  type AttemptCostSource,
  type AttemptCostNoteCode,
  type WorkflowTokenCoverage,
} from "../types/DashboardConstants";
import type { AttemptCostEstimate } from "../types/CtrlYokeTypes";

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

/** Format a dollar estimate without implying that it is subscription spend. */
export function formatCostLabel(
  usd: number | undefined,
  partial = false
): string {
  if (usd === undefined || !Number.isFinite(usd) || usd < 0) return "";
  return `${partial ? "≥" : "≈"}$${usd.toFixed(2)}`;
}

function costSourceMethodLabel(source: AttemptCostSource): string {
  switch (source) {
    case ATTEMPT_COST_SOURCES.PRICE_TABLE:
      return "at API list prices";
    case ATTEMPT_COST_SOURCES.HARNESS_REPORTED:
      return "reported by the harness";
    case ATTEMPT_COST_SOURCES.USER_OVERRIDE:
      return "using your configured price override";
  }
}

/**
 * Describe how a cost figure was computed. When multiple attempts contribute
 * different sources (e.g. one harness reports its own dollar figure while
 * another is priced from the table), the methods are joined into one
 * sentence rather than concatenated with "+", which read as if the costs
 * themselves were being added together. The "not incremental subscription
 * spend" caveat is appended whenever a harness-reported figure is among the
 * sources, since a raw harness-reported number is the one most likely to be
 * mistaken for actual subscription billing.
 */
export function formatCostSourcePhrase(
  sources: readonly AttemptCostSource[] | undefined
): string {
  if (!sources?.length) return "estimated token value";
  const methods = sources.map(costSourceMethodLabel);
  const joinedMethods =
    methods.length > 1
      ? `${methods.slice(0, -1).join(", ")} and ${methods[methods.length - 1]}`
      : methods[0];
  return sources.includes(ATTEMPT_COST_SOURCES.HARNESS_REPORTED)
    ? `${joinedMethods}; not incremental subscription spend`
    : joinedMethods;
}

export function formatCostTooltip(
  usd: number | undefined,
  sources: readonly AttemptCostSource[] | undefined,
  partial = false,
  noteCode?: AttemptCostNoteCode
): string {
  const label = formatCostLabel(usd, partial);
  if (!label) return "";
  const partialNote = partial ? " One or more attempts were unpriceable." : "";
  const divergenceNote =
    noteCode === ATTEMPT_COST_NOTE_CODES.HARNESS_DIVERGENCE
      ? " The harness-reported value diverged from the calculated value, so the calculated value is shown."
      : "";
  return `${label} ${formatCostSourcePhrase(sources)}.${partialNote}${divergenceNote}`;
}

export function formatAttemptCostTooltip(
  cost: AttemptCostEstimate | undefined
): string {
  if (!cost) return "";
  return formatCostTooltip(cost.usd, [cost.source], false, cost.noteCode);
}
