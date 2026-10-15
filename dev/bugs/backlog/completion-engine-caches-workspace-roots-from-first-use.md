# Completion engine keeps the workspace roots from its first use, so the regex symbol fallback misresolves added folders

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/completions/CompletionHelpers.ts`
- **Severity:** low

## Symptom

After a folder is added to a multi-root workspace that is already open, `#` symbol completions from the regex fallback index never include symbols declared in the new folder. The folder's files appear in the file list, but their symbols resolve to nonexistent paths under the primary root and are silently skipped until the extension host restarts.

## Steps to Reproduce

1. Open a multi-root `.code-workspace` with two folders (A and B), with no language server providing workspace or document symbols for a file type the regex index supports (or disable the TS language features).
2. In a workflow prompt, type `#` to trigger a completion. This builds the `CompletionCore` singleton with the roots [A, B].
3. Use File > Add Folder to Workspace to add folder C, which contains a file declaring `class Foo`. The extension host does not restart, because this is not the first folder change.
4. Wait more than 5 s, or edit a file so the file cache is cleared, then type `#Foo`.
5. No symbol completion for `Foo` appears. The path `C/...` is in the file list, but the resolver maps it to `<A>/C/...`, `fs.stat` fails, and the result is `[]`.

## Root Cause

`getCompletionCore()` (`src/completions/CompletionHelpers.ts:65-92`) saves `root = getVsCodeWorkspaceRoot()` and `roots = getVsCodeNamedWorkspaceRoots()` once, at lines 67-68, inside the `if (!completionCore)` singleton guard. The resolver closure passed to `RegexSymbolIndex` (lines 75-86) always uses those saved values, and `RegexSymbolIndex` also keeps its own copy of `root`.

`getCompletionFiles()` (lines 37-62), by contrast, re-reads `vscode.workspace.workspaceFolders` on every uncached call and prefixes each path with the current folder name. Nothing rebuilds the core when folders change: `clearFilesCache()` (lines 95-100) only clears caches, the `configService` subscription (lines 106-110) only calls `clearFilesCache()`, and the `onDidChangeWorkspaceFolders` handler in `src/extension.ts:679-702` acts only when the resolved `.ctrlyoke` root changes. Adding a sibling folder does not change that root or restart the host.

So for a `C/...` viewer path, `rootForViewerPath` (`src/platform/WorkspaceViewerPath.ts:82-89`) finds no matching named root, and `fromViewerPath` (`src/platform/WorkspaceViewerPath.ts:149-164`) falls through to `resolveNamedRelativePath` against the primary root, producing `<A>/C/...`. That path stays inside the primary root, so the containment check passes, and `RegexSymbolIndex.symbolsForFile` (`src/completions/RegexSymbolIndex.ts:83-130`) swallows the `ENOENT` from `fs.stat` and returns `[]`.

## Suggested Fix

Read the roots lazily: call `getVsCodeWorkspaceRoot()` and `getVsCodeNamedWorkspaceRoots()` inside the resolver closure on each call, or pass getter functions to `RegexSymbolIndex` instead of captured values. Pass the root as a getter too, since `RegexSymbolIndex` keeps its own `workspaceRoot`.

Alternatively, subscribe to `vscode.workspace.onDidChangeWorkspaceFolders` in `initializeCompletionHelpers` and reset `completionCore` and `vsCodeSymbolIndex` to `undefined` along with `clearFilesCache()`, so the next call rebuilds the core with the current roots.

Add a test that changes the mocked `workspaceFolders` after the first `getCompletionCore()` call and asserts that a symbol from the new folder resolves.
