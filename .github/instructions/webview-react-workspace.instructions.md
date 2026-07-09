---
applyTo: "src/ui/webview-react/components/workspace-viewer/**"
---

<purpose>
Workspace viewer is a full-screen modal for browsing/editing files and SCM state from the hosted dashboard. It mixes Zustand modal state with direct hosted-server HTTP calls, so path normalization and optimistic draft handling matter more than component structure.
</purpose>

<architecture>
- `WorkspaceViewerModal.tsx` is a portal with enter/exit animation state; closing the modal should clear transient loading/error flags through the store instead of relying on component unmount timing.
- Explorer and SCM panes call `utils/hostedApi.ts` directly. In hosted mode those requests carry the dashboard token; keep new endpoints in that helper instead of open-coding `fetch`.
- `workspaceViewerStore` caches unsaved file drafts by normalized workspace-relative path. Components should keep using those canonical keys, even if navigation starts from absolute paths or mixed separators.
</architecture>

<gotchas>
- `WorkspaceExplorerPane.tsx` deliberately normalizes Windows paths with case-insensitive workspace-root stripping so links emitted by AI output, Node, and the browser all resolve to the same selected file.
- File selection is request-sequenced and mobile editor visibility is store-driven. Avoid local component shortcuts that bypass `selectFile`, `setLoadedFileContent`, or pending-navigation handling.
- SCM actions refresh status first, then re-open the selected diff only if it still exists. Preserve that refresh-after-mutation flow so staged/unstaged lists and diff panes do not drift apart.
- Confirmation settings such as delete warnings come from `settingsStore.globalSettings`; do not add viewer-local copies.
- **Reference-link clicks in the hosted browser do not go through `MESSAGE_TYPES.OPEN_FILE`.** `openContextReference()` (`utils/contextReferenceActions.ts`) branches on `isStandalone`: in the VS Code panel it posts `OPEN_FILE` to the extension host; in the hosted browser (and inside `WorkspaceFileEditor.tsx`'s own in-file link clicks) it calls `workspaceViewerStore.openToFile()`/`openToDirectory()` instead, which resolves purely through `HostedWorkspaceViewerService`'s HTTP endpoints. A path-resolution fix on the VS Code side (`WebviewMessageRouter`/`PromptLinkProvider`) does **not** cover this path — multi-root folder-name-prefixed refs (`root2/src/index.ts`) must be handled by `HostedWorkspaceViewerService` itself.
- **Multi-root top level**: when the server reports `WorkspaceTreeResponse.isRootsList: true` (root path `""` in a multi-root workspace), every entry in the listing represents an entire workspace root, not a real file/subdirectory. `useWorkspaceExplorerContextMenu` disables Cut/Copy/Delete/Paste in that view (via its `isRootsList` option) — "Add to ctrlyoke" stays enabled since referencing a whole root as `@root2/` is meaningful. No other client-side path arithmetic changes were needed for multi-root browsing — the existing directory-listing/breadcrumb code already handles folder-name-prefixed paths correctly once the server returns them.
</gotchas>
