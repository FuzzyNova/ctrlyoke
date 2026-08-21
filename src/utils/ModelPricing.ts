import {
  ATTEMPT_COST_CACHE_RELATIONSHIPS,
  ATTEMPT_COST_CONFIDENCE,
  ATTEMPT_COST_NOTE_CODES,
  ATTEMPT_COST_REASONING_RELATIONSHIPS,
  ATTEMPT_COST_SOURCES,
  ATTEMPT_COST_UNAVAILABLE_REASONS,
  HARNESS_IDS,
  TOKEN_TOTAL_CONFIDENCE,
  type AttemptCostCacheRelationship,
  type AttemptCostReasoningRelationship,
  type AttemptCostSource,
  type AttemptCostUnavailableReason,
  type HarnessId,
  type TokenTotalConfidence,
} from "../types/DashboardConstants";
import type { AttemptCostEstimate } from "../types/CtrlYokeTypes";
import type { ModelPricingOverride } from "../types/CtrlYokeSettings";
import { getModelPricingFromRegistry } from "./ModelPricingRegistry";
import { Log } from "./Log";

/** USD rates per one million tokens for a single harness/model pair. */
export interface ModelPricing {
  /** USD per 1M non-cached input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens (reasoning included unless priced separately). */
  outputPerMTok: number;
  /** USD per 1M cache-read input tokens. */
  cachedInputPerMTok?: number;
  /** USD per 1M cache-write tokens — Claude only. */
  cacheWritePerMTok?: number;
  /** USD per 1M reasoning tokens, when a provider prices them apart from output. */
  reasoningPerMTok?: number;
  /** Provider doc URL the numbers were read from. Asserted as fact — keep current. */
  sourceUrl: string;
  /** ISO date the entry was last verified against `sourceUrl`. */
  verifiedOn: string;
}

export interface HarnessTokenSemantics {
  /** Whether cache-read tokens are included in the harness input count. */
  cacheInputRelationship: AttemptCostCacheRelationship;
  /** Whether separately reported reasoning tokens are already in output. */
  reasoningRelationship: AttemptCostReasoningRelationship;
}

export interface AttemptTokenCounts {
  prompt: number;
  completion: number;
  cached?: number;
  cacheCreated?: number;
  reasoning?: number;
}

export interface AttemptCostCalculationInput extends AttemptTokenCounts {
  harnessId: HarnessId;
  modelId?: string;
  totalConfidence?: TokenTotalConfidence;
  /** Explicit setting override takes precedence over the bundled table. */
  pricingOverride?: ModelPricingOverride;
  /** Raw provider-reported USD total, when available. */
  harnessReportedCostUsd?: number;
}

export interface AttemptCostCalculationResult {
  cost?: AttemptCostEstimate;
  costUnavailableReason?: AttemptCostUnavailableReason;
}

/**
 * Billing relationships currently supported by the calculation. The three
 * unverified harnesses stay unknown until a real run confirms their fields;
 * parser comments and synthetic fixtures are not enough for this gate.
 */
export const HARNESS_TOKEN_SEMANTICS: Record<HarnessId, HarnessTokenSemantics> =
  {
    [HARNESS_IDS.CLAUDE_CLI]: {
      cacheInputRelationship: ATTEMPT_COST_CACHE_RELATIONSHIPS.DISJOINT,
      reasoningRelationship: ATTEMPT_COST_REASONING_RELATIONSHIPS.UNREPORTED,
    },
    [HARNESS_IDS.CODEX_CLI]: {
      cacheInputRelationship: ATTEMPT_COST_CACHE_RELATIONSHIPS.SUBSET,
      reasoningRelationship:
        ATTEMPT_COST_REASONING_RELATIONSHIPS.INCLUDED_IN_OUTPUT,
    },
    [HARNESS_IDS.QWEN_CLI]: {
      cacheInputRelationship: ATTEMPT_COST_CACHE_RELATIONSHIPS.UNKNOWN,
      reasoningRelationship: ATTEMPT_COST_REASONING_RELATIONSHIPS.UNKNOWN,
    },
    [HARNESS_IDS.OPENCODE_CLI]: {
      cacheInputRelationship: ATTEMPT_COST_CACHE_RELATIONSHIPS.UNKNOWN,
      reasoningRelationship: ATTEMPT_COST_REASONING_RELATIONSHIPS.UNKNOWN,
    },
    [HARNESS_IDS.ANTIGRAVITY_CLI]: {
      cacheInputRelationship: ATTEMPT_COST_CACHE_RELATIONSHIPS.UNKNOWN,
      reasoningRelationship: ATTEMPT_COST_REASONING_RELATIONSHIPS.UNKNOWN,
    },
    [HARNESS_IDS.COPILOT_CLI]: {
      cacheInputRelationship: ATTEMPT_COST_CACHE_RELATIONSHIPS.DISJOINT,
      reasoningRelationship: ATTEMPT_COST_REASONING_RELATIONSHIPS.UNREPORTED,
    },
  };

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
  return [tokens.cached, tokens.cacheCreated, tokens.reasoning].every(
    (value) => value === undefined || Number.isFinite(value)
  );
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
  const cachedInputUsd = perMillion(
    cached,
    pricingData.cachedInputPerMTok ?? pricingData.inputPerMTok
  );
  const cacheWriteUsd = perMillion(
    cacheCreated,
    pricingData.cacheWritePerMTok ?? pricingData.inputPerMTok
  );
  const outputUsd = perMillion(completion, pricingData.outputPerMTok);
  const reasoningUsd = perMillion(
    separatelyPricedReasoning,
    pricingData.reasoningPerMTok ?? 0
  );

  return {
    usd: inputUsd + cachedInputUsd + cacheWriteUsd + outputUsd + reasoningUsd,
    source,
    confidence: ATTEMPT_COST_CONFIDENCE.COMPLETE,
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
    pricingData && canCalculate
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

function costsAgreeWithinTwoX(left: number, right: number): boolean {
  if (left === 0 || right === 0) return left === right;
  return Math.max(left, right) / Math.min(left, right) <= 2;
}
