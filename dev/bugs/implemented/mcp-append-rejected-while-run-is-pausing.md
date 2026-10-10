# Pressing Pause during an orchestrator step makes its `append_step` fail with a misleading "another run is executing" error

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (hit live: the user pressed Pause while this final step was running; every `append_step` call then failed)
- **Area:** `src/core/orchestration/RunContinuationService.ts` (`validateContinuationTarget`), MCP `append_step`/`edit_step`/`remove_step`/`reorder_steps`
- **Resolution:** fixed in this commit

## Symptom

Pause is documented to let the current step finish and then pause. But once
the run's `executionState` is `pausing`, the still-running step's own MCP
queue mutations are rejected:

```
append_step → Error: Another run in this workflow lineage is executing and ownership is indeterminate
```

- The message is wrong: no other run exists. The lock names this exact run,
  and its owner is the live host executing the calling step.
- An orchestrator / final step (e.g. a spec-driven loop or a bug-hunt final
  step) cannot queue the follow-up work it was asked to queue. When it ends,
  the run pauses with nothing appended. For a final step, appending nothing is
  how a loop declares completion, so the planned work is lost unless someone
  queues it by hand.

## Steps to Reproduce

1. Run a workflow whose final step calls `append_step`.
2. While the final step is running, press Pause (state becomes `pausing`).
3. The final step calls `append_step` → the error above.

## Root Cause

`RunContinuationService.validateContinuationTarget` (~194-201) only treats an
append/edit as the exact-run dynamic operation when
`executionState === EXECUTION_STATES.RUNNING`. In `pausing`,
`activeTargetOperation` is false, so the active lock (which names this run but
belongs to another process from the MCP server's point of view) falls into the
"another run in this lineage is executing" branch (~232-250). Even past that,
the explicit `PAUSING`/`CANCELLING` rejection (~260-266) would block it.
`dev/implemented/RUN_HEAD_MUTABILITY_FOLLOWUP.md` keeps `PAUSING` runs
mutation-locked "except the existing exact-run dynamic MCP append", but that
exception was implemented for `RUNNING` only.

## Suggested Fix

Extend the exact-run dynamic-mutation exception to `PAUSING`: when the lock is
active, names the target run, and the caller is the step currently executing
in that run (as already established for `RUNNING`), allow the append/edit.
Steps appended during `pausing` are simply queued; the run still pauses after
the current step, and Resume runs them. Keep `CANCELLING` rejected. Separately,
when the lock names the target run, never report "Another run in this workflow
lineage is executing" — say the run is pausing/cancelling. Tests in
`src/test/unit/RunContinuationService.test.ts` and
`src/test/unit/McpServer.test.ts` (append during `pausing` succeeds; during
`cancelling` fails with an accurate message).
