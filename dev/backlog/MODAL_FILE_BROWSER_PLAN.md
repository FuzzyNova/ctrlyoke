# Modal File Browser Plan

## Problem

Template variables of type `file` / `directory` render a **Browse…** button
(`TemplateModal.tsx:599`). That button posts `BROWSE_TEMPLATE_FILE`
(`TemplateModal.tsx:233`), which the extension handles in
`WorkflowSerializer.handleBrowseTemplateFile` (`WorkflowSerializer.ts:602`) by
calling `vscode.window.showOpenDialog(...)` — a **native OS dialog**.

That is correct for the VS Code panel (extension host and user are the same
machine) but **broken for the hosted dashboard** (`CtrlYokeHostedServer`): a
remote browser user clicks Browse, the message routes over the WebSocket to the
extension, and the native dialog opens on the *host's* screen — invisible and
useless to the browser user. There is no web-native way to pick a workspace file
or folder from the hosted dashboard today.

Related, weaker pickers exist but don't fit this need:

- `WorkflowFilePickerModal.tsx` — a **flat list** of pre-discovered workflow
  files (`/api/workflow-files`) plus a manual-path text box. No directory
  navigation, no folder selection, workflow-files-only. Wrong shape for browsing
  an arbitrary file/dir.
- `WorkspaceExplorerPane.tsx` — a full IDE explorer+editor pane. Right data
  foundation, wrong packaging for a modal (see below).

## Goals

- A web-native modal file/directory picker usable from the hosted dashboard.
- Reuse the existing workspace-viewer API and navigation primitives — **not** a
  third parallel file-browser implementation.
- Keep the native OS dialog in the VS Code panel (better UX there); only add the
  web modal where the native dialog can't work.
- Generic enough that `SaveWorkflowDialog` / `WorkflowFilePickerModal` could
  adopt it later, but land it scoped to TemplateModal's Browse button first.

## Non-goals

- No new server endpoint (the tree API already exists).
- No `schemas/workflow-schema.json` change.
- No new third-party dependency.
- No unification of the VS Code panel onto the web modal (decision below).

---

## Decisions

**1. Branch the Browse button on `isStandalone`, not unify.**
`isStandalone` already exists (`useVsCodeApi.ts:24`, backed by
`window.__ctrlyokeStandalone`). VS Code panel → keep native `showOpenDialog`
(full filesystem, OS-native, same machine). Browser (`isStandalone === true`) →
open the new `FileBrowserModal`. Only the *result-application* logic is unified
so the two paths can't drift.

**2. Reject an off-the-shelf React file-browser plugin.**
The hosted server serves under a strict, self-contained CSP
(`CtrlYokeHostedServer.ts:1202-1211`: `default-src 'self'`, no external hosts,
everything inlined). Any plugin drags in external assets/fonts that violate that,
won't theme against the VS Code CSS tokens, and still needs a custom adapter to
the workspace-viewer API. All cost, no leverage.

**3. Reject reusing `WorkspaceExplorerPane` wholesale; reuse its data layer +
extract its primitives.** As-is it's welded to `workspaceViewerStore` — which is
**shared with the live Workspace Viewer tab**, so mounting it in a modal would
cross-contaminate `selectedFilePath` / `fileContent` / editor state — and carries
an editor column, context menus, cut/copy/paste, and mobile split logic a picker
doesn't want. But it sits on exactly the right foundation, which we extract.

**4. Return workspace-relative paths.** The tree API speaks workspace-relative
paths; the picker returns the same. Consciously match the native picker's output
shape so a generated template behaves identically regardless of client. (Verify
what `handleBrowseTemplateFile` currently returns and normalize both to the same
shape — see Open Questions.)

---

## Existing facts this plan relies on

- `workspaceTree(dirPath)` (`hostedApi.ts:66`) → `GET /api/workspace-viewer/tree`
  (`CtrlYokeHostedServer.ts:694`, served by `HostedWorkspaceViewerService`) is
  already workspace-scoped and path-hardened (`Path not allowed` → 403) and
  returns `entries`, `path`, `parentPath`, `rootLabel`, `isRootsList`,
  `isGitRepo`. That is everything a picker needs. `hostedFetch` sends the token
  header automatically.
- `isRootsList` is the virtual top level of a multi-root workspace (one entry per
  root). The picker treats each root as a navigable folder; the server already
  handles the containment.
- `EntryRow` (`WorkspaceExplorerPane.tsx:106`), `renderBreadcrumb`
  (`WorkspaceExplorerPane.tsx:498`), and `toWorkspaceRelative`
  (`WorkspaceExplorerPane.tsx:46`) are self-contained enough to extract and share.
- Git-status coloring in the explorer (`getEntryStatusColorClass`, line 71) is
  **optional** for a picker — leave it out initially to keep the modal lean (no
  `workspaceStatus()` call).
- The native-path result already flows: `handleBrowseTemplateFile` →
  `TEMPLATE_FILE_SELECTED` → `useMessageHandler.ts:1349` →
  `uiStore.setTemplateFileSelection` → consumed by `TemplateModal.tsx:131`
  (applies path to the variable **and** does `autoFillFilename`). That
  apply-logic is what both paths must share.
- `ext`-from-glob extraction for `fileFilter` already exists in
  `WorkflowSerializer.ts:616` — mirror it client-side for the web filter.

---

## Implementation

### Part 1 — Extract shared navigation primitives

Create a shared module (e.g. `components/workspace-viewer/fileBrowserShared.tsx`
or a `fileBrowser/` folder) and move, without behavior change:

- `EntryRow` — presentational row (icon + name + optional status color). Keep the
  `statusColorClass` prop optional so the picker can omit it.
- `toWorkspaceRelative(filePath, workspaceRoot)` — path helper.
- The breadcrumb renderer, generalized to take `(explorerPath, rootLabel,
  onNavigate)` instead of closing over component state.

`WorkspaceExplorerPane` imports these back — net zero behavior change, verified by
its existing tests still passing.

### Part 2 — `FileBrowserModal`

New component `components/workflow/FileBrowserModal.tsx` (or `shared/`), built on
`Modal`, with **local state only** (no store):

Props:
```ts
interface FileBrowserModalProps {
  isOpen: boolean;
  mode: "file" | "directory";
  fileFilter?: string[];        // globs; file mode only
  initialPath?: string;         // workspace-relative; defaults to ""
  title?: string;
  onSelect: (path: string) => void;   // workspace-relative
  onClose: () => void;
}
```

Behavior:
- On open, `workspaceTree(initialPath ?? "")`; render breadcrumb + entry list
  using the Part 1 primitives.
- Folder row click → navigate into it (`workspaceTree(entry.path)`). Back button
  uses `parentPath`.
- **file mode**: clicking a file selects it (highlight); `fileFilter` dims/disables
  non-matching files but folders always stay navigable. Confirm button enabled
  when a file is selected → `onSelect(selectedFile)`.
- **directory mode**: a "Select this folder" action targets the *current*
  directory; folder rows are also directly selectable. Files render dimmed/
  non-selectable. Confirm → `onSelect(currentOrSelectedDir)`.
- Loading / error / empty states mirror `WorkflowFilePickerModal`'s copy.
- Reuse the `hideGitIgnoredFiles` setting toggle pattern only if cheap; otherwise
  omit for v1.

### Part 3 — Unify result application + wire the branch

- Extract TemplateModal's "apply picked path to variable (+ optional
  `autoFillFilename`)" out of the `templateFileSelection` effect
  (`TemplateModal.tsx:131-157`) into a local helper, e.g.
  `applyPickedPath(variable, path)`. Both the message-driven effect (native) and
  the modal `onSelect` (web) call it → single source for the apply behavior.
- In `handleBrowseFile` (`TemplateModal.tsx:231`): if `isStandalone`, open
  `FileBrowserModal` (local `browseState: { variable, mode, fileFilter } | null`)
  instead of posting `BROWSE_TEMPLATE_FILE`. Otherwise keep the existing native
  post. Modal `onSelect` → `applyPickedPath(browseState.variable, path)`.
- No new message type, no server change — the web path resolves entirely
  webview-side via `hostedFetch`.

### Part 4 (deferred / follow-up)

- Adopt `FileBrowserModal` in `SaveWorkflowDialog` (save-location picker) and let
  `WorkflowFilePickerModal`'s manual-path box optionally launch it.
- Optional git-status coloring by adding a `workspaceStatus()` fetch.

---

## Open questions

1. **Path shape parity.** Confirm exactly what string `handleBrowseTemplateFile`
   returns today (absolute fsPath vs. workspace-relative) and normalize both
   clients to the same shape so template substitution is client-independent.
2. **Modal home vs. store-driven.** Start with local state in `TemplateModal`. If
   a second consumer lands (SaveWorkflowDialog), consider promoting to a
   `uiStore`-driven global picker (`openFileBrowser({ mode, onSelect })`) to avoid
   each caller re-plumbing open/close state.
3. **External roots.** If `ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md` lands, the tree
   API and this picker both inherit external-root navigation for free via
   `FileAccessPolicy`; nothing picker-specific needed, but keep the modal's root
   handling generic (`isRootsList`) so multiple roots already work.

## Verification

- `npm run typecheck`.
- `npm run test:ui` — extend `WorkspaceExplorerPane` coverage stays green after
  the Part 1 extraction; add a `FileBrowserModal` test (navigation, file vs.
  directory confirm, `fileFilter` dimming).
- Manual pass in the hosted dashboard (browser, `isStandalone`): open New Workflow
  → a template with `file` + `directory` variables → Browse on each → navigate,
  pick, confirm → variable populates and `autoFillFilename` still seeds the
  workflow name. Then confirm the VS Code panel still opens the native dialog
  unchanged.
