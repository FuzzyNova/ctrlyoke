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

const VERIFIED_ON = "2026-08-09";
const ANTHROPIC_PRICING_URL =
  "https://platform.claude.com/docs/en/about-claude/pricing";
const OPENAI_PRICING_URL = "https://developers.openai.com/api/docs/pricing";
const COPILOT_PRICING_URL =
  "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing";
const COPILOT_VERIFIED_ON = "2026-08-21";

function pricing(
  inputPerMTok: number,
  outputPerMTok: number,
  cachedInputPerMTok: number | undefined,
  cacheWritePerMTok: number | undefined,
  sourceUrl: string,
  verifiedOn: string = VERIFIED_ON
): ModelPricing {
  return {
    inputPerMTok,
    outputPerMTok,
    ...(cachedInputPerMTok === undefined ? {} : { cachedInputPerMTok }),
    ...(cacheWritePerMTok === undefined ? {} : { cacheWritePerMTok }),
    sourceUrl,
    verifiedOn,
  };
}

function copilotPricing(
  inputPerMTok: number,
  outputPerMTok: number,
  cachedInputPerMTok: number | undefined,
  cacheWritePerMTok: number | undefined
): ModelPricing {
  return pricing(
    inputPerMTok,
    outputPerMTok,
    cachedInputPerMTok,
    cacheWritePerMTok,
    COPILOT_PRICING_URL,
    COPILOT_VERIFIED_ON
  );
}

/**
 * Curated list-price data. Keep this keyed by harness first: a model ID can
 * mean a different routed provider, region, or billing contract per harness.
 * Harnesses with arbitrary/BYO routing intentionally have no bundled entries.
 */
export const MODEL_PRICING: Record<
  HarnessId,
  Readonly<Record<string, ModelPricing>>
> = {
  [HARNESS_IDS.CLAUDE_CLI]: {
    fable: pricing(10, 50, 1, 12.5, ANTHROPIC_PRICING_URL),
    sonnet: pricing(2, 10, 0.2, 2.5, ANTHROPIC_PRICING_URL),
    "sonnet[1m]": pricing(2, 10, 0.2, 2.5, ANTHROPIC_PRICING_URL),
    opus: pricing(5, 25, 0.5, 6.25, ANTHROPIC_PRICING_URL),
    "opus[1m]": pricing(5, 25, 0.5, 6.25, ANTHROPIC_PRICING_URL),
    haiku: pricing(1, 5, 0.1, 1.25, ANTHROPIC_PRICING_URL),
  },
  [HARNESS_IDS.CODEX_CLI]: {
    "gpt-5.6-sol": pricing(5, 30, 0.5, undefined, OPENAI_PRICING_URL),
    "gpt-5.6-terra": pricing(2, 12, 0.2, undefined, OPENAI_PRICING_URL),
    "gpt-5.6-luna": pricing(0.2, 1.2, 0.02, undefined, OPENAI_PRICING_URL),
    "gpt-5.5": pricing(5, 30, 0.5, undefined, OPENAI_PRICING_URL),
    "gpt-5.4": pricing(2.5, 15, 0.25, undefined, OPENAI_PRICING_URL),
    "gpt-5.4-mini": pricing(0.75, 4.5, 0.075, undefined, OPENAI_PRICING_URL),
  },
  // Copilot marks up the same underlying models Claude/Codex bill directly, at
  // its own per-token rates (1 AI credit = $0.01), so these are kept separate
  // from the CLAUDE_CLI/CODEX_CLI tables above rather than shared. Keyed from
  // `COPILOT_CLI_MODEL_IDS` (ModelConstants.ts) — the exact model IDs the
  // `copilot` CLI can report — not the full GitHub billing-page catalog,
  // which also lists models (Gemini, Grok, Kimi, ...) the CLI doesn't expose.
  // Three of these (gpt-5.4, gpt-5.5, gemini-3.1-pro-preview) bill a higher
  // "long context" tier past a per-model input-token threshold; that isn't
  // representable by this flat-rate shape, so the "Default" tier rate is used
  // as a documented approximation (same tradeoff as Qwen's tiered pricing,
  // see HARNESS_TOKEN_SEMANTICS[QWEN_CLI] below).
  [HARNESS_IDS.COPILOT_CLI]: (() => {
    const claudeSonnet4x = copilotPricing(3, 15, 0.3, 3.75);
    const claudeOpus4x = copilotPricing(5, 25, 0.5, 6.25);
    return {
      "claude-sonnet-5": copilotPricing(2, 10, 0.2, 2.5),
      "claude-sonnet-4.6": claudeSonnet4x,
      "claude-sonnet-4.5": claudeSonnet4x,
      "claude-haiku-4.5": copilotPricing(1, 5, 0.1, 1.25),
      "claude-fable-5": copilotPricing(10, 50, 1, 12.5),
      "claude-opus-4.8": claudeOpus4x,
      "claude-opus-4.8-fast": copilotPricing(10, 50, 1, 12.5),
      "claude-opus-4.7": claudeOpus4x,
      "claude-opus-4.6": claudeOpus4x,
      "claude-opus-4.5": claudeOpus4x,
      "gpt-5.5": copilotPricing(5, 30, 0.5, undefined),
      "gpt-5.4": copilotPricing(2.5, 15, 0.25, undefined),
      "gpt-5.3-codex": copilotPricing(1.75, 14, 0.175, undefined),
      "gpt-5.4-mini": copilotPricing(0.75, 4.5, 0.075, undefined),
      "gpt-5-mini": copilotPricing(0.25, 2, 0.025, undefined),
      "gemini-3.1-pro-preview": copilotPricing(2, 12, 0.2, undefined),
      "gemini-3.5-flash": copilotPricing(1.5, 9, 0.15, undefined),
    };
  })(),
  [HARNESS_IDS.OPENCODE_CLI]: {},
  [HARNESS_IDS.QWEN_CLI]: {
    // qwen3.5-plus is tiered by input length and therefore cannot be
    // represented faithfully by the current single-rate ModelPricing shape.
  },
  [HARNESS_IDS.ANTIGRAVITY_CLI]: {},
};

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
  const entries = MODEL_PRICING[harnessId];
  const exact = entries[modelId];
  if (exact) return exact;
  const normalized = modelId.toLowerCase();
  const alias = Object.keys(entries).find((key) => {
    const lower = key.toLowerCase();
    return normalized.includes(lower) || lower.includes(normalized);
  });
  return alias ? entries[alias] : undefined;
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
