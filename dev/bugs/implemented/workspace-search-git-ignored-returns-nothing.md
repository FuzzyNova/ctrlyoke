# Workspace search returns nothing with "Include git-ignored files" on

- **Found:** 2026-10-24 by user (hosted dashboard, phone)
- **Area:** `src/server/HostedWorkspaceViewerService.ts`
- **Resolution:** fixed in this commit

## Symptom

In the workspace viewer's Search tab, ticking **Include git-ignored files**
returned no results for any query, including ones that match tracked files.
The extension host was blocked for about 4 seconds per search
(`[EventLoopStall] event loop blocked for ~3830ms` … `~4955ms` in the session
log, with heap jumping 130–180 MB each time).

## Steps to Reproduce

1. Open the workspace viewer on a checkout with `node_modules/` (this repo).
2. Search tab, tick **Include git-ignored files**, search for any term.
3. "No results" (and **Load more** returns nothing either).

## Root Cause

`discoverSearchCandidates` ran `git ls-files --others --ignored
--exclude-standard` (`getGitIgnoredFiles`), which lists every ignored file
recursively: about 174,000 paths and 4.3 s on this repo. The result was parsed,
deduplicated and mapped to viewer paths synchronously. The search's 3 s budget
(`SEARCH_MAX_DURATION_MS`) is measured from before discovery, so the scan loop
saw the budget already spent and broke on its first candidate with
`truncated: true` and zero results.

## Fix

`getGitIgnoredEntries` adds `--directory`, so a wholly ignored directory is one
entry (74 ms here). Search became a resumable session
(`src/server/WorkspaceSearchSession.ts`) that pulls candidates lazily: tracked
files first, then ignored files, then the ignored directories, walked
breadth-first by `iterateSearchFiles` only as far as the pages read need.
