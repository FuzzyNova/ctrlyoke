# Copilot cost estimate charges cached input twice because its input count already includes cache tokens

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/utils/TokenSemantics.ts`, `src/utils/ModelPricing.ts`, `src/core/harness/copilot/CopilotLogParser.ts`, `src/core/harness/copilot/CopilotCliProvider.ts`
- **Severity:** medium

## Symptom

Copilot step cost estimates are inflated, often by more than 2×. The input the prompt cache served
is charged once at the full input rate and again at the cache-read or cache-write rate. The usage
tooltip also presents three overlapping numbers (`63.8k in | 31.2k cached | 32.5k cache-created`)
as if they were separate amounts.

## Steps to Reproduce

1. Check every `chat <model>` span in real Copilot OTel output (`.ctrlyoke/temp/ctrlyoke-otel-*.jsonl`
   in the ctrlyoke checkouts on the dev machine, 2,873 spans across gpt-5.6-luna/sol,
   claude-sonnet-5 and gpt-5.4-mini). In **every** span,
   `gen_ai.usage.input_tokens >= cache_read + cache_creation`, and the smallest remainder is 2.
   So `input_tokens` includes both cache amounts.
2. Feed one such file (e.g. `ctrlyoke-otel-workflow-p2.jsonl`) through
   `CopilotLogParser.setOtelFilePath` → `pollOtelContextWindow()` → `getFinalOtelUsage()`, then call
   `calculateAttemptCost` for `copilot-cli` with pricing $1.25 input, $10 output, $0.125 cache read
   and $1.25 cache write.
   - Parsed: input 63,754, cache read 31,232, cache write 32,516, so 6 tokens were uncached.
   - Actual cost: $0.1291, of which $0.0797 is input billed at the full rate.
   - Expected: about $0.0494.

## Root Cause

`HARNESS_TOKEN_SEMANTICS[COPILOT_CLI].cacheInputRelationship` is `DISJOINT` (`TokenSemantics.ts`,
around line 49). That tells `calculateTokenCost` (`ModelPricing.ts`, around lines 130-148) that
`prompt` excludes cache tokens, so the full `prompt` is priced at the input rate and `cached` and
`cacheCreated` are then priced on top. `dev/implemented/TOKEN_TOTAL_CACHE_NORMALIZATION_PLAN.md`
reached `DISJOINT` by reading the Copilot CLI summary `↑ 43.7k (21.8k cached, 21.9k written)` as
per-request amounts. It is actually a session running total (two turns of about 21.8k input
each), so it doesn't show the amounts are disjoint.

The existing `SUBSET` relationship subtracts only `cached`. Copilot's input also contains cache
writes, so switching the enum value alone is not enough.

## Suggested Fix

Pick one:

- Normalise at the source: have the Copilot OTel usage path (`CopilotLogParser`
  `pollOtelContextWindow`/`getFinalOtelUsage`, or `CopilotCliProvider.augmentParsedOutput`) report
  `inputTokens = input - cacheRead - cacheWrite` (clamped at 0) and keep `DISJOINT`, so every
  consumer sees consistent, non-overlapping amounts.
- Or add a relationship meaning "input includes both cache reads and writes", and teach
  `calculateTokenCost` and `resolveTokenCounts` about it.

Update the unit test that pins the wrong assumption (`src/test/unit/ModelPricing.test.ts`, around
lines 263-279, "Copilot reports cache reads disjoint…"). Add a regression test using the span above
(input 63,754 / read 31,232 / write 32,516 → about $0.0494). Check whether context-window or
total-token calculations for Copilot also add cache tokens onto an input count that already
includes them.
