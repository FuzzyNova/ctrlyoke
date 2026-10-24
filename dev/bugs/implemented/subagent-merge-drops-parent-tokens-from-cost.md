# Subagent usage merge makes cost ignore the parent's own tokens when the parent reports no per-model usage

- **Found:** 2026-10-23 by review of the subagent output attribution plan (section 4)
- **Area:** `src/core/harness/shared/mergeSubagentOutput.ts`, `src/utils/ModelPricing.ts`
- **Resolution:** fixed in this commit

## Symptom

For a harness whose parent usage has no `modelUsage` (codex-cli, qwen-cli, opencode-cli, antigravity-cli, and claude-cli interactive, which the plan lists as "parent-only"), a step that launched subagents shows a cost covering only the subagents. The parent's tokens are in the token totals but missing from the estimated cost, so the cost is understated and is still marked `COMPLETE`.

## Steps to Reproduce

1. Run a step on one of those harnesses where the parent used N tokens and a child registered `usage` (for example a child on a different model).
2. `mergeSubagentOutput` receives `output.metadata.modelUsage` / `usage.modelUsage` as `undefined`.
3. `WorkflowExecutor.resolveTokenCounts` passes `u.modelUsage` to `calculateAttemptCost`.
4. The cost is the sum over the child models only. The parent's tokens, which are in `prompt` / `completion`, are not priced.

## Root Cause

`mergeSubagentOutput` seeds `modelUsage` from `output.metadata.modelUsage ?? output.metadata.usage?.modelUsage ?? {}` (line 53). When the parent has no per-model breakdown, the seed is empty and only child models are added. That makes `modelUsage` non-empty, and `calculateAttemptCost` (`ModelPricing.ts` line 220) then takes `calculatePerModelCost` and ignores `prompt` / `completion` / `cached` entirely. The merge never adds an entry for the parent's own model (`metadata.model`) carrying the parent's pre-merge totals. Plan section 4 requires the per-model costs to be summed so that children are included. It does not allow the parent to drop out.

If a child uses the parent's model, its tokens are added to that model's entry, which has the same effect. The parent's tokens are still missing.

## Suggested Fix

In `mergeSubagentOutput`, when the prior output has no `modelUsage` and children contribute usage, first seed an entry keyed by `output.metadata.model` from `priorUsage` (input, output, cache-read, cache-write, long-TTL, reasoning). If the parent model is unknown, skip the per-model path by leaving `modelUsage` unset and marking coverage `PARTIAL`. Add a `mergeSubagentOutput` plus `calculateAttemptCost` test with a parent that has no `modelUsage`.
