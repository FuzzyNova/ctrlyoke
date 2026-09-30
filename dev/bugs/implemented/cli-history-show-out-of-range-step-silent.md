# `ctrlyoke history show --step N` with an out-of-range index prints nothing and exits 0

- **Found:** 2026-09-29 by bug-hunt final step (claude-cli)
- **Area:** `src/cli/HistoryInspectionCommands.ts` (`parseHistoryShowStep` / `matchesHistoryShowStep`)
- **Resolution:** fixed in this commit

## Symptom

For a completed 3-step run, `ctrlyoke history show --workflow <key> --run 1 --step 5`
prints only `ℹ Run terminated: completed` and exits 0. `--step final` on a run
without a final step behaves the same way. Other CLI commands (`step remove`)
reject an out-of-range index with a clear message and exit 2, e.g. "valid
zero-based indices are 0 to 2". A script that uses `history show --step`
can't tell a wrong index from a step with no output.

## Steps to Reproduce

1. Run any 3-step script-only workflow.
2. `ctrlyoke history show --workflow <key> --run 1 --step 5`.
3. Observe no error and exit 0.

## Root Cause

The step filter is applied to the attempt stream without validating the index
against the run's step count (or whether a final step exists).

## Suggested Fix

After resolving the run, reject an index ≥ the step count, and `final` when the
run has no final step, with a usage error (exit 2) that states the valid range.
Reuse the wording from `step remove`.
