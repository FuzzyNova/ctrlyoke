# Prompt undo matches an edit to a different file with the same name, and reverse-patches the wrong file

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli), reproduced in a scratch Vitest test
- **Area:** `src/ui/webview-react/utils/promptUndo.ts` (`sameFilePath`, `buildUndoFileCandidates` tier-1/tier-2 matching)
- **Resolution:** fixed in this commit

## Symptom

In a repo with repeated file names (monorepos: `package.json`, `README.md`,
`index.ts`), an AI edit to a nested file is shown in the prompt-undo change list
with the diff of a *different* file that has the same name at a shallower path,
and its undo instruction targets that other file. Clicking Undo reverse-patches
the wrong file (for example the root `package.json`) and leaves the real AI edit
in place. The genuinely changed shallower file also disappears from the tier-2
list, so only one file is shown where two changed.

## Steps to Reproduce

1. One prompt edits `packages/api/package.json` (bumps lodash) and, through a
   shell command, also changes the root `package.json` (version bump).
2. The harness reports the edit as `C:/ws/packages/api/package.json`. The
   workspace snapshot's `changedFiles` are `["package.json", "packages/api/package.json"]`
   (git name-status order: sorted by path).
3. `buildUndoFileCandidates` produces one tier-1 candidate whose `path` is the
   nested file but whose `instruction.path` is `package.json` and whose diff is
   the root version bump. Both snapshot entries are excluded from tier 2.

## Root Cause

`sameFilePath` (`promptUndo.ts` ~160-166) treats two paths as equal when one
ends with `"/" + other`. That is meant to bridge absolute event paths and
workspace-relative snapshot paths, but `C:/ws/packages/api/package.json` also
ends with `/package.json`. `snapshotFiles.find(...)` (~311, and ~140 for
FILE_DELETE) takes the first such match, and the tier-2 filter (~355) drops every
snapshot entry any event path suffix-matches.

## Suggested Fix

Resolve each event path to exactly one snapshot entry. Relativize absolute
event paths against the run's workspace/execution root when the webview has it,
and compare relative paths exactly. Where no root is available, pick the
*longest* (most specific) suffix match rather than the first, and exclude a
snapshot entry from tier 2 only if it is the chosen match of some event. Add
Vitest coverage under `src/ui/webview-react/test/` for the repro above.
