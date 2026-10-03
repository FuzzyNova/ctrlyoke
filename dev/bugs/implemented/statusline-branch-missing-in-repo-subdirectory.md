# Statusline `branch` field disappears when the harness runs from a repo subdirectory

- **Found:** 2026-10-03 by bug-hunt final step (claude-cli); reproduced by piping payloads into the built statusline script
- **Area:** `src/scripts/ctrlyoke-statusline-wrapper.js` (`getGitHeadPath` ~467-486, `getBranchName` ~488-503)
- **Resolution:** fixed in this commit

## Symptom

With a statusline format that includes the `branch` field, the branch segment
silently vanishes whenever the harness's reported cwd is a subdirectory of the
repository rather than its root. This is common: monorepo packages, or a Claude
session that has `cd`'d into `src/`. It affects every harness that uses the
shared wrapper (Claude, Copilot, Qwen, Antigravity).

## Steps to Reproduce

1. Settings with `sharedFormat: [branch, "|", cwd]`.
2. `echo '{"cwd":"C:/dev/ctrlyoke.worktrees/bug-fix"}' | node out/scripts/ctrlyoke-claude-statusline.js`
   → `bug-fix | bug-fix`.
3. Same payload with `"cwd":"C:/dev/ctrlyoke.worktrees/bug-fix/src"` → `src`.
   Expected `bug-fix | src`.

## Root Cause

`getGitHeadPath` only stats `<cwd>/.git` and never walks up to parent
directories. When `.git` is absent, `statSync` throws, `getBranchName`
swallows the error and returns `undefined`, and the field is dropped. The same
file's `findWorkspaceSettingsFromCwd` already walks up parents, so the two are
inconsistent.

## Suggested Fix

Walk from the payload directory up to the filesystem root, using the first
`.git` found (a directory, or a `gitdir:` file for worktrees/submodules —
keep the existing handling). Stop at the root. Add `StatuslineWrapper.test.ts`
cases for a nested subdirectory of a normal repo and of a worktree (`.git` file).
