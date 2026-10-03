# VS Code and the CLI fully rebuild each other's search index because its workspace hash is case-sensitive

- **Found:** 2026-10-02 by Claude (claude-cli), timing `ctrlyoke history search` on Windows while the extension was running
- **Area:** `src/core/orchestration/historySearchRebuildWorker.ts` (`hashPath`, `getIndexCompatibilityReason`)
- **Resolution:** fixed in this commit

## Symptom

On Windows, with the extension open on the same workspace, every
`ctrlyoke history search` after the extension has touched the index does a **full**
rebuild over all 1,648 runs. That takes 51-85s here, instead of the incremental
refresh, or the roughly 3s a fresh index takes. The CLI log names the cause:

```
[HistorySearchIndexService] index missing or stale; triggering synchronous rebuild before search
[HistorySearchIndexService] freshness check stale: schema/workspace hash mismatch
```

The reverse also happens: once the CLI has rebuilt, the extension's next refresh
sees the CLI's hash and fully rebuilds too. `orchestration.instructions.md` flags
`HistorySearchIndexService` as memory-sensitive (it has OOM'd the extension host).

## Steps to Reproduce

1. Open the workspace in VS Code (the workspace path has a lowercase drive letter, `c:\dev\ctrlyoke`) and let a run write history.
2. From a terminal (`C:\dev\ctrlyoke`), run `node out/cli.js history search worktree --limit 5`. It rebuilds the full index.
3. Let the extension write more history, then repeat step 2. It fully rebuilds again.

Evidence: `~/.ctrlyoke/projects/ctrlyoke-81d730fe53ae/.search-index/v1/manifest.json`
has `workspaceRootHash` `af32b29a…` = `sha256(path.resolve("C:\\dev\\ctrlyoke"))`.
The extension computes `sha256("c:\\dev\\ctrlyoke")` = `81d730fe…`.

## Root Cause

`hashPath` (`historySearchRebuildWorker.ts` ~775) hashes `path.resolve(filePath)`
verbatim, and `getIndexCompatibilityReason` (~286-294) treats any mismatch with the
manifest's `workspaceRootHash` as incompatible, which forces a full rebuild. VS Code
reports the workspace folder with a lowercase drive letter, while a shell's `cwd`
usually has an uppercase one. `ProjectStatePaths.projectKey` already solves this
by hashing `foldPathForCompare(resolvedStateRoot)` (`src/utils/PathCasing.ts`),
which is why both hosts agree on the project directory but not on the index.

## Suggested Fix

Hash `foldPathForCompare(path.resolve(workspaceFolderPath))` for
`workspaceRootHash`. Put this in one shared helper rather than a second copy of the
`projectKey` logic. Check whether `getDocumentsShardFileName` (which also uses
`hashPath`) can see paths that differ only in casing. Add a unit test where the
same workspace given with `c:\` and `C:\` must pass the compatibility check.
