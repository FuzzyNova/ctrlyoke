# Hosted commit diffs mislabel the first changed file when `log.showSignature=true`

- **Found:** 2026-11-25 by bug-hunt workflow final step (subagent, reproduced against a scratch repo)
- **Area:** `src/server/HostedWorkspaceViewerService.ts` (~2566-2572, ~3113-3119), `src/utils/GitUtils.ts` (`getChangedFilesWithBinaryStatus` ~1055-1072)
- **Resolution:** fixed in this commit

## Symptom

With `git config log.showSignature true` and a signed commit, the hosted workspace
viewer's commit diff reports the wrong status for the commit's first changed file.
A deleted or added file shows as modified, and so does the first side of a rename.
For a deleted binary or media file, the viewer then tries to read a blob that the
commit removed.

This is the part that c54af7731 missed (`dev/bugs/implemented/git-log-show-signature-config-corrupts-commit-metadata.md`).
That fix added `--no-show-signature` to the `log`/`show` calls inside `GitUtils.ts`, and
its suggested fix asked for an audit of `src/server/**`. Two `git show` argument lists
built in the hosted server were never updated.

## Steps to Reproduce

1. Create a repo with commit signing set up (e.g. SSH signing) and run
   `git config log.showSignature true`.
2. Make a signed commit that deletes `c` and adds `new1`.
3. Call `getChangedFilesWithBinaryStatus(repo, ["show","--format=","--no-ext-diff","--end-of-options","HEAD"])`.
   This is the argument list the hosted commit diff uses.
4. The result is `[{"path":"c","status":"M"},{"path":"new1","status":"A"}]`. With
   `--no-show-signature` added, `c` is correctly `"D"`.

## Root Cause

`git show` writes `Good "git" signature …\n` to stdout before the `--raw` records.
That text has no NUL terminator, so it is glued onto the first `-z` token. The raw-record
parser in `getChangedFilesWithBinaryStatus` only recognizes tokens that start with `:`,
so it skips that record, and the first file's status falls back to `"M"`.

The two callers pass `git show` without `GIT_NO_SHOW_SIGNATURE_OPTION`:

- `HostedWorkspaceViewerService.ts` ~3113-3119: `changedFilesArgs` for a commit diff.
- `HostedWorkspaceViewerService.ts` ~2566-2572: the per-file commit diff.

## Suggested Fix

Make `getChangedFilesWithBinaryStatus` add `GIT_NO_SHOW_SIGNATURE_OPTION` itself whenever
`gitArgs[0]` is `"show"` (or `"log"`), so no caller can forget it. Then drop any duplicate
from callers. Extend the signed-commit test in `src/test/unit/GitUtils.test.ts` (~597) to
cover `getChangedFilesWithBinaryStatus` with `show` args for a commit that deletes a file.
