# `history show --step final…` misreports a run whose final step never ran

- **Found:** 2026-11-01 by Claude Code (bug-hunt final step, exercising the CLI)
- **Area:** `src/cli/HistoryInspectionCommands.ts`, `src/core/StepIdentity.ts`
- **Severity:** low

## Symptom

On a run that has a `finalStep` but stopped before reaching it (for example, step 1 failed):

- `ctrlyoke history show --workflow <key> --step final` (or `final:latest`) prints only
  `Run: <ref>` and exits 0. There is no notice that the final step has not run, unlike the
  documented notice for a queue step (`--step 57 has not started (pending)`).
- `--step final:1` fails with
  `Invalid --step value "final:1"; valid final pass numbers are 1 to 0` (exit 2), an
  impossible range.
- A parse error for a final selector also gets the queue-index range appended. For example,
  `--step final:0` says "...; valid zero-based indices are 0 to 2", which says nothing about
  pass numbers.

Related wording problem in the same area: step mutations refused on a run that has already
settled (completed or errored) say `Cannot remove a completed step while the workflow is
running`. That comes from `STEP_MUTATION_ERROR_MESSAGES.completed`
(#selection:src/core/StepIdentity.ts:6-13), and `ctrlyoke step remove|edit --json` and the
MCP `remove_step`/`edit_step` tools all return it. The run is not running, and a *failed*
step is also called "completed".

## Steps to Reproduce

1. Create a scratch workflow with two script steps, where step 1 fails (`exit 1`), and a
   script `finalStep`. Run it with `ctrlyoke run`.
2. `ctrlyoke history show --workflow <key> --step final` prints only `Run:` and exits 0.
3. `ctrlyoke history show --workflow <key> --step final:1` gives "valid final pass numbers are
   1 to 0".
4. `ctrlyoke step remove --workflow <key> --run 1 --index 1 --json` gives "Cannot remove a
   completed step while the workflow is running".

## Root Cause

- #selection:src/cli/HistoryInspectionCommands.ts:653-662 builds the pass-range error from
  `index.finalPassCount` without handling `0`. The "not started" notices further down only
  cover queue selectors.
- #selection:src/cli/HistoryInspectionCommands.ts:602-609 appends
  `formatValidStepIndexRange(stepCount)` to every selector parse error, final selectors
  included.
- The mutation message hard-codes "while the workflow is running" and "completed".

## Suggested Fix

- When `finalPassCount === 0`, emit a "final step has not run (<status>)" notice for `final`,
  `final:latest` and `final:N`, mirroring the queue-step notice in both text and `--json`
  output (additive JSON field, same shape as the queue notice). Exit as the queue-step notice
  does.
- Append the queue-index range only to queue-style selector errors.
- Reword `STEP_MUTATION_ERROR_MESSAGES.completed` so it is true in every state, e.g.
  `Cannot ${operation} a step that has already run`. Check the copies at
  `RunContinuationService.ts` and `PromptQueue.ts` that reuse or duplicate it, and update any
  tests that assert the old text.
