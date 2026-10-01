# A slow history delete gets its pending trash entry "recovered" mid-flight, stranding later lineages

- **Found:** 2026-09-30 by bug-backlog final step (claude-cli, code review + fs mtime check)
- **Area:** `src/core/orchestration/HistoryTrashRepository.ts`
- **Resolution:** fixed in this commit

## Symptom

`recoverPendingEntries` treats a `<id>.pending` directory whose mtime is more than 5
minutes old (`STALE_PENDING_ENTRY_MS`) as the leftovers of a crashed delete, and publishes
it. The mtime of the pending directory never moves after the batch creates it, because the
batch moves things into `<id>.pending/payload/`, not into `<id>.pending/` itself. Checked on
Windows/NTFS: renaming a directory into `payload/` leaves the parent's mtime unchanged. So
any delete that takes longer than 5 minutes is treated as crashed while it is still
running.

`recoverPendingEntries` runs from every `list()`. That includes opening Settings →
Recently deleted, `ctrlyoke history trash list`, `purgeAll`, and the scheduled
`purgeExpired`, which another VS Code window on the same user-scoped project runs 60s after
startup and then daily. When one of these runs during a long **Clear all history**, the
following happens:

1. The partial batch is published as a separate entry (kind `all`, requested by
   `recovered`).
2. The still-running batch keeps moving lineages. `movePath` calls `mkdir(recursive)`,
   which quietly recreates `<id>.pending/payload/`.
3. `commit()` → `publishEntry` renames `<id>.pending` onto `<id>`, which now already
   exists. The rename fails, and Clear all history reports a failure.
4. Every lineage moved after the hijack is left in `<id>.pending`. It is gone from the
   workflow list and never shows up in Recently deleted. Each later recovery attempt
   collides with the same existing `<id>`, so the lineages are never restorable from the UI
   and never purged.

Long deletes are realistic. Each refused rename retries for up to 2s
(`MOVE_RENAME_BUDGET_MS`) before falling back to a recursive copy. That is the normal path
for a user-scoped state home under OneDrive, and for watched directories. A few hundred
lineages, or a few GB of `events.jsonl`, are enough to pass 5 minutes.

## Steps to Reproduce

Deterministic, as a unit test:

1. `const batch = trash.begin(ALL, "t"); await batch.moveLineageDir(keyA);`
2. Backdate `pendingTrashEntryDir(root, batch.entryId)` by 6 minutes with `fs.utimes`.
   This is exactly the state a batch that started 6 minutes ago is in.
3. `await trash.list(30)`. Key A is published as a "recovered" entry.
4. `await batch.moveLineageDir(keyB); await batch.commit()` throws, and key B is left
   under `<id>.pending`, not reachable from `list()`.

## Root Cause

Whether a pending entry is abandoned is decided only from the mtime of its top directory,
which never reflects the batch's progress (`recoverPendingEntries`, ~l.539-555). Nothing
records that a live process owns the batch. `publishEntry` also can't cope with a target
that already exists.

## Suggested Fix

- Record ownership. When the pending directory is created, write an owner marker such as
  `owner.json` with the pid and host, and have recovery skip entries whose owner is alive.
  `WorkflowLockInspector`/`WorkflowLockManager` may already have a pid-liveness helper to
  reuse. Keep the mtime threshold only as a fallback for entries with no marker. Touching
  the pending directory before and after each move is a cheap extra heartbeat, but it
  doesn't cover a single move that lasts more than 5 minutes, so it can't be the whole
  fix.
- Make `publishEntry` safe when the target already exists: publish under a fresh entry id,
  or merge the payloads, so moved history is never stranded.
- Tests: the reproduction above no longer hijacks a live batch, and a pending directory
  whose owner pid is dead is still recovered, as in the existing "finishes a delete that
  crashed before committing" test.
