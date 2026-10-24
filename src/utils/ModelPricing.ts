import {
  ATTEMPT_COST_CACHE_RELATIONSHIPS,
  ATTEMPT_COST_CONFIDENCE,
  ATTEMPT_COST_NOTE_CODES,
  ATTEMPT_COST_REASONING_RELATIONSHIPS,
  ATTEMPT_COST_SOURCES,
  ATTEMPT_COST_UNAVAILABLE_REASONS,
  HARNESS_IDS,
  TOKEN_TOTAL_CONFIDENCE,
  type AttemptCostSource,
  type AttemptCostUnavailableReason,
  type HarnessId,
  type TokenTotalConfidence,
} from "../types/DashboardConstants";
import type { AttemptCostEstimate } from "../types/CtrlYokeTypes";
import type { ModelPricingOverride } from "../types/CtrlYokeSettings";
import type { ProviderModelUsage } from "../types/CliOutputTypes";
import { getModelPricingFromRegistry } from "./ModelPricingRegistry";
import { Log } from "./Log";
import {
  HARNESS_TOKEN_SEMANTICS,
  type HarnessTokenSemantics,
} from "./TokenSemantics";

export { HARNESS_TOKEN_SEMANTICS } from "./TokenSemantics";
export type { HarnessTokenSemantics } from "./TokenSemantics";

/** USD rates per one million tokens for a single harness/model pair. */
export interface ModelPricing {
  /** USD per 1M non-cached input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens (reasoning included unless priced separately). */
  outputPerMTok: number;
  /** USD per 1M cache-read input tokens. */
  cachedInputPerMTok?: number;
  /** USD per 1M cache-write tokens (default 5-minute TTL) — Claude only. */
  cacheWritePerMTok?: number;
  /** USD per 1M reasoning tokens, when a provider prices them apart from output. */
  reasoningPerMTok?: number;
  /** Provider doc URL the numbers were read from. Asserted as fact — keep current. */
  sourceUrl: string;
  /** ISO date the entry was last verified against `sourceUrl`. */
  verifiedOn: string;
}

export interface AttemptTokenCounts {
  prompt: number;
  completion: number;
  cached?: number;
  cacheCreated?: number;
  /** Subset of `cacheCreated` written with a 1-hour TTL. */
  cacheCreatedLongTtl?: number;
  reasoning?: number;
}

/**
 * Anthropic bills 1-hour cache writes at twice the base input rate. models.dev
 * carries only the default 5-minute write rate, so the 1-hour rate is derived.
 */
const LONG_TTL_CACHE_WRITE_INPUT_MULTIPLIER = 2;

export interface AttemptCostCalculationInput extends AttemptTokenCounts {
  harnessId: HarnessId;
  modelId?: string;
  totalConfidence?: TokenTotalConfidence;
  /** Explicit setting override takes precedence over the bundled table. */
  pricingOverride?: ModelPricingOverride;
  /** Raw provider-reported USD total, when available. */
  harnessReportedCostUsd?: number;
  /** Optional per-model billing counts; absent on older persisted attempts. */
  modelUsage?: Record<string, ProviderModelUsage>;
}

export interface AttemptCostCalculationResult {
  cost?: AttemptCostEstimate;
  costUnavailableReason?: AttemptCostUnavailableReason;
}

/**
 * Resolve USD-per-million-token rates for a harness/model pair. A user's
 * explicit override always wins; otherwise every harness is priced by
 * looking the model up in the downloaded models.dev registry (see
 * `ModelPricingRegistry.ts`) — there is no hand-maintained price table in
 * this codebase to fall back to.
 */
export function getModelPricing(
  harnessId: HarnessId,
  modelId: string,
  pricingOverride?: ModelPricingOverride
): ModelPricing | undefined {
  if (pricingOverride) {
    return {
      ...pricingOverride,
      sourceUrl: "user-configured override",
      verifiedOn: "user-configured",
    };
  }
  return getModelPricingFromRegistry(harnessId, modelId);
}

function perMillion(tokens: number, rate: number): number {
  return (tokens / 1_000_000) * rate;
}

function hasValidTokenCounts(tokens: AttemptTokenCounts): boolean {
  if (!Number.isFinite(tokens.prompt) || !Number.isFinite(tokens.completion)) {
    return false;
  }
  return [
    tokens.cached,
    tokens.cacheCreated,
    tokens.cacheCreatedLongTtl,
    tokens.reasoning,
  ].every((value) => value === undefined || Number.isFinite(value));
}

/**
 * Apply one explicit semantics descriptor to one price entry. This low-level
 * function is also useful for tests because subset and disjoint cache math
 * must remain observably different for identical counts.
 */
export function calculateTokenCost(
  pricingData: ModelPricing,
  semantics: HarnessTokenSemantics,
  tokens: AttemptTokenCounts,
  source: AttemptCostSource = ATTEMPT_COST_SOURCES.PRICE_TABLE,
  modelId?: string
): AttemptCostEstimate | undefined {
  if (
    !hasValidTokenCounts(tokens) ||
    semantics.cacheInputRelationship ===
      ATTEMPT_COST_CACHE_RELATIONSHIPS.UNKNOWN ||
    semantics.reasoningRelationship ===
      ATTEMPT_COST_REASONING_RELATIONSHIPS.UNKNOWN
  ) {
    return undefined;
  }

  const prompt = Math.max(tokens.prompt, 0);
  const completion = Math.max(tokens.completion, 0);
  const cached = Math.max(tokens.cached ?? 0, 0);
  const cacheCreated = Math.max(tokens.cacheCreated ?? 0, 0);
  const cacheCreatedLongTtl = Math.min(
    Math.max(tokens.cacheCreatedLongTtl ?? 0, 0),
    cacheCreated
  );
  const reasoning = Math.max(tokens.reasoning ?? 0, 0);
  const nonCachedInput =
    semantics.cacheInputRelationship === ATTEMPT_COST_CACHE_RELATIONSHIPS.SUBSET
      ? Math.max(prompt - cached, 0)
      : prompt;
  const separatelyPricedReasoning =
    semantics.reasoningRelationship ===
    ATTEMPT_COST_REASONING_RELATIONSHIPS.DISJOINT
      ? reasoning
      : 0;

  const inputUsd = perMillion(nonCachedInput, pricingData.inputPerMTok);
  // Without a cache-read rate, cache hits are priced as misses: never an
  // under-estimate, but flagged so the tooltip can call it an upper bound.
  const cacheReadRateUnknown =
    cached > 0 && pricingData.cachedInputPerMTok === undefined;
  const cachedInputUsd = perMillion(
    cached,
    pricingData.cachedInputPerMTok ?? pricingData.inputPerMTok
  );
  const cacheWriteUsd =
    perMillion(
      cacheCreated - cacheCreatedLongTtl,
      pricingData.cacheWritePerMTok ?? pricingData.inputPerMTok
    ) +
    perMillion(
      cacheCreatedLongTtl,
      pricingData.inputPerMTok * LONG_TTL_CACHE_WRITE_INPUT_MULTIPLIER
    );
  const outputUsd = perMillion(completion, pricingData.outputPerMTok);
  const reasoningUsd = perMillion(
    separatelyPricedReasoning,
    pricingData.reasoningPerMTok ?? pricingData.outputPerMTok
  );

  return {
    usd: inputUsd + cachedInputUsd + cacheWriteUsd + outputUsd + reasoningUsd,
    source,
    confidence: ATTEMPT_COST_CONFIDENCE.COMPLETE,
    ...(cacheReadRateUnknown
      ? { noteCode: ATTEMPT_COST_NOTE_CODES.CACHE_READ_UPPER_BOUND }
      : {}),
    ...(modelId === undefined ? {} : { modelId }),
    breakdown: {
      inputUsd,
      outputUsd,
      cachedInputUsd,
      cacheWriteUsd,
      reasoningUsd,
    },
  };
}

export function calculateAttemptCost(
  input: AttemptCostCalculationInput
): AttemptCostCalculationResult {
  if (input.totalConfidence === TOKEN_TOTAL_CONFIDENCE.PARTIAL) {
    return {
      costUnavailableReason: ATTEMPT_COST_UNAVAILABLE_REASONS.PARTIAL_TOKENS,
    };
  }

  const harnessReported = input.harnessReportedCostUsd;
  const hasHarnessReported =
    harnessReported !== undefined &&
    Number.isFinite(harnessReported) &&
    harnessReported >= 0;

  const pricingData = input.modelId
    ? getModelPricing(input.harnessId, input.modelId, input.pricingOverride)
    : undefined;

  const semantics = HARNESS_TOKEN_SEMANTICS[input.harnessId];

  const canCalculate =
    semantics.cacheInputRelationship !==
      ATTEMPT_COST_CACHE_RELATIONSHIPS.UNKNOWN &&
    semantics.reasoningRelationship !==
      ATTEMPT_COST_REASONING_RELATIONSHIPS.UNKNOWN;
  const calculatedCost =
    input.modelUsage && Object.keys(input.modelUsage).length > 0
      ? calculatePerModelCost(input)
      : pricingData && canCalculate
        ? calculateTokenCost(
            pricingData,
            semantics,
            input,
            input.pricingOverride
              ? ATTEMPT_COST_SOURCES.USER_OVERRIDE
              : ATTEMPT_COST_SOURCES.PRICE_TABLE,
            input.modelId
          )
        : undefined;

  // A user's price override is an explicit instruction about what their tokens
  // cost, so it outranks the harness's own figure.
  if (input.pricingOverride && calculatedCost) {
    return { cost: calculatedCost };
  }

  if (hasHarnessReported) {
    if (
      input.harnessId === HARNESS_IDS.CLAUDE_CLI &&
      calculatedCost &&
      !costsAgreeWithinTwoX(harnessReported, calculatedCost.usd)
    ) {
      Log.warn(
        `[Cost] Claude harness-reported cost diverges from ${
          input.pricingOverride ? "user override" : "price table"
        } for ${input.modelId ?? "unknown model"}: reported=$${harnessReported}, calculated=$${calculatedCost.usd}`
      );
      return {
        cost: {
          ...calculatedCost,
          noteCode: ATTEMPT_COST_NOTE_CODES.HARNESS_DIVERGENCE,
        },
      };
    }
    return {
      cost: {
        usd: harnessReported,
        source: ATTEMPT_COST_SOURCES.HARNESS_REPORTED,
        confidence: ATTEMPT_COST_CONFIDENCE.COMPLETE,
        ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      },
    };
  }

  if (calculatedCost) return { cost: calculatedCost };
  return {
    costUnavailableReason:
      pricingData && !canCalculate
        ? ATTEMPT_COST_UNAVAILABLE_REASONS.UNVERIFIED_TOKEN_SEMANTICS
        : ATTEMPT_COST_UNAVAILABLE_REASONS.UNKNOWN_MODEL,
  };
}

function calculatePerModelCost(
  input: AttemptCostCalculationInput
): AttemptCostEstimate | undefined {
  const semantics = HARNESS_TOKEN_SEMANTICS[input.harnessId];
  let usd = 0;
  const breakdown = {
    inputUsd: 0,
    outputUsd: 0,
    cachedInputUsd: 0,
    cacheWriteUsd: 0,
    reasoningUsd: 0,
  };
  let cacheReadUpperBound = false;
  for (const [modelId, usage] of Object.entries(input.modelUsage ?? {})) {
    const pricing = getModelPricing(
      input.harnessId,
      modelId,
      modelId === input.modelId ? input.pricingOverride : undefined
    );
    if (!pricing) return undefined;
    const cost = calculateTokenCost(
      pricing,
      semantics,
      {
        prompt: usage.inputTokens ?? 0,
        completion: usage.outputTokens ?? 0,
        cached: usage.cacheReadInputTokens,
        cacheCreated: usage.cacheCreationInputTokens,
        cacheCreatedLongTtl: usage.cacheCreationLongTtlInputTokens,
        reasoning:
          usage.reasoningOutputTokens ??
          (modelId === input.modelId ? input.reasoning : undefined),
      },
      input.pricingOverride && modelId === input.modelId
        ? ATTEMPT_COST_SOURCES.USER_OVERRIDE
        : ATTEMPT_COST_SOURCES.PRICE_TABLE,
      modelId
    );
    if (!cost) return undefined;
    cacheReadUpperBound ||=
      cost.noteCode === ATTEMPT_COST_NOTE_CODES.CACHE_READ_UPPER_BOUND;
    usd += cost.usd;
    breakdown.inputUsd += cost.breakdown?.inputUsd ?? 0;
    breakdown.outputUsd += cost.breakdown?.outputUsd ?? 0;
    breakdown.cachedInputUsd += cost.breakdown?.cachedInputUsd ?? 0;
    breakdown.cacheWriteUsd += cost.breakdown?.cacheWriteUsd ?? 0;
    breakdown.reasoningUsd += cost.breakdown?.reasoningUsd ?? 0;
  }
  return {
    usd,
    source: input.pricingOverride
      ? ATTEMPT_COST_SOURCES.USER_OVERRIDE
      : ATTEMPT_COST_SOURCES.PRICE_TABLE,
    confidence: ATTEMPT_COST_CONFIDENCE.COMPLETE,
    ...(cacheReadUpperBound
      ? { noteCode: ATTEMPT_COST_NOTE_CODES.CACHE_READ_UPPER_BOUND }
      : {}),
    ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
    breakdown,
  };
}

function costsAgreeWithinTwoX(left: number, right: number): boolean {
  if (left === 0 || right === 0) return left === right;
  return Math.max(left, right) / Math.min(left, right) <= 2;
}
