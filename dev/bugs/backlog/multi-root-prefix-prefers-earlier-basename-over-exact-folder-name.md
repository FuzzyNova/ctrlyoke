# Multi-root prefix prefers an earlier folder's basename over an exact folder name

- **Found:** 2026-10-02 by bug-hunt final step (source review, reproduced against the resolver)
- **Area:** `src/platform/WorkspaceRootResolver.ts`, `src/platform/WorkspaceViewerPath.ts`
- **Severity:** high

## Symptom

In a multi-root workspace, a folder-name-prefixed viewer path can resolve to a
different root than the one whose display name it carries. This happens when
an earlier folder's directory basename equals a later folder's display name.
The realistic case is two repos both checked out as `app`, with one renamed in
the `.code-workspace` file:

```jsonc
"folders": [
  { "name": "frontend", "path": "C:/repo1/app" },
  { "name": "app",      "path": "C:/repo2/app" }
]
```

- `toViewerPath("C:\\repo2\\app\\src\\index.ts")` → `"app/src/index.ts"` (from `root.name`)
- `fromViewerPath("app/src/index.ts")` → `C:\repo1\app\src\index.ts`, which is the **wrong repository**

`toViewerPath`/`fromViewerPath` are documented as inverses, and this breaks
that. The hosted workspace viewer resolves through `fromViewerPath`
(`HostedWorkspaceViewerService.resolveAgainstRoots`). So opening, saving, or
deleting `app/...` in the viewer acts on `repo1`, while the tree shows `repo2`.
`@app/...` references (`PromptFileResolver`, `ContextExpander`,
`WorkspaceSnapshotService`, `WebviewMessageRouter`) attach the wrong file the
same way. `rootForViewerPath` gives the wrong repo for SCM association too.

Duplicate _display names_ are documented as first-wins. Here the display names
are distinct (`frontend`, `app`), so nothing documents this behavior.

## Steps to Reproduce

1. Call `resolveNamedRelativePath("app/src/index.ts", "C:/repo1/app", [{name:"frontend", fsPath:"C:/repo1/app"}, {name:"app", fsPath:"C:/repo2/app"}])`.
2. Observe that `absolutePath` is under `C:\repo1\app`. The expected result is `C:\repo2\app`,
   the folder whose display name is exactly `app`.
3. `rootForViewerPath("app/x", sameRoots)` likewise returns the `frontend` root.

## Root Cause

Both lookups test display name and directory basename together in one
`find`, folder by folder:

- `resolveWorkspaceOrNamedPath` in `src/platform/WorkspaceRootResolver.ts`
  (about lines 266–270)
- `rootForViewerPath` in `src/platform/WorkspaceViewerPath.ts` (about lines 84–87)

```ts
namedRoots.find(
  (root) => root.name === seg || path.basename(root.fsPath) === seg
);
```

So an earlier root's basename match wins over a later root's exact name match.
The doc comments describe matching the name "falling back to its directory
basename", which means the intended precedence is all names first, then
basenames. `toViewerPath` only ever emits `root.name` prefixes.

## Suggested Fix

- Add one shared helper (e.g. `findNamedRootBySegment(seg, namedRoots)` in
  `WorkspaceRootResolver.ts`) that does
  `namedRoots.find(r => r.name === seg) ?? namedRoots.find(r => path.basename(r.fsPath) === seg)`.
  Use it from both `resolveWorkspaceOrNamedPath` and `rootForViewerPath`, so
  the rule lives in one place.
- Check the webview mirror `repoIdForPath` in `workspaceViewerStore.ts`. The
  `WorkspaceViewerPath.ts` header says it mirrors the `firstViewerSegment`
  rule. If it also does a name-or-basename match, apply the same precedence.
- Add tests: the repro above for both functions, a round trip
  `fromViewerPath(toViewerPath(p)) === p` for this layout, and an unchanged
  basename fallback when no folder's name matches.
