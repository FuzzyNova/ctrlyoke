# `ctrlyoke continue` on a completed run executes another final-step pass

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (reproduced with the built CLI on a script-only workflow)
- **Area:** `src/core/orchestration/RunContinuationService.ts` (`validateContinuationTarget`)
- **Resolution:** fixed in this commit — `continue` on a completed run (no pending rewind) is refused with a usage error (exit 2) pointing at `append`, in both the CLI/MCP and dashboard paths; `append` remains allowed

## Symptom

After a run with a `finalStep` completes, `ctrlyoke continue --workflow <key>
--run 1` runs another final-step pass and exits 0. Each further `continue` adds
one more pass. Without a `finalStep`, the same command does nothing and exits 0.
With an AI final step, every accidental `continue` re-runs a paid step.

## Steps to Reproduce

1. Run a workflow with a script `finalStep` to completion (1 pass).
2. `ctrlyoke continue --workflow <key> --run 1` → exit 0, and the run now has
   2 final-step passes.

## Root Cause

`RunContinuationService.validateContinuationTarget`
(`src/core/orchestration/RunContinuationService.ts` ~262-290) does not reject
`executionState === completed` for the `continue` action. `docs/cli/ctrlyoke.md`
describes `continue` as resuming "the unchanged pending work of a stopped,
paused, or interrupted run", and a completed run has no pending work.
`WorkflowStartupPipeline.ts` (~1072-1082) treats a completed final step as not
queued. No design doc explicitly says whether `continue` on a completed run
should start a new final-step pass, so this needs a decision before a fix.

## Suggested Fix

Decide the intended behaviour. If `continue` should only resume unfinished work,
refuse it for a completed run with a clear usage error (exit 2) that points at
`append` for adding work. Otherwise, document that it starts a new final-step
pass. Test in `src/test/unit/RunContinuationService.test.ts`.
