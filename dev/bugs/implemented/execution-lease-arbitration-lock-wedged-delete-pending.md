# Execution-lease arbitration lock wedges permanently when left delete-pending on Windows

- **Found:** 2026-09-30 by claude-cli (investigating a user-reported crash of a long `bug-backlog` run)
- **Area:** `src/core/orchestration/ExecutionRootLeaseManager.ts` (`withArbitrationLock`), `src/utils/FileLockUtils.ts`
- **Resolution:** fixed in this commit. `withArbitrationLock` now wraps `withFileLock`; lock release and stale takeover rename the lock to a unique `.released` tombstone before unlinking it; a lock whose name can never be created raises `FileLockUnavailableError` explaining delete-pending; heartbeat failures log once per streak; attaching to an existing named worktree persists its runtime only after the lease is held. No tombstone sweep was added: a delete-pending tombstone is removed by Windows when its holder closes, and a leftover one never blocks the lock name.

## Symptom

After VS Code went down mid-run, continuing the run failed immediately and kept failing:

```text
Execution failed: EPERM: operation not permitted, open
'C:\dev\ctrlyoke\.git\ctrlyoke\execution-leases\<scope>\arbitration.lock'
  at withArbitrationLock -> ExecutionRootLeaseManager.acquireLease
  -> resolveNamedWorktree -> prepareExecutionWorktree -> executeLoadedPromptFile
```

Every lease operation on that execution root (acquire, heartbeat, release) fails this way until
whatever holds the stray handle exits. In practice that means a reboot. No ctrlyoke process is
involved by then: the lease's owner PID is dead.

## Steps to Reproduce / Evidence

Observed 2026-09-30 (UTC):

1. 22:09:27–40: system-wide resource trouble. RemoteMouseService, Everything, WER, and DiagTrack
   crashed, and Docker Desktop died with `0xc0000409`. The extension-host heap was ~1.7 GB.
2. 22:09:31: a lease heartbeat creates `arbitration.lock` (file birth time). The write lands 5 s
   later, at 22:09:36.07, the same instant as the lease's final `lastHeartbeat`. The heartbeat
   then `unlink`s the lock while some other handle (opened with `FILE_SHARE_DELETE`) is still
   open. The file becomes delete-pending instead of disappearing, and that handle never closes.
3. Later heartbeats fail with EPERM, and `RunnerLockCoordinator.startHeartbeat` swallows the
   errors with `.catch(() => {})`, so the log shows nothing.
4. 22:14:30: extension deactivation, `failed to release execution lease: EPERM ... arbitration.lock`.
5. 22:22:52: continuing the run fails with the error above.
6. 22:42: the file is still there. `CreateFileW` with any access returns
   `STATUS_DELETE_PENDING (0xC0000056)`, and even the Restart Manager can't open it. The owner PID
   21732 is gone and no ctrlyoke or VS Code orphan survives, so the holder is outside the user's
   session (a filter driver or SYSTEM service). Finding it needs elevation.

Repro without the system event: open `arbitration.lock` from a second process with
`FILE_SHARE_DELETE`, let the owner release (unlink), then call `acquireLease`. It fails at once
with EPERM and keeps failing while the second handle stays open.

## Root Cause

1. **Duplicate lock loop that missed the delete-pending fix.** `withArbitrationLock`
   (`ExecutionRootLeaseManager.ts:105`) is a hand-rolled copy of `FileLockUtils.acquireLock`. It
   rethrows anything other than `EEXIST` from `fs.open(lockPath, "wx")`, so even a momentary
   delete-pending state (fixed for `withFileLock` in
   `dev/bugs/implemented/file-lock-eperm-on-windows-contention.md`) fails the caller at once.
2. **Unlink-based release can wedge the name forever.** Both implementations release by
   `fs.unlink(lockPath)`. On Windows, if any other handle with share-delete is open at that
   moment, the name stays reserved (delete-pending) until the handle closes. No process can create,
   open, stat-then-unlink, or rename it in the meantime, and the stale-lock takeover can't help.
   `FileLockUtils` now retries through the brief version of this, but a long-lived holder turns it
   into a `FileLockTimeoutError` or an EPERM every time.
3. **Silent heartbeat failures.** `RunnerLockCoordinator.ts:148,153` discard heartbeat errors,
   so a wedged lease went unnoticed for five minutes before anything reported it.

Also seen in the same failed continue: `resolveNamedWorktree` persisted
`_runtime.worktree` (new `baseCommit`, `lifecycleState: "provisioning"`) _before_
`acquireLease` threw. Nothing rolls that back, so the run file is left claiming a worktree that is
still provisioning.

## Suggested Fix

- Delete `withArbitrationLock` and use `withFileLock` (or a shared primitive both call), so the
  lease manager gets the transient-sharing retry and there is one lock implementation (DRY).
- Release by **rename-then-unlink**: `rename(lock, "<lock>.<uuid>.released")`, then a best-effort
  `unlink` of the tombstone, with a sweep for leftover tombstones on the next acquire. A rename
  succeeds under exactly the condition that causes delete-pending (the other handle allows
  delete), and it frees the lock _name_ immediately even if the tombstone lingers. Apply the same
  rename-away to the stale-lock takeover path.
- When acquire times out on EPERM for an existing-but-unopenable lock, say so. Name the path and
  explain that another process holds a handle (a reboot or closing that process clears it). Don't
  surface a bare EPERM.
- Log heartbeat failures once per failure streak instead of swallowing them.
- Persist the worktree runtime only after the lease is held, or roll it back when the lease fails.
- Tests: stub `open`/`unlink` to simulate a delete-pending name. Assert that release frees the
  name (the next acquire succeeds) and that a permanently unopenable lock produces the new
  diagnostic.
