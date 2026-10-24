# Cache hits are charged at the full input rate when a model has no cache-read price

- **Found:** 2026-10-23 by Claude Code, during a token and cost accuracy audit
- **Area:** `src/utils/ModelPricing.ts` (`calculateTokenCost`)
- **Resolution:** fixed in this commit

## Symptom

Qwen Code estimates are inflated. In the local run history, 74 `qwen3.5-plus`
attempts were estimated at $1.91, and $1.17 of that (61%) is cache hits
charged at the full input price. Any model the bundled registry lists without
a `cacheRead` rate has the same problem, which is many Alibaba, Google and
older OpenAI entries.

## Steps to Reproduce

1. Run a Qwen Code step on `qwen3.5-plus`, which caches most of its prompt.
2. Hover the step's cost: the breakdown's cached-input share is priced at
   $0.40/M, the same as uncached input.

## Root Cause

`calculateTokenCost` prices cache reads at
`pricingData.cachedInputPerMTok ?? pricingData.inputPerMTok`. When models.dev
has no cache-read rate for a model, a cache hit costs as much as a miss. That
over-states cost whenever the provider does discount cache hits: Alibaba bills
implicit cache hits at a fraction of input.

## Suggested Fix

Decide what an unknown cache-read rate should mean rather than defaulting to
the most expensive answer:

- Mark the estimate partial (`≥` would be wrong, since it is an over-estimate;
  this would need a new note or confidence value), or
- leave cached tokens unpriced and say so in the cost tooltip, or
- keep the full-rate fallback but label it as an upper bound in the tooltip.

Whatever the choice, tell the user, and remind them that a `modelPricing`
override with `cachedInputPerMTok` gives an exact figure.
