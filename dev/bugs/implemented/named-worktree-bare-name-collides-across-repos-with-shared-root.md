# A bare-name worktree `directory` collides across repositories when `worktrees.root` is set

- **Found:** 2026-11-12 by the bug-hunt workflow's final step (claude-cli subagent), reproduced with bundled `resolveWorktreeDirectory` against two temp repos
- **Area:** `src/utils/WorktreeUtils.ts` (`resolveWorktreeDirectory`)
- **Resolution:** fixed in this commit. Only an explicit `worktrees.root` scopes bare names by repository (`<root>/<repository>-<hash>/<name>`); the `<repository>.worktrees` sibling default and the central fallback are already per-repository and unchanged.

## Symptom

`worktrees.root` is a single user-scope setting shared by every repository, and an explicit
root gets no per-repository subfolder. Since 157aaa4e4, a new bare-name directory is created
at exactly `<root>/<name>`. Once repo A creates `<root>/bug-fix`, every other repo using
`directory: bug-fix` is refused with
`Directory "<root>/bug-fix" already exists but is not a registered worktree of this repository.`
So a user-scope `defaults.worktree` with a bare `directory` works in only one repository.
Branch-derived names never collided, because their hash includes the common git dir.
The default root (`<repository>.worktrees/`) is per-repo and unaffected.

## Steps to Reproduce

1. Set `worktrees.root` to `~/worktrees`.
2. Run a workflow with `worktree: { directory: bug-fix }` in repo A. `~/worktrees/bug-fix` is created.
3. Run the same workflow in repo B. It fails with the error above.

## Root Cause

`const target = path.join(root, value);` (#selection:src/utils/WorktreeUtils.ts:185-187) uses
the shared root without scoping it by repository. `docs/workflows/worktrees.md` documents
"exactly `<worktree root>/bug-fix`", so this is documented behavior with an unintended
consequence.

## Suggested Fix

**Needs a design decision.** This changes where new directories land and what the docs promise.
Options:

- For an explicit `worktrees.root`, plan bare-name targets at
  `<root>/<repositoryIdentity>/<name>` (as the fallback root does). Existing directories stay
  reachable, because bare names match registered worktrees by basename anywhere.
- Or document that a shared explicit root needs path-form directories, and improve the error
  to say the folder belongs to another repository.

Update `docs/workflows/worktrees.md` either way.
