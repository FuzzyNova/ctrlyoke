# Home directory as workspace: init is implicit and `.ctrlyoke/.gitignore` misses user-only state

- **Found:** 2026-11-23 by claude-cli, reviewing ctrlyoke run from the home directory
- **Area:** `src/core/orchestration/WorkspaceInitializer.ts`, `src/extension.ts`, `src/utils/WorktreeUtils.ts`
- **Severity:** low

## Symptom

When ctrlyoke opens the home directory as its workspace, `<root>/.ctrlyoke` is the user's
`~/.ctrlyoke`. Two problems follow. Both matter only when the home directory is itself a Git
work tree, which is common with dotfiles setups (`git --work-tree=$HOME`).

1. The dashboard's "Initialize ctrlyoke in this workspace?" opt-in never appears. The extension
   writes the generated `.gitignore` into `~/.ctrlyoke/` on activation without asking.
2. That `.gitignore` lists only workspace runtime entries. The user-only state stored in the same
   folder stays visible to Git and can be committed by a broad `git add`:
   - `projects/` (user-mode run history)
   - `worktrees/`
   - `workspace-settings-trust.json`
   - `external-roots-trust.json`
   - `secret-index`
   - the statusline launcher folder

Managed worktrees of such a home repository also misbehave. The sibling root
(`C:\Users\<you>.worktrees`) usually cannot be created, and the fallback
`~/.ctrlyoke/worktrees/<identity>` lies inside the source checkout.

## Steps to Reproduce

1. Make the home directory a Git work tree and create user settings (`~/.ctrlyoke/settings.json`).
2. Open the home directory in VS Code with ctrlyoke installed.
3. No initialize prompt is shown, `~/.ctrlyoke/.gitignore` is created, and `git status` lists
   `.ctrlyoke/projects/`, `.ctrlyoke/workspace-settings-trust.json` and similar files as untracked.

## Root Cause

- `WorkspaceInitializer.isInitialized` (`src/core/orchestration/WorkspaceInitializer.ts:154-163`)
  treats any existing `.ctrlyoke/` as opted in. `~/.ctrlyoke/` exists as soon as the user has
  user settings, and `src/extension.ts:453` then calls `initializeIfNeeded`.
- `WORKSPACE_RUNTIME_ENTRY_RULES` (`WorkspaceInitializer.ts:57-72`) has no entries for user-only
  state, because a normal workspace never holds it.
- `resolveWorktreeRoot` (`src/utils/WorktreeUtils.ts:384-413`) falls back to
  `~/.ctrlyoke/worktrees`, and `assertWorktreePlacement` then rejects it for a checkout rooted at
  the home directory.

## Suggested Fix

- Use `isUserHomeWorkspace` (`src/utils/ProjectStatePaths.ts`) to keep `isInitialized` from
  counting a home `.ctrlyoke/` that only holds user state, so the opt-in still appears.
- In the home case, have `ensureGitignore` also ignore the user-only entries. Single-source that
  list with the files `ctrlyokeStateHome()` and the trust stores write.
- For a checkout rooted at the home directory, choose a worktree fallback outside it (for example
  under the OS temp or local app-data folder), or report that `worktrees.root` must be set.
