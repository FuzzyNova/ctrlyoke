# Listing Recently deleted during a copy-based trash publish deletes the in-progress payload and strands the run

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (deterministic `npx tsx` repro with a watched run directory and a hooked `fs.promises.cp`)
- **Area:** `src/core/orchestration/HistoryTrashRepository.ts` (`recoverPendingEntries`, `publishEntry`)
- **Resolution:** fixed in this commit

## Symptom

When a run directory is being watched (the dashboard watches open runs), the
trash rename is refused (EPERM) and `publishEntry` falls back to copying the
payload into the published `<id>/` folder before writing `entry.json`. If any
other caller lists the trash during that copy — the Recently deleted view in
another client, `ctrlyoke history trash list`, a scheduled `purgeExpired` in
another window, or `purgeAll` — recovery deletes the published folder:

- the delete fails with `ENOENT … .trash\<id>\entry.json.<n>.tmp`,
- the run is gone from its lineage,
- `.trash` holds only `<id>.pending`, and `list()` returns no entry, so
  nothing can be undone until the process that owns the pending entry exits
  and stale recovery runs.

## Steps to Reproduce

1. Promote two runs; `fs.watch` one run directory.
2. Wrap `fs.promises.cp` so that `new HistoryTrashRepository(ws).list(30)` runs
   after the payload copy but before `entry.json` is written.
3. `deleteRunByRef` on the watched run → the published folder is removed
   during `list()` and the delete throws ENOENT.

## Root Cause

`recoverPendingEntries` (~614-627) treats "published folder exists without
`entry.json`" as an interrupted copy and deletes it immediately. That check
runs *before* the owner-liveness check (~628-646) that skips pending entries
whose owner process is still alive. During `publishEntry`'s copy fallback
(~544-554) that exact state is normal, and `list()` runs recovery every time.

## Suggested Fix

Move the owner-liveness test (live `owner.json` pid on this host, or a young
pending-dir mtime when there is no owner marker) ahead of the published-folder
cleanup, and only remove a marker-less published folder once the pending
owner is shown to be gone. Test in `src/test/unit/HistoryTrashRepository.test.ts`
(or the existing trash suite): a pending folder with a live-pid `owner.json`
plus a published folder without `entry.json` → `recoverPendingEntries()`
leaves both; with a dead pid → the published folder is cleaned up as today.
