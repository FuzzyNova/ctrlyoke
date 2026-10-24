# Explorer marks children of a git-ignored directory as not ignored

- **Found:** 2026-10-24 by timeout-budget bug sweep workflow (server-completions)
- **Area:** `src/server/HostedWorkspaceViewerService.ts`
- **Severity:** low

## Symptom

In the hosted workspace viewer explorer, with git-ignored files shown, the ignored folder
itself (for example `node_modules/` or `out/`) is dimmed. When it is expanded, its
contents appear as normal, non-ignored files and folders. VS Code's explorer dims
everything inside an ignored folder.

## Steps to Reproduce

1. Open the hosted dashboard's workspace viewer on this repo, with git-ignored files
   included.
2. Expand `node_modules/`.
3. The children are shown without the ignored color.

Confirmed: `cd node_modules && git ls-files --others --ignored --exclude-standard
--directory -z .` prints only `./`.

## Root Cause

- `src/server/HostedWorkspaceViewerService.ts:1129-1142` (`createListingSnapshot`) gets
  `ignoredNames` from `getIgnoredEntryNames(containingRoot, rootRelativeDir)` and marks
  each child by `ignoredNames.has(`${name}/`)` or `ignoredNames.has(name)`.
- `src/utils/GitUtils.ts:1251-1278` runs `git ls-files --others --ignored
  --exclude-standard --directory .` with `cwd` set to the listed directory. When that
  directory is itself wholly ignored, git collapses it to the single entry `./`, so no
  child name matches and every child gets `gitIgnored: false`.
- `src/ui/webview-react/components/workspace-viewer/WorkspaceExplorerPane.tsx:89` colors
  by `entry.gitIgnored` only, and does not inherit the flag from the parent.

## Suggested Fix

In `createListingSnapshot`, treat a result that contains `./` (or an empty relative
entry) as "this whole directory is ignored", and mark every child `gitIgnored: true`.
This also avoids listing anything further. Alternatively, pass the parent's ignored
state down on the request, or have the client inherit `gitIgnored` from an ignored
ancestor. The server-side fix keeps the flag correct for every client.
