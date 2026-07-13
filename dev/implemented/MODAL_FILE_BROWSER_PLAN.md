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
extension, and the native dialog opens on the _host's_ screen — invisible and
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
open the new `FileBrowserModal`. Only the _result-application_ logic is unified
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
  `EntryRow` needs two more props loosened beyond `statusColorClass`: `isCut`
  and `openContextMenu` are currently **required** (`WorkspaceExplorerPane.tsx:100-103`)
  and wire into the explorer's cut/paste + right-click context menu, which the
  picker doesn't have. Default them (`isCut = false`, `openContextMenu` a no-op)
  so the picker can render rows without that wiring.
- The tree API's `entry.path` (`HostedWorkspaceViewerTypes.ts:21-22`) is already
  workspace-relative and folder-name-prefixed in multi-root workspaces —
  confirmed the same shape `handleBrowseTemplateFile` returns (see resolved
  Open Question 1 below). No normalization step needed on either side.
- Git-status coloring in the explorer (`getEntryStatusColorClass`, line 71) is
  **optional** for a picker — leave it out initially to keep the modal lean (no
  `workspaceStatus()` call).
- The native-path result already flows: `handleBrowseTemplateFile` →
  `TEMPLATE_FILE_SELECTED` → `useMessageHandler.ts:1349` →
  `uiStore.setTemplateFileSelection` → consumed by `TemplateModal.tsx:131`
  (applies path to the variable **and** does `autoFillFilename`). That
  apply-logic is what both paths must share.
- `ext`-from-glob extraction for `fileFilter` already exists in
  `WorkflowSerializer.ts:616`, and has no `vscode` dependency. Extract it to a
  pure function in `src/utils/` (e.g. `fileFilterUtils.ts`) and import it from
  both `WorkflowSerializer.handleBrowseTemplateFile` and `FileBrowserModal` via
  the `@root/utils` Vite alias (`vite.config.ts:130`, already proven by
  `WorkflowFilePickerModal.tsx:8`'s `@root/utils/WorkflowFileDiscovery` import).
  Single-source it — don't duplicate the regex client-side.

---

## Implementation

### Part 1 — Extract shared navigation primitives

Create a shared module (e.g. `components/workspace-viewer/fileBrowserShared.tsx`
or a `fileBrowser/` folder) and move, without behavior change:

- `EntryRow` — presentational row (icon + name + optional status color). Make
  `statusColorClass`, `isCut`, and `openContextMenu` all optional (default
  `isCut = false`, `openContextMenu` a no-op) so the picker can render rows
  without status coloring or the cut/paste + context-menu wiring.
- `toWorkspaceRelative(filePath, workspaceRoot)` — path helper.
- The breadcrumb renderer, generalized to take `(explorerPath, rootLabel,
onNavigate)` instead of closing over component state.

Also extract `extractExtensionsFromGlobs` (the ext-from-glob regex currently
inline in `WorkflowSerializer.ts:616`) into `src/utils/fileFilterUtils.ts` as a
pure function, with `WorkflowSerializer` importing it directly and
`FileBrowserModal` importing it via `@root/utils/fileFilterUtils`.

`WorkspaceExplorerPane` imports these back — net zero behavior change, verified by
its existing tests still passing.

### Part 2 — `FileBrowserModal`: a single store-driven canonical instance

One instance mounts once in the tree; every web-mode caller opens it through
`uiStore` instead of each mounting its own copy. Chosen over local
per-consumer state (see decision 2) for future consumers, portal/z-index
simplicity, and so only one picker can ever be open at a time app-wide.

`uiStore` additions:

```ts
interface FileBrowserRequest {
  mode: "file" | "directory";
  fileFilter?: string[];        // globs; file mode only
  initialPath?: string;         // workspace-relative; defaults to ""
  title?: string;
  onSelect: (path: string) => void;   // workspace-relative
}

fileBrowserState: FileBrowserRequest | null;
openFileBrowser: (request: FileBrowserRequest) => void;
closeFileBrowser: () => void;
```

`onSelect` is a plain in-memory callback, not a message-carried value —
this is fine because the web path never round-trips through the extension
host (unlike `templateFileSelection`, which has to be a serializable
`{variable, path}` record because it arrives via `postMessage` from
`WorkflowSerializer`). This is the first callback-shaped field in `uiStore`;
if that pattern feels wrong on review, the alternative is a `resolve`-style
request id + separate result field, but that's unneeded complexity for a
same-tick, same-process callback.

New component `components/workflow/FileBrowserModal.tsx`, built on `Modal`,
reads `fileBrowserState` directly from `uiStore` (no props, same convention as
`SaveWorkflowDialog`) and renders nothing when `null`. Mount it once in
`Header.tsx` alongside `SaveWorkflowDialog`/`TemplateModal`
(`Header.tsx:507-514`, the existing app-level dialog mount point).

**Caller modal hides (not unmounts) while the picker is open.** `Modal`
(`Modal.tsx`) is not stacking-safe on its own: each instance renders its own
full-screen backdrop via `createPortal` and attaches a `document.keydown`
Escape listener that fires `onClose` whenever `isOpen` is true
(`Modal.tsx:41-50,68-76`). If `TemplateModal`/`SaveWorkflowDialog` stayed
`isOpen` while `FileBrowserModal` opened on top, that's two stacked
backdrops, and pressing Escape to back out of the picker would also fire the
underlying dialog's `onClose` — closing both at once.

Fix: the caller derives a separate visual flag for its own `<Modal>` JSX —
`modalVisible = isOpen && !fileBrowserState` for `TemplateModal`,
`saveWorkflowDialogOpen && !fileBrowserState` for `SaveWorkflowDialog` — and
passes _that_ to its `<Modal isOpen={modalVisible} ...>`, while every other
effect keyed on the real logical-open flag (`TemplateModal`'s
`prevIsOpenRef`-guarded form-reset at `TemplateModal.tsx:101-121`,
`SaveWorkflowDialog`'s reset effect at `SaveWorkflowDialog.tsx:58-69`) stays
keyed on the _unmodified_ flag. Don't route the hide-while-picking behavior
through the same `isOpen` prop those effects watch — doing so would make
closing the picker look like "the dialog just reopened" and wipe whatever the
user had already typed. Since `isOpen={false}` returns `null` before
`Modal` portals anything (`Modal.tsx:59`), the hidden dialog has no backdrop
and its Escape listener no-ops, so this fixes both problems above, not just
the visual stacking. Any future consumer gets this for free by adding the
same `&& !fileBrowserState` guard to its own `<Modal isOpen>` — no
coordination code needed beyond reading the one shared store field.

Behavior:

- On open, `workspaceTree(initialPath ?? "")`; render breadcrumb + entry list
  using the Part 1 primitives.
- Folder row click → navigate into it (`workspaceTree(entry.path)`). Back button
  uses `parentPath`.
- **file mode**: clicking a file selects it (highlight); `fileFilter` dims/disables
  non-matching files but folders always stay navigable. Confirm button enabled
  when a file is selected → `onSelect(selectedFile)` then `closeFileBrowser()`.
- **directory mode**: a "Select this folder" action targets the _current_
  directory; folder rows are also directly selectable. Files render dimmed/
  non-selectable. Confirm → `onSelect(currentOrSelectedDir)` then
  `closeFileBrowser()`.
- Cancel / backdrop close → `closeFileBrowser()` without calling `onSelect`.
- Loading / error / empty states mirror `WorkflowFilePickerModal`'s copy.
- Reuse the `hideGitIgnoredFiles` setting toggle pattern only if cheap; otherwise
  omit for v1.

### Part 3 — Unify result application + wire the branch

- Extract TemplateModal's "apply picked path to variable (+ optional
  `autoFillFilename`)" out of the `templateFileSelection` effect
  (`TemplateModal.tsx:131-157`) into a local helper, e.g.
  `applyPickedPath(variable, path)`. Both the message-driven effect (native) and
  the store-driven modal's `onSelect` (web) call it → single source for the
  apply behavior.
- In `handleBrowseFile` (`TemplateModal.tsx:231`): if `isStandalone`, call
  `uiStore.openFileBrowser({ mode, fileFilter, initialPath: ..., onSelect: (path) =>
applyPickedPath(variable, path) })` instead of posting `BROWSE_TEMPLATE_FILE`.
  Otherwise keep the existing native post.
- No new message type, no server change — the web path resolves entirely
  webview-side via `hostedFetch`.
- Per Part 2's stacking fix: change `TemplateModal`'s returned
  `<Modal isOpen={isOpen} .../>` to `<Modal isOpen={isOpen && !fileBrowserState} .../>`
  (read `fileBrowserState` from `uiStore`). Leave the `prevIsOpenRef` reset
  effect (`TemplateModal.tsx:101-121`) keyed on the original `isOpen` prop,
  untouched.

### Part 4 — `SaveWorkflowDialog` adopts the picker

Unlike `TemplateModal`, `SaveWorkflowDialog` has **no existing Browse affordance**
today — just a single free-text "Save Path" input holding the full path
(`SaveWorkflowDialog.tsx:266-295`). This is new UI, not a swap.

**Split "Save Path" into Location + Name.**

- Replace the single `filePath` state with `location` (directory, the same
  absolute-or-workspace-relative string `defaultDir`/`defaultPath` already use)
  and `name` (workflow name, no extension).
- On dialog open, derive both from `saveWorkflowDialogData.defaultPath`: `name`
  = basename with the `.ctrlyoke.(yaml|yml|json)` suffix stripped (mirrors the
  slug logic already in `WorkflowSerializer.ts:110-119`, but keep the
  human-readable name here — no need to lowercase/slugify a value the user can
  see and edit); `location` = everything before the final path segment.
- Render: a read-only "Location" row showing `location` (breadcrumb-style, or
  just the path in muted text) with a **Browse…** button, then an editable
  "Name" text input (`validateSafeName` — already rejects `/`/`\`, so it can't
  smuggle a path back into the name). Format toggle (yaml/json) is unchanged.
  `handleSave` rejoins `location` + `name` + extension into the same
  `filePath` string `SAVE_WORKFLOW` already expects — no change to the save
  message or `WorkflowSerializer.handleSaveWorkflow`.

**Default starting location — already solved, no new storage needed.**
The "remember last save location" behavior the user is thinking of is real,
but it isn't browser `localStorage` — it's VS Code `workspaceState`
(`LAST_EXPORT_DIR_KEY = "ctrlyoke.lastWorkflowExportDir"`,
`WorkflowSerializer.ts:100,307-310`), written on every successful save and read
back into `defaultDir` on the next `SAVE_WORKFLOW_REQUEST`. It already flows
into `saveWorkflowDialogData.defaultPath` for both the VS Code panel and the
hosted browser client (same extension-host handler serves both). So `location`
is already seeded correctly on open — the picker (native or web) just needs to
open with `location` as its starting directory (`defaultUri` / `initialPath`);
no new persistence to add.

**Browse button: branch on `isStandalone`, same pattern as Part 3.**

- VS Code panel → native OS folder dialog, following the existing
  `handleBrowseTemplateFile` pattern (`WorkflowSerializer.ts:602-658`) but
  folder-only. Add `handleBrowseSaveLocation(postMessage?, defaultDir?)` to
  `WorkflowSerializer`: `showOpenDialog({ canSelectFolders: true,
canSelectFiles: false, canSelectMany: false, defaultUri:
vscode.Uri.file(defaultDir) })`, then the same fsPath → workspace-relative →
  forward-slash normalization already at `WorkflowSerializer.ts:640-650`.
  Extract that normalization block into a small shared private helper (e.g.
  `resolveDialogSelection(uris, workspaceRoot)`) so `handleBrowseTemplateFile`
  and `handleBrowseSaveLocation` share it instead of duplicating it — same
  single-source rationale as decision 5 above.
- New message pair, mirroring `BROWSE_TEMPLATE_FILE`/`TEMPLATE_FILE_SELECTED`:
  `BROWSE_SAVE_LOCATION` (webview → extension, panel-only) and
  `SAVE_LOCATION_SELECTED` (extension → webview reply, `{ path }`). Don't
  reuse the template message pair — it carries a `variable` field that has no
  meaning here, and overloading it with a sentinel value would couple two
  unrelated features through a magic string. Wire the new pair through
  `WebviewMessageRouter` and a `useMessageHandler` case
  (`uiStore.setSaveLocationSelection`), mirroring `TEMPLATE_FILE_SELECTED`'s
  handling at `useMessageHandler.ts:1349-1355`.
- Hosted browser (`isStandalone`) → call `uiStore.openFileBrowser({ mode:
"directory", initialPath: location, onSelect: setLocation })`, no message
  round trip — same singleton picker `TemplateModal` uses in Part 3, just a
  different `mode`/`onSelect`. Unlike `TemplateModal`'s `applyPickedPath`,
  there's no `autoFillFilename` cross-cutting concern here (the Name field is
  independent user input), so `onSelect` is just `setLocation` directly — no
  shared "apply" helper needed between the native and web paths.
- Per Part 2's stacking fix: change `SaveWorkflowDialog`'s returned
  `<Modal isOpen={saveWorkflowDialogOpen} .../>` to
  `<Modal isOpen={saveWorkflowDialogOpen && !fileBrowserState} .../>`. Leave
  the reset effect (`SaveWorkflowDialog.tsx:58-69`) keyed on the original
  `saveWorkflowDialogOpen`, untouched.

**Deferred further:**

- Let `WorkflowFilePickerModal`'s manual-path box optionally launch
  `FileBrowserModal` too.
- Optional git-status coloring by adding a `workspaceStatus()` fetch.

---

## Decisions (previously open questions — resolved)

1. **Path shape parity — already consistent, no normalization needed.**
   `handleBrowseTemplateFile` (`WorkflowSerializer.ts:640-650`) already returns
   a workspace-relative, forward-slash-normalized path. The tree API's
   `entry.path` (`HostedWorkspaceViewerTypes.ts:21-22`) is the same shape,
   including the multi-root folder-name prefix. `FileBrowserModal.onSelect`
   passes `entry.path`/current directory path straight through — no
   transformation step, on either client.
2. **Modal home: `uiStore`-driven, one canonical instance — reversed from the
   original "local state" lean.** `SaveWorkflowDialog` (Part 4) landing as a
   second consumer in the same effort, plus `WorkflowFilePickerModal` as a
   likely third (deferred bullet), tipped this toward a single store-driven
   picker (`uiStore.fileBrowserState` / `openFileBrowser` / `closeFileBrowser`,
   Part 2) mounted once in `Header.tsx` rather than each caller mounting its
   own instance. Rationale: one mount point avoids N sets of portal/z-index
   plumbing, guarantees only one picker can be open app-wide, and each new
   consumer (present or future) only has to call `openFileBrowser({ mode,
initialPath, onSelect })` instead of re-plumbing local `isOpen`/`browseState`.
   The per-consumer "apply result" logic (`applyPickedPath` +
   `autoFillFilename` for `TemplateModal` vs. plain `setLocation` for
   `SaveWorkflowDialog`) still stays caller-side as the `onSelect` callback —
   only the open/close/config state moves into the store, not the apply logic.
3. **External roots: no picker-specific work needed today.** The modal already
   consumes `isRootsList` generically (Part 2), so if
   `ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md` lands later, external-root navigation
   arrives for free via the existing tree API + `FileAccessPolicy`.

Two additional decisions surfaced while verifying the plan against current code
(see "Existing facts" above for details):

4. **`EntryRow` needs `isCut` and `openContextMenu` made optional**, not just
   `statusColorClass` — both are currently required props tied to the
   explorer's cut/paste and context-menu feature, which the picker omits.
5. **Single-source the `fileFilter` ext-extraction regex** in
   `src/utils/fileFilterUtils.ts` instead of duplicating it client-side —
   `WorkflowSerializer.ts:616`'s logic has no `vscode` dependency and the
   webview can already import `src/utils/**` via the `@root/utils` Vite alias.
6. **The caller modal hides (visual `isOpen` gate), not overlays, while the
   picker is open.** `Modal` isn't stacking-safe — two simultaneously-`isOpen`
   instances double up backdrops and, more importantly, both attach an
   Escape-closes-on-`isOpen` listener, so an un-gated stack would let Escape
   close the picker _and_ the underlying `TemplateModal`/`SaveWorkflowDialog`
   at once. Fix is a derived `isOpen && !fileBrowserState` passed only to the
   caller's own `<Modal>` JSX, never to the effects that reset the caller's
   form state on open — see Part 2's "Caller modal hides" note, and the Part
   3/4 wiring bullets.

## Verification

- `npm run typecheck`.
- `npm run test:ui` — extend `WorkspaceExplorerPane` coverage stays green after
  the Part 1 extraction; add a `FileBrowserModal` test (seed
  `uiStore.fileBrowserState` directly since the component takes no props —
  navigation, file vs. directory confirm, `fileFilter` dimming, and that
  `closeFileBrowser` clears state on both confirm and cancel).
- Manual pass in the hosted dashboard (browser, `isStandalone`): open New Workflow
  → a template with `file` + `directory` variables → Browse on each → navigate,
  pick, confirm → variable populates and `autoFillFilename` still seeds the
  workflow name. Then confirm the VS Code panel still opens the native dialog
  unchanged.
- Stacking check (browser): with New Workflow open and some variables already
  typed, hit Browse — the template dialog should visually disappear (single
  backdrop, only the picker showing), typed variables must still be there when
  the picker closes. Press Escape while the picker is open — only the picker
  should close, `TemplateModal` must stay open with its values intact. Repeat
  for `SaveWorkflowDialog`'s Browse button.
- Manual pass for `SaveWorkflowDialog` (Part 4), both clients: open Save As on
  an unsaved workflow → Location defaults to the last-saved directory (or repo
  root on first save) and Name defaults to the workflow's name → Browse
  changes Location without touching Name → Save writes to
  `location/name.ctrlyoke.<format>` → save again and confirm the _next_ Save
  As opens with the just-used directory as Location (workspaceState roundtrip
  still works for both the VS Code panel and the hosted browser client).
