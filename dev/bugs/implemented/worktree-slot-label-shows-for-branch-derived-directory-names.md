# Worktrees slot label shows on almost every row, not only for reused slots

- **Found:** 2026-11-12 by the bug-hunt workflow's final step (claude-cli subagent), from code reading
- **Area:** `src/ui/webview-react/components/settings/WorktreesSection.tsx`, `src/ui/webview-react/utils/worktreeStatus.ts` (`stripWorktreeDirectoryHashSuffix`)
- **Resolution:** fixed in this commit

## Symptom

The checkout-slots plan (`dev/implemented/NAMED_WORKTREE_CHECKOUT_SLOTS_PLAN.md`, item 3
"Slot label") adds a `<directory> · <branch>` line so a *slot* that holds different work
(`bug-fix · fix-race-condition`) is readable at a glance. In practice the line appears
on nearly every row whose directory ctrlyoke named itself:

- A named worktree for branch `feature/login` lives in `feature-login-<hash12>`; its row
  shows `feature-login · feature/login`.
- The same for any branch with uppercase letters, `_`, `.`, or longer than 40
  characters.

The label is meant to flag a mismatch, and it fires when there is none.

## Steps to Reproduce

1. Run a workflow with `worktree: { directory: "feature/login" }` (a bare name, so
   ctrlyoke creates the directory under the worktree root).
2. Open Settings → Worktrees.
3. The row shows `feature-login · feature/login` under its status line.

## Root Cause

#selection:src/ui/webview-react/components/settings/WorktreesSection.tsx:930-946 compares
the directory basename minus its hash suffix with the raw branch name. Directory names
come from `createWorktreeDirectoryName`, which runs the branch through
`slugifyWorktreeName` (#selection:src/utils/WorktreeUtils.ts:65-72): lowercased, every
non-`[a-z0-9]` run turned into `-`, truncated to 40 characters. So any branch that the
slug changes never compares equal. The only test (`WorktreesSection.test.tsx`) uses a
plain `bug-fix` directory.

## Suggested Fix

Show the label only when the hash-stripped basename differs from both the branch name
and `slugifyWorktreeName(branchName)`. `slugifyWorktreeName` lives in
`src/utils/WorktreeUtils.ts`, which imports Node built-ins the webview can't bundle, so
move it (it is pure string code) into a Node-free shared module and import it from
both places. Add `WorktreesSection` tests: `feature/login` in `feature-login-<hash>`
shows no label; `bug-fix` holding `fix-race-condition` still shows it.
