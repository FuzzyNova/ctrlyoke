# Stale-lock normalization can stop a successor that resumed the same run

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli subagent)
- **Area:** `src/utils/WorkflowLockManager.ts`
- **Severity:** medium

## Symptom

`WorkflowLockManager.normalizeStaleLocks` reclaims a dead runner's
`runner.json` and then marks that run `stopped`. If another host (VS Code
window, CLI `continue`/`append`, MCP server) resumes the *same* run between
the reclaim and the rewrite, normalization overwrites the successor's live run
file: `executionState` becomes `stopped`, `currentIndex` moves past the
running step, and that step's `_runtime` gets `terminalStatus: "cancelled"`,
while the successor still holds a valid lock and keeps executing.

This is an incomplete fix of
`dev/bugs/implemented/normalize-stale-locks-deletes-successor-runner-lock.md`,
whose suggested fix was to re-read the lock and rewrite the run file inside
the mutex. The shipped fix moved only the staleness check and unlink inside
it. Its regression test (`src/test/unit/WorkflowLockManager.test.ts:89`) only
covers a successor on a different run.

## Steps to Reproduce

Deterministic repro (node script against `out/`):

1. Create a lineage whose run file has `_runtime.executionState: "running"`
   and a stale `runner.json` (dead pid 999999, `lastHeartbeat: 0`).
2. Stub `fs.promises.readFile` so that on the run-file read that follows the
   reclaim, a successor first calls `WorkflowLockManager.acquireLock` for the
   same `runRef` and writes the run file with `executionState: "running"` and
   `steps[0]._runtime = { startedAt }`.
3. Call `WorkflowLockManager.normalizeStaleLocks(ws, [key])`.

Observed: the lock owner is still the successor, but the run file now has
`executionState: "stopped"`, `currentIndex: 1`, and step 0 has
`terminalStatus: "cancelled"`.

Real-world shape: a window starting up runs `normalizeStaleLocks` (via
`ExternalRunWatchCoordinator.setupExternalRunWatching`) while another host
resumes the crashed run. The window is narrow (unlink → read → write), but
nothing serializes it.

## Root Cause

`reclaimIfStale` (`WorkflowLockManager.ts:45-64`) checks staleness and unlinks
`runner.json` inside `withFileLock(lockPath)`, then releases the mutex.
`normalizeStaleLocks` (`WorkflowLockManager.ts:319-354`) only afterwards
reads the run file, sets `STOPPED`, calls `settleInterruptedRun`, and writes it
with a plain `writeFileAtomic`, with no lock held and no check that the lock is
still absent. A successor's `acquireLock` can succeed as soon as the unlink
lands.

## Suggested Fix

Settle the run file inside the `reclaimIfStale` mutex, before the unlink:
give `reclaimIfStale` an optional callback that runs after the staleness check
and before `unlink`, and do the read, settle and write there. A successor's
`acquireLock` takes the same `runner.json` mutex, so it cannot start until the
settle is written. Keep the existing newer-run-file and paused/inactive
guards. Add a regression test where the successor acquires the lock for the
*same* `runRef` during normalization (e.g. by stubbing the run-file read as
above, or by calling `acquireLock` from the callback hook) and assert the
successor's run file is untouched, or that the successor's acquire waits until
the settle is written.
