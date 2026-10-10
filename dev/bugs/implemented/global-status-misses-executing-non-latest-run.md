# `ctrlyoke status` and MCP `global_status` miss an executing run that is not the lineage's latest

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (confirmed with a scratch `npx tsx` script against `GlobalWorkflowStatusService`)
- **Area:** `src/core/orchestration/GlobalWorkflowStatusService.ts` (`getStatus`)
- **Resolution:** fixed in this commit

## Symptom

Continue or append to an older run while a newer run of the same workflow
exists, for example `ctrlyoke continue --workflow X --run <older>`. While it
executes:

- Plain `ctrlyoke status` prints "No workflows are executing."
- `ctrlyoke status --workflow X` says the newest run "exists but is not
  executing (state: completed), so it is not listed here."
- MCP `global_status` behaves the same way.

The run is only visible if you already know its ref and pass `--run`. The docs
say both commands list the workflows that are currently executing
(`docs/reference/mcp-tools.md`, `docs/reference/commands.md`).

## Steps to Reproduce

1. Use a lineage with an older run whose working file has
   `_runtime.executionState: "running"` (and a `runner.json` naming it), and a
   newer run that is `completed`. The descriptor's `latestRunRef` is the newer
   run.
2. `getStatus()` returns `workflowCount: 0`.
3. `getStatus({ workflowKey })` returns 0 rows plus the "not executing (state:
   completed)" note.
4. `getStatus({ workflowKey, runRef: older })` returns the running row.

## Root Cause

With no run selector, `GlobalWorkflowStatusService.getStatus` reads only
`descriptor.latestRunRef` and drops the lineage if that run is not in an active
execution state. `latestRunRef` is written only when a run is allocated
(`WorkflowLineageRepository.ts`, `latestRunRef: allocation.runRef`) or when runs
are deleted. Continuing or appending to an older run executes it in place
(`RunContinuationService.validateContinuationTarget` accepts any run in the
lineage), so `latestRunRef` keeps pointing at the finished newer run.

`runner.json` names the run that is actually executing, and
`CliStatusCommand.describeLiveness` even has an `OTHER_RUN` case for that, but
the status service never consults the runner lock when it picks which run to
report.

## Suggested Fix

When no `runRef` is given, read the lineage's runner lock first (the existing
`WorkflowLockManager`/`WorkflowLockInspector` helpers). If it names a run in
this lineage, report that run. Otherwise fall back to `descriptor.latestRunRef`.
Keep the narrowed-selector note wording for the case where nothing is
executing.

Test in `src/test/unit/GlobalWorkflowStatusService.test.ts`, using the setup
above, with no selector and with only the workflow key. Also check that
`ctrlyoke status` liveness for that row is reported `alive`, not
`stale (other-run)`. The existing `CliStatusCommand` tests are the place for
that check.
