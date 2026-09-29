# `$step:` ranges are rejected when they overlap or go past 100, whatever the workflow's step limit

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/utils/RangeNotationParser.ts`
- **Resolution:** fixed in this commit

## Symptom

The unbounded-expansion fix (`dev/bugs/implemented/prior-context-step-range-unbounded-expansion.md`)
caps range expansion at `DEFAULT_MAX_STEPS` (100). The cap is enforced on the summed raw size of
every part, not on unique indices. It also ignores a workflow's real step limit (`maxSteps` or
`queue.maxSteps` may be larger than 100, or -1 for unlimited):

| Input         | Result  | Expected                       |
| ------------- | ------- | ------------------------------ |
| `1-100`       | 100 ids | 100 ids                        |
| `1-100,1`     | `null`  | 100 ids (dedupes to 100)       |
| `1-60,50-100` | `null`  | 100 ids                        |
| `1-101`       | `null`  | 101 ids in a 200-step workflow |

`FileReferenceParser.ts` (around line 401) skips a `null` range with only a `console.warn`. So
`$step:1-120` in a long workflow silently attaches no prior context. The same parser backs
`PriorContextSelect`, `useOutputExport` and `atomicReferences`.

## Steps to Reproduce

Call `parseRangeNotation` with the inputs above (verified with a tsx script).

## Root Cause

`RangeNotationParser.ts` lines 31-33 and 42-43 increment `expandedCount` by each part's raw size
and compare it against `DEFAULT_MAX_STEPS`.

## Suggested Fix

Keep the OOM protection but make it a sanity bound, not a step limit:

- Enforce a generous, single-sourced ceiling on **unique** indices, well above any realistic
  workflow (for example a named constant of 10 000).
- Check it before expanding each range. `result.size + rangeCount` is fine as a conservative
  pre-check.
- Keep rejecting non-safe integers.

Update the tests added by the earlier fix (huge range, many ranges over the cap, non-safe integer)
to the new bound. Add the table above as regression tests, including a 150-step range.
