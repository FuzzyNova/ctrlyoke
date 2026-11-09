# Resume after a failed parallel group skips the failed members

- **Found:** 2026-11-08 during the resume-after-failure fix
- **Area:** `src/core/PromptQueue.ts` (`applyParallelGroupJoin`), `src/core/WorkflowInstance.ts` (continuation)
- **Resolution:** fixed in this commit — continuation rewinds to the group start and resets every member that did not succeed; succeeded members keep their settlement

## Symptom

When a parallel group has a terminal failure and the run ends in `error`, Resume or `ctrlyoke continue` can start after the group. The failed member is not retried, and successful members remain settled.

## Steps to Reproduce

1. Run a workflow with a parallel group containing a script that fails with `onFail: stopWorkflow`.
2. Fix the script's cause.
3. Resume the errored run.
4. Observe that the continuation starts after the parallel group instead of retrying its failed member.

## Root Cause

`PromptQueue.applyParallelGroupJoin` advances `currentIndex` to `group.endIndex + 1` after the members settle. The sequential failure recovery addresses only the step at `currentIndex - 1`; in a group, that can be a successful member, and the continuation boundary is after the whole group.

## Suggested Fix

Define a consistent recovery policy for a failed group, including which members to reset and how group output attempt indices are allocated, then apply it to dashboard Resume and `continue` before startup announces the continuation.
