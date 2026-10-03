# Hosted diffs treat a blob over 50 MB as missing and read working files with no size cap

- **Found:** 2026-10-02 by bug-hunt final step (Claude)
- **Area:** `src/utils/GitUtils.ts` (`getBlobBytes`), `src/server/HostedWorkspaceViewerService.ts` (diff builders)
- **Resolution:** fixed in this commit

## Symptom

- A modified tracked text file whose `HEAD` blob is larger than 50 MiB opens
  in the hosted SCM diff as `kind: "modified"` with `oldContent: ""` and the
  whole working file as `newContent`, so the diff shows every line as added.
- Commit and file-history diffs of such a file show an empty change, because
  both sides come back `null`.
- The working-tree side is read with an uncapped `fs.promises.readFile`. A
  file of a few hundred MB is read in full, decoded, run through
  `redactValue`, and JSON-serialised in the extension host. The viewer's
  `readFile` enforces `MAX_FILE_SIZE` (2 MB); the diff paths do not. This is
  the large-single-allocation extension-host OOM shape described in the
  project debugging notes.

## Steps to Reproduce

1. Commit a 60 MB text file `big.txt`, then append one line to it.
2. `getBlobBytes(root, "HEAD", "big.txt")` (compiled `out/utils/GitUtils.js`)
   returns `null`. This was verified.
3. Open `big.txt` from the hosted dashboard's SCM pane
   (`GET /api/workspace-viewer/diff?path=big.txt`): the old side is empty.

## Root Cause

`GitUtils.ts` `getBlobBytes` (~lines 504-530) runs `git show` with
`maxBuffer: GIT_MAX_BUFFER` (50 MiB) and `catch { return null; }`. That swallows
`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, timeouts, and every other failure into
the "path absent on this side" value. Its callers in
`HostedWorkspaceViewerService.ts` read `null` as "added" or "deleted":

- `getDiff` (~1816)
- `buildGitRefDiffEntry` (~1946)
- `getFileHistoryDiff` (~2290)
- `readWorkingTreeDiffBytes` (~2756)
- `buildNonTextDiffEntries` (~2785/2796)
- `buildGitRefDiffPageEntry` (~2890)

`getDiff` and `readWorkingTreeDiffBytes` call `fs.promises.readFile` with no
size check.

## Suggested Fix

- Make `getBlobBytes` return `null` only for a genuinely missing path, for
  example after `git cat-file -e`, or by matching git's "does not exist" /
  "exists on disk, but not in" stderr. Rethrow, or return a distinct
  too-large result, for maxBuffer and timeout errors.
- Apply one diff-side size cap, single-sourced with the viewer's
  `MAX_FILE_SIZE` or a dedicated diff constant, to both the blob side
  (check `git cat-file -s` first) and the working-file side (`stat` first).
- When a side exceeds the cap, return a "too large to diff" payload in the
  same way `readFile` handles oversized files.

Cover these with `HostedWorkspaceViewerService` tests. A small cap injected
for the test is fine; don't commit 50 MB fixtures.
