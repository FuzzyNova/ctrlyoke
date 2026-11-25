# Runner-lock heartbeat uses a plain temp-file rename, so a Windows sharing violation can let a live run be reclaimed as stale

- **Found:** 2026-11-25 by bug-hunt workflow final step (Claude subagent; read-only, not reproduced, since the failure is Windows-only)
- **Area:** `src/utils/WorkflowLockManager.ts` (`updateHeartbeat` ~194-232)
- **Severity:** medium (Windows only: a live run can be marked STOPPED and its lock taken by another host)

## Symptom

`updateHeartbeat` writes `${lockPath}.${ownerToken}.tmp` and then calls a bare
`fs.promises.rename(tmpPath, lockPath)` (~216-221). On Windows that rename fails with
`EPERM`/`EACCES`/`EBUSY` while any other process has `runner.json` open. Run-storage
readers (the dashboard, the CLI's `status`/`history`, the MCP server, a second VS Code
window) read it often. When it fails:

- the error is only logged (`Log.warn` in the catch), and the `.tmp` file is left behind
  in the lineage directory;
- if it keeps failing for about six 5-second heartbeats, `lastHeartbeat` passes the
  30-second `STALE_HEARTBEAT_MS` limit. Another host then judges the live lock stale: it
  can reclaim it, and `normalizeStaleLocks` marks the run STOPPED.

Every other run-state write in this file goes through `writeFileAtomic` (~338), which
retries transient sharing violations and cleans up its temp file.
`.github/instructions/utils.instructions.md` and `orchestration.instructions.md` document
that a plain temp-plus-rename is not safe on Windows for this reason.

## Steps to Reproduce

Not reproduced (requires Windows). By inspection:

1. On Windows, start a workflow so the runner heartbeat runs every 5 s.
2. Hold `runner.json` open from another process (e.g. a polling reader) during a
   heartbeat.
3. The `rename` throws `EPERM`. The heartbeat is skipped, the `.tmp` file stays, and
   repeated failures age the lock past 30 s.

## Root Cause

`updateHeartbeat` reimplements atomic replace with a raw rename instead of using the shared
`writeFileAtomic` helper (`src/utils/AtomicFileUtils.ts`), so it gets no transient-error
retry and no temp-file cleanup.

## Suggested Fix

Replace the hand-rolled write-then-rename with
`writeFileAtomic(lockPath, JSON.stringify(updated, null, 2), runStateWriteOptions(...))`,
matching the other writer in the file (~338). Check `WORKFLOW_CRITICAL_RENAME_BUDGET_MS`
first: the write runs inside `withFileLock`, so if that budget is far longer than the 30 s
stale limit, pass a heartbeat-specific budget (e.g. under the 5 s interval) rather than
holding the lock that long. Keep the `withFileLock` and owner-token check
around it. Add a unit test that stubs the rename to fail once with `EPERM` and asserts
that the heartbeat still lands and no `*.tmp` file is left behind. Use the same injection
seam the existing `AtomicFileUtils`/`writeFileAtomic` tests use.
