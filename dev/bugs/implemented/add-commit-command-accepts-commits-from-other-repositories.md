# "Add Commit to ctrlyoke" inserts `~<hash>` for commits from other repositories, which never expands

- **Found:** 2026-11-01 by bug-hunt final step (claude-cli)
- **Area:** `src/completions/ContextMenuReferenceCommands.ts`, `package.json` (`ctrlyoke.addEditorCommitToPromptEditor` menus)
- **Resolution:** fixed in this commit

## Symptom

The diff-editor command added in ~4d76f419c appears for any commit diff VS
Code's git extension opens: from the SCM Graph or Timeline of **any**
repository VS Code sees, including a second root folder's repo, a submodule
(`git.detectSubmodules` is on by default) or a nested repo. It inserts
`~<hash>` with no warning. At run time the reference resolves only against the
workspace root's repo, so it is reported as a skipped attachment ("bad
object") and the step runs without the diff the user asked for.

## Steps to Reproduce

1. Open a workspace where VS Code tracks a second git repo (a multi-root
   folder that is its own repo, or a submodule).
2. In the Source Control Graph for that second repo, open a commit's diff.
3. Choose **Add Commit to ctrlyoke** from the editor's `...` menu: `~<hash>`
   is inserted.
4. Run the step: the attachment is skipped.

## Root Cause

- The `when` clauses (`package.json` around lines 475 and 492) match any
  `git:` / `scm-history-item:` resource with a hex ref, regardless of
  repository.
- `extractCommitHashFromEditorUri`
  (`ContextMenuReferenceCommands.ts:73-87`) reads only the hash and ignores the
  repository the URI identifies.
- `insertCommitReference` (`:348-361`) inserts without checking that the
  commit exists in the workspace repo.
- `ContextExpander` resolves every commit reference against
  `this.workspaceRoot` (`src/utils/ContextExpander.ts:885-886`) and turns a
  failure into a skipped reference.

The dashboard History "Add Commit to ctrlyoke" only lists the workspace
repo's commits, so it does not have this problem. The diff-editor command made
foreign commits reachable for the first time.

## Suggested Fix

Before inserting, check the commit exists in the workspace root's repo
(`git -C <workspaceRoot> cat-file -e <hash>^{commit}` through the existing git
helpers in `src/git/`). If it doesn't, show a warning such as "ctrlyoke: Commit
<short> is not in this workspace's repository, so a ~ reference can't attach
it" and insert nothing. Unit-test both outcomes with the git check stubbed.
Supporting `~` references to other repositories would be a separate feature,
not this fix.
