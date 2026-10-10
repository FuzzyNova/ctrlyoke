# Managed worktree post-setup lock timeout leaks the lease and skips setup on retry

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (code review of ~87c4065e4, confirmed with a scratch unit test)
- **Area:** `src/core/orchestration/WorktreeManager.ts` (`completeManagedInfo`)
- **Resolution:** fixed in this commit

## Symptom

When managed worktree setup finishes while another process or run holds the
worktree mutation lock for more than 5 s (for example a parallel fan-out sibling
landing its branch and removing a worktree with a large `node_modules` on
Windows), `ensureManagedWorktree` rejects with `FileLockTimeoutError` instead of
completing or reporting the real setup outcome. Then:

1. On the setup-failure path, the real `WorktreeSetupError` is lost. The record
   stays `ready` with no `setupOutcome` and is never marked `blocked`/`failed`,
   so `reconcileBlockedManagedWorktrees` never reclaims it.
2. The execution-root lease and the runtime trusted-root registration are never
   released. A retry within 30 s fails with
   `ExecutionLeaseConflictError: Execution root is in use: workflow <key>, run <run>`.
   The run is blocked by its own leaked lease.
3. After the leaked lease goes stale, the retry succeeds with
   `origin=recovered`, and **setup is never re-run**: `shouldRunSetup` requires
   `origin === CREATED || directoryRecreated`. The workflow then runs in a
   worktree whose setup failed (no `node_modules`, and so on).

On the success path, a lock timeout at the final record write likewise fails
the run after setup succeeded and leaks the lease for 30 s.

## Steps to Reproduce

1. Use a `WorktreeSetupRunner` whose `run()` creates
   `<git-common-dir>/ctrlyoke-worktree-mutation.lock` (simulating another
   holder) and returns `success: false`.
2. Call `ensureManagedWorktree` for a new managed worktree with a `setup` command.
3. Observe a `FileLockTimeoutError` after about 5 s, a lease still listed by
   `ExecutionRootLeaseManager.inspectLeases(worktreePath)`, and a record with no
   `setupOutcome`. Remove the lock file and retry: the retry hits a lease
   conflict, and after the lease goes stale it never re-runs setup.

## Root Cause

~87c4065e4 moved setup outside the mutation lock. `completeManagedInfo` now
re-enters `withWorktreeMutationLock` after setup to write the record:
#selection:src/core/orchestration/WorktreeManager.ts:3086-3110 on failure, and
#selection:src/core/orchestration/WorktreeManager.ts:3126-3128 on success.
`withWorktreeMutationLock` uses `withFileLock`'s default 5 s timeout. Before the
change those writes ran under a lock that was already held and could not time
out. Nothing in `completeManagedInfo` is wrapped in try/finally, so any throw
after the lease and trust are acquired leaks them. On the failure branch,
`lease.release()` and `runtimeTrust.release()` only run if the locked write
succeeds. The unguarded `persistRuntime` calls (from line 3059) have the same
gap, but that predates the change.

## Suggested Fix

- Wrap the whole body of `completeManagedInfo` so any non-success exit releases
  `runtimeTrust` and `lease` exactly once. On the setup-failure path, rethrow
  the original `WorktreeSetupError`, not a later lock or persistence error.
- Make sure a busy lock can't stop a failed setup from being recorded as
  BLOCKED+FAILED. Either let `withWorktreeMutationLock` forward a longer
  `timeoutMs` to `withFileLock` for these post-setup writes, or retry the write.
- Tests in `src/test/unit/WorktreeManager.test.ts`:
  - **Contended setup failure:** the call rejects with `WorktreeSetupError`, no
    lease remains, and the record is `blocked`/`failed`. After the lock is
    freed, a retry runs setup again.
  - **Contended success path:** the lease is not leaked.
