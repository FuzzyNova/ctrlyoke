# Discarding a continuation leaves a resident queue holding the rewound definition

- **Found:** 2026-10-03 by Claude (claude-cli), reviewing 08d87da41 (code reading only, not reproduced)
- **Area:** `src/core/orchestration/RunContinuationService.ts` / `WorkflowLineageRepository` (`discardPendingRewind`), `src/core/PromptQueue.ts`, `src/core/WorkingFileManager.ts`
- **Resolution:** fixed in this commit

## Symptom

`discardContinuationAtRun` restores the run's base snapshot through the static
`discardPendingRewind` writer, which deliberately lowers `definitionRevision`.
Nothing updates a resident `WorkflowInstance` whose `PromptQueue` already applied
that pending rewind. Its queue keeps the higher revision, the rewound steps, and
`pendingRewind`. Its next write through `WorkingFileManager.updateWorkingFileDirect`
takes `max(disk, memory)`, so it could put the discarded steps and revision back
over the restored snapshot.

This predates 68608cafd / 08d87da41; those commits did not change it.

## Steps to Reproduce (from code reading)

1. With a run loaded in a resident instance, start a rewind/continuation so the queue applies the pending rewind.
2. Discard the continuation (`discardContinuationAtRun`).
3. Trigger any runtime or definition write from the resident instance. The working file may again contain the rewound steps at the higher revision.

## Root Cause

`discardPendingRewind` writes the file outside the resident queue's operation path
and publishes nothing that makes the queue reload, so memory stays ahead of disk.

## Suggested Fix

After a discard, reload (or `resyncQueueFromDisk`) any resident instance for that
run address, and clear its `pendingRewind`. Add a test: apply rewind → discard →
runtime write, then assert the restored snapshot and its lower revision survive on disk.
