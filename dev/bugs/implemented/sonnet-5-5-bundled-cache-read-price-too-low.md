# Bundled price for Sonnet 5.5 cache reads is half the real rate

- **Found:** 2026-10-23 by Claude Code, during a token and cost accuracy audit
- **Area:** `src/utils/generated/modelPricingRegistryData.json`, `scripts/sync-model-pricing.mjs`
- **Resolution:** fixed in this commit

## Symptom

Cost estimates for `claude-sonnet-5-5` steps are 30–50% lower than the cost
Claude Code reports for the same steps. After the 1-hour cache-write fix, Opus
and Haiku estimates match Claude Code's figure exactly; Sonnet 5.5 does not.

## Steps to Reproduce

1. Run a Claude Code step on `sonnet` (resolves to `claude-sonnet-5-5`)
   headless, so the result event carries `total_cost_usd`.
2. Re-price the recorded tokens with the bundled registry rates.
3. The estimate is 1.3–1.7× lower than Claude Code's figure.

Six recorded Sonnet 5.5 attempts in the local run history (2026-10-08 `wave2`
runs) match Claude Code's figure to the cent with a cache-read rate of
$0.20/M and 1-hour writes at 2× input. They do not match with the bundled
$0.10/M.

## Root Cause

The models.dev snapshot lists `claude-sonnet-5-5` (and `claude-sonnet-5.5` in
the `github-copilot` bucket) with `cacheRead: 0.1` against `input: 2`, which
is 5% of input. Anthropic's cache reads are 10% of input, which is $0.20/M.
Every other Anthropic entry in the snapshot follows the 10% rule. Long Sonnet
steps are dominated by cache reads, so the error halves most of the estimate.

## Suggested Fix

Report the entry upstream to models.dev and re-run `npm run sync-model-pricing`
once it is corrected. `modelPricingRegistryData.json` is generated and must not
be hand-edited. If upstream is slow, consider a small, documented correction
layer in `ModelPricingRegistry.ts` that `sync-model-pricing.mjs` checks for
staleness, so a fix doesn't silently outlive the upstream correction. Until
then, users can add a `modelPricing` override for `claude-cli` /
`claude-sonnet-5-5` with `cachedInputPerMTok: 0.2`.

The upstream models.dev report remains to be filed by the maintainer.
