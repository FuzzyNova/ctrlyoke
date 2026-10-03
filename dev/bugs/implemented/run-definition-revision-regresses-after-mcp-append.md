# A running run's definitionRevision does not increase with MCP appends, and can go backwards

- **Found:** 2026-10-02 by Claude (claude-cli), inspecting the live `more bug backlog2` run with `ctrlyoke history`; the exact writer that rolls it back was not pinned down
- **Area:** `src/core/orchestration/RunContinuationService.ts` (`appendStepsToRun`), `src/core/PromptQueue.ts` (disk merge + `updateWorkingFileDirect` writes), `src/core/orchestration/TimelineRecorder.ts` (`commitDefinitionRevisionIfNewer`)
- **Resolution:** runtime-write rollback fixed in 68608cafd; the merge, definition-write (ABA / dropped append) and client-republish defects fixed in this commit

## Symptom

In a long run that extends itself (a planner step plus repeated `finalStep` reviews,
all calling `append_step` against their own running run), the working file grew from
1 to 64 steps, but its `definitionRevision` ended at **5**. The revisions that
`append_step` reported back to the agent repeat and go backwards. These are the
(`newQueueSize`, `definitionRevision`) pairs recorded in that run's `events.jsonl`:

```
size=5  rev=2
size=7  rev=4   size=10 rev=4   size=13 rev=4   size=16 rev=4   size=21 rev=4
size=23 rev=6   size=28 rev=6   size=34 rev=6   size=39 rev=6   size=43 rev=6
size=47 rev=6   size=49 rev=7   size=54 rev=6   size=60 rev=6   size=64 rev=6
```

`appendStepsToRun` writes `sourceRevision + 1` (`RunContinuationService.ts` ~425)
under the run-file lock, so five consecutive appends that each report `4` mean some
other writer put the file back to `3` between them. Revision `7` followed by `6`,
and the final on-disk `5`, are outright regressions.

Consequences:

1. **The optimistic-concurrency guard is weakened.** `definitionRevision` is what
   clients echo back to reject stale edits (`core.instructions.md`). A revision
   that returns to an earlier value means a client holding that superseded number
   can pass the check again (ABA).
2. **Run history loses step definitions.** `commitDefinitionRevisionIfNewer` only
   records a `DEFINITION_REVISION_COMMITTED` event when the revision increases.
   This run has exactly two such events (revisions 3 and 5) for about 12 appends.
   Every attempt for a step past index 20 therefore resolves against the
   21-step revision-5 snapshot with `definition.step` undefined. `history show`
   then renders headers like `Step 55/21 — Step 55`, with no step name and no
   harness (see `cli-history-step-counts-disagree-and-go-stale.md`).

## Steps to Reproduce

1. Start a workflow whose first step uses `append_step` to queue several steps on
   its own run, and give it a `finalStep` that also appends.
2. Let several steps complete while appends continue.
3. Compare the `definitionRevision` in each `append_step` result with the working
   file's `definitionRevision` and with the run's `definitionRevisionCommitted` events.

The extension session log for this run (`ctrlyoke-1790978827576.log`) shows 187
`updateWorkingFileDirect write analysis` entries on the working file with
`"definitionRevision":"no-op"`, 4 with `"changed"`, and four
`mergeStepsFromDisk: Found N new steps from disk (MCP append)` merges.

## Root Cause

Confirmed; three defects in the in-process queue's handling of an
out-of-process definition change:

1. **Merges adopted steps without their revision.**
   `PromptQueue.mergeStepsFromDisk` (the working-file watcher merge behind the
   `Found N new steps from disk` log line) never copied the disk `definitionRevision`, and the outcome /
   parallel-settlement merges copied it only when they themselves found new
   steps. Memory stayed on the superseded number; `PromptFileLoader` published
   it to the dashboard via `STEPS_EXTENDED` (the client's next edit then
   conflicted), and `WorkflowInstance.getDefinitionRevisionContext` handed it to
   `commitDefinitionRevisionIfNewer`, which correctly ignored a revision the
   manifest already had — so the appended steps' definition was never committed.
2. **Runtime writes serialized the stale memory counter.**
   `WorkingFileManager.updateWorkingFileDirect` wrote
   `queueAccess.getDefinitionRevision()` without looking at disk, so the next
   outcome/session flush rolled the append's revision back.
3. **Local definition mutations bumped the stale counter outside the lock.**
   `bumpDefinitionRevision` ran on memory before a `skipMerge` write, so with
   memory at `m` and disk at `d > m` an edit produced `m + 1`: either a
   regression, or (once writes took `max`) a different definition stored under
   a revision an MCP append had already reported (ABA). Because the write
   serialized memory's step list, it also silently dropped the MCP-appended
   steps memory had not merged yet. Unguarded callers (e.g.
   `WorkflowInstance`'s append-from-file, which arms no expected revision) had
   no other protection.

## Fix

- Every in-process disk merge goes through `PromptQueue.mergeDiskDefinition`,
  which adopts `max(memory, disk)` along with the steps; `PromptFileLoader`
  republishes `STEPS_EXTENDED` whenever the merge changed the revision, even
  with no new steps.
- Runtime writes persist `max(disk, memory)` under the working-file lock.
- Local definition mutations run mutation + write as one `runInQueue`
  operation and persist through `WorkingFileManager.persistDefinitionMutationDirect(base)`.
  Under the lock it rejects with `Definition revision conflict` and resyncs the
  queue from disk when disk is past `base` (the edit was built on a definition
  it never saw); otherwise it writes `max(disk + 1, memory)`, strictly above the
  revision it replaces. Rejection was chosen over merging the disk-only steps:
  local edits are index-addressed against the caller's view and `mergeDiskSteps`
  is disk-authoritative, so a rebase could apply an edit to the wrong step.
- `discardPendingRewind` still restores the base snapshot's lower revision; it
  is a static writer outside this path.

Regression tests: `promptQueue.test.ts` ("definition revision vs out-of-process
writers") and `OutputHistoryManager.test.ts` ("an out-of-process append
survives a runtime write and is committed before its first output"), both on a
real `PromptQueue` and asserting the file read back from disk.
