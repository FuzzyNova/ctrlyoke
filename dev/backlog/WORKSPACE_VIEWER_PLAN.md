# Hosted Workspace Viewer Plan

## Status: Ready for Implementation

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
- No binary editing.
- No large-file virtualization or streaming file reads.
- No live watcher-driven auto-refresh on every filesystem or git change.
- No separate index-vs-working-tree diff toggle (combined `HEAD → workspace` diff only).
- No conflict resolution UI.

---

## Library Evaluation: File Explorer

Evaluated `react-file-explorer`, `react-accessible-treeview`, and `react-complex-tree`. All are designed for recursive tree-view rendering and carry significant layout/state overhead for what this feature needs — a simple one-level-at-a-time list. A custom component is the right call: fewer dependencies, full control over mobile touch targets, and no tree state to manage.

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

The viewer's header is a **tab bar** rendered at the top of the fullscreen shell:

```
[ FlightPath Workspace ]    Explorer  |  Source Control         [✕ Close]
```

- The active tab is underlined / highlighted (consistent with existing tab styling in the webview).
- Each tab owns its own body state. Switching is instant because both panes remain mounted; only visibility changes.
- The close button (`codicon-close`) sits at the far right of the header bar.

---

## Architecture

## 1. Hosted server API

Add hosted-only workspace viewer routes under a dedicated prefix:

- `GET /api/workspace-viewer/tree?path=...`
- `GET /api/workspace-viewer/file?path=...`
- `PUT /api/workspace-viewer/file`
- `GET /api/workspace-viewer/status`
- `GET /api/workspace-viewer/diff?path=...`
- `POST /api/workspace-viewer/stage`
- `POST /api/workspace-viewer/unstage`
- `POST /api/workspace-viewer/commit`
- `POST /api/workspace-viewer/push`
- `POST /api/workspace-viewer/pull`

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
  - git stage / unstage
  - git commit
  - git push
  - git pull

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
- `commitMessage`
- `committing`
- `pushing`
- `pulling`
- `scmError`
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
- `components/workspace-viewer/WorkspaceCommitArea.tsx`

This keeps the feature self-contained and avoids mixing file-browser concerns into workflow/editor/output components.

---

## Explorer Tab

### Layout

The Explorer tab uses a **two-column layout on wide viewports**:

```
┌────────────────────────────────────────────────────────────────┐
│  Explorer  │  Source Control                        [✕ Close]  │  ← tab bar
├───────────────────────┬────────────────────────────────────────┤
│ [ ← ]  root / src    │  src/ui/App.tsx  ●           [Save]    │
│ ─────────────────────│────────────────────────────────────────│
│ 📁 components/       │                                        │
│ 📁 hooks/            │   <CodeMirror editor>                  │
│ 📄 App.tsx      ←sel │                                        │
│ 📄 utils.ts          │                                        │
└───────────────────────┴────────────────────────────────────────┘
```

- **Left column**: directory list with its own nav toolbar (back + breadcrumb). Width is fixed (e.g. `w-64` / `16rem`) and the list scrolls independently.
- **Right column**: CodeMirror editor fills the remaining space. Empty state shown when no file is selected.
- Clicking a file in the list opens it in the right column — the directory list stays visible.
- Clicking a directory drills into it in the left column — the editor stays open if a file was already selected.

**Mobile (narrow viewport):**

```
[ ← ]  root / src              [↻]
────────────────────────────────
📁 components/
📁 hooks/
📄 App.tsx
```

- The directory list is the default view.
- Selecting a file transitions to a full-screen editor with a back button in its toolbar.
- Back returns to the directory list (dirty-exit guard applies).
- This is the same interaction model as the wide layout’s left column, just without the persistent right column.

### Navigation model

The directory list follows a single-level explorer pattern:

- one directory level visible at a time
- directories first, then files
- all files and directories shown including hidden ones (`.git`, `.env`, etc.)
- navigation is scoped to the workspace root — paths cannot escape via `..` or symlinks
- a future setting (`hideHiddenFiles`) can filter dotfiles from the list; expose as a toggle button in the explorer toolbar when implemented

### Navigation button UX

**Left column nav toolbar**

```
[ ← ]  workspace-root / src / ui          [↻ Refresh]
```

- **Back button** (`codicon-arrow-left`): navigates to `parentPath` from the tree response. Hidden when at workspace root.
- **Breadcrumb**: each path segment is a clickable link (jumps directly to that directory). Workspace root label comes from `rootLabel` in the tree response.
- **Refresh** (`codicon-refresh`): re-fetches the current directory listing.

**Right column (editor) toolbar — wide viewport**

```
src/ui/App.tsx  ●                                      [Save]
```

- **File path**: workspace-relative path shown left-aligned. Dot `●` suffix when unsaved.
- **Save button**: right-aligned, `codicon-save`. Spinner / disabled while PUT in-flight. Also bound to `Ctrl+S` / `Cmd+S`.

**Mobile editor toolbar (full-screen file view)**

```
[ ← Back ]  src/ui/App.tsx  ●                          [Save]
```

- **Back button**: returns to the directory list. Triggers dirty-exit guard if file is modified.

All icons use existing VS Code codicons via `codicon-*` CSS classes already in the webview stylesheet.

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
- syntax highlighting via CodeMirror's native lezer-based parser
- find/replace support
- undo/redo/history
- line number gutter
- line wrapping toggle
- theme consistent with existing CodeMirror styling (`createThemeExtension` extracted from `CodeMirrorEditor.tsx`)
- no completions
- no spell checker
- no prompt-link decorations
- no prompt validation
- no workflow keyboard shortcuts

The point is a clean editor, not a second prompt-authoring surface.

### Syntax highlighting strategy

Do **not** re-use the refractor-based highlighting from `syntaxHighlighting.tsx`. CodeMirror 6 uses lezer grammars with its own `HighlightStyle` system, which is integrated into the editor at the parser level and is significantly faster for large files.

**Language detection**: reuse `getLanguageFromPath(filePath)` from `syntaxHighlighting.tsx` to get the language name from the file extension.

**Language extension mapping**: create a helper in `src/ui/webview-react/utils/codemirrorLanguage.ts` that maps language names to CodeMirror language extensions. Start with the languages already supported by packages that will be added:

| Language | Package |
|---|---|
| javascript / jsx | `@codemirror/lang-javascript` |
| typescript / tsx | `@codemirror/lang-javascript` (TypeScript dialect) |
| python | `@codemirror/lang-python` |
| rust | `@codemirror/lang-rust` |
| json | `@codemirror/lang-json` |
| html / markup | `@codemirror/lang-html` |
| css / scss | `@codemirror/lang-css` |
| yaml | `@codemirror/lang-yaml` (already installed via lang-markdown peer) |
| markdown | `@codemirror/lang-markdown` (already installed) |
| java | `@codemirror/lang-java` |
| cpp / c | `@codemirror/lang-cpp` |
| php | `@codemirror/lang-php` |

Add these packages to `package.json` devDependencies (they are already bundled by Vite so they stay webview-only).

**Highlight style**: create `createWorkspaceEditorHighlightExtension()` in `src/ui/webview-react/utils/codemirrorLanguage.ts`. Build a `HighlightStyle` using `@lezer/highlight` tags mapped to the **same VS Code CSS variables** as `SYNTAX_TOKEN_STYLES` in `syntaxHighlighting.tsx`:

```ts
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

export function createWorkspaceEditorHighlightExtension() {
  const style = HighlightStyle.define([
    { tag: [tags.keyword, tags.definitionKeyword, tags.modifier],
      color: "var(--vscode-symbolIcon-functionForeground, #569cd6)" },
    { tag: [tags.string, tags.character, tags.attributeValue],
      color: "var(--vscode-debugTokenExpression-string, #ce9178)" },
    { tag: tags.number,
      color: "var(--vscode-debugTokenExpression-number, #b5cea8)" },
    { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
      color: "var(--vscode-charts-green, #6a9955)", fontStyle: "italic" },
    { tag: [tags.function(tags.variableName), tags.function(tags.name)],
      color: "#dcdcaa" },
    { tag: [tags.className, tags.typeName, tags.namespace],
      color: "var(--vscode-chat-editedFileForeground, #4ec9b0)" },
    { tag: [tags.variableName, tags.propertyName, tags.attributeName,
            tags.local(tags.variableName), tags.definition(tags.variableName)],
      color: "var(--vscode-symbolIcon-variableForeground, #9cdcfe)" },
    { tag: [tags.bool, tags.null],
      color: "var(--vscode-debugTokenExpression-boolean, #4e94ce)" },
    { tag: tags.regexp,
      color: "var(--vscode-charts-red, #d16969)" },
    { tag: tags.tagName,
      color: "var(--vscode-symbolIcon-constructorForeground, #4ec9b0)" },
    { tag: [tags.selector, tags.className],
      color: "var(--vscode-chat-editedFileForeground, #d7ba7d)" },
    { tag: tags.url,
      color: "var(--vscode-textLink-foreground, #4e94ce)" },
  ]);
  return syntaxHighlighting(style);
}
```

This gives visual parity with the refractor token styles used in DiffView and output blocks, using the same design-token variables, without coupling the editor to refractor or injecting `<style>` tags.

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

### Layout

The Source Control tab uses a **two-column layout on wide viewports** matching VS Code's SCM panel ordering — commit area first, then file lists:

```
┌────────────────────────────────────────────────────────────────┐
│  Explorer  │  Source Control                        [✕ Close]  │  ← tab bar
├───────────────────────┬────────────────────────────────────────┤
│  Commit message...    │                                        │
│                       │   Diff for selected file               │
│  [Commit] [Push|Pull] │   (DiffView.tsx)                       │
│  ─────────────────── │                                        │
│  Staged (1) [Unstage All]                                      │
│   ✓ M  src/types.ts [-]                                        │
│  ─────────────────── │                                        │
│  Changes (3) [Stage All]                                       │
│   ● M  src/App.tsx [+]│                                        │
│   ● M  src/utils.ts[+]│                                        │
│   ● U  src/new.ts  [+]│                                        │
└───────────────────────┴────────────────────────────────────────┘
```

The left column has a fixed width (same as the Explorer list column) and scrolls independently. The right column fills the remaining space with the diff.

**Mobile (narrow viewport):**

The left column (commit area + file lists) is the default view. Clicking a file row transitions to a full-screen diff view with a back button. Back returns to the file list. Commit/push controls remain at the top of the left column, not duplicated in the diff view.

### File list behavior

Two sections in VS Code order — **Staged** above **Changes**:

- **Staged** section: files that have been `git add`-ed. Header includes a `[Unstage All]` button shown only when ≥1 file is staged.
- **Changes** section: modified, deleted, and untracked files that are not staged. Header includes a `[Stage All]` button.

Each row includes:

- status badge: `M` modified, `A` added, `D` deleted, `U` untracked, `R` renamed
- color: staged rows use `--vscode-gitDecoration-addedResourceForeground` (green-tinted); unstaged rows use `--vscode-gitDecoration-modifiedResourceForeground` (orange/yellow)
- relative file path
- action button: `[+]` to stage (Changes section), `[−]` to unstage (Staged section)

Clicking a file row selects it and loads its diff in the right panel. The selected row is highlighted.

The list covers all changed files:

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

Clicking a file shows its **current effective workspace diff** (`HEAD → current working tree`):

- compare current workspace content to `HEAD` when the file exists in git
- compare `””` to current content for untracked files
- compare prior `HEAD` content to `””` for deleted files

For staged files, the diff shown is still `HEAD → working tree` (the combined view) for V1. Separate `HEAD → index` vs `index → working tree` toggles are a later enhancement.

### Stage / unstage actions

- Clicking `+` on a Changes row calls `POST /api/workspace-viewer/stage` with `{ path }`.
- Clicking `−` on a Staged row calls `POST /api/workspace-viewer/unstage` with `{ path }`.
- Both refresh the file list after the operation completes.
- If staging an untracked file, it becomes tracked + staged (equivalent to `git add`).

### Commit and push area

Positioned at the **top of the left column**, above the file lists (matching VS Code’s SCM panel order):

**Commit message textarea**

- Multiline textarea, placeholder `Commit message...`
- Required to be non-empty before the Commit button is enabled

**Action buttons**

Two controls sit below the textarea in a single row:

1. **Commit button** (standalone): calls `POST /api/workspace-viewer/commit` with `{ message }`. Disabled when message is empty or while committing. Clears the message and refreshes the file list on success.

2. **Push / Pull split button** (grouped, styled like `UndoRedoControl.tsx`): a single bordered button group containing two segments separated by a divider:
   - `[Push]` — calls `POST /api/workspace-viewer/push`. Disabled while pushing.
   - `[Pull]` — calls `POST /api/workspace-viewer/pull`. Disabled while pulling.

   Implement as a `<div role="group">` with shared border and overflow-hidden, identical to the undo/redo button grouping pattern in `UndoRedoControl.tsx`.

Both controls show inline error text below the buttons if an operation fails (no remote, auth failure, conflict, etc.). Spinners replace icons while in-flight.

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

Also add:

- `src/ui/webview-react/utils/hostedApi.ts` — token-aware fetch helper (token from URL, JSON boilerplate, error normalization)
- `src/ui/webview-react/utils/codemirrorLanguage.ts` — language detection → CodeMirror extension mapper and `createWorkspaceEditorHighlightExtension()`

These are cleaner than sprinkling raw `fetch("/api/...")` calls or language-switching logic across components.

### New request types (add to `HostedWorkspaceViewerTypes.ts`)

```ts
interface WorkspaceStageRequest   { path: string }
interface WorkspaceUnstageRequest { path: string }
interface WorkspaceCommitRequest  { message: string }
interface WorkspacePushResponse   { branch: string; remote: string }
interface WorkspacePullResponse   { branch: string; remote: string }
```

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
- stage / unstage file
- commit with message
- push (and failure cases: no remote, auth error)
- pull (and failure cases: no remote, conflicts)

## Webview tests

Add React/Vitest tests for:

- header button hidden in panel mode and shown in standalone mode
- opening/closing the workspace viewer
- explorer directory drill-in and back navigation
- file editor dirty-state transitions
- save request flow and dirty indicator
- back button triggers dirty-exit guard when file is modified
- source control file list: Changes and Staged sections render correctly
- stage/unstage action buttons call correct API and refresh list
- commit button disabled when message is empty
- commit + push + pull request flows
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

- Add shared hosted viewer types (`HostedWorkspaceViewerTypes.ts`)
- Add hosted API helper (`hostedApi.ts`)
- Add `HostedWorkspaceViewerService` with filesystem + git methods
- Add tree/file/save/status/diff routes in `FlightPathHostedServer.ts`
- Add stage/unstage/commit/push/pull routes in `FlightPathHostedServer.ts`

### Phase 2: Viewer shell

- Add browser-only header button
- Add fullscreen viewer shell with tabs
- Add dedicated store

### Phase 3: Explorer

- Add two-column layout (directory list left, editor right) with mobile single-column fallback
- Add single-level directory list with breadcrumb/back navigation
- Add file open flow (wide: loads into right column; mobile: transitions to full-screen editor)

### Phase 4: File editor

- Extract `createThemeExtension` from `CodeMirrorEditor.tsx` into a shared helper
- Add `@codemirror/lang-javascript`, `@codemirror/lang-python`, `@codemirror/lang-rust`, `@codemirror/lang-json`, `@codemirror/lang-html`, `@codemirror/lang-css`, `@codemirror/lang-java`, `@codemirror/lang-cpp`, `@codemirror/lang-php` to `package.json`
- Build `codemirrorLanguage.ts` with language map and `createWorkspaceEditorHighlightExtension()`
- Build `WorkspaceFileEditor.tsx` with syntax highlighting, save button, dirty indicator
- Add `Ctrl+S` / `Cmd+S` save keybinding

### Phase 5: Source Control

- Add two-section file list (Changes / Staged) with stage/unstage action buttons
- Add diff fetch flow and `WorkspaceDiffPane.tsx` rendering through `DiffView.tsx`
- Add `WorkspaceCommitArea.tsx` with commit message textarea, Commit button, Push/Pull split button
- Wire commit/push/pull to new API routes with in-flight state and error display
- Mobile: clicking a file in the list transitions to full-screen diff with back button

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
- `src/ui/webview-react/components/workspace-viewer/WorkspaceCommitArea.tsx`
- `src/ui/webview-react/store/workspaceViewerStore.ts`
- `src/ui/webview-react/utils/hostedApi.ts`
- `src/ui/webview-react/utils/codemirrorLanguage.ts`

---

## Open Questions

1. Should deleted files be viewable as diff-only rows with no editor open path, or should the explorer also surface them separately when selected from Source Control?

> **Resolved:** The Explorer shows all files and directories including hidden ones (`.git`, dotfiles). Navigation is scoped to the workspace root — paths cannot escape. A `hideHiddenFiles` setting is planned as a future toggle (exposed as a shortcut button in the explorer toolbar when implemented).

---

## Recommendation

Build this as a **hosted-only, HTTP-backed workspace viewer** with a dedicated fullscreen UI, a dedicated store, a lightweight file editor, and direct reuse of `DiffView.tsx`.

Two key implementation decisions:

1. **Avoid reusing `CodeMirrorEditor.tsx` wholesale.** Extract `createThemeExtension` and the VS Code CSS variable wiring, but keep prompt editing and file editing as separate surfaces.

2. **Use CodeMirror's native lezer-based highlighting** (not refractor) in the file editor. Create a `HighlightStyle` that maps `@lezer/highlight` tags to the same VS Code CSS variables already defined in `SYNTAX_TOKEN_STYLES` in `syntaxHighlighting.tsx`. This gives fast, integrated highlighting without duplicating the CSS token variable set.

3. **Staging and commit/push/pull are in scope for V1.** The Source Control tab should be a usable mini-SCM panel, not just a diff viewer. Keep it simple (no conflict resolution, no rebase, no branch switching), but enough to review changes, stage selectively, commit with a message, push, and pull — all without leaving the browser.

4. **Two-column layout on wide viewports for both tabs.** The Explorer shows the directory list and editor side-by-side. Source Control shows the commit area + file lists alongside the diff. Mobile collapses to single-column with file selection transitioning to a full-screen view with a back button. This matches the spatial model users expect from VS Code and GitHub mobile.
