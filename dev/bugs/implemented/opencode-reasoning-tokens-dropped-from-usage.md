# OpenCode reasoning tokens are dropped from output, total and table-priced cost

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/utils/TokenSemantics.ts`, `src/core/harness/opencode/OpenCodeEventMapper.ts`, `src/utils/ModelPricing.ts`
- **Resolution:** fixed in this commit

## Symptom

For OpenCode steps on reasoning models, the reported output and total tokens leave out every
reasoning token. A real 30-step `opencode/big-pickle` session reports `outputTokens 3,294` and
`totalTokens 43,307`, even though the model generated 13,955 tokens (3,294 output + 10,661
reasoning). When OpenCode does not report a `cost` and ctrlyoke prices the step from its pricing
table, reasoning is priced at $0, so the estimate is about 35% low. When OpenCode does report a
cost, that cost is used, but the token counts are still wrong.

## Steps to Reproduce

1. Read `~/.local/share/opencode/opencode.db` (table `part`, `step-finish` records, OpenCode 1.18.x).
   In all 895 records that have `tokens.reasoning > 0` and a `tokens.total`,
   `total == input + output + reasoning + cache.read + cache.write`. None fit "reasoning included in
   output". Many have reasoning much larger than output (e.g. output 207, reasoning 749).
2. Feed that session's step-finish tokens, wrapped as `step_finish` events, to
   `new OpenCodeLogParser(() => 200000).extractResponse(...)`.
   - Actual: `outputTokens 3,294`, `totalTokens 43,307`; with a pricing-table estimate, `reasoningUsd 0`.
   - Expected: reasoning counted, i.e. total 53,968 (input + output + reasoning, cache excluded, the
     same convention as today) and reasoning priced.

## Root Cause

- `HARNESS_TOKEN_SEMANTICS[OPENCODE_CLI].reasoningRelationship` is `INCLUDED_IN_OUTPUT`
  (`TokenSemantics.ts`, around lines 38-41). OpenCode actually reports reasoning as a separate
  amount. The normalization plan in `dev/implemented/TOKEN_TOTAL_CACHE_NORMALIZATION_PLAN.md` based
  this on sessions where reasoning was always 0, and it listed this as an open caveat.
- `accumulateOpenCodeStepTokens` (`OpenCodeEventMapper.ts`, around lines 34-42) builds
  `totalTokens` as `input + output` and ignores `tokens.reasoning`.
- Even with `DISJOINT`, `calculateTokenCost` (`ModelPricing.ts`, around lines 150-153) prices
  reasoning at `reasoningPerMTok ?? 0`. Models with no separate reasoning price then get it for free,
  when it should fall back to `outputPerMTok`.

## Suggested Fix

Mark OpenCode reasoning `DISJOINT`. Accumulate `tokens.reasoning` into `reasoningOutputTokens` and
into `totalTokens` in `accumulateOpenCodeStepTokens`. Make `calculateTokenCost` price disjoint
reasoning at `reasoningPerMTok ?? outputPerMTok`. Before changing that fallback, check which other
harnesses use `DISJOINT` reasoning so their costs don't shift unexpectedly. Add regression tests
with a `step_finish` fixture where reasoning is greater than output (e.g. input 24073, output 207,
reasoning 749), covering tokens and a table-priced cost.
