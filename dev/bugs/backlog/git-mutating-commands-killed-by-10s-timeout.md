# Managed worktree commit, merge and `worktree add` are killed after 10 s (hooks, large checkouts)

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli)
- **Area:** `src/utils/GitUtils.ts` (`GIT_TIMEOUT_MS`, `execGit`, `commitAll`, `addWorktree`, `mergeNoFastForward`, `abortMerge`); callers in `src/core/orchestration/WorktreeManager.ts`
- **Severity:** high

## Symptom

Every git call through `GitUtils`' `execFileAsync`/`execGit` gets
`timeout: GIT_TIMEOUT_MS` (10 s). That fits read-only queries (`rev-parse`,
`status`), but it also applies to commands that can legitimately run much longer:

- `commitAll` (managed-worktree landing auto-commit, `WorktreeManager.ts` ~728)
  runs the user's `pre-commit` / `commit-msg` hooks — husky + lint-staged, a
  typecheck, or a test run easily take more than 10 s.
- `addWorktree` does a full checkout plus the `post-checkout` hook; on a large
  repo, or on Windows with Defender scanning, that often takes more than 10 s.
- `mergeNoFastForward` runs `pre-merge-commit`/`post-merge` hooks and the merge
  itself.

When the timer fires Node SIGTERMs git. Reproduced with a temp repo whose
`.git/hooks/pre-commit` is `sleep 12`: `commitAll(dir, "auto")` from
`out/utils/GitUtils.js` rejected with `killed=true signal=SIGTERM` after ~10.07 s.
No commit was created and the change was left staged, so the managed landing
reports "blocked" with a raw `Command failed` message and leaves the worktree
index half-modified. A killed `worktree add` can leave a half-populated worktree
directory and a registered-but-broken worktree entry.

## Steps to Reproduce

1. Create a repo with `.git/hooks/pre-commit` containing `sleep 12` (made
   executable), modify a tracked file.
2. `node -e "require('./out/utils/GitUtils.js').commitAll('<repo>','auto').then(console.log,console.error)"`.
3. It fails after ~10 s with `killed: true, signal: 'SIGTERM'`; `git status`
   shows the change still staged and no new commit.

## Root Cause

`execFileAsync` in `GitUtils.ts` (~80–94) spreads
`{ timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, ...options }`, and
`commitAll`, `addWorktree`, `mergeNoFastForward` and `abortMerge` call `execGit`
without overriding `timeout`. Nothing documents that hooks or checkouts must finish
within 10 s.

## Suggested Fix

Add a named constant for long-running mutating git commands (e.g.
`GIT_MUTATION_TIMEOUT_MS`, generous — several minutes — or no timeout at all,
relying on the workflow's own stop/cancel) next to `GIT_TIMEOUT_MS`, and pass it
from `commitAll` (both the `add` and the `commit`), `addWorktree`,
`mergeNoFastForward`, and `abortMerge`. Grep `GitUtils.ts` and `WorktreeManager.ts`
for any other hook-running or checkout-heavy command (`checkout`, `switch`,
`reset --hard`, `worktree remove`) and treat it the same. When a git command is
killed by the timeout, surface a clear message ("git commit timed out after N s —
a slow hook?") rather than the raw `Command failed`. Unit test: a temp repo with a
`pre-commit` hook that sleeps longer than `GIT_TIMEOUT_MS` (make the timeouts
injectable or use a short test override so the test stays fast) still commits via
`commitAll`.
