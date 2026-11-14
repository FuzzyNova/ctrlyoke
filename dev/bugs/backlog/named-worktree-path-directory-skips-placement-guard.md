# A path-form named worktree `directory` can create a worktree inside the source checkout

- **Found:** 2026-11-13 by the bug-hunt workflow final step (claude-cli)
- **Area:** `src/utils/WorktreeUtils.ts` (`resolveWorktreeDirectory`, `assertWorktreePlacement`), `src/core/orchestration/WorktreeManager.ts` (`resolveNamedWorktreeWith`)
- **Severity:** medium

## Symptom

`worktree: { mode: named, branch: x, directory: /path/to/repo/wt }` (or any
path that does not exist yet and lies inside the source checkout or inside
another linked worktree) is accepted. ctrlyoke runs `git worktree add` at the
nested path and makes it the run's execution root.

The source checkout then sees the nested worktree as an untracked embedded
repository: a `git add -A` there stages it as a gitlink, and the run's
execution root sits inside the user's working checkout. A trusted path-form
`defaults.worktree.directory` behaves the same.

## Steps to Reproduce

1. In a git repo at `<repo>`, call the compiled
   `resolveWorktreeDirectory(<repo>, "<repo>/nested-wt", entries, commonDir, root)`
   from `out/utils/WorktreeUtils.js`, or run a workflow with that `directory`.
2. It returns `{ kind: "planned", path: "<repo>/nested-wt" }`, and a run
   creates the worktree there.

## Root Cause

The path-form branch of `resolveWorktreeDirectory` only rejects a target equal
to the source checkout and a target that already exists but is not a
registered worktree. It returns `PLANNED` without the containment checks the
rest of the worktree code enforces. `assertWorktreePlacement` refuses a
worktree root "inside the source checkout" and "inside an existing worktree",
and bare names and branch-derived directories get that check through
`resolveWorktreeRoot`; path-form directories skip it.

## Suggested Fix

Before returning `PLANNED` in the path-form branch, reject a target that is
inside the source checkout or inside any discovered worktree, and one that
contains either. Reuse `assertWorktreePlacement` (or the same
symlink-aware `resolveThroughNearestExistingAncestor` + `isPathWithinDirectory`
checks) so there is one placement rule. An `EXISTING` match on a registered
worktree path stays allowed. Add `WorktreeUtils` tests for: inside the source
checkout, inside another linked worktree, a sibling path (allowed), and a
symlinked parent that resolves into the checkout.
