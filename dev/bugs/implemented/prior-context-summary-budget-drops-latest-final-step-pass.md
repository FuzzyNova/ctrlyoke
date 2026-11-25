# Prior-context summary budget drops the latest final-step pass before older queue steps

- **Found:** 2026-11-25 by bug-hunt workflow final step (Claude subagent, reproduced against compiled `out/`)
- **Area:** `src/core/HarnessIntegration.ts` (`buildPriorContextXmlFromItems` ~272-282, `applySummaryBudget` ~304-327), `src/core/orchestration/RunOutputResolver.ts` (~1360-1416)
- **Resolution:** fixed in this commit

## Symptom

When one prior-context block selects summary queue steps and summary final-step passes
together (`$all:summary` plus `$allFinalStep:summary`, e.g. in a looping final step or an
appended step) and the summaries exceed `PRIOR_CONTEXT_LIMITS.SUMMARY_BUDGET_BYTES`
(400 KB), the budget leaves out every final-step pass, the newest one included. Queue steps
from the middle of the run stay. Docs (`docs/workflows/context-files.md` ~116-121), the
CHANGELOG entry and the `SUMMARY_BUDGET_BYTES` doc comment all promise that the earliest
summary steps are left out first and the latest is always kept.

## Steps to Reproduce

1. Build prior-context items as `RunOutputResolver` produces them: 30 summary queue items
   (`index` 0-29, ~16 KB each), then 3 summary `type: "finalStep"` items (`index` 0-2).
2. Pass them to `buildPriorContextXmlFromItems`.
3. Observed order and result: q0, f0, q1, f1, q2, f2, q3, … — q0-q5 and **all three
   final-step passes** become `<step … omitted="all"/>`, q6-q29 are kept. The always-kept
   "latest" step is q29, not pass 3.

## Root Cause

`buildPriorContextXmlFromItems` sorts items only by `item.index` and `applySummaryBudget`
treats that order as chronological (omits from the front, keeps `summaryPositions.at(-1)`).
But a final-step item's `index` is its `loopIndex` (`RunOutputResolver.ts` ~1369), a
separate index space that overlaps the queue indices, so the stable sort interleaves
f0 after q0, f1 after q1, and so on. Before the budget (63b467eb5) that only affected
display order; now it decides what is deleted. Items imported from another run through
`AddressedPriorContextResolver` carry that run's indices and interleave the same way.

## Suggested Fix

Give `applySummaryBudget` a chronological rank independent of the display sort: queue
items before final-step items, final-step items by `loopIndex`; items imported from
another run before the current run's (or simply preserve the resolver's emission order,
which is already chronological per source). Choose both the omitted steps and the
always-kept latest step from that rank, while leaving the rendered order unchanged. Add
a unit test with mixed queue and final-step summary items over budget asserting the
newest pass is kept and the earliest queue steps are omitted first.
