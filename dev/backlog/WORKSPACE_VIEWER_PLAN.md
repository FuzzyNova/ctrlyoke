# Hosted Workspace Viewer Plan

## Status: Proposed

---

## Background

The browser-hosted FlightPath dashboard currently has no first-class way to inspect workspace files or current git changes. Users can only drop into the terminal and run ad hoc commands, which is functional but unnecessarily disruptive on phones and tablets.

The requested feature is a **browser-only** workspace viewer reachable from the hosted dashboard. It should open as a full-screen modal, expose two tabs (`Explorer` and `Source Control`), let users browse the workspace one directory level at a time, open files into a lightweight editable CodeMirror instance, and reuse the existing `DiffView.tsx` to display current file changes.

This plan is intentionally scoped to the hosted browser surface only. The VS Code panel should not expose the entry point.

---

## Relevant Existing Code

### `src/server/FlightPathHostedServer.ts`

- Already owns token-protected hosted routes under `/api/*`.
- Already knows the workspace root and runs in a trusted Node context with `fs`, `path`, and child-process access.
- Is the correct place to mount browser-only HTTP routes, but it is already large enough that new file/git logic should be delegated to a small service/helper instead of being embedded inline.

### `src/ui/webview-react/components/output/DiffView.tsx`

- Already handles:
  - full-content diffs (`oldContent` + `newContent`)
  - structured patch diffs
  - split/unified responsive rendering
  - hidden-context expansion when the original full file content is available
- This makes it the right renderer for the Source Control tab. The hosted viewer should feed it normalized file content, not build a second diff UI.

### `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx`

- The current editor is prompt-specific and contains a large amount of workflow-only behavior:
  - prompt/path completions
  - context-reference validation
  - spell checking
  - Ctrl+click prompt link handling
  - prompt/footer-specific keyboard behavior
- Reusing it directly for file editing would add more branching to an already large component. The better direction is to extract shared CodeMirror theme/setup pieces and create a separate lightweight file editor component for hosted workspace editing.

### `src/ui/webview-react/hooks/useVsCodeApi.ts`

- `isStandalone` already tells us whether the app is running through `FlightPathHostedServer`.
- That is the correct gate for showing the new header button and for any hosted-only fetch helpers.

---

## Goals

1. Add a browser-only workspace viewer entry point in the header.
2. Open a full-screen viewer with `Explorer` and `Source Control` tabs.
3. Let users browse the workspace like GitHub mobile explorer:
   - one directory level at a time
   - simple list UI
   - directory click drills in
   - file click opens an editor view
4. Let users edit and save text files from the browser.
5. Show current changed files in a flat Source Control list.
6. Reuse `DiffView.tsx` to show the current diff for a selected changed file.

---

## Non-Goals for V1

- No VS Code panel support.
- No multi-root workspace support beyond the first workspace root.
- No full SCM feature parity with VS Code.
- No inline staging/unstaging/commit/discard actions.
- No binary editing.
- No large-file virtualization or streaming file reads.
- No live watcher-driven auto-refresh on every filesystem or git change.

---

## Product Shape

### Entry point

Add a new header button, visible only when `isStandalone === true`.

- Label option: `Workspace Viewer`
- Icon-only option: `codicon-files`
- Recommendation: icon button with tooltip `Workspace Viewer`

The button should not render in the VS Code panel. Hiding only the button is enough for UX, but the backing hosted routes should still remain isolated and token-protected.

### Modal layout

Use a new dedicated full-screen overlay component rather than the shared `Modal.tsx`.

Reason:

- `Modal.tsx` is width-capped (`sm`/`md`/`lg`/`xl`) and uses a `max-h-[70vh]` body.
- The requested viewer needs full width/height, its own internal layout, and mobile-safe behavior.

### Tabs

The viewer contains two top-level tabs:

1. `Explorer`
2. `Source Control`

Each tab owns its own body state, but both live inside the same fullscreen shell so switching between them is instant.

---

## Architecture

## 1. Hosted server API

Add hosted-only workspace viewer routes under a dedicated prefix:

- `GET /api/workspace-viewer/tree?path=...`
- `GET /api/workspace-viewer/file?path=...`
- `PUT /api/workspace-viewer/file`
- `GET /api/workspace-viewer/status`
- `GET /api/workspace-viewer/diff?path=...`

These should use the same token middleware already used by the hosted server.

### Why HTTP routes instead of webview messages

This feature is browser-only and file-data-heavy. HTTP routes are a better fit than adding more `MESSAGE_TYPES` because they:

- stay local to the hosted surface
- avoid routing large file contents through the shared postMessage/WebSocket path
- avoid accidental feature bleed into the VS Code panel
- match the existing hosted-server `/api/*` pattern

### Server implementation split

Do not put all file and git logic directly into `FlightPathHostedServer.ts`.

Recommended split:

- `FlightPathHostedServer.ts`
  - route registration
  - request validation / response wiring
- `src/server/HostedWorkspaceViewerService.ts`
  - safe path resolution
  - directory listing
  - text file read/write
  - git status collection
  - git diff/base-content collection

That keeps the hosted server class from becoming another general-purpose filesystem controller.

## 2. Webview state

Create a dedicated store instead of inflating `uiStore` further:

- `src/ui/webview-react/store/workspaceViewerStore.ts`

Suggested state:

- `isOpen`
- `activeTab: "explorer" | "sourceControl"`
- `explorerPath`
- `explorerEntries`
- `explorerLoading`
- `selectedFilePath`
- `fileContent`
- `originalFileContent`
- `fileDirty`
- `fileLoading`
- `fileSaving`
- `sourceControlFiles`
- `sourceControlLoading`
- `selectedDiffPath`
- `diffData`
- `diffLoading`
- `error`

This state is highly feature-local and mostly transient. It should not be merged into the main persisted dashboard layout state unless there is a strong reason later.

## 3. New UI components

Recommended component set:

- `components/workspace-viewer/WorkspaceViewerModal.tsx`
- `components/workspace-viewer/WorkspaceViewerHeader.tsx`
- `components/workspace-viewer/WorkspaceExplorerPane.tsx`
- `components/workspace-viewer/WorkspaceFileEditor.tsx`
- `components/workspace-viewer/WorkspaceSourceControlPane.tsx`
- `components/workspace-viewer/WorkspaceDiffPane.tsx`

This keeps the feature self-contained and avoids mixing file-browser concerns into workflow/editor/output components.

---

## Explorer Tab

### Navigation model

Use a GitHub-mobile-style single-level explorer:

- one directory level visible at a time
- directories first, then files
- breadcrumb/back affordance at the top
- clicking a directory replaces the list with that directory’s children
- clicking a file replaces the directory list with a file editor view

This is simpler and more touch-friendly than a recursive tree.

### Tree route response

`GET /api/workspace-viewer/tree?path=...` should return:

```ts
interface WorkspaceTreeResponse {
  rootLabel: string;
  path: string; // workspace-relative directory path, "" for root
  parentPath: string | null;
  entries: Array<{
    name: string;
    path: string;
    kind: "file" | "directory";
    size?: number;
  }>;
}
```

Notes:

- `path` is always workspace-relative.
- Sort directories before files.
- Ignore obvious noise like `.git/`, `node_modules/.cache`, and other generated junk only if we already have a clean repo-level convention for that. Otherwise keep V1 literal and predictable.
- Add a directory entry count cap if needed to protect mobile rendering.

### File open flow

Clicking a file should:

1. call `GET /api/workspace-viewer/file?path=...`
2. load content into `WorkspaceFileEditor`
3. retain the current explorer directory so the user can go back without re-rooting

### File response

```ts
interface WorkspaceFileResponse {
  path: string;
  name: string;
  language?: string;
  size: number;
  eol: "lf" | "crlf";
  content: string;
  readOnly?: boolean;
  reason?: string;
}
```

The server should return text files only. Binary or oversized files should return a clear read-only/error response rather than corrupted content.

---

## File Editor Strategy

## Do not reuse `CodeMirrorEditor.tsx` directly

The current prompt editor is too specialized. Adding a `mode="workspaceFile"` branch inside it would push more unrelated logic into a component that is already large and workflow-heavy.

## Preferred approach

Extract shared editor styling/setup helpers from `CodeMirrorEditor.tsx`, then create a separate lightweight editor component for files.

Possible shared extraction:

- `createThemeExtension(...)`
- any generic linter theme styling
- shared base keymap/theme helpers that are not prompt-specific

New component:

- `WorkspaceFileEditor.tsx`

Behavior:

- editable text buffer
- find/replace support
- undo/redo/history
- line wrapping optional
- theme consistent with existing CodeMirror styling
- no completions
- no spell checker
- no prompt-link decorations
- no prompt validation
- no workflow keyboard shortcuts

The point is a clean editor, not a second prompt-authoring surface.

### Save behavior

Saving should call `PUT /api/workspace-viewer/file` with:

```ts
interface WorkspaceFileSaveRequest {
  path: string;
  content: string;
}
```

The server should:

- resolve the path safely within the workspace root
- preserve original line endings when practical
- write atomically
- reject binary/read-only/out-of-root paths

The client should:

- show dirty state
- disable save while the request is in flight
- refresh Source Control data after a successful save

### Dirty-exit guard

If the user navigates away from a dirty file:

- prompt for `Save`, `Discard`, or `Cancel`
- do this when:
  - switching tabs
  - opening a different file
  - closing the viewer
  - navigating back to explorer from the editor

---

## Source Control Tab

### List behavior

Show a flat list of changed files. Each row should include:

- relative path
- status badge(s)
- optional file-kind icon

The list should include files with:

- unstaged changes
- staged changes
- both
- untracked files
- deleted files

### Status route

`GET /api/workspace-viewer/status`

Return a normalized git status list derived from `git status --porcelain=v1` or `v2`.

Suggested response:

```ts
interface WorkspaceScmStatusResponse {
  files: Array<{
    path: string;
    stagedStatus: string | null;
    unstagedStatus: string | null;
    kind: "modified" | "added" | "deleted" | "renamed" | "untracked";
  }>;
}
```

### Diff semantics

For V1, clicking a file should show the file’s **current effective workspace diff** in the browser. The simplest practical definition is:

- compare current workspace content to `HEAD` when the file exists in git
- compare `""` to current content for untracked files
- compare prior `HEAD` content to `""` for deleted files

This gives a stable “what does the workspace currently look like relative to the repo baseline?” view and works well with `DiffView.tsx`.

If a file has both staged and unstaged changes, the list should still show both badges, but the rendered diff should remain the combined current workspace state relative to `HEAD` for V1. Separate index-vs-working-tree toggles can be a later enhancement if needed.

### Diff route

`GET /api/workspace-viewer/diff?path=...`

Recommended response:

```ts
interface WorkspaceScmDiffResponse {
  path: string;
  language?: string;
  oldContent: string;
  newContent: string;
  kind: "modified" | "added" | "deleted" | "renamed" | "untracked";
}
```

This lets the UI feed `oldContent` and `newContent` directly into `DiffView.tsx`, which is preferable to building and parsing raw patch text for V1.

### Diff rendering

Reuse `DiffView.tsx` directly with:

- `oldContent`
- `newContent`
- inferred `language`
- `globallyCollapsed={false}` or a viewer-local collapsed state

This gives us:

- split/unified responsive layout
- syntax tokenization
- hidden-context expansion
- no duplicated diff rendering code

---

## Hosted-Only Visibility

The feature should be browser-only at the UI layer and hosted-only at the data layer.

### UI gate

In `Header.tsx`:

- import `isStandalone`
- render the workspace viewer button only when `isStandalone` is true

### Data gate

Only `FlightPathHostedServer.ts` should expose the new API routes. The VS Code webview should not receive equivalent postMessage handlers for this feature.

This keeps the separation clear:

- VS Code panel: open files and git diffs in the editor via existing `OPEN_FILE` / `OPEN_GIT_CHANGE`
- hosted browser: inspect and edit files inline via hosted API routes

---

## Security and Safety

The hosted viewer is local-first but still needs proper guardrails.

### Path safety

All requested paths must:

- be resolved against `workspaceRoot`
- be normalized
- be realpath-checked
- be rejected if they escape the workspace via `..` or symlink traversal

### File-type safety

V1 should allow editing only text files.

Reject or mark read-only when:

- the file is binary
- the file exceeds a conservative size cap
- encoding cannot be safely handled

### Write safety

Use atomic writes where practical and avoid writing outside the workspace root.

### Git command safety

All git commands should:

- run with `-C <workspaceRoot>`
- use timeouts
- tolerate non-git workspaces by returning empty status/diff results with a friendly message

---

## Shared Types and Utilities

Because the hosted server and React client both need the same shapes, add a shared type file rather than duplicating interfaces in component-local code.

Recommended:

- `src/types/HostedWorkspaceViewerTypes.ts`

Also add a small hosted fetch helper for token-aware API calls:

- `src/ui/webview-react/utils/hostedApi.ts`

This helper should centralize:

- token propagation from the current URL
- JSON fetch boilerplate
- hosted-route error normalization

That is cleaner than sprinkling raw `fetch("/api/...")` calls across components.

---

## Testing Plan

## Server tests

Add focused tests around the new service/helpers for:

- directory listing at root and nested paths
- path traversal rejection
- symlink escape rejection
- text file read
- binary file rejection
- save success
- save rejection outside workspace
- git status parsing
- non-git workspace fallback
- diff content generation for modified, added, and deleted files

## Webview tests

Add React/Vitest tests for:

- header button hidden in panel mode and shown in standalone mode
- opening/closing the workspace viewer
- explorer directory drill-in and back navigation
- file editor dirty-state transitions
- save request flow
- source control list rendering
- diff pane rendering through `DiffView`
- dirty-exit confirmation behavior

## Manual verification

Test in:

- desktop browser
- mobile Safari / Chrome
- a git workspace with:
  - unstaged changes
  - staged changes
  - untracked files
  - deleted files

---

## Implementation Phases

### Phase 1: Server foundation

- Add shared hosted viewer types
- Add hosted API helper
- Add `HostedWorkspaceViewerService`
- Add tree/file/save/status/diff routes in `FlightPathHostedServer.ts`

### Phase 2: Viewer shell

- Add browser-only header button
- Add fullscreen viewer shell with tabs
- Add dedicated store

### Phase 3: Explorer

- Add single-level explorer list
- Add breadcrumb/back navigation
- Add file open flow

### Phase 4: File editor

- Extract shared CodeMirror theme/setup pieces from `CodeMirrorEditor.tsx`
- Build `WorkspaceFileEditor.tsx`
- Add save + dirty tracking

### Phase 5: Source Control

- Add SCM list
- Add diff fetch flow
- Render diffs through `DiffView.tsx`

### Phase 6: Hardening

- Add dirty-exit guard
- Handle large/binary files cleanly
- Add tests and mobile polish

---

## Recommended Initial File List

- `src/server/FlightPathHostedServer.ts`
- `src/server/HostedWorkspaceViewerService.ts`
- `src/types/HostedWorkspaceViewerTypes.ts`
- `src/ui/webview-react/components/layout/Header.tsx`
- `src/ui/webview-react/components/workspace-viewer/WorkspaceViewerModal.tsx`
- `src/ui/webview-react/components/workspace-viewer/WorkspaceExplorerPane.tsx`
- `src/ui/webview-react/components/workspace-viewer/WorkspaceFileEditor.tsx`
- `src/ui/webview-react/components/workspace-viewer/WorkspaceSourceControlPane.tsx`
- `src/ui/webview-react/components/workspace-viewer/WorkspaceDiffPane.tsx`
- `src/ui/webview-react/store/workspaceViewerStore.ts`
- `src/ui/webview-react/utils/hostedApi.ts`

---

## Open Questions

1. Should the Explorer hide `.git/` and other noise by default, or should V1 show the literal filesystem?
2. Should deleted files be viewable as diff-only rows with no editor open path, or should the explorer also surface them separately when selected from Source Control?
3. Do we want a manual `Refresh` button in both tabs for V1, or is open/tab-switch/save refresh enough?
4. Should partially staged files eventually gain a toggle between `HEAD -> index` and `index -> working tree`, or is the combined `HEAD -> current workspace` diff sufficient for the hosted UX?

---

## Recommendation

Build this as a **hosted-only, HTTP-backed workspace viewer** with a dedicated fullscreen UI, a dedicated store, a lightweight file editor, and direct reuse of `DiffView.tsx`.

The key implementation decision is to **avoid reusing `CodeMirrorEditor.tsx` wholesale**. Extract the theme/setup pieces that are truly shared, but keep prompt editing and file editing as separate surfaces. That keeps the prompt editor maintainable while still giving the hosted browser a strong editing experience.
