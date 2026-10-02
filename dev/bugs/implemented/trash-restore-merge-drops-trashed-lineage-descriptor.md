# Restoring trash entries oldest-first permanently drops the trashed lineage's descriptor and draft

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli subagent), reproduced with a tsx script
- **Area:** `src/core/orchestration/HistoryTrashRepository.ts` (`restore`, ~690-760), `src/core/orchestration/WorkflowLineageRepository.ts` (`restoreRuns`, ~500-531)
- **Resolution:** fixed in this commit

## Symptom

1. Delete one run of a workflow. This creates trash entry A, which holds only that run.
2. Delete the whole workflow. This creates entry B, which holds the lineage dir: `workflow.json`, the draft, and the remaining runs.
3. In Recently deleted, restore A, then B.

All runs come back, but the lineage's `workflow.json` is a synthesized minimal
descriptor:
`{"workflowName":..., "isFavorite": false, "createdAt": <restore time>, ...}`.
The original `originalFile`, `isSystemGenerated`, `isFavorite`, `createdAt`, and
any other descriptor fields are gone, and so is the draft. Entry B's copies were
deleted from the trash, so nothing can recover them. Losing `isSystemGenerated`
also makes a system lineage (for example the commit-message lineage) appear in
recent sessions.

Restoring B first, then A, works correctly.

## Root Cause

- Restoring A finds no lineage, so `WorkflowLineageRepository.restoreRuns` writes a fresh minimal descriptor.
- Restoring B then sees `lineageDir` exists and takes the merge path. That path moves only run directories.
- Then this line deletes B's trashed `workflow.json` and draft:
  ```ts
  if ((await listRunDirNames(source)).length === 0) {
    await fs.promises.rm(source, { recursive: true, force: true });
  }
  ```
- The comment there says "the live lineage's are the ones that count". That's false when the live descriptor was synthesized moments earlier by a restore.

## Suggested Fix

When a whole-lineage item merges into an existing lineage, read the trashed
`workflow.json` and use it as the base descriptor. Keep the live
`latestRunRef`/`nextRunId`/`revision` repairs `restoreRuns` already performs, and
take the max of the `nextRunId` values. If the live lineage has no draft and the
trashed one does, move the trashed draft in too. Alternatively, let `restoreRuns`
accept an optional fallback descriptor and use it in place of the synthesized
one. Add Mocha coverage for the A-then-B order.
