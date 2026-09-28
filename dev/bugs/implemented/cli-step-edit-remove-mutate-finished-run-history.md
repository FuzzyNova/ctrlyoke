# `step edit` / `step remove` rewrite already-executed steps of a finished run

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/core/orchestration/RunContinuationService.ts` (`assertEditableDuringExecution`, edit ~778, remove ~912, reorder ~990)
- **Resolution:** fixed in this commit

## Symptom

```
ctrlyoke run a.ctrlyoke.yaml --headless                                   # 3 script steps, all complete
ctrlyoke step remove --workflow <key> --run 1 --index 0 --json            # success: true, stepCount 2
ctrlyoke step edit   --workflow <key> --run 1 --index 1 --prompt x --json # success: true
```

A step with `_runtime.terminalStatus: "failed"` in a run that stopped with an error can be edited and
removed the same way. Afterwards the run definition has 2 steps while `history show` still reports
"Step 1/3 … 3/3", so the run record no longer matches what executed.

The docs say otherwise: `docs/cli/ctrlyoke.md` — "An edit is accepted for any not-yet-executed step
… the completed prefix and in-flight step remain protected"; `docs/reference/mcp-tools.md` —
"Completed and currently running steps cannot be edited, removed, or moved." `step reorder` on the
same run already protects the executed prefix (its movable set starts at `currentIndex`).

## Steps to Reproduce

As above, using only `type: script` steps.

## Root Cause

`assertEditableDuringExecution` (`RunContinuationService.ts:~1224`) returns early unless the run is
running or paused, so edit and remove skip the executed-prefix check for stopped, errored and
completed runs. Reorder computes its range from `currentIndex` regardless of state, hence the
inconsistency.

## Suggested Fix

Always reject edit/remove of a step whose index is before the run's `currentIndex` or that has a
terminal `_runtime` status (reuse the existing `assertStepMutable(..., "completedPrefix")` path),
and keep only the in-flight/head check conditional on active execution. Leave the live dashboard
queue (`PromptQueue.assertEditableDuringExecution`) alone unless it has the same persisted-history
problem. Tests: edit/remove of a completed or failed step in a finished run is refused; editing a
never-executed trailing step of a stopped run is still allowed.
