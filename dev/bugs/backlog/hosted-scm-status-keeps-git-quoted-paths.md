# Hosted viewer SCM status keeps git's C-quoted paths (spaces, non-ASCII, quotes)

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli)
- **Area:** `src/server/HostedWorkspaceViewerService.ts` (`getRepoStatus` / `parsePorcelainV1`)
- **Severity:** medium

## Symptom

In the hosted workspace viewer's source-control view, any changed file whose name
contains a space, a non-ASCII character or a quote shows a mangled path, can't be
opened, and can't be staged. Reproduced with git 2.47 and untracked files `a b.txt`,
`café.txt`, `q"t.txt`; `HostedWorkspaceViewerService.getStatus()` returned:

| real file | reported path             |
| --------- | ------------------------- |
| `a b.txt` | `"a b.txt"` (with quotes) |
| `café.txt`| `"caf/303/251.txt"`       |

`readFile(status.path)` → "File not found"; `stageFile(status.path)` → `fatal:
pathspec '"a b.txt"' did not match any files`. `readFile("a b.txt")` works.

## Steps to Reproduce

1. In a workspace repo, create an untracked `a b.txt`.
2. Open the hosted dashboard's workspace viewer source-control pane.
3. The entry shows as `"a b.txt"`; clicking or staging it fails.

## Root Cause

`getRepoStatus` runs `git status --porcelain=v1` without `-z`. In that mode git
C-quotes unusual paths (`core.quotePath`). `parsePorcelainV1` takes `line.slice(3)`
verbatim (and splits renames on `" -> "`), then `normalizeScmPath` turns the octal
escapes' backslashes into `/`. Elsewhere the codebase already uses `-z`
(`src/git/GitUtils.ts`) or strips quoting (`WorkspaceSnapshotService.ts`).

## Suggested Fix

Run `git status --porcelain=v1 -z` and parse NUL-separated records (for renames/copies
the original path is the following NUL-terminated field, and the order is
`new\0old` in `-z` mode), so no unquoting is needed. Reuse an existing `-z` porcelain
parser if one exists in `src/git/` rather than writing another. Add tests with a temp
repo containing `a b.txt`, `café.txt`, and a renamed file with a space, asserting
`getStatus()` paths are the real names and that `stageFile`/`readFile` succeed on them.
