# Prior context can return a condition script's output as the step's own output

- **Found:** 2026-10-13 by Claude (prior-context plan review; found by reading the code, no
  reproduction yet)
- **Area:** `src/core/orchestration/RunOutputResolver.ts`
- **Resolution:** fixed in this commit

## Symptom

`$previous`, `$step:N`, and MCP `read_output` can report a step's **pre-condition** (or
end-condition) script stdout as that step's response:

1. **Step that never ran.** A step whose pre-condition failed, so the step itself never started,
   still yields a prior-context item: its authored prompt paired with the condition script's
   stdout as `<response>`.
2. **Interrupted step after a pre-condition.** When a step's own attempt was interrupted (no
   `ATTEMPT_TERMINATED`), the pre-condition's output wins over the step's partial output.

## Steps to Reproduce

1. Queue step 1 with a pre-condition script that prints `checking…` and fails, so step 1 is
   skipped. Step 2 uses `$previous`.
2. Run the workflow.
3. Step 2's prior context contains step 1's prompt with `checking…` as its response.

Case 2: give step 1 a passing pre-condition, stop the run while step 1's AI attempt is
streaming, then resolve `$step:1`.

## Root Cause

- Condition scripts record their own attempts on the step's target, with the step's
  `attemptIndex` and a `phase` (`ScriptExecutionReporter.ts:249-260`), so their attempt key
  carries a phase suffix (`getAttemptKey`, `RunOutputResolver.ts:1404-1406`).
- `ATTEMPT_TERMINATED` is only ever written without a phase (`OutputHistoryManager.ts:575-598`).
  A condition attempt therefore never terminates under its own key. It stays open until the end
  of the stream and settles as unterminated (`streamAttempts`, `RunOutputResolver.ts:570-572`).
- `resolveLatestAttempts` (`:662-690`) keys values by **target only** and takes the first value
  it sees unless a later one is strictly newer (`isNewerAttempt`, `:1408-1417`). Unlike
  `resolveAttemptProjection`, which skips `TIMELINE_ATTEMPT_KINDS.CONDITION` attempts (`:737-740`),
  it does not filter condition attempts.
  - With no step attempt at all, the condition value is the only candidate (case 1).
  - At the end of the stream, still-open attempts are yielded in insertion order. The
    pre-condition was opened first, so it wins over an unterminated step attempt with the same
    index (case 2).
- `resolvePriorContextItems` then uses that value's `responseText` (`:1025`), which is the
  condition's stdout. `getStepScriptVerdict` already guards against this for verdicts (`:1392-1402`);
  the text has no such guard.

## Suggested Fix

Skip condition attempts in `resolveLatestAttempts`, as the projection does, using the
`attemptKind` from `ATTEMPT_STARTED`. Add resolver tests for both cases before changing it.
This is Phase 0 of [`PRIOR_CONTEXT_DETAIL_PLAN.md`](../../backlog/PRIOR_CONTEXT_DETAIL_PLAN.md),
because that plan makes the resolver the only source of step output.
