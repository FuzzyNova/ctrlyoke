# Workspace viewer Discard/Stage/Unstage read a file path as a git glob, so discarding `[id].tsx` reverts other files

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli, node repro against `out/`)
- **Area:** `src/server/HostedWorkspaceViewerService.ts` (`stageFile`, `unstageFile`, `discardFile`); `src/utils/GitUtils.ts` (file-history helpers that end in `-- <gitPath>`)
- **Resolution:** fixed in this commit

## Symptom

The workspace viewer's Source Control pane (hosted dashboard) acts on one
file. It passes that file's repo-relative path to git as a plain pathspec.
Git expands glob characters (`*`, `?`, `[...]`) and `:(magic)` prefixes in
pathspecs, so a path that contains them matches other files too.

Bracketed names are routine in Next.js, SvelteKit and Nuxt routes
(`app/[id].tsx`, `[...slug].tsx`). **Discard** on `app/[id].tsx` runs
`git restore --worktree -- app/[id].tsx`. The pathspec `[id]` is a character
class matching `i` or `d`, so the command also reverts `app/i.tsx` and
`app/d.tsx`. Their uncommitted edits are lost, with no prompt and no way to
recover them. **Stage** and **Unstage** have the same problem: they stage or
unstage files the user never selected. A file literally named `*` would hit
the whole repository.

## Steps to Reproduce

```sh
R=/private/tmp/cyglob; mkdir -p $R/app && cd $R && git init -q
for f in '[id].tsx' i.tsx d.tsx; do echo orig > "app/$f"; done
git add -A && git commit -qm init
for f in '[id].tsx' i.tsx d.tsx; do echo edited > "app/$f"; done
node -e '
const {HostedWorkspaceViewerService}=require("<repo>/out/server/HostedWorkspaceViewerService.js");
const s=new HostedWorkspaceViewerService(process.argv[1]);
s.discardFile("app/[id].tsx").then(()=>{s.dispose();process.exit(0)})' "$R"
cat app/i.tsx app/d.tsx   # both "orig": their edits were discarded too
```

The same thing happens through the dashboard: open the Source Control pane
in the workspace viewer and click Discard on `app/[id].tsx`.

## Root Cause

`safeResolve` only checks that the path stays inside the workspace. The
resulting `relPath` then goes to git verbatim after `--`:

- `stageFile`: `git -C <repo> add -- <relPath>` (around line 2313)
- `unstageFile`: `git -C <repo> restore --staged -- <relPath>` (around line 2325)
- `discardFile`: `git -C <repo> restore --worktree -- <relPath>` (around lines 2354-2362)

`--` stops option parsing but not pathspec magic. Elsewhere the service
already writes `:(literal)` / `:(exclude,literal)` pathspecs (around lines
3363, 3551, 3650). These three mutating calls were missed. The file-history
helpers in `GitUtils.ts` (`getFileHistoryCommits` and its siblings, which end
in `args.push("--", gitPath)` around lines 632, 670, 797) have the same
problem, but there it only shows the wrong history and destroys nothing.

## Suggested Fix

Make each of these git invocations use literal pathspecs. Either pass
`--literal-pathspecs` as a global option
(`git --literal-pathspecs -C <repo> restore --worktree -- <path>`) or prefix
the path with `:(literal)`. `--follow` accepts a `:(literal)` pathspec, so
either form works for the history helpers too. Prefer one small shared helper
(for example `literalGitPathspec(path)` in `GitUtils.ts`) over repeating the
prefix. Add `HostedWorkspaceViewerService.test.ts` cases: with `app/[id].tsx`,
`app/i.tsx` and `app/d.tsx` all modified, `discardFile("app/[id].tsx")` must
revert only `[id].tsx`. `stageFile` and `unstageFile` must touch only that
file.
