# `$all_files` expands `$all`: prior-context tokens end at an underscore

- **Found:** 2026-10-01 by bug-hunt final step (claude-cli), reproduced by bundling `FileReferenceParser` with esbuild
- **Area:** `src/utils/ReferencePatterns.ts` (`createInlinePriorContextReferencePattern`)
- **Severity:** medium

## Symptom

`parseInlinePriorContextRefs` treats a keyword followed by `_` as a reference:

| Input                 | Parsed                                     | Expected |
| --------------------- | ------------------------------------------ | -------- |
| `for f in $all_files` | `$all` (attaches every prior step output)  | nothing  |
| `$previous_output`    | `$previous`                                | nothing  |
| `$finalStep_1`        | `$finalStep`                               | nothing  |
| `$step:1_x`           | `$step:1`                                  | nothing  |

Shell or Python text pasted outside a fence silently pulls prior outputs into
the prompt. The runtime, the editor chips, and the token counter all share this
pattern, so the chip "agrees" with the wrong runtime behaviour.

## Inconsistency

Elsewhere `_` is a filename/word character:

- `NOT_BEFORE_BOUNDARY` in `src/utils/ReferenceBoundary.ts` includes `_`.
- `$preCondition:stdout_x` is left alone (`createConditionOutputReferencePattern`).
- `~staged_files` is rejected (existing test in `FileReferenceParser.test.ts`).
- The ctrlyoke-syntax skill says not to glue letters or digits onto a token.

## Root Cause

In `createInlinePriorContextReferencePattern`, the keyword alternative
`[A-Za-z][A-Za-z0-9]*` and the step alternative `step:[A-Za-z0-9,\-]*` exclude
`_`. The match stops before the underscore, and the truncated body is a valid
keyword.

## Suggested Fix

Let the body capture include `_`, as `createConditionOutputReferencePattern`
does, so `all_files` reaches `parseInlinePriorContextBody` whole and returns
null. Or add a trailing `NOT_BEFORE_BOUNDARY`-style lookahead. Check the
`$previous: fix it` / `$previous:3x` fallback documented in the pattern's
comment still behaves as written. Keep a single pattern shared by the parser,
the editor decorations, and the token counter.
