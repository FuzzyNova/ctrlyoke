# Git snapshot drops edits and misplaces undo paths when the workspace is a subdirectory of a repo

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/utils/WorkspaceSnapshotService.ts`
- **Resolution:** fixed in this commit

## Symptom

When the execution root is a subdirectory of a git repo, per-step snapshots go wrong in three ways. A typical case is a monorepo package opened as the workspace.

- AI edits to tracked or untracked files under the workspace never appear in the step's changed files, so they can't be reviewed or undone. Nothing reports the omission.
- Deletions and commit-range changes are recorded under repo-relative paths such as `packages/foo/src/b.ts`. Undo resolves those paths against the workspace and writes the restored content to a stray file at `<repo>/packages/foo/packages/foo/src/b.ts`. The deleted file itself is never restored.
- Changes made elsewhere in the repo, outside the workspace, are attributed to the step.

## Steps to Reproduce

1. Create a git repo and commit `packages/foo/src/a.ts` and `packages/foo/src/b.ts`.
2. Open `<repo>/packages/foo` as a single-folder VS Code workspace, or run the CLI with that directory as the workspace.
3. Run a prompt step that modifies `packages/foo/src/a.ts` and deletes `packages/foo/src/b.ts`. The git snapshot strategy is selected because the folder is inside a work tree.
4. Check the step's changes. `a.ts` is missing, and the deletion is listed as `packages/foo/src/b.ts`.
5. Click Undo for the step. It creates `<repo>/packages/foo/packages/foo/src/b.ts` with the old content of `b.ts`. `packages/foo/src/b.ts` is still deleted and `a.ts` is still modified.

## Root Cause

The single-root branch of `captureWorkspaceState` (`src/utils/WorkspaceSnapshotService.ts:632-648`) calls `captureSegment(executionRoot, strategy, "")`. It stores the result as a segment with `root = executionRoot` and `pathspec = ""`, which assumes `executionRoot` is the repo toplevel.

Git reports paths relative to the toplevel, not the cwd. Running `git status` from a subdirectory prints `M sub/x.txt`. Both git commands the segment depends on behave this way:

- `git status --porcelain=v1` in `captureSegment` (lines 682-691)
- `git diff --name-status` in `getCommitRangeChanges` (lines 449-476)

The consequences, by location:

- **Lost edits.** Line 734 reads `path.join(root, filePath)`, which repeats the subdirectory prefix. `readFileForSnapshot` (lines 136-159) returns null for the nonexistent path, so the change is dropped from both the before and after maps.
- **Misplaced paths.** Deleted entries (lines 720-731) and commit-range entries skip that read. With an empty pathspec, `segmentViewerPath` (lines 842-851) strips nothing, so their viewer paths stay repo-relative.
- **Wrong undo target.** `undoFiles` (line 1089) resolves those paths against `workspacePath`, which is the subdirectory. The trusted-root guard does not catch this, because the doubled path is still inside the workspace.
- **Changes outside the workspace.** Without a pathspec, `git status` and `git diff` report changes from the whole repo.

Single-root workspaces can hit this on purpose: `WorktreeManager.resolveExecutionInputs` (`src/core/orchestration/WorktreeManager.ts:3452-3454`) returns an `executionRoot` below `sourceRoot` when the state root is a subdirectory of the checkout.

The multi-root path, `captureMultiRootSegments` (lines 778-826), works. It sets `root` to the discovered repo toplevel and passes a pathspec.

## Suggested Fix

For the GIT strategy in the single-root branch, run `git rev-parse --show-toplevel` from `executionRoot`. If the toplevel differs from `executionRoot`, build the segment the way `captureMultiRootSegments` does:

- `root` = toplevel
- `pathspec` = `toPosixPath(path.relative(toplevel, executionRoot))`
- `prefix` = `""`

With that segment, `captureSegment` reads `path.join(toplevel, filePath)`, and `git status`/`git diff` are scoped with `-- pathspec`. `segmentViewerPath` then strips the pathspec, so viewer paths stay workspace-relative, which is what `undoFiles` expects.

The simplest option is to send single-root git capture through the same repo-discovery helper (`discoverRepos`) that the multi-root path uses, and keep `prefix` empty.

`enrichSnapshotBeforeContent` also needs a fix. Its single-root `git show ${headCommit}:${change.path}` (line 1301) must rebuild the toplevel-relative path, either through `gitRelFromChange` (line 1319) or by emitting a `repos` entry for the segment.

Add a test with the workspace in a repo subdirectory. It should cover a modified file, a deleted file, a file changed outside the subtree, and undo.
