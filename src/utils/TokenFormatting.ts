import {
  ATTEMPT_COST_CACHE_RELATIONSHIPS,
  WORKFLOW_TOKEN_COVERAGE,
  ATTEMPT_COST_SOURCES,
  ATTEMPT_COST_NOTE_CODES,
  type AttemptCostSource,
  type AttemptCostNoteCode,
  type HarnessId,
  type WorkflowTokenCoverage,
} from "../types/DashboardConstants";
import type { AttemptCostEstimate } from "../types/CtrlYokeTypes";
import { HARNESS_TOKEN_SEMANTICS } from "./TokenSemantics";
import { formatCompactTokenMagnitude } from "./CompactMagnitude";

/** Explains why the context-window snapshot and attempt total are not additive. */
export const TOKEN_USAGE_SCOPE_NOTE =
  "Current context window is the last turn only; attempt total sums every turn.";
/** Explains that a subset harness's headline total excludes cache-read hits. */
export const TOKEN_TOTAL_CACHE_NETTED_NOTE =
  "Cache-read tokens are netted out of the attempt total for this harness.";

export interface TokenBreakdownValues {
  input: number | undefined;
  output: number | undefined;
  total: number | undefined;
  harness?: HarnessId;
  cached?: number;
  cacheCreated?: number;
}

export function isCacheInputSubset(harness: HarnessId | undefined): boolean {
  return (
    harness !== undefined &&
    HARNESS_TOKEN_SEMANTICS[harness].cacheInputRelationship ===
      ATTEMPT_COST_CACHE_RELATIONSHIPS.SUBSET
  );
}

function normalizeTokenCount(tokens: number | undefined): number | undefined {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens < 0) {
    return undefined;
  }

  return Math.round(tokens);
}

/** Format a known token count compactly for visual labels. */
export function formatTokenCount(tokens: number | undefined): string {
  const normalized = normalizeTokenCount(tokens);
  if (normalized === undefined) {
    return "";
  }

  return formatCompactTokenMagnitude(normalized, { trimTrailingZero: true });
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

  const cached = formatTokenCount(values.cached);
  const cacheCreated = formatTokenCount(values.cacheCreated);
  const cacheIsInputSubset = isCacheInputSubset(values.harness);
  const inputLabel =
    cacheIsInputSubset && cached
      ? `${input} in (${cached} cached)`
      : `${input} in`;
  const details = [`Tokens: ${inputLabel} / ${output} out / ${total} total`];
  if (cached && !cacheIsInputSubset) details.push(`${cached} cached`);
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

/** Token fields consumed by {@link buildAttemptTokenTooltipLines}, matching the shape of `CliOutput.tokens`. */
export interface AttemptTokenSnapshot {
  prompt?: number;
  completion?: number;
  total?: number;
  cached?: number;
  cacheCreated?: number;
  compactionCount?: number;
  cost?: AttemptCostEstimate;
}

/**
 * Builds the lines shown in a step's context/token tooltip (context window
 * usage, attempt total, input/output/cache breakdown, compactions, cost).
 * Single source shared by the on-hover tooltip and the "Copy Metadata" step
 * action so both surfaces report identical numbers.
 */
export function buildAttemptTokenTooltipLines(params: {
  contextWindow?: { used: number; size: number };
  harness?: HarnessId;
  attemptTokens?: AttemptTokenSnapshot;
  showCostEstimates?: boolean;
}): string[] {
  const { contextWindow, harness, attemptTokens, showCostEstimates } = params;
  const contextPct = contextWindow?.size
    ? Math.round((contextWindow.used / contextWindow.size) * 100)
    : undefined;
  const contextLabel =
    contextWindow && contextPct !== undefined
      ? `${formatTokenCount(contextWindow.used)}/${formatTokenCount(contextWindow.size)} (${contextPct}%)`
      : undefined;
  const attemptTotalLabel = formatTokenCount(
    resolveTokenTotal(
      attemptTokens?.total,
      attemptTokens?.prompt,
      attemptTokens?.completion
    )
  );
  const attemptBreakdown = attemptTokens
    ? formatTokenBreakdown({
        input: attemptTokens.prompt,
        output: attemptTokens.completion,
        total: attemptTokens.total,
        harness,
        cached: attemptTokens.cached,
        cacheCreated: attemptTokens.cacheCreated,
      })
    : "";
  const compactionCount = attemptTokens?.compactionCount;
  return [
    contextLabel ? `Current context window: ${contextLabel}` : null,
    contextLabel && attemptTotalLabel ? TOKEN_USAGE_SCOPE_NOTE : null,
    attemptTotalLabel && isCacheInputSubset(harness)
      ? TOKEN_TOTAL_CACHE_NETTED_NOTE
      : null,
    attemptTotalLabel ? `Attempt total: ${attemptTotalLabel} tokens` : null,
    attemptBreakdown || null,
    compactionCount !== undefined ? `Compactions: ${compactionCount}` : null,
    showCostEstimates !== false && attemptTokens?.cost
      ? formatAttemptCostTooltip(attemptTokens.cost)
      : null,
  ].filter((part): part is string => part !== null);
}

/**
 * Builds the full hover-tooltip text for a step row or chip: a primary-action
 * line (e.g. "Click to edit — right-click for options") followed by the same
 * context/token detail lines everywhere they're shown, so the full panel row
 * and the collapsed chip rail never drift out of sync.
 */
export function buildStepHoverTooltip(params: {
  primaryAction: string;
  contextWindow?: { used: number; size: number };
  harness?: HarnessId;
  attemptTokens?: AttemptTokenSnapshot;
  showCostEstimates?: boolean;
}): string {
  const detailLines = buildAttemptTokenTooltipLines(params);
  return detailLines.length
    ? `${params.primaryAction}\n\n${detailLines.join("\n")}`
    : params.primaryAction;
}
