# Antigravity thinking tokens are never priced

- **Found:** 2026-10-23 by Claude Code, during a token and cost accuracy audit
- **Area:** `src/utils/TokenSemantics.ts`, `src/core/harness/antigravity/AntigravityStreamJsonUsage.ts`
- **Severity:** low

## Symptom

A headless Antigravity step that thinks has its thinking tokens left out of
its cost estimate. The step's total token count includes them, so the total and
the cost disagree.

## Steps to Reproduce

The stream-json fixtures in `src/test/unit/AntigravityStreamJsonUsage.test.ts`
show the shape: a `result` with `input_tokens: 17930`, `output_tokens: 1`,
`thinking_tokens: 4`, `total_tokens: 17935`. The total is input + output +
thinking, so `thinking_tokens` is not part of `output_tokens`.

1. Run a headless Antigravity step on a thinking model.
2. The step's cost prices `output_tokens` only.

The local run history has no headless Antigravity attempts with thinking
tokens, so the size of the error in practice is unmeasured.

## Root Cause

`HARNESS_TOKEN_SEMANTICS` declares Antigravity's reasoning as
`INCLUDED_IN_OUTPUT`, so `calculateTokenCost` prices
`reasoningOutputTokens` at zero to avoid double-counting. The stream-json
source maps `thinking_tokens` to `reasoningOutputTokens` and reports it
separately from output. The statusline source, which has no thinking field, is
unaffected.

## Suggested Fix

Change Antigravity's `reasoningRelationship` to `DISJOINT`, so reasoning is
priced at the reasoning or output rate (as OpenCode's is). First confirm that
no other Antigravity usage source folds thinking into `outputTokens`, or the
change would double-count it there. Update the Antigravity cases in
`src/test/unit/ModelPricing.test.ts`.
