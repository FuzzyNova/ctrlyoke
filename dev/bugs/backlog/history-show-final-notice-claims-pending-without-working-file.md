# `history show --step final` claims a pending final step when the run has no working file

- **Found:** 2026-11-01 by bug-hunt final step (claude-cli)
- **Area:** `src/cli/HistoryInspectionCommands.ts`
- **Severity:** low

## Symptom

For a run whose `workflow.ctrlyoke.json` is missing or unreadable (a damaged
or legacy run directory), `ctrlyoke history show --step final` (also
`final:latest` and `final:N`) prints
`--step final: the final step has not run (pending)` and exits 0, with
`status: "pending"` under `--json`. It does this even when the workflow never
had a final step. `docs/cli/ctrlyoke.md` (around line 762) promises that
notice only "when a run has a final step that never ran". Before ~5df7b1fe1
the same input printed nothing.

## Steps to Reproduce

1. Take a finished run with no final step and delete (or corrupt) its
   `run-<timestamp>/workflow.ctrlyoke.json`, keeping `manifest.json` and
   `events.jsonl`.
2. Run `ctrlyoke history show -w <workflow> --step final`.
3. It reports the final step as pending instead of rejecting the selector or
   saying the state is unknown.

## Root Cause

The "no final step" guard in `showHistoryCommand` only fires when
`runSummary.hasFinalStep === false`. `hasFinalStep` comes from the working
file (`OutputHistoryManager.ts`, `hasFinalStep: workingFile.finalStep !==
undefined`), so it is `undefined` when that file can't be read. With no
recorded pass, the final-step notice then calls
`historyFinalStepState(undefined, [])`, which falls through to
`historyWorkingStepState(undefined)` and returns `pending`.

## Suggested Fix

When the working definition is unavailable and `hasFinalStep` is unknown,
don't infer `pending`: report an `unknown` state (for example
`--step final: the final step's state is unknown (no working file)`) with a
matching `status` in the `--json` notice. Add a test in
`src/test/unit/HistoryInspectionCommands.test.ts` next to "reports a final
step that never ran for every final selector", using a summary without
`hasFinalStep` and no working file. Check whether `history steps` has the same
fallback and fix it the same way if so. Update `docs/cli/ctrlyoke.md` if the
notice text or status values it documents change.
