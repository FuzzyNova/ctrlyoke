# Final-step loop decision misses steps appended out of process that haven't been merged yet

- **Found:** 2026-10-09 by claude-cli while scoping `dev/backlog/SCRIPT_GENERATED_STEPS_PLAN.md` (code reading; not reproduced)
- **Area:** `src/core/WorkflowExecutor.ts` (final-step loop, ~745-839)
- **Severity:** medium

## Symptom

A final step queues more work through another process (MCP `append_step`, or a
future `ctrlyoke step add` from a script), but the workflow can still finish as
if the pass appended nothing. The appended steps end up in the run file as
pending steps of a completed run, and they never execute. This is the "steps
written to a settled run would never execute" outcome that
`assertRunAcceptsMutation` in `mcp-server.ts` exists to prevent.

## Steps to Reproduce

1. A workflow whose `finalStep` appends a step out of process and then finishes
   immediately. The clearest case is a script `finalStep` that calls the
   continuation service (or an MCP client) and exits.
2. Run it from a host that polls the run file rather than watching it natively.
   This includes every user-scoped run under `~/.ctrlyoke/projects/...`, which
   is outside the workspace watcher roots, so `PromptFileWatcher` falls back to a
   1 s `setInterval` poll.
3. The final step completes within the poll interval of the append. The executor
   reports the final step completed and the workflow ends. The appended step
   stays pending.

## Root Cause

The loop decides whether the pass appended work by comparing **in-memory**
queue sizes (`WorkflowExecutor.ts` ~745 `queueSizeBefore` and ~793
`queueSizeAfter`). Nothing guarantees that an out-of-process append has been
merged into memory by the time line ~793 runs:

- Queue steps don't have this problem.
  `PromptQueue.commitStepOutcomeAndAdvance` re-reads the run file and calls
  `mergeDiskDefinition` under the working-file lock before advancing. The
  final-step target returns early from that method, and no final-step
  equivalent exists.
- After a successful final step, no runtime write happens before the check
  (`writeQueueState` merges disk steps on every non-`skipMerge` write). Script
  steps persist `elapsed` only for queue targets (`WorkflowExecutor.ts` ~2819),
  and prompt steps do the same (~2367). The next final-step write is the
  `setFinalStepRuntime` at ~823, which comes after the decision.
- The only remaining merge source is the file watcher or poller
  (`WorkflowInstance.setupPromptFileWatcher` →
  `PromptFileLoader.reloadFromWorkingFile`, "Scenario 2"), which is
  asynchronous and polls at 1 s for run files outside the workspace.

AI final steps mostly avoid this by accident. The model keeps writing its
summary for several seconds after its last `append_step`, which gives the
watcher time to merge. A script final step that appends and exits has no such
slack.

## Suggested Fix

Before reading `queueSizeAfter`, merge the on-disk definition under the
working-file lock, the same way `commitStepOutcomeAndAdvance` does for queue
steps. For example, add a `PromptQueue` method that runs
`readWorkingFile` + `mergeDiskDefinition` inside
`runInQueueWithWorkingFileLock` and fires `onDiskStepsMerged` when it found
steps, then call it after `executeWithSnapshot` returns for the final target.
That makes the loop decision deterministic for every out-of-process writer.

Test: a final step whose execution appends through
`RunContinuationService.appendStepsToRun` and returns immediately, with no file
watcher. The loop must run the appended step and then run the final step again.
