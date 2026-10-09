# Managed worktree setup runs inside the repository mutation lock

- **Found:** 2026-10-09 by Claude (WORKFLOW_STEP_PLAN refinement review)
- **Area:** `src/core/orchestration/WorktreeManager.ts`, `src/utils/FileLockUtils.ts`
- **Resolution:** fixed in this commit

## Symptom

Start two managed-worktree runs in the same repository at about the same time (for example two
queued workflows with `worktree: { mode: managed, setup: "npm ci" }`). If the first run's `setup`
takes more than 5 seconds, the second fails to start with
`Timed out waiting for lock: <commonDir>/ctrlyoke-worktree-mutation.lock`. If `setup` takes more
than 30 seconds, the second run treats the held lock as stale, takes it over, and runs
`git worktree add` / record writes concurrently with the first run's provisioning.

A run that settles (auto-commit, merge, remove) while another run is in `setup` hits the same
timeout or takeover.

## Steps to Reproduce

1. Create two workflows with `worktree: { mode: managed, setup: "node -e \"setTimeout(()=>{}, 40000)\"" }`.
2. Start both within a few seconds of each other.
3. The second either fails with the lock timeout or proceeds by taking over the lock while the
   first is still inside it.

## Root Cause

`ensureManagedWorktree` wraps creation in `withWorktreeMutationLock` (`WorktreeManager.ts`
~1394-1583). The last call inside that callback is `acquireManagedInfo` (`:1569`), which takes the
execution lease and runs the configured setup command through `runSetup` (`:3003-3035`). Setup is
therefore executed while holding the repository-wide mutation lock.

`withFileLock` (`FileLockUtils.ts`) is designed for short critical sections: `LOCK_TIMEOUT_MS =
5000` and `LOCK_STALE_MS = 30000` by file mtime, with no heartbeat while held. A long setup
breaks both assumptions.

`WORKTREE_SUPPORT_PLAN.md` (Managed lifecycle, steps 4–8) intended only the record, branch, and
`git worktree add` to run under the "short repository worktree-mutation lock", with setup as a
later step. Named worktrees already run setup outside the lock (`resolveNamedWorktree`, add-only
under the lock at ~2243-2279).

## Suggested Fix

Run the managed setup command outside the mutation-lock callback, matching named worktrees.
Keep lease acquisition and runtime-trust registration **inside** the lock (they are short). If
the lease were taken after the lock is released, a concurrent sweep/recovery could see a READY
record with no live lease and reclaim the new worktree. Split `acquireManagedInfo` so the
locked section returns the leased info plus whether setup is due, then run setup after the lock
is released. The record writes that follow setup in `acquireManagedInfo` (BLOCKED on setup
failure, READY with `setupOutcome` on success) must re-enter `withWorktreeMutationLock`, because
other record writers (`reconcileBlockedManagedWorktrees`, settlement, cleanup) run under it. Add a test that runs two managed creations
concurrently where the first setup outlasts `LOCK_TIMEOUT_MS`, and assert that the second
creation completes while the first setup is still running.

This blocks parallel sub-workflow fan-out in `dev/backlog/WORKFLOW_STEP_PLAN.md`, where several
managed children start at the same moment.
